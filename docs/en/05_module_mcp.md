<p align="right"><a href="../cn/05_module_mcp.md">中文</a></p>

# Phase 5-E: Deep Dive into MCP Protocol Integration

> This chapter reverse-engineers the full MCP (Model Context Protocol) integration architecture in Claude Code. MCP is Anthropic's open standard for exposing external tools and resources to LLMs through a unified protocol. In Claude Code, the MCP subsystem spans more than 30 source files and covers server discovery, connection management, transport abstraction, tool registration, the resource system, security controls, and the surrounding plugin ecosystem. All conclusions here are grounded in reverse analysis of `cli.js` (16,667 lines), with public types in `sdk-tools.d.ts` used for cross-checking.


## Contents

1. Interface Contracts
   - 1.1 MCP Protocol Overview
   - 1.2 Core Interface Inventory
   - 1.3 MCP Tool Naming Conventions
   - 1.4 The Three Built-in MCP Tools
   - 1.5 MCP Client State Model
2. Implementation Mechanisms
   - 2.1 MCP Server Discovery
   - 2.2 Connection Management and the `MCPConnectionManager` Lifecycle
   - 2.3 Transport Abstraction
   - 2.4 Tool Registration: Mapping MCP Tools into Claude Code Tools
   - 2.5 Resource System: Listing and Reading Resources
   - 2.6 Security Model
   - 2.7 Official Registry and Plugin Ecosystem
   - 2.8 Environment-Variable Expansion
   - 2.9 MCPB (MCP Bundle) Format
   - 2.10 Channel System
3. Evolution Thought Experiment
4. Verification Strategy


## 1. Interface Contracts

### 1.1 MCP Protocol Overview

MCP, or Model Context Protocol, is an open standard led by Anthropic. Its goal is to create a standard communication interface between LLMs and external services. In Claude Code, MCP functions as an **extension bus**: third-party tools, external resources, and custom services all enter the system through MCP.

MCP revolves around three core primitives:

| Primitive | Direction | Description |
|------|------|------|
| **Tools** | Server exposes to client | Callable functions with JSON Schema input definitions |
| **Resources** | Server exposes to client | Readable data sources such as files or database rows |
| **Prompts** | Server exposes to client | Predefined prompt templates. Claude Code primarily consumes Tools and Resources today |

Claude Code embeds an MCP client inside the CLI process. During session initialization it discovers configured MCP servers, connects to them, and maps remote capabilities into locally callable Claude Code tools.

### 1.2 Core Interface Inventory

The following MCP-related interfaces can be recovered from `cli.js`:

| Interface / Class | Role | Responsibility |
|-----------|------|---------|
| `MCPConnectionManager` | Connection manager | Owns the lifecycle of all MCP servers, including connect, disconnect, and reconnect |
| `MCP Client` | Protocol client | Standard MCP client built on `@modelcontextprotocol/sdk` |
| `ListMcpResourcesTool` | Built-in tool | Lists resources exposed by connected MCP servers |
| `ReadMcpResourceTool` | Built-in tool | Reads a resource from a given MCP server by URI |
| MCP proxy tools | Dynamic tools | Each remote MCP tool is registered locally as `mcp__<serverName>__<toolName>` |
| `SSETransport` (`bJ6`) | Transport | SSE plus HTTP POST transport for remote servers |
| `StdioClientTransport` | Transport | Local transport over stdin/stdout to a subprocess |
| `StreamableHTTPClientTransport` | Transport | Newer streaming HTTP transport |
| `fX7` (`SdkControlTransport`) | Transport | SDK-internal bridge transport |

### 1.3 MCP Tool Naming Conventions

Claude Code uses a strict double-underscore naming convention for MCP tools:

```text
mcp__<serverName>__<toolName>
```

Examples:

- `mcp__claude-in-chrome__tabs_context_mcp`
- `mcp__playwright__screenshot`
- `mcp__weather__get_forecast`

