<p align="right"><a href="../cn/01_foundation.md">中文</a></p>

# Phase 1: Project Foundation

This chapter provides a project-level dissection of `@anthropic-ai/claude-code`, moving from product identity and technology choices to the responsibility of each major directory, then to a complete dependency knowledge graph. The goal is to establish a solid foundation for the architectural analysis and module deep dives in later chapters.


## 1. Project Identity

### 1.1 Basic Information

| Property | Value |
|------|-----|
| Package name | `@anthropic-ai/claude-code` |
| Version | 2.1.88 |
| Author | Anthropic &lt;support@anthropic.com&gt; |
| Repository | [github.com/anthropics/claude-code](https://github.com/anthropics/claude-code) |
| Homepage | [claude.com/product/claude-code](https://claude.com/product/claude-code) |
| Documentation | [code.claude.com/docs/en/overview](https://code.claude.com/docs/en/overview) |
| License | Proprietary to Anthropic PBC (not open source) |
| Entry command | `claude` (mapped to `cli.js` via the `bin` field in `package.json`) |
| Module system | ES Module (`"type": "module"`) |
| Node.js requirement | >= 18.0.0 |
| Build tool | Bun (inferred from `bun.lock`) |
| Bug reporting | GitHub Issues or the built-in `/bug` command in the CLI |

### 1.2 Product Positioning and Core Value

Claude Code is Anthropic's **official command-line coding assistant**. It embeds Claude's capabilities directly into a developer's terminal workflow. Unlike a traditional IDE plugin or a browser-based chat UI, Claude Code treats the terminal as a first-class interface, reflecting a design philosophy of bringing AI directly into the environment where developers already work most naturally.

Its core value proposition includes:

- **Repository understanding**: Deeply understands project structure and code semantics through tools such as Grep, Glob, and FileRead.
- **File editing**: Uses FileEdit and FileWrite to modify code directly on disk, supporting precise string replacement and whole-file rewrites.
- **Command execution**: Runs arbitrary shell commands through the Bash tool inside a sandbox, with timeout control and background execution support.
- **Git workflow support**: Understands Git operations natively and assists with commits, branch management, and Pull Request creation.
- **Multimodal input**: Supports text, images through Sharp, and voice through the native `audio-capture` module.
- **Extensibility**: Integrates external tools and resources through MCP (Model Context Protocol).
- **Multi-surface deployment**: Usable from the terminal, inside IDEs, and on GitHub via `@claude` interactions.

### 1.3 Technology Stack at a Glance

```
┌─────────────────────────────────────────────────┐
│              User Interaction Layer             │
│        React + Ink (terminal UI rendering)      │
├─────────────────────────────────────────────────┤
│               Application Logic Layer           │
│    TypeScript (1332 .ts + 552 .tsx + 18 .js)    │
│           1902 application source files         │
├─────────────────────────────────────────────────┤
│                  AI Engine Layer                │
│   @anthropic-ai/sdk (Claude API client)         │
│   @anthropic-ai/bedrock-sdk (AWS Bedrock)       │
│   @anthropic-ai/vertex-sdk (Google Vertex AI)   │
│   @anthropic-ai/foundry-sdk (Azure Foundry)     │
├─────────────────────────────────────────────────┤
│                Native Module Layer              │
│      ripgrep (search) │ Sharp │ audio           │
├─────────────────────────────────────────────────┤
│                    Runtime                      │
│          Node.js >= 18.0.0 (ES Module)          │
└─────────────────────────────────────────────────┘
```


## 2. Deep Directory Anatomy

### 2.1 Distribution Layout (npm Package)

The following is the on-disk layout after installing the package with `npm install -g @anthropic-ai/claude-code`:

```
@anthropic-ai/claude-code/                  # Package root
│
├── cli.js                  # [13.0 MB, 16,667 lines] bundled main entrypoint
│                           # Bun compiles all TypeScript source + dependencies
│                           # into a single ESM file
│                           # Contains business logic, UI components, tools,
│                           # and service-layer code
│
├── cli.js.map              # [57.0 MB] Source map
│                           # Maps back to 4,756 original source files
│                           # 1,902 are application files (../src/);
│                           # the remainder come from node_modules
│
├── package.json            # Package metadata: bin mapping, engine requirements,
│                           # optional dependency declarations
│                           # Note that `dependencies` is empty because runtime
│                           # dependencies are already bundled into cli.js
│                           # Only 9 platform-specific `@img/sharp-*` bindings
│                           # remain under `optionalDependencies`
│
├── bun.lock                # Bun lockfile recording dependency resolution
│                           # used at build time
│
├── sdk-tools.d.ts          # [2,719 lines] TypeScript declaration file
│                           # Generated automatically by json-schema-to-typescript
│                           # Defines input/output types for all tools
│                           # such as Agent, Bash, FileEdit, and others
│                           # Provides type hints for SDK integrators
│
├── README.md               # Project documentation
├── LICENSE.md              # License file (Anthropic PBC proprietary)
│
├── node_modules/           # Only platform-specific native bindings
│   └── @img/
│       ├── sharp-darwin-arm64/          # Sharp native binding for macOS ARM64
│       └── sharp-libvips-darwin-arm64/  # libvips native image library
│       # Other platforms (linux-x64, win32-x64, etc.) are installed on demand
│
└── vendor/                 # Precompiled native binaries
    ├── audio-capture/      # Cross-platform audio capture module
    │   ├── arm64-darwin/   # macOS ARM64 (Apple Silicon)
    │   ├── x64-darwin/     # macOS x86_64 (Intel Mac)
    │   ├── arm64-linux/    # Linux ARM64
    │   ├── x64-linux/      # Linux x86_64
    │   ├── arm64-win32/    # Windows ARM64
    │   └── x64-win32/      # Windows x86_64
    │
    └── ripgrep/            # ripgrep search engine binaries
        ├── arm64-darwin/   # macOS ARM64
        ├── x64-darwin/     # macOS x86_64
        ├── arm64-linux/    # Linux ARM64
        ├── x64-linux/      # Linux x86_64
        ├── arm64-win32/    # Windows ARM64
        ├── x64-win32/      # Windows x86_64
        └── COPYING         # ripgrep license (Unlicense/MIT)
```

**Key design decisions:**

1. **Single-file distribution**: All TypeScript source and roughly 200 npm dependencies are bundled into a single 13 MB `cli.js`. As a result, `dependencies` in `package.json` is an empty object. The benefit is near-instant installation with no dependency conflicts; the tradeoff is a very large 57 MB source map.
2. **Externalized native modules**: Sharp and the binaries in `vendor/` cannot be handled cleanly by a JavaScript bundler, so they are shipped either as `optionalDependencies` or as precompiled vendor assets. Each native component provides six platform variants across three OSes and two CPU architectures.
3. **Platform-aware installation**: Packages such as `@img/sharp-*` are declared as `optionalDependencies`, allowing npm to install only the platform-specific variant required by the current machine. For example, macOS ARM64 installs only `sharp-darwin-arm64`.

### 2.2 Original Source Layout (Inferred from the Source Map)

By parsing the `sources` array inside `cli.js.map`, it is possible to reconstruct the full pre-bundled source tree. The application contains 1,902 source files in total: 1,332 `.ts`, 552 `.tsx`, and 18 `.js`.

```
src/
│
├── entrypoints/                    # [8 files] application entrypoints
│   ├── cli.tsx                     # Main CLI entry; parses CLI args and starts the main loop
│   ├── init.ts                     # Initialization flow entry (`claude init`)
│   ├── mcp.ts                      # MCP server-mode entry (`claude mcp serve`)
│   ├── sdk/
│   │   ├── coreTypes.ts            # SDK core type exports
│   │   ├── coreSchemas.ts          # SDK core schema definitions
│   │   └── controlSchemas.ts       # SDK control-layer schemas
│   ├── sandboxTypes.ts             # Sandbox environment type definitions
│   └── agentSdkTypes.ts            # Agent SDK type exports
│
├── main.tsx                        # [about 4,684 lines] primary program file
│                                   # Contains the core conversation loop,
│                                   # message handling, and streaming rendering
│                                   # It is the central orchestration file of the app
│
├── Tool.ts                         # Base tool class; defines registration, validation, and execution interfaces
├── Task.ts                         # Base task class; defines the task lifecycle
├── commands.ts                     # Command dispatcher; routes `/command` input to handlers
├── tools.ts                        # Tool manager; registers and looks up available tools
├── context.ts                      # Context management for conversation and environment state
├── history.ts                      # Conversation-history persistence and loading
├── cost-tracker.ts                 # Token usage and cost accounting
│
├── components/                     # [389 files] React/Ink UI component library
│   # Implements all terminal UI elements
│   # Includes message rendering, permission dialogs, task lists,
│   # progress bars, Markdown rendering, and more
│   # Uses .tsx and a declarative React + Ink UI model
│
├── commands/                       # [207 files] CLI slash commands
│   # User-triggered commands such as /help, /bug, /commit,
│   # /review-pr, /config, and others
│   # Most commands are implemented as separate files
│   # They are registered and dispatched centrally by commands.ts
│
├── tools/                          # [184 files] tool implementations
│   # Each tool corresponds to one capability callable by the AI
│   # Known tools include Agent, Bash, FileEdit, FileRead, FileWrite,
│   # Glob, Grep, TaskOutput, TaskStop, McpInput,
│   # ListMcpResources, ReadMcpResource, NotebookEdit,
│   # TodoWrite, WebFetch, WebSearch, AskUserQuestion,
│   # Config, EnterWorktree, ExitWorktree, ExitPlanMode
│   # The tool list is derived from the type definitions in sdk-tools.d.ts
│
├── services/                       # [130 files] business-service layer
│   ├── api/                        # API client (core files total about 3,420 lines)
│   │                               # Encapsulates communication with the Claude API,
│   │                               # including streaming handling
│   ├── mcp/                        # MCP protocol services
│   │                               # Client and server implementations of MCP
│   ├── compact/                    # Context compaction services
│   │                               # Performs intelligent compression when the
│   │                               # conversation grows beyond the model window
│   └── tools/                      # Tool execution pipeline
│                                   # Middleware chain:
│                                   # validation -> permissions -> execution -> result
│
├── hooks/                          # [104 files] React hooks
│   # Encapsulate side effects and state logic
│   # Includes modules such as costHook.ts and many UI-state hooks
│
├── utils/                          # [571 files] utility library (largest directory)
│   ├── permissions/                # Core permission-engine implementation
│   │                               # Rule parsing, matching algorithms, security policies
│   └── ...                         # General helpers for file operations, strings,
│                                   # platform detection, and more
│
├── bridge/                         # [31 files] Bridge communication layer
│   # Bidirectional communication with the web version of Claude
│   # Includes core files such as bridgeClient.ts
│
├── ink/                            # [96 files] Ink terminal-UI extensions
│   # Customization and extension of the Ink framework
│   # Custom renderer, layout components, theming system
```

```
├── state/                          # [18 files] state management
│   # Definition and management of global application state
│   # Likely implemented with React Context or a custom store container
│
├── skills/                         # [20 files] skills and plugin system
│   # Extensible skill modules such as /commit and /review-pr
│   # Provides a declarative capability-registration model
│
├── platform/                       # [40 files] platform adaptation layer
│   # Handles differences across operating systems and environments
│   # Terminal capability detection, path normalization, native-module loading
│
├── auth/                           # [28 files] authentication
│   # OAuth and API-key authentication flows
│   # Multi-provider support: Anthropic, AWS, Google, and Azure
│
├── trace/                          # [26 files] tracing and telemetry
│   # OpenTelemetry integration
│   # Collection and export of performance metrics
│
├── configuration/                  # [11 files] configuration management
│   # Multi-layer configuration merging
│   # (global -> project -> session)
│   # settings.json parsing
│
├── context/                        # [11 files] advanced context subsystem
│   # Higher-level conversation-context management
│   # Read/write support for Memory files such as `.claude/MEMORY.md`
│
├── tasks/                          # [12 files] task subsystem
│   # Async task management and TodoWrite support
│
├── detectors/                      # [17 files] detectors
│   # Environment detection and project-type identification
│   # Includes modules such as projectOnboardingState.ts
│
├── export/                         # [17 files] export subsystem
│   # Conversation-history export functionality
│
├── aggregator/                     # [14 files] aggregation subsystem
│   # Data aggregation and summarization logic
│
├── keybindings/                    # [14 files] keybinding system
│   # Custom keybinding support
│   # Manages `~/.claude/keybindings.json`
│
├── cli/                            # [19 files] CLI infrastructure
│   # Command-line argument parsing
│   # Subcommand routing
│
├── migrations/                     # [11 files] data migrations
│   # Versioned migration of configuration formats and data structures
│
├── metrics/                        # [9 files] metrics subsystem
│   # Usage statistics and performance metrics
│
├── vim/                            # [5 files] Vim mode
│   # Vim-style keybinding support inside the terminal
│
├── voice/                          # voice-input subsystem
│   # Works with `vendor/audio-capture`
│   # Supports speech-to-text input
│
├── buddy/                          # [6 files] Buddy subsystem
│   # Likely a companion-process or helper-agent mechanism
│
├── coordinator/                    # coordinator
│   # Multi-task and multi-agent coordination
│
├── remote/                         # [4 files] remote features
│   # Remote agent triggering and management
│
├── screens/                        # [3 files] screen/view definitions
│   # Top-level UI screens
│
├── query/                          # [4 files] query engine
│   # QueryEngine.ts and non-interactive query mode
│
├── outputStyles/                   # output styling
│   # Style definitions for different output formats
│
├── assistant/                      # assistant subsystem
│   # Logic related to assistant personas and behavior
│
└── native-ts/                      # [4 files] native TypeScript modules
    # TypeScript interface layer over native bindings
    # Includes imageResize.ts, pixelCompare.ts, deniedApps.ts, and others
```

### 2.3 Source File Size Breakdown

| Directory | File Count | Share | Primary Responsibility |
|------|--------|------|---------|
| `utils/` | 571 | 30.0% | General utilities, permission engine, platform helpers |
| `components/` | 389 | 20.4% | React/Ink UI components |
| `commands/` | 207 | 10.9% | Slash command implementations |
| `tools/` | 184 | 9.7% | AI-callable tools |
| `services/` | 130 | 6.8% | Business services such as API, MCP, and compaction |
| `hooks/` | 104 | 5.5% | React hooks |
| `ink/` | 96 | 5.0% | Ink framework extensions |
| `platform/` | 40 | 2.1% | Platform adaptation |
| `bridge/` | 31 | 1.6% | Web Bridge communication |
| Other | 150 | 7.9% | `auth`, `trace`, `state`, `skills`, and others |
| **Total** | **1902** | **100%** | |


## 3. Dependency Knowledge Graph

### 3.1 Core Dependencies (Bundled into `cli.js`)

Claude Code bundles all runtime dependencies into a single `cli.js`. Source-map analysis identifies roughly 200 npm packages. They can be grouped by functional area as follows.

#### AI / LLM Clients

| Library | File Count | Purpose | Key Usage |
|----|--------|------|-------------|
| `@anthropic-ai/sdk` | 51 | Official Anthropic Claude API client | Powers the core conversation engine: sending messages, receiving streamed responses, and managing conversation context. Supports the Messages API and the tool-calling protocol |
| `@anthropic-ai/bedrock-sdk` | 12 | Access to Claude via AWS Bedrock | Enables enterprise usage of Claude through AWS Bedrock, including AWS authentication and regional routing |
| `@anthropic-ai/vertex-sdk` | 6 | Access to Claude via Google Cloud Vertex AI | Provides Claude model access through Google Cloud |
| `@anthropic-ai/foundry-sdk` | 9 | Access to Claude via Azure Foundry | Provides Claude model access through Azure |
| `@anthropic-ai/sandbox-runtime` | 14 | Sandbox runtime | Supplies the secure execution environment used by the Bash tool |

#### Protocol and Communication

| Library | File Count | Purpose | Key Usage |
|----|--------|------|-------------|
| `@modelcontextprotocol/sdk` | 21 | Official MCP SDK | Implements both MCP client and server support, bridging external tools and resources into Claude's tool system |
| `vscode-jsonrpc` | 16 | JSON-RPC implementation | Underlying transport protocol for the MCP layer, supporting request/response and notification patterns |
| `ws` | 14 | WebSocket client | Used by the Bridge layer to establish real-time bidirectional connections with the web version of Claude |
| `undici` | 96 | HTTP client (Node-native) | High-performance HTTP transport for API calls |
| `axios` | 56 | Additional HTTP client | Likely used for specific third-party API integrations |

#### UI Rendering

| Library | File Count | Purpose | Key Usage |
|----|--------|------|-------------|
| React + Ink | (bundled) | Terminal UI framework | Renders all user-interface elements: messages, permission dialogs, task lists, progress indicators, and more. Ink brings React's declarative component model into the terminal |
| `highlight.js` | 193 | Syntax-highlighting engine | Colors code blocks in the terminal across dozens of programming languages |
| `chalk` | 7 | Terminal color utility | Wraps ANSI color sequences for text styling |
| `@alcalzone/ansi-tokenize` | 7 | ANSI sequence parser | Parses and processes terminal ANSI escape sequences |
| `@inquirer/core` | 20 | Interactive CLI prompts | Used for user input collection, confirmation dialogs, and choice menus |

#### Data Processing and Validation

| Library | File Count | Purpose | Key Usage |
|----|--------|------|-------------|
| `zod` | 77 | TypeScript-first schema validation | Validates tool inputs, API responses, and configuration formats |
| `zod-to-json-schema` | 27 | Zod-to-JSON-Schema conversion | Converts tool schemas defined in Zod into JSON Schema for Claude API consumption |
| `ajv` | 61 | JSON Schema validator | Validates MCP messages and configuration files |
| `ajv-formats` | 3 | AJV format extensions | Adds support for formats such as `email` and `uri` |
| `yaml` | 72 | YAML parser | Parses YAML configuration and front matter |
| `jsonc-parser` | 6 | JSON-with-comments parser | Parses files such as `settings.json` that allow comments |

#### Cloud Authentication (AWS / Azure / Google)

| Library | File Count | Purpose | Key Usage |
|----|--------|------|-------------|
| `@aws-sdk/credential-providers` | 17 | AWS credential providers | Retrieves AWS IAM credentials when running in Bedrock mode |
| `@aws-sdk/client-bedrock` | 6 | AWS Bedrock client | Makes Bedrock API calls |
| `@aws-sdk/client-bedrock-runtime` | 6 | Bedrock runtime client | Sends model inference requests |
| `@aws-sdk/client-sts` | 10 | AWS STS client | Retrieves temporary credentials through `AssumeRole` |
| `@aws-sdk/client-cognito-identity` | 6 | Cognito identity client | Supports federated identity authentication |
| `@aws-sdk/client-sso` | 6 | AWS SSO client | Handles SSO login flows |
| `@aws-crypto/*` | 23 | AWS cryptography utilities | Provides SHA-256, CRC32, and related cryptographic helpers |
| `@smithy/*` | ~150 | AWS SDK infrastructure | The low-level AWS SDK v3 toolkit for HTTP transport, serialization, middleware, and more |
| `@azure/identity` | 41 | Azure identity library | Handles Azure AD authentication in Foundry mode |
| `@azure/msal-node` | 48 | Microsoft authentication library | Implements OAuth 2.0 / OIDC flows |
| `@azure/msal-common` | 60 | Shared MSAL logic | Common logic shared by Microsoft authentication flows |
| `@azure/core-rest-pipeline` | 29 | Azure REST pipeline | HTTP request pipeline and middleware |
| `@azure/core-client` | 15 | Azure client foundation | REST API client wrappers |

#### Text and File Processing

| Library | File Count | Purpose | Key Usage |
|----|--------|------|-------------|
| `lodash-es` | 226 | Utility library | The largest dependency by file count, heavily used for collection operations, object processing, and string helpers |
| `diff` | 7 | Text diffing | Generates and displays diffs for the FileEdit tool |
| `shell-quote` | 3 | Shell command parsing | Safely parses and escapes shell command strings |
| `parse5` | 26 | HTML parser | Used by WebFetch to parse web-page content |
| `@mixmark-io/domino` | 53 | Server-side DOM implementation | Enables DOM operations alongside HTML parsing |
| `xss` | 5 | XSS filtering | Sanitizes untrusted HTML |
| `cssfilter` | 5 | CSS filtering | Sanitizes untrusted CSS |
| `fs-extra` | 56 | Enhanced filesystem utilities | Supports advanced file operations such as recursive copy, move, and directory creation |
| `graceful-fs` | 4 | Filesystem fault tolerance | Handles issues such as `EMFILE` when file descriptors are exhausted |
| `proper-lockfile` | 4 | File locking | Prevents concurrent processes from modifying configuration files at the same time |

#### Security and Cryptography

| Library | File Count | Purpose | Key Usage |
|----|--------|------|-------------|
| `node-forge` | 42 | Cryptography toolkit | Handles TLS certificates and other cryptographic operations |
| `jsonwebtoken` | 12 | JWT support | Used for JWT signing and verification in OAuth flows |
| `jws` | 5 | JSON Web Signature | Low-level JWT signing implementation |

#### Observability (OpenTelemetry)

| Library | File Count | Purpose | Key Usage |
|----|--------|------|-------------|
| `@opentelemetry/*` | ~80 | Distributed tracing framework | Provides performance tracing, metrics collection, and log correlation across a full stack including TracerProvider, MeterProvider, and LoggerProvider |
| `@grpc/grpc-js` | ~50 | gRPC client | Sends OpenTelemetry data to OTLP collectors over gRPC |
| `protobufjs` | ~20 | Protocol Buffers | Serializes and deserializes gRPC messages |

#### Other Utilities

| Library | File Count | Purpose | Key Usage |
|----|--------|------|-------------|
| `semver` | 110 | Semantic-version parsing | Version comparison, compatibility checks, and upgrade prompts |
| `commander` | 7 | CLI framework | Defines and parses command-line arguments |
| `uuid` | 32 | UUID generation | Produces unique IDs for sessions, requests, and agents |
| `qrcode` | 34 | QR-code generation | Displays terminal login QR codes during OAuth flows |
| `picomatch` | 6 | Glob matching | Underlies file-path pattern matching for the Glob tool |
| `execa` | 9 | Process execution | Child-process management beneath the Bash tool |
| `cross-spawn` | 6 | Cross-platform process creation | Normalizes process spawning across Windows, macOS, and Linux |
| `signal-exit` | 4 | Exit signal handling | Ensures cleanup runs on process exit |
| `detect-libc` | 4 | C-library detection | Detects glibc vs musl for correct native-binding loading |
| `flora-colossus` | 4 | Dependency-tree analysis | Analyzes Node.js module dependency graphs |
| `@growthbook/growthbook` | 6 | Feature flags and A/B testing | Supports gradual rollout and experiment control |
| `plist` | 3 | Apple plist parsing | Reads macOS-specific configuration data |
| `json-bigint` | 3 | Big-integer JSON support | Handles JSON numbers beyond JavaScript's safe integer range |

### 3.2 Native / Vendor Dependencies

These dependencies are not bundled through npm. They are distributed as precompiled binaries instead:

| Component | Location | Purpose | Technical Detail |
|------|------|------|---------|
| ripgrep | `vendor/ripgrep/` | Extremely fast regular-expression search engine | Written in Rust and significantly faster than `grep`. It acts as the underlying implementation of the Grep tool and delivers millisecond-level searches in large repositories. Ships with 6 platform-specific binaries |
| Sharp | `node_modules/@img/sharp-*` | High-performance image processing | Built on the libvips C library. Used by FileRead when processing images for scaling, format conversion, and metadata extraction. Supports JPEG, PNG, WebP, AVIF, and other formats |
| audio-capture | `vendor/audio-capture/` | System audio capture | Native bindings over platform audio APIs. Provides microphone stream capture for voice-input mode. Ships with 6 platform-specific binaries |

### 3.3 Dependency Footprint Overview

| Category | Approx. Package Count | Notes |
|------|------------|------|
| AI / LLM clients | 5 | Anthropic SDK family |
| AWS SDK and infrastructure | ~50 | Supports Bedrock deployment mode |
| Azure SDK | ~10 | Supports Foundry deployment mode |
| OpenTelemetry | ~15 | Full observability stack |
| gRPC / Protobuf | ~10 | OTLP transport layer |
| UI rendering | ~10 | React, Ink, syntax highlighting, colors |
| Data validation | ~5 | Zod, AJV |
| Text / file processing | ~15 | lodash, diff, parse5, fs-extra, and others |
| Security / cryptography | ~5 | node-forge, JWT |
| General utilities | ~30 | semver, uuid, commander, and others |
| Native / vendor | 3 | ripgrep, Sharp, audio-capture |
| **Total** | **~200** | All bundled into a 13 MB `cli.js` |


## 4. SDK Tool Type System

`sdk-tools.d.ts` (2,719 lines) defines the complete set of tool types exposed publicly by Claude Code. Because it is auto-generated, it is also the most authoritative source for understanding the tool system as a public API.

### 4.1 Tool Type Union

```typescript
export type ToolInputSchemas =
  | AgentInput          // Create a sub-agent to run a subtask
  | BashInput           // Execute a shell command
  | TaskOutputInput     // Retrieve async task output
  | ExitPlanModeInput   // Exit plan mode
  | FileEditInput       // Edit file content precisely
  | FileReadInput       // Read files or images
  | FileWriteInput      // Write a complete file
  | GlobInput           // Search by file-pattern matching
  | GrepInput           // Search content with regular expressions
  | TaskStopInput       // Stop an async task
  | ListMcpResourcesInput  // List MCP resources
  | McpInput            // Invoke an MCP tool
  | NotebookEditInput   // Edit a Jupyter Notebook
  | ReadMcpResourceInput   // Read an MCP resource
  | TodoWriteInput      // Write todo items
  | WebFetchInput       // Fetch webpage content
  | WebSearchInput      // Search the web
  | AskUserQuestionInput   // Ask the user a question
  | ConfigInput         // Read or write configuration
  | EnterWorktreeInput  // Enter a Git worktree
  | ExitWorktreeInput;  // Exit a Git worktree
```

### 4.2 Functional Tool Categories

| Category | Tools | Description |
|------|------|------|
| **Code search** | Glob, Grep | Filename matching plus regex content search |
| **File operations** | FileRead, FileEdit, FileWrite, NotebookEdit | Read, precise edit, full rewrite, and Notebook editing |
| **Command execution** | Bash | Shell command execution inside a sandbox |
| **Subtasks** | Agent, TaskOutput, TaskStop | Create sub-agents, retrieve async results, and stop tasks |
| **Web interaction** | WebFetch, WebSearch | Fetch web content and search the web |
| **MCP extensions** | McpInput, ListMcpResources, ReadMcpResource | MCP tool invocation and resource access |
| **User interaction** | AskUserQuestion | Actively prompt the user when input is required |
| **Workspace management** | EnterWorktree, ExitWorktree | Switch Git worktrees |
| **Flow control** | ExitPlanMode, Config, TodoWrite | Exit plan mode, manage configuration, and manage todos |


## 5. Build and Distribution Strategy

### 5.1 Single-file Bundle

Claude Code uses an aggressive single-file bundling strategy. Instead of webpack or esbuild, it relies on Bun to compile 1,902 application source files and about 200 npm dependencies into one `cli.js`.

**Bundle characteristics:**

- **Output format**: ES Module, matching `"type": "module"` in `package.json`
- **File size**: about 13 MB (`13,047,043` bytes)
- **Line count**: 16,667 highly compressed / merged lines
- **Source map**: a standalone `cli.js.map` of about 57 MB, mapping back to 4,756 source files
- **Tree shaking**: Bun removes unused code paths during bundling

**Why Bun is likely the bundler of choice:**

1. Bun bundles much faster than webpack, which is valuable for frequent release cycles.
2. Bun provides native support for TypeScript and JSX/TSX, avoiding extra Babel configuration.
3. Bun generates high-quality ES Module output.
4. Anthropic likely also uses Bun as part of its development runtime.

### 5.2 Publish Guardrails

`package.json` includes a publication guard:

```json
"scripts": {
  "prepare": "node -e \"if (!process.env.AUTHORIZED) { ... process.exit(1); }\""
}
```

This ensures that new versions can only be published through the official CI/CD path with the `AUTHORIZED` environment variable set, preventing accidental manual releases.

### 5.3 Version Semantics

Version `2.1.88` follows semantic versioning:

- **2** (`major`): second major generation, potentially including changes incompatible with 1.x
- **1** (`minor`): incremental feature release
- **88** (`patch`): a high patch count that reflects a fast iteration cadence


## 6. Runtime Environment

### 6.1 Node.js Requirement

`"engines": { "node": ">=18.0.0" }` requires Node.js 18 or higher. That choice is grounded in the following:

- **Native ES Module support**: Node.js 18 fully supports ESM, aligning with `"type": "module"`.
- **Fetch API**: Node.js 18 adds a global `fetch()`, reducing reliance on external HTTP libraries.
- **Web Streams API**: Streamed API response handling depends on `ReadableStream` support in Node.js 18.
- **LTS stability**: Node.js 18 is an LTS release widely deployed in enterprise environments.

### 6.2 Platform Support Matrix

Based on the platform variants visible in `vendor/` and the Sharp dependencies:

| OS | Architecture | ripgrep | audio-capture | Sharp |
|---------|------|---------|---------------|-------|
| macOS | ARM64 (Apple Silicon) | ✅ | ✅ | ✅ |
| macOS | x86_64 (Intel) | ✅ | ✅ | ✅ |
| Linux | ARM64 | ✅ | ✅ | ✅ |
| Linux | x86_64 | ✅ | ✅ | ✅ |
| Linux (musl) | ARM64 | - | - | ✅ |
| Linux (musl) | x86_64 | - | - | ✅ |
| Windows | ARM64 | ✅ | ✅ | ✅ |
| Windows | x86_64 | ✅ | ✅ | ✅ |

### 6.3 Filesystem Layout at Runtime

Claude Code creates and uses the following user-data directories at runtime:

```
~/.claude/                    # Global configuration directory
├── settings.json             # Global settings (permission rules, feature flags)
├── keybindings.json          # Custom keybindings
├── MEMORY.md                 # Global Memory file (cross-project persistent knowledge)
├── projects/                 # Project-scoped data
│   └── <project-hash>/
│       ├── MEMORY.md         # Project-level Memory file
│       └── sessions/         # Conversation history
└── credentials/              # Authentication credentials

<project>/.claude/            # Project-level configuration
├── settings.json             # Project-level settings
└── MEMORY.md                 # Project-level Memory (alternate path convention)
```


## 7. Quick Start

### 7.1 Installation

```bash
# Global install (recommended)
npm install -g @anthropic-ai/claude-code

# Verify installation
claude --version
```

### 7.2 First Use

```bash
# Enter your project directory
cd /path/to/your/project

# Launch Claude Code
claude

# The first launch guides you through authentication
# Supported methods include Anthropic API Key, OAuth,
# AWS Bedrock, and Google Vertex AI
```

### 7.3 Common Commands

```bash
# Interactive mode (default)
claude

# Ask a direct question (non-interactive mode)
claude "Explain this project's architecture"

# Pipe input into Claude Code
cat error.log | claude "Analyze this error log"

# Resume the previous conversation
claude --continue

# Start in MCP server mode
claude mcp serve
```

### 7.4 Slash Commands in Interactive Mode

| Command | Description |
|------|------|
| `/help` | Show help information |
| `/bug` | Report a bug |
| `/commit` | Create a Git commit |
| `/review-pr` | Review a Pull Request |
| `/config` | Manage configuration |
| `/clear` | Clear conversation history |

### 7.5 Using It as an SDK

Claude Code can also be used as a Node.js SDK:

```typescript
import { claude } from "@anthropic-ai/claude-code";

// sdk-tools.d.ts provides complete TypeScript type support,
// including input and output type definitions for every tool.
```


## 8. Chapter Summary

Claude Code is a large TypeScript system with a carefully engineered architecture. Its most important technical characteristics can be summarized as follows:

1. **Extreme distribution optimization**: 1,902 source files and about 200 dependencies are bundled into a single 13 MB file for zero-dependency installation.
2. **React in the terminal**: It boldly brings the React component model into terminal UI through Ink, rendering 389 UI components.
3. **Multi-cloud architecture**: It natively supports four deployment paths: direct Anthropic access, AWS Bedrock, Google Vertex AI, and Azure Foundry.
4. **Protocol-driven extensibility**: It exposes open-ended extensions for tools and resources through MCP.
5. **Deep observability**: It integrates a full OpenTelemetry stack for traces, metrics, and logs, exported through gRPC/OTLP.
6. **Cross-platform native capabilities**: The `vendor/` directory ships precompiled `ripgrep` and `audio-capture` binaries for six platform variants.
7. **Defense in depth**: It combines a permission engine, sandbox runtime, file locking, XSS filtering, and secret detection into a layered security model.
8. **Experimental feature framework**: It integrates GrowthBook for feature flags and A/B testing, enabling gradual rollout.

The following chapters will examine the implementation details behind each of these traits.