The helper `nT()` parses the full name back into `serverName` and `toolName`:

```javascript
function nT(toolName) {
  if (!toolName.startsWith("mcp__")) return null;
  const parts = toolName.split("__");
  if (parts.length < 3) return null;
  return {
    serverName: parts[1],
    toolName: parts.slice(2).join("__")
  };
}
```

This naming convention is not cosmetic. It enables permission rules such as `mcp__weather__*` to cover every tool exposed by a single server.

### 1.4 The Three Built-in MCP Tools

#### 1.4.1 MCP proxy tools

Every tool exposed by an MCP server is dynamically registered as its own Claude Code tool. These generated tools:

- default to `shouldDefer: true`
- take their input and output schemas directly from the server's `tools/list` response
- forward execution through the server's `tools/call` endpoint

#### 1.4.2 ListMcpResourcesTool

The runtime defines the tool-name constant as:

```javascript
var no6 = "ListMcpResourcesTool";
```

Key characteristics:

- `name`: `ListMcpResourcesTool`
- `isConcurrencySafe`: `true`
- `isReadOnly`: `true`
- `shouldDefer`: `true`
- optional `server` field in the input schema
- iterates over all connected MCP clients that declare `resources` capability

#### 1.4.3 ReadMcpResourceTool

The input and output shape is roughly:

```javascript
L.object({
  server: L.string().describe("The MCP server name"),
  uri: L.string().describe("The resource URI to read")
})
```

```javascript
L.object({
  contents: L.array(L.object({
    uri: L.string(),
    mimeType: L.string().optional(),
    text: L.string().optional(),
    blobSavedTo: L.string().optional()
  }))
})
```

Implementation details:

- `server` and `uri` are both required
- the target server must exist, be connected, and declare `resources`
- the tool sends a standard MCP `resources/read` request
- binary blobs are saved to temporary files through `ZN6()`
- `maxResultSizeChars` is capped at 100,000

Representative blob handling:

```javascript
if ("blob" in content) {
  let filename = `mcp-resource-${Date.now()}-${index}-${randomId}`;
  let result = await ZN6(
    Buffer.from(content.blob, "base64"),
    content.mimeType,
    filename
  );
  return {
    uri: content.uri,
    mimeType: content.mimeType,
    blobSavedTo: result.filepath,
    text: DE8(result.filepath, content.mimeType, result.size,
      `[Resource from ${serverName} at ${content.uri}] `)
  };
}
```

### 1.5 MCP Client State Model

Each entry in `mcpClients` maintains a state object with fields along these lines:

```text
name: string
type: "connected" | "connecting" | "error" | "not_connected"
capabilities?: {
  tools?: boolean
  resources?: boolean
  prompts?: boolean
}
tools?: ToolDef[]
error?: string
```

Before any MCP tool runs, Claude Code verifies:

1. the server exists in `mcpClients`
2. its `type` is `"connected"`
3. it declares the required capability, such as `tools` or `resources`


## 2. Implementation Mechanisms

### 2.1 MCP Server Discovery

Claude Code discovers MCP server configuration from several layers. The observed priority stack is:

1. CLI flags or SDK options (`flagSettings`)
2. project-level `.mcp.json`
3. user-level `~/.claude/settings.json`
4. project-local `.claude/settings.local.json`
5. enterprise policy settings
6. plugin-provided built-in MCP servers

#### 2.1.1 Configuration layers

The important design point is that MCP discovery is **multi-source**. Some layers are team-shared, such as `.mcp.json`; others are local or enterprise-controlled.

#### 2.1.2 `.mcp.json` format

Project-level MCP servers are declared in `.mcp.json` at repo root:

```json
{
  "mcpServers": {
    "weather": {
      "command": "npx",
      "args": ["-y", "@weather/mcp-server"],
      "env": {
        "API_KEY": "${WEATHER_API_KEY}"
      }
    },
    "database": {
      "command": "node",
      "args": ["./mcp-servers/database.js"],
      "cwd": "/opt/app"
    },
    "remote-api": {
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}"
      }
    }
  }
}
```

The loader `SH("project")` reads this file and merges it with configuration from other layers.

#### 2.1.3 User-level configuration

User-global MCP servers live under `~/.claude/settings.json` in the `mcpServers` field, and they can also be managed interactively through the `/mcp` command.

#### 2.1.4 Merge strategy

Server definitions from project config, user config, local config, CLI flags, plugins, and enterprise settings are merged and deduplicated. If two servers resolve to the same `command` or `url`, the later one is suppressed with an error like:

```javascript
case "mcp-server-suppressed-duplicate": {
  let K = q.duplicateOf.startsWith("plugin:")
    ? `server provided by plugin "${q.duplicateOf.split(":")[1] ?? "?"}"`
    : `already-configured "${q.duplicateOf}"`;
  return `MCP server "${q.serverName}" skipped — same command/URL as ${K}`;
}
```

### 2.2 Connection Management and the `MCPConnectionManager` Lifecycle

`MCPConnectionManager` owns the full lifecycle:

1. read server configs from every layer
2. merge and deduplicate
3. expand environment variables
4. construct a transport instance for each server
5. connect to all servers concurrently
6. initialize capabilities, tools, and resources
7. route tool calls during the session
8. disconnect and clean up on shutdown

Multiple servers are connected in parallel. A failure in one connection does not block the others.

### 2.3 Transport Abstraction

Claude Code implements the major MCP transport styles.

#### 2.3.1 Stdio transport

This is the most common local transport. Claude Code launches a subprocess and communicates with it over stdin/stdout using JSON-RPC.

Example config:

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem"],
  "env": { "HOME": "/Users/user" },
  "cwd": "/workspace"
}
```

Key properties:

- subprocess lifecycle is tied to the MCP client
- stderr is captured for debugging
- `env` and `cwd` are passed through
- abnormal subprocess exit can trigger reconnection

#### 2.3.2 SSE transport (`bJ6`)

Used for remote servers. The server streams events to the client via SSE, while the client sends requests back with HTTP POST.

Observed internal state:

```javascript
class bJ6 {
  url;
  state = "idle";
  sessionId;
  lastSequenceNum = 0;
  reconnectAttempts = 0;
  reconnectTimer = null;
  livenessTimer = null;
  postUrl;
}
```

Key features:

- resume support via `lastSequenceNum` and `Last-Event-ID`
- automatic reconnect with exponential backoff
- distinction between permanent and retriable HTTP failures
- support for `refreshHeaders` and `getAuthHeaders` so auth tokens can rotate

#### 2.3.3 Streamable HTTP transport

The newer HTTP path uses a single streaming endpoint rather than the SSE-plus-POST split. It is selected when configuration uses a plain `http://` or `https://` `url`.

#### 2.3.4 `SdkControlTransport` (`fX7`)

This transport is used when Claude Code runs as the backend for the Agent SDK. It bridges through the SDK control channel instead of using an external subprocess or network service.

Observed behaviors:

- socket security validation through `validateSocketSecurity`
- 5000 ms connection timeout
- automatic reconnect, up to 10 attempts with exponential backoff
- request/response matching plus notification handling

#### 2.3.5 Transport-selection logic

Transport choice is driven by configuration shape:

- `command` present → `StdioClientTransport`
- `url` present with SSE semantics → `SSETransport`
- `url` present with HTTP streaming semantics → `StreamableHTTPTransport`
- internal SDK invocation → `SdkControlTransport`

### 2.4 Tool Registration: Mapping MCP Tools into Claude Code Tools

#### 2.4.1 Registration flow

Once a server connects, Claude Code calls `tools/list`, receives the remote tool definitions, and maps each of them into a Claude Code tool named `mcp__<server>__<tool>`.

```text
MCP server → tools/list → remote tool definitions
          → Claude Code mapping → deferred local proxy tools
          → call() forwards to MCP tools/call
```

#### 2.4.2 Deferred loading

MCP tools default to `shouldDefer: true` for three reasons:

1. **token economy**: a single server may expose dozens of tools
2. **semantic discovery**: ToolSearch finds the relevant tool when needed
3. **slow connection tolerance**: deferred loading avoids blocking session startup

Representative flow:

```text
Model decides it needs weather data
→ ToolSearch("weather forecast")
→ match mcp__weather__get_forecast
→ load schema
→ call tool
```

#### 2.4.3 Permission integration

MCP tools integrate into the standard permission system.

```javascript
var N$Y = new Set([
  no6,
  "ReadMcpResourceTool",
]);
```

Supported permission patterns include:

| Rule Pattern | Meaning |
|---------|------|
| `mcp__weather__get_forecast` | Exact single-tool match |
| `mcp__weather__*` | Every tool on the `weather` server |
| `mcp__*` | Every MCP tool |

Telemetry also normalizes all concrete MCP tool names into `"mcp"`:

```javascript
if (typeof A.toolName === "string" && A.toolName.startsWith("mcp__"))
  A.toolName = "mcp";
```

### 2.5 Resource System: Listing and Reading Resources

MCP Resources provide a standard path for loading structured external data.

#### 2.5.1 Resource discovery

`ListMcpResourcesTool`:

1. iterates through all `mcpClients`
2. filters for `type === "connected"` and `capabilities?.resources`
3. calls `resources/list` on each eligible server
4. merges the results and adds a `server` field to each resource

#### 2.5.2 Resource reads

`ReadMcpResourceTool({ server, uri })`:

1. locates the target client
2. verifies existence, connection state, and `resources` support
3. calls `resources/read`
4. returns either text content directly or saves blob content to a temporary file

#### 2.5.3 `mcpContextUris`

The project-default config object `hc6` includes `mcpContextUris`, which lets a project declare resource URIs that should be auto-read at session startup and injected into Claude's context.

```javascript
var hc6 = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
};

### 2.6 Security Model

#### 2.6.1 Permission layers

MCP tools follow Claude Code's unified security model, which can be summarized in four layers:

1. **Server admission**
   - enterprise policy can restrict allowed servers
   - `.mcp.json` requires trust confirmation via `hasTrustDialogAccepted`
   - `enabledMcpjsonServers` and `disabledMcpjsonServers` allow selective inclusion
2. **Tool-level permissions**
   - `alwaysAllowRules`, `alwaysDenyRules`, and `alwaysAskRules` support MCP patterns such as `mcp__<server>__*`
3. **Hook-based audit**
   - `PermissionRequest` hooks can intercept MCP tool usage
   - permissions can be updated dynamically
4. **Transport security**
   - subprocess isolation for stdio
   - TLS for SSE and HTTP
   - OAuth for remote servers
   - header injection for tokens such as Bearer auth

#### 2.6.2 OAuth flow

Remote MCP servers can require OAuth 2.0. Claude Code retrieves and refreshes credentials dynamically through `getAuthHeaders` and related callbacks.

Typical flow:

```text
Initial connection
→ server returns 401 / 403
→ OAuth flow begins
→ discover OAuth metadata
→ build authorization URL
→ open browser
→ receive callback code
→ exchange for access token
→ store refresh token
→ reconnect
→ later refresh automatically when expired
```

Representative SSE header handling:

```javascript
let authHeaders = this.getAuthHeaders();
let headers = {
  ...this.headers,
  ...authHeaders,
  "Accept": "text/event-stream",
  "anthropic-version": "2023-06-01",
  "User-Agent": userAgent()
};
if (authHeaders.Cookie) delete headers.Authorization;
```

If cookie-based auth is present, Claude Code removes the `Authorization` header to avoid conflicts.

#### 2.6.3 `.mcp.json` trust model

Project-level `.mcp.json` files are treated as potentially sensitive because they can introduce new external servers.

The flow is:

```text
Discover .mcp.json
→ check hasTrustDialogAccepted
→ accepted: load config
→ not yet accepted: show trust dialog
→ accepted by user: persist trust and load
→ rejected by user: skip those servers
→ enabledMcpjsonServers / disabledMcpjsonServers can selectively override
```

### 2.7 Official Registry and Plugin Ecosystem

#### 2.7.1 Official plugin registry

Claude Code maintains an official plugin registry, `claude-plugins-official`, hosted on GitHub in `anthropics/claude-plugins-official`. Plugins can provide MCP servers as part of their capability bundle.

Representative built-in plugin shape:

```javascript
{
  name: string,
  description: string,
  version: string,
  defaultEnabled: boolean,
  mcpServers: Object,
  skills: Array,
  hooks: Object,
  isAvailable: Function,
}
```

#### 2.7.2 Plugins and MCP servers

Plugins can declare `mcpServers`, and when the plugin is enabled those servers are automatically registered with `MCPConnectionManager`.

The built-in `claude-in-chrome` plugin is the clearest example. It exposes MCP tools such as:

- `mcp__claude-in-chrome__tabs_context_mcp`
- `mcp__claude-in-chrome__screenshot`
- `mcp__claude-in-chrome__javascript_tool`
- `mcp__claude-in-chrome__read_console_messages`
- `mcp__claude-in-chrome__gif_creator`

#### 2.7.3 Marketplace and dependency management

Plugin IDs may include a marketplace suffix in the form `<name>@<marketplace>`:

```javascript
function Z4(pluginId) {
  if (pluginId.includes("@")) {
    let parts = pluginId.split("@");
    return { name: parts[0], marketplace: parts[1] };
  }
  return { name: pluginId };
}
```

Dependencies are resolved through `DK4`, which handles:

- transitive dependency closure
- cycle detection
- cross-marketplace validation
- demotion when dependencies are missing

#### 2.7.4 Competitor-tool detection

Claude Code includes a detection map for known search and AI-coding tools and can surface integration guidance if they appear as MCP servers:

```javascript
var UB1 = {
  src: "sourcegraph", cody: "cody", aider: "aider",
  tabby: "tabby", tabnine: "tabnine", augment: "augment",
  pieces: "pieces", qodo: "qodo", aide: "aide",
  hound: "hound", seagoat: "seagoat", bloop: "bloop",
  gitloop: "gitloop", q: "amazon-q", gemini: "gemini"
};
```

### 2.8 Environment-Variable Expansion

MCP server configs support `${VARIABLE_NAME}` substitution, which is essential when sharing `.mcp.json` across environments.

#### 2.8.1 Expansion syntax

```json
{
  "mcpServers": {
    "my-server": {
      "command": "my-mcp-server",
      "env": {
        "API_KEY": "${MY_API_KEY}",
        "DB_URL": "${DATABASE_URL}",
        "HOME_DIR": "${HOME}"
      }
    }
  }
}
```

Expansion rules:

- `${VAR}` resolves to the runtime value of `VAR`
- undefined variables remain unchanged
- expansion runs in `env` and certain config fields
- array items in `args` can also be expanded

#### 2.8.2 Security considerations

Expansion happens when configuration is loaded, not when it is written. That means:

- `.mcp.json` can safely contain placeholders such as `${SECRET}` and still be committed
- actual secret values are only read from the environment at runtime
- different developers can use the same committed config with different local secrets

### 2.9 MCPB (MCP Bundle) Format

MCPB is a bundle format supported by Claude Code for distributing plugins that contain MCP servers.

#### 2.9.1 MCPB lifecycle

```text
Download MCPB
→ extract and validate
→ possible failures:
  - mcpb-download-failed
  - mcpb-extract-failed
  - mcpb-invalid-manifest
→ read manifest
→ register MCP servers
→ continue with normal MCP connection flow
```

#### 2.9.2 Error handling

The formatter `$M` contains dedicated MCPB error cases:

```javascript
case "mcpb-download-failed":
  return `Failed to download MCPB from ${q.url}: ${q.reason}`;
case "mcpb-extract-failed":
  return `Failed to extract MCPB ${q.mcpbPath}: ${q.reason}`;
case "mcpb-invalid-manifest":
  return `MCPB manifest invalid at ${q.mcpbPath}: ${q.validationError}`;
```

### 2.10 Channel System

Channels are an MCP extension that allow deeper integration than plain tool calls, including permission requests and bidirectional notifications.

#### 2.10.1 Channel capability declaration

Servers opt in through `experimental["claude/channel"]`:

```javascript
function R78(serverName, capabilities, installedFrom) {
  if (!capabilities?.experimental?.["claude/channel"])
    return { action: "skip", kind: "capability",
      reason: "server did not declare claude/channel capability" };
}
```

#### 2.10.2 Admission control

Channel registration is gated by multiple checks:

1. server declares `claude/channel`
2. feature availability check via `QH6()`
3. authentication check, including claude.ai login when required
4. organization policy check, such as `channelsEnabled`
5. session allowlist checks like `--channels`
6. plugin-source validation
   - inline marketplace matching
   - development mode through `--dangerously-load-development-channels`
   - official allowlist via `allowedChannelPlugins`

#### 2.10.3 Permission notifications

Channel-based permission negotiation uses dedicated notification methods:

```javascript
var L47 = "notifications/claude/channel/permission";
var QNK = "notifications/claude/channel/permission_request";
```


## 3. Evolution Thought Experiment

How would Claude Code's external-tool integration architecture evolve if it were designed from scratch?

### Level 1: Hard-coded tools

The naive starting point is to embed every external service directly inside the CLI:

```javascript
class WeatherTool {
  name = "weather";
  async call(input) {
    return fetch(`https://api.weather.com/forecast?q=${input.city}`);
  }
}

class DatabaseTool {
  name = "database";
  async call(input) {
    return db.query(input.sql);
  }
}

const tools = [new WeatherTool(), new DatabaseTool()];
```

Problems:

- every new tool requires a CLI release
- users cannot add their own tools
- the CLI and tool implementations are tightly coupled
- portability across working environments is poor

### Level 2: Custom plugin layer

The next step is to let users declare tools in configuration:

```javascript
{
  "customTools": [{
    "name": "my-api",
    "endpoint": "http://localhost:3000/tool",
    "schema": {}
  }]
}
```

This is better, but still flawed:

- the protocol is ad hoc
- capability discovery is manual
- each AI product invents its own integration interface
- tool providers must build one adapter per AI platform

### Level 3: Standardized MCP

Claude Code's actual design lands here:

```text
Open MCP standard
→ Tools / Resources / Prompts
→ multiple transports: stdio / SSE / StreamableHTTP
→ standard capability negotiation through initialize
→ unified config via .mcp.json
→ registry and marketplace ecosystem
```

What Level 3 solves:

| Dimension | Level 1 | Level 2 | Level 3 |
|------|---------|---------|---------|
| Adding a new tool | modify CLI code | config plus a custom adapter | write a standard MCP server |
| Cross-platform compatibility | none | weak | any MCP client can consume it |
| Capability discovery | hard-coded | manual schema config | automatic `tools/list` |
| Transport flexibility | fixed | usually HTTP only | stdio, SSE, HTTP |
| Security model | minimal | basic auth | OAuth plus layered permissions |
| Resource access | none | none | built-in `resources` primitive |
| Ecosystem | none | fragmented | official registry plus marketplace |

### Design insights

The MCP integration follows several clear engineering principles:

1. **Protocol first**: define the contract before defining any single tool implementation.
2. **Transport agnostic**: stdio, SSE, and HTTP are transport variants under the same protocol.
3. **Progressive discovery**: `shouldDefer: true` plus ToolSearch avoids flooding the model with unused tool schemas.
4. **Configuration as declaration**: `.mcp.json` describes *what* servers to use, not *how* the client should implement them.
5. **Layered security**: server admission, tool permissions, hook-based audit, and transport security are independent defense layers.


## 4. Verification Strategy

### 4.1 Source-code checkpoints

| Checkpoint | Search Term | Expected Finding |
|--------|-----------|---------|
| ListMcpResourcesTool definition | `no6="ListMcpResourcesTool"` | Tool constant, description, and `call` implementation |
| ReadMcpResourceTool definition | `name:"ReadMcpResourceTool"` | Zod schema and blob-handling logic |
| MCP naming convention | `mcp__` | `serverName__toolName` pattern |
| SSE transport | `class bJ6` | Full SSE transport with resume and reconnect logic |
| Merge deduplication | `mcp-server-suppressed-duplicate` | Duplicate server detection |
| Permission integration | `alwaysAllowRules`, `mcp__*` | Pattern-based permission rules |
| MCPB errors | `mcpb-download-failed` | MCPB lifecycle error cases |
| Channel support | `claude/channel`, `R78` | Capability detection and admission control |
| Telemetry anonymization | `toolName.startsWith("mcp__")` | Tool names normalized to `"mcp"` |
| `.mcp.json` loading | `SH("project")` | Project-level config loading |

### 4.2 Runtime verification

```bash
# Verify MCP server registration
# Run /mcp inside a Claude Code session
# Expected: all connected MCP servers and their status are listed

# Verify automatic .mcp.json discovery
# Start Claude Code in a project containing .mcp.json
# Expected: declared servers connect automatically

# Verify deferred tool loading
# Search for an MCP tool through ToolSearch
# Expected: ToolSearch discovers and loads the deferred MCP tool

# Verify environment-variable expansion
# Use ${VAR} placeholders in .mcp.json
# Expected: values are replaced at runtime
```

### 4.3 Cross-validation

| SDK Declaration | `cli.js` Runtime | Consistency |
|-------------------------------|--------------|--------|
| `mcpServers` option | `hc6.mcpServers` default config | Type and default behavior match |
| MCP server URL support | SSE / StreamableHTTP transports | Remote servers via `url` are supported |
| `mcp_servers` in Python SDK | `mcpServers` in TS SDK | Snake_case and camelCase naming are adapted correctly |

### 4.4 Architecture verification checklist

- [ ] Confirm the six MCP configuration layers and their effective priority
- [ ] Confirm that `mcp__<serverName>__<toolName>` naming participates in permission-rule matching
- [ ] Confirm that `SSETransport` (`bJ6`) supports resume via `lastSequenceNum` and `Last-Event-ID`
- [ ] Confirm blob handling in `ReadMcpResourceTool`
- [ ] Confirm that MCPB error coverage spans download, extraction, and manifest validation
- [ ] Confirm the full multi-step Channel admission flow
- [ ] Confirm that environment-variable expansion happens at load time rather than mutating config on disk
- [ ] Confirm that telemetry anonymizes concrete MCP tool names to `"mcp"`
- [ ] Confirm the integration path from plugin `mcpServers` into `MCPConnectionManager`
- [ ] Confirm the completeness of competitor-tool detection maps such as `UB1`


> **Source basis**: all code excerpts and architectural conclusions are derived from reverse analysis of `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js` in v2.1.88, built at `2026-03-30T21:59:52Z`. Obfuscated runtime symbols such as `bJ6`, `no6`, `hc6`, `$M`, and `R78` are the identifiers present in the bundled build.
```
