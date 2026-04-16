<p align="right"><a href="../cn/05_module_tool_system.md">中文</a></p>

# Phase 5: Deep Dive into the Tool System

> The tool system is the core module of Claude Code. It defines the full capability boundary between the AI and its host environment. From file I/O to command execution, from code search to sub-agent forking, from MCP-based dynamic discovery to scheduled automation, the tool system spans roughly **184 source files** and serves as Claude Code's "hands and feet." This chapter examines it layer by layer, from interface contracts to concrete implementation details, with every claim cross-checked against the runtime code in `cli.js` (16,667 bundled lines).


## Contents

1. Interface Contracts
   - 1.1 Core Tool Type Definitions
   - 1.2 Complete Tool Inventory
   - 1.3 File-Operation Tool Group
   - 1.4 Code-Search Tool Group
   - 1.5 Command-Execution Tool Group
   - 1.6 Agent-System Tool Group
   - 1.7 Task-Management Tool Group
   - 1.8 Plan-Mode Tool Group
   - 1.9 Git-Isolation Tool Group
   - 1.10 Network Tool Group
   - 1.11 MCP Tool Group
   - 1.12 Interactive Tool Group
   - 1.13 Configuration Tool Group
   - 1.14 Scheduling Tool Group
   - 1.15 Remote Tool Group
2. Implementation Mechanisms
   - 2.1 Tool Registration Flow
   - 2.2 Tool Execution Pipeline
   - 2.3 Tool Input Validation
   - 2.4 Streaming Tool Execution
   - 2.5 Hook System
   - 2.6 Result Formatting
   - 2.7 BashTool Core Implementation
   - 2.8 FileReadTool Core Implementation
   - 2.9 GrepTool Core Implementation
   - 2.10 AgentTool Core Implementation
3. Evolution Thought Experiment
4. Verification


## 1. Interface Contracts

### 1.1 Core Tool Type Definitions

Every tool is created through the `sq()` factory function, which merges a tool-definition object with a set of defaults. The runtime contract inferred from `cli.js` looks like this:

```typescript
interface ToolDefinition {
  // Identity
  name: string;
  searchHint?: string;
  aliases?: string[];

  // Descriptions
  description(): Promise<string>;
  prompt(): Promise<string>;

  // Schemas
  inputSchema: ZodSchema;
  outputSchema?: ZodSchema;

  // Lifecycle
  isEnabled(): boolean;
  shouldDefer?: boolean;
  isConcurrencySafe(input): boolean;
  isReadOnly(input): boolean;
  isDestructive(input): boolean;

  // Permissions
  checkPermissions(input, context): Promise<PermissionResult>;

  // Execution
  call(input, context): Promise<ToolResult>;
  validateInput?(input): Promise<ValidationResult>;

  // Result mapping
  mapToolResultToToolResultBlockParam(data, toolUseId): ToolResultBlock;
  toAutoClassifierInput(input): string;

  // Rendering
  userFacingName(input?): string;
  renderToolUseMessage(input): ReactNode;
  renderToolResultMessage(data): ReactNode;
}
```

Key design observations:

- **Lazy schema construction**: `B6(() => L.strictObject({...}))` delays schema creation until first access, avoiding unnecessary startup work.
- **Factory defaults**: `sq()` merges user definitions with `KJ_`, which provides defaults such as `isEnabled: () => true`, `isConcurrencySafe: () => false`, `isReadOnly: () => false`, and `isDestructive: () => false`.
- **Environment sensitivity**: `isEnabled()` can depend on platform detection (`Z1()` returning `"macos"`, `"linux"`, `"windows"`, or `"wsl"`) and feature flags.

### 1.2 Complete Tool Inventory

The following tool-name constants can be extracted directly from `cli.js`:

| Variable | Tool Name | Category |
|---------|--------|----------|
| `Cq` | `"Read"` | File operations |
| `X4` | `"Edit"` | File operations |
| `tK` | `"Write"` | File operations |
| `nW` | `"NotebookEdit"` | File operations |
| `i9` | `"Glob"` | Code search |
| `n3` | `"Grep"` | Code search |
| `_q` | `"Bash"` | Command execution |
| — | `"PowerShell"` | Command execution |
| `v4` | `"Agent"` | Agent system |
| `wD` | `"SendMessage"` | Agent system |
| `TN` | `"TaskCreate"` | Task management |
| `Gq6` | `"TaskGet"` | Task management |
| `Tq6` | `"TaskList"` | Task management |
| — | `"TaskUpdate"` | Task management |
| — | `"TaskStop"` | Task management |
| — | `"TaskOutput"` | Task management |
| — | `"EnterPlanMode"` | Plan mode |
| `TL` | `"ExitPlanMode"` | Plan mode |
| — | `"EnterWorktree"` | Git isolation |
| — | `"ExitWorktree"` | Git isolation |
| `Sj` | `"WebFetch"` | Network |
| `$N` | `"WebSearch"` | Network |
| — | `"MCPTool"` | MCP |
| — | `"ListMcpResources"` | MCP |
| — | `"ReadMcpResource"` | MCP |
| — | `"AskUserQuestion"` | Interactive |
| — | `"Skill"` | Interactive |
| — | `"ToolSearch"` | Interactive |
| — | `"Config"` | Configuration |
| — | `"TodoWrite"` | Configuration |
| `xL` | `"CronCreate"` | Scheduling |
| `Vq6` | `"CronDelete"` | Scheduling |
| `Ro6` | `"CronList"` | Scheduling |
| `_H6` | `"RemoteTrigger"` | Remote |
| — | `"Brief"` | Remote |

Tool availability is controlled jointly by environment variables, feature flags, and platform checks. Core tools such as Read, Write, Edit, Bash, Glob, and Grep are always enabled. Task tools are gated by `IH()`, cron tools by `vN()`, and `RemoteTrigger` requires both the `tengu_surreal_dali` feature flag and an OAuth session.

### 1.3 File-Operation Tool Group

#### 1.3.1 Read

**Tool name**: `"Read"` (`Cq`)

**Purpose**: Reads content from the local filesystem. Supports plain text, images, PDFs, and Jupyter notebooks.

**Input parameters**

| Parameter | Type | Required | Description |
|------|------|------|------|
| `file_path` | `string` | Yes | Absolute path |
| `offset` | `number` | No | Starting line number, 0-based |
| `limit` | `number` | No | Maximum number of lines, default `mc6 = 2000` |
| `pages` | `string` | No | PDF page range, for example `"1-5"` |

**Output behavior**

- Text files are returned in `cat -n` style with 1-based line numbers.
- Images are resized through Sharp and embedded as base64.
- PDFs use `PN1()` to parse ranges such as `"3"`, `"1-5"`, or `"10-"`.
- `.ipynb` files are rendered as notebook cells plus outputs.

**Key behavior**

- File-change detection returns `_T6`, a "File unchanged since last read..." shortcut, when possible.
- The default line limit is 2000.
- `KT6()` identifies PDF input by extension.
- `uc6()` checks whether the current model supports vision, excluding `claude-3-haiku`.

**Permission characteristics**

- `isReadOnly()` returns `true`
- `isConcurrencySafe()` returns `true`
- `checkPermissions()` defaults to `"allow"`

#### 1.3.2 Edit

**Tool name**: `"Edit"` (`X4`)

**Purpose**: Performs precise string replacement within an existing file. It is more efficient than rewriting the whole file because only the diff matters.

**Input parameters**

| Parameter | Type | Required | Description |
|------|------|------|------|
| `file_path` | `string` | Yes | Absolute path |
| `old_string` | `string` | Yes | The original text to replace |
| `new_string` | `string` | Yes | Replacement text; must differ from `old_string` |
| `replace_all` | `boolean` | No | Replace every match, default `false` |

**Key behavior**

- `old_string` must match uniquely unless `replace_all` is enabled.
- The file normally must have been read first through Read.
- Unexpected file changes are rejected through the `df8` error constant.
- Sensitive paths such as `/.claude/**` and `~/.claude/**` are protected by default.

**Permission characteristics**

- `isReadOnly()` returns `false`
- `isDestructive()` returns `false`
- Requires ask permission or `acceptEdits` mode

#### 1.3.3 Write

**Tool name**: `"Write"` (`tK`)

**Purpose**: Creates a new file or fully overwrites an existing one.

**Input parameters**

| Parameter | Type | Required | Description |
|------|------|------|------|
| `file_path` | `string` | Yes | Absolute path |
| `content` | `string` | Yes | Entire file content |

**Key behavior**

- Overwriting an existing file requires a prior Read.
- The preflight helper `NJ_()` generates the explicit "read first" guidance.
- Creating a brand-new file does not require a prior Read.

**Permission characteristics**

- `isReadOnly()` returns `false`
- Requires ask permission or `acceptEdits` mode
- Validates whether the destination path sits inside an allowed writable directory

#### 1.3.4 NotebookEdit

**Tool name**: `"NotebookEdit"` (`nW`)

**Purpose**: Edits a specific Jupyter notebook cell, supporting insert, replace, and delete operations without rewriting the entire notebook structure.

**Input parameters**

| Parameter | Type | Required | Description |
|------|------|------|------|
| `notebook_path` | `string` | Yes | Absolute path to the notebook |
| `command` | `"insert" \| "replace" \| "delete"` | Yes | Operation type |
| `cell_number` | `number` | Yes | Target cell index, 0-based |
| `cell_type` | `"code" \| "markdown"` | No | Cell type for insert/replace |
| `new_source` | `string` | No | New cell content |

**Key behavior**

- Each call modifies exactly one cell.
- Notebook JSON is updated through `Zh7()`.
- Existing kernel metadata and unrelated notebook metadata are preserved.

### 1.4 Code-Search Tool Group

#### 1.4.1 Glob

**Tool name**: `"Glob"` (`i9`)

**Purpose**: Fast file-pattern matching across codebases of any size.

**Input parameters**

| Parameter | Type | Required | Description |
|------|------|------|------|
| `pattern` | `string` | Yes | Glob pattern such as `"**/*.js"` or `"src/**/*.ts"` |
| `path` | `string` | No | Search root, defaulting to the current working directory |

**Output**: A list of matching file paths, sorted by modification time.

**Key behavior**

- Exclusion list `QS_` skips `.git` while preserving `.claude/commands` and `.claude/agents` through `oG8()`.
- `Ih1()` lowercases patterns before matching.
- `GG()` detects wildcard characters such as `*`, `?`, `[`, and `]`.
- `oV()` normalizes `~`, `./`, `../`, and symlink-resolved paths.

**Permission characteristics**

- `isReadOnly()` returns `true`
- `isConcurrencySafe()` returns `true`

#### 1.4.2 Grep

**Tool name**: `"Grep"` (`n3`)

**Purpose**: A full-regular-expression search tool backed by a vendored ripgrep binary.

**Input parameters**: 15 total

| Parameter | Type | Required | Description |
|------|------|------|------|
| `pattern` | `string` | Yes | Regex search pattern |
| `path` | `string` | No | Search root, default current directory |
| `glob` | `string` | No | File filter, for example `"*.js"` |
| `type` | `string` | No | Type filter such as `"js"`, `"py"`, or `"rust"` |
| `output_mode` | `"content" \| "files_with_matches" \| "count"` | No | Output mode, default `"files_with_matches"` |
| `-A` | `number` | No | Lines of trailing context |
| `-B` | `number` | No | Lines of leading context |
| `-C` / `context` | `number` | No | Symmetric context lines |
| `-n` | `boolean` | No | Show line numbers, default `true` |
| `-i` | `boolean` | No | Ignore case |
| `multiline` | `boolean` | No | Multiline matching |
| `head_limit` | `number` | No | Result limit, default 250 |
| `offset` | `number` | No | Skip the first N results |

**Three output modes**

1. `files_with_matches` returns only file paths plus a `"Found N file(s)"` header.
2. `content` returns matching lines with optional context and line numbers.
3. `count` returns `"Found N total occurrences across M files."`

**Key behavior**

- `ps1()` generates pagination hints such as `"Showing results with pagination = ..."`
- `head_limit` defaults to 250 to control output size
- Empty results return `"No files found"` or `"No matches found"`

**Permission characteristics**

- `isReadOnly()` returns `true`
- `isConcurrencySafe()` returns `true`

### 1.5 Command-Execution Tool Group

#### 1.5.1 Bash

**Tool name**: `"Bash"` (`_q`)

**Purpose**: Executes shell commands with support for sandboxing, timeouts, and background execution.

**Input parameters**

| Parameter | Type | Required | Description |
|------|------|------|------|
| `command` | `string` | Yes | Shell command to execute |
| `description` | `string` | No | Human-readable purpose of the command |
| `timeout` | `number` | No | Timeout in milliseconds, max 600000 (10 minutes) |
| `run_in_background` | `boolean` | No | Whether to detach into the background |
| `dangerouslyDisableSandbox` | `boolean` | No | Disable sandbox mode |

**Output behavior**

- Standard output returns `stdout`
- Failures include an `"exit code N"` prefix plus `stderr`
- Large output is truncated with a message like `"Output too large (XMB). Full output saved to: ..."`
- Background execution returns a `"Background process started..."` status message

**Permission characteristics**

- `isReadOnly()` and `isDestructive()` are inferred from command content
- `toAutoClassifierInput()` extracts semantic information for auto-permission mode
- Permission rules such as `"Bash(command_prefix:*)"` support wildcard matching

#### 1.5.2 PowerShell

**Tool name**: `"PowerShell"`

**Purpose**: Windows-native command execution with behavior similar to BashTool, but routed through the PowerShell engine.

**Enablement**: only available when `Z1() === "windows"`.

### 1.6 Agent-System Tool Group

#### 1.6.1 Agent

**Tool name**: `"Agent"` (`v4`)

**Purpose**: Starts a child Agent process for complex work. The sub-agent shares context from the parent while running its own independent message loop.

**Input parameters**

| Parameter | Type | Required | Description |
|------|------|------|------|
| `prompt` | `string` | Yes | The task prompt for the child Agent |
| `subagent_type` | `string` | No | Child-agent type, which determines tool set and system prompt |

**Built-in sub-agent types**

| Type | Tool Set | Purpose |
|------|--------|------|
| `"general-purpose"` | Full tool set | General tasks |
| `"Plan"` | Read-only, no Write/Edit/Bash | Architecture and planning |
| `"Explore"` | Read-only, primarily Read/Glob/Grep | Code exploration |
| `"statusline-setup"` | Read/Edit | Status-line setup |
| Custom agents | Defined in `.claude/agents/` | Project-specific specialization |

**Output behavior**

- On success, returns the child Agent's content blocks
- When worktree isolation is used, includes `worktreeBranch`
- Empty results become `"(Subagent completed but returned no output.)"`
- Resumable sessions include `"use SendMessage with to: 'agentId' to continue this agent"`

**Key behavior**

- Child tools are filtered through `disallowedTools`
- The Plan agent disables `[v4, TL, X4, tK, nW]`, namely Agent, ExitPlanMode, Edit, Write, and NotebookEdit
- Agents can define independent `model`, `color`, `memory`, and `isolation`
- Plugin agents are lazy-loaded through `Ui6` by scanning Markdown files in `.claude/agents/`

**Permission characteristics**

- `isConcurrencySafe()` returns `false`
- The child Agent inherits the parent Agent's permission context

#### 1.6.2 SendMessage

**Tool name**: `"SendMessage"` (`wD`)

**Purpose**: Sends a message to an already running child Agent, allowing interrupted agent sessions to continue.

**Input parameters**

| Parameter | Type | Required | Description |
|------|------|------|------|
| `to` | `string` | Yes | Target agent ID |
| `content` | `string` | Yes | Message content |

### 1.7 Task-Management Tool Group

The task subsystem provides structured task tracking. All Task tools are enabled or disabled through `IH()`.

#### 1.7.1 TaskCreate

**Tool name**: `"TaskCreate"` (`TN`)

**Purpose**: Creates a new task in the task list. The system prompt encourages proactive use once a task exceeds roughly three steps.

**Input parameters**

| Parameter | Type | Required | Description |
|------|------|------|------|
| `subject` | `string` | Yes | Short imperative title |
| `description` | `string` | Yes | Detailed task description |
| `activeForm` | `string` | No | Progressive title such as `"Running tests"` for spinner display |
| `metadata` | `Record<string, unknown>` | No | Arbitrary metadata |

**Output**: `"Task #ID created successfully: SUBJECT"`

**Key behavior**

- New tasks default to `pending`
- The task panel expands automatically after creation
- Data is persisted through `$67()` under `~/.claude/tasks/`
- Blocking errors are surfaced through `Y67(blockingError)`
- Failed creation is rolled back through `vC8(cG(), id)`

**Permission characteristics**

- `isConcurrencySafe()` returns `true`
- `shouldDefer` is `true`

#### 1.7.2 TaskGet

**Tool name**: `"TaskGet"` (`Gq6`)

**Purpose**: Returns full details for a task by ID.

**Input parameters**

| Parameter | Type | Required | Description |
|------|------|------|------|
| `taskId` | `string` | Yes | Task ID |

**Output**

```text
Task #ID: SUBJECT
Status: STATUS
Description: DESCRIPTION
Blocked by: #X, #Y
Blocks: #Z
```

**Permission characteristics**: `isReadOnly()` returns `true`

#### 1.7.3 TaskList

**Tool name**: `"TaskList"` (`Tq6`)

**Purpose**: Lists summary information for all tasks.

**Input**: empty object `{}`

**Output**

```text
#1 [completed] Fix auth bug
#2 [in_progress] Implement search (agent-1) [blocked by #3]
#3 [pending] Setup database
```

**Key behavior**

- Internal tasks are filtered via `filter(t => !t.metadata?._internal)`
- Completed blockers are hidden automatically
- The `owner` field is returned for task routing in Swarm mode

**Permission characteristics**: `isReadOnly()` returns `true`

#### 1.7.4 TaskUpdate

**Tool name**: `"TaskUpdate"`

**Purpose**: Updates task state, description, or dependency relationships.

**Input parameters**

| Parameter | Type | Required | Description |
|------|------|------|------|
| `taskId` | `string` | Yes | Task ID |
| `status` | `"pending" \| "in_progress" \| "completed" \| "deleted"` | No | New status |
| `subject` | `string` | No | Updated title |
| `description` | `string` | No | Updated description |
| `owner` | `string` | No | Assigned owner, especially relevant in Swarm mode |
| `blockedBy` | `string[]` | No | Upstream dependency IDs |
| `blocks` | `string[]` | No | Downstream dependency IDs |

**Key behavior**

- Supports state transitions, reassignment, and dependency rewiring in one operation
- Persists immediately into the task store
- Drives the task list as the single source of truth for team coordination

#### 1.7.5 TaskStop / TaskOutput

`TaskStop` terminates a running task, while `TaskOutput` retrieves task output or progress from long-running tasks. Together they provide management APIs for background execution.

### 1.8 Plan-Mode Tool Group

#### 1.8.1 EnterPlanMode

**Purpose**: Switches the session into plan mode, where the model is expected to generate an execution plan rather than immediately applying changes.

#### 1.8.2 ExitPlanMode

**Tool name**: `"ExitPlanMode"` (`TL`)

**Purpose**: Leaves plan mode and returns the session to normal tool-enabled execution.

### 1.9 Git-Isolation Tool Group

#### 1.9.1 EnterWorktree

**Purpose**: Creates and enters a dedicated Git worktree for isolated work. It is exposed as a user-facing session tool rather than a low-level Git primitive.

#### 1.9.2 ExitWorktree

**Purpose**: Leaves the current worktree session. Depending on the chosen action, the worktree can be preserved or removed.

### 1.10 Network Tool Group

#### 1.10.1 WebFetch

**Tool name**: `"WebFetch"` (`Sj`)

**Purpose**: Fetches URL content and converts it into model-readable text. It is intended for precise page retrieval rather than broad discovery.

**Key behavior**

- Fetches specific pages by URL
- Runs through domain-aware permission checks
- Normalizes response content into a text form suitable for tool results

#### 1.10.2 WebSearch

**Tool name**: `"WebSearch"` (`$N`)

**Purpose**: Performs web search when open-ended discovery is required.

**Key behavior**

- Subject to feature flags and regional rollout controls
- Better suited than WebFetch when the target page is not known in advance

### 1.11 MCP Tool Group

#### 1.11.1 MCPTool

**Tool name**: `"MCPTool"`

**Purpose**: A generic wrapper for dynamically discovered tools exposed by connected MCP servers.

#### 1.11.2 ListMcpResources

**Purpose**: Lists resources exposed by MCP servers.

#### 1.11.3 ReadMcpResource

**Purpose**: Reads the content of a selected MCP resource.

### 1.12 Interactive Tool Group

#### 1.12.1 AskUserQuestion

**Purpose**: Prompts the user directly for structured clarification when the model cannot proceed safely on its own.

#### 1.12.2 Skill

**Purpose**: Loads and applies a skill workflow, making behavior reusable and auditable.

#### 1.12.3 ToolSearch

**Purpose**: Searches the deferred-tool registry and loads full schema definitions on demand. This is the mechanism that keeps uncommon tools out of the initial token budget.

### 1.13 Configuration Tool Group

#### 1.13.1 Config

**Purpose**: Reads or writes Claude Code settings.

Supported setting keys extracted from the runtime include:

```text
apiKeyHelper, installMethod, autoUpdates, theme, verbose,
preferredNotifChannel, editorMode, autoCompactEnabled,
showTurnDuration, diffTool, todoFeatureEnabled, messageIdleNotifThresholdMs,
autoConnectIde, fileCheckpointingEnabled, terminalProgressBarEnabled,
respectGitignore, voiceEnabled, remoteControlAtStartup, ...
```

**Key behavior**

- `CJK()` distinguishes global settings from project-scoped settings
- Nested keys use dot notation such as `"permissions.defaultMode"`
- String values `"true"` and `"false"` are coerced into booleans
- `hm8()` supplies enum candidates for validation
- `validateOnWrite` performs async validation before persisting
- `voiceEnabled` triggers extra checks for microphone permission, recording capability, and streaming support

**Permission characteristics**

- Read operations: `isReadOnly()` returns `true`
- Write operations: require ask permission and show a confirmation message such as `"Set SETTING to VALUE"`

#### 1.13.2 TodoWrite

**Purpose**: Writes a structured TODO list directly. Unlike the Task tool family, TodoWrite operates at the file level rather than through the task database.

### 1.14 Scheduling Tool Group

#### 1.14.1 CronCreate

**Tool name**: `"CronCreate"` (`xL`)

**Purpose**: Creates a recurring or one-shot scheduled task based on a cron expression.

**Input parameters**

| Parameter | Type | Required | Description |
|------|------|------|------|
| `cron` | `string` | Yes | Five-field local-time cron expression, `"M H DoM Mon DoW"` |
| `prompt` | `string` | Yes | Prompt to run on each trigger |
| `recurring` | `boolean` | No | Whether it repeats, default `true` |
| `durable` | `boolean` | No | Whether to persist on disk, default `false` |

**Key behavior**

- Maximum number of jobs: `$MK = 50`
- `Eo6()` validates cron syntax
- `xV6()` verifies that the cron matches at least one date within the next year
- Durable schedules are stored in `.claude/scheduled_tasks.json`
- Jobs auto-expire after `kq6` days
- Durable cron jobs are not supported for teammates

**Output behavior**

- Recurring: `"Scheduled recurring job ID (SCHEDULE). SESSION-ONLY. Auto-expires after N days."`
- One-shot: `"Scheduled one-shot task ID (SCHEDULE). It will fire once then auto-delete."`

#### 1.14.2 CronDelete

**Tool name**: `"CronDelete"` (`Vq6`)

**Input parameters**

| Parameter | Type | Required | Description |
|------|------|------|------|
| `id` | `string` | Yes | Job ID returned by CronCreate |

**Key behavior**

- In teammate mode, an agent can only delete jobs it created itself
- Ownership violations raise `"Cannot delete cron job 'ID': owned by another agent"`

#### 1.14.3 CronList

**Tool name**: `"CronList"` (`Ro6`)

**Input**: empty object `{}`

**Output**

```text
job-1 — every 5 minutes (recurring) [session-only]: Check deploy status
job-2 — Feb 28 at 2:30pm (one-shot): Send reminder
```

**Key behavior**

- Teammates only see jobs they created
- `bV6()` translates cron expressions into human-readable schedules

### 1.15 Remote Tool Group

#### 1.15.1 RemoteTrigger

**Tool name**: `"RemoteTrigger"` (`_H6`)

**Purpose**: Manages scheduled remote-agent triggers through the Claude Code Remote API on `claude.ai`. OAuth tokens are handled inside the process and are never exposed to the shell.

**Input parameters**

| Parameter | Type | Required | Description |
|------|------|------|------|
| `action` | `"list" \| "get" \| "create" \| "update" \| "run"` | Yes | API operation |
| `trigger_id` | `string` | No | Trigger ID, required for `get`, `update`, and `run` |
| `body` | `Record<string, unknown>` | No | JSON request body, required for `create` and `update` |

**Endpoint mapping**

```text
list   → GET  /v1/code/triggers
get    → GET  /v1/code/triggers/{trigger_id}
create → POST /v1/code/triggers
update → POST /v1/code/triggers/{trigger_id}
run    → POST /v1/code/triggers/{trigger_id}/run
```

**Key behavior**

- Uses API beta header `"anthropic-beta": "ccr-triggers-2026-01-30"`
- Requires a valid `Kq().accessToken`
- Resolves the organization UUID through `mW()`
- Uses a 20-second timeout
- Requires the `tengu_surreal_dali` feature flag and `OO("allow_remote_sessions")`

**Output**: `"HTTP STATUS\nJSON_BODY"`

#### 1.15.2 Brief

**Purpose**: Toggles brief mode, which influences how concise Claude's replies should be.


## 2. Implementation Mechanisms

### 2.1 Tool Registration Flow

The tool system is registered in three phases.

**Phase 1: static registration at startup**

Core tools are created at module initialization through `sq()` and added to the global tool registry. The bundled runtime shows the following pattern:

```javascript
var IY = y(() => { cf8() });    // Read dependencies
var E2 = y(() => { IY() });     // Write dependencies
var qM = y(() => { Z$() });     // Grep dependencies

var Cq = "Read";
var tK = "Write";
var X4 = "Edit";
var _q = "Bash";
var i9 = "Glob";
var n3 = "Grep";
var v4 = "Agent";
```

`y()` is a lazy-once initializer. It guarantees dependency ordering while avoiding repeated work.

**Tool-set pruning**

Different agent types prune the available tool set through `disallowedTools`:

```javascript
Mk8 = {
  agentType: "Plan",
  disallowedTools: [v4, TL, X4, tK, nW],
  tools: cF.tools,
  model: "inherit",
  omitClaudeMd: true,
  getSystemPrompt: () => UQ_()
};

Noq = new Set([Cq, tK, X4, i9, n3, _q, nW, v4]);
```

The Plan agent therefore blocks Agent, ExitPlanMode, Edit, Write, and NotebookEdit, while the REPL's core interactive set includes Read, Write, Edit, Glob, Grep, Bash, NotebookEdit, and Agent.

**Phase 2: dynamic MCP registration**

MCP tools are registered after MCP servers connect. Chrome In Claude is a representative example:

```javascript
function i37() {
  let K = pc.map((Y) => `mcp__claude-in-chrome__${Y.name}`);

  return {
    mcpConfig: {
      [yN]: {
        type: "stdio",
        command: process.execPath,
        args: ["--claude-in-chrome-mcp"],
        scope: "dynamic"
      }
    },
    allowedTools: K,
    systemPrompt: j17()
  };
}
```

The `inputSchema` for MCP tools comes from MCP `tools/list` responses using standard JSON Schema. Browser-oriented tools such as `javascript_tool` and `tabs_context_mcp` are registered this way.

**Phase 3: deferred loading**

Tools marked with `shouldDefer: true` register only their names and search hints at startup. The full schema is fetched later through ToolSearch. This reduces initial system-prompt size by avoiding unused schemas.

Observed deferred-tool list:

```text
CronCreate, CronDelete, CronList, EnterWorktree, ExitWorktree,
NotebookEdit, RemoteTrigger, TaskCreate, TaskGet, TaskList,
TaskUpdate, WebFetch, WebSearch
```

### 2.2 Tool Execution Pipeline

The runtime execution pipeline inferred from `cli.js` has five core steps:

```text
API response stream → extract tool_use blocks → execute in parallel → collect results → assemble tool_result blocks
```

**Step 1: extract `tool_use` blocks**

```javascript
let _ = K.content.filter((Y) => Y.type === "tool_use");
if (_.length === 0) return null;
```

**Step 2: tool lookup and input parsing**

Each `tool_use` block is matched by `name`:

```javascript
let $ = q.tools.find((A) =>
  ("name" in A ? A.name : A.mcp_server_name) === Y.name
);

if ("parse" in $ && $.parse) A = $.parse(A);
```

Built-in tools match on `name`; MCP tools can also match via `mcp_server_name`.

**Step 3: permission checks and PreToolUse hooks**

Before `call()` runs, Claude Code evaluates permissions and executes any PreToolUse hooks.

**Step 4: tool execution**

```javascript
let O = await $.run(A);
return { type: "tool_result", tool_use_id: Y.id, content: O };
```

**Step 5: error handling**

```javascript
catch (A) {
  return {
    type: "tool_result",
    tool_use_id: Y.id,
    content: A instanceof nX6 ? A.content : `Error: ${A instanceof Error ? A.message : String(A)}`,
    is_error: true
  };
}
```

The custom error class `nX6` lets a tool return structured error content instead of a plain string.

### 2.3 Tool Input Validation

Tool input validation has two layers: Zod schemas and optional business-level `validateInput()` logic.

**Layer 1: Zod schema validation**

All `inputSchema` definitions use lazy Zod construction:

```javascript
MqY = B6(() => L.strictObject({
  cron: L.string().describe('Standard 5-field cron expression in local time'),
  prompt: L.string().describe('The prompt to enqueue at each fire time.'),
  recurring: BX(L.boolean().optional()).describe('true = fire on every cron match...'),
  durable: BX(L.boolean().optional()).describe('true = persist to .claude/scheduled_tasks.json...')
}));
```

`L.strictObject()` rejects unknown fields, and `BX()` wraps optional booleans with extra serialization behavior.

**Layer 2: custom validation**

Some tools implement business-rule checks after schema validation:

```javascript
async validateInput(q) {
  if (!Eo6(q.cron))
    return { result: false, message: `Invalid cron expression '${q.cron}'...`, errorCode: 1 };
  if (xV6(q.cron, Date.now()) === null)
    return { result: false, message: `...does not match any calendar date...`, errorCode: 2 };
  if ((await uV6()).length >= $MK)
    return { result: false, message: `Too many scheduled jobs (max ${$MK})...`, errorCode: 3 };
  if (q.durable && VP())
    return { result: false, message: "durable crons are not supported for teammates", errorCode: 4 };
  return { result: true };
}
```

The explicit `errorCode` field makes failures classifiable.

### 2.4 Streaming Tool Execution

Tool execution supports concurrency, cancellation, timeout control, and backgrounding.

**Concurrent execution**

Multiple `tool_use` blocks are executed through `Promise.all`:

```javascript
return {
  role: "user",
  content: await Promise.all(_.map(async (Y) => {
    // lookup, permission checks, execution
  }))
};
```

Not every tool is truly concurrency-safe. Tools such as Agent and Bash typically return `false` from `isConcurrencySafe()` and therefore require extra coordination.

**Cancellation**

Each execution context can carry an `AbortSignal`:

```javascript
signal: K.abortController?.signal
```

Ctrl+C, session teardown, or explicit cancellation can therefore interrupt in-flight tool work.

**Timeouts**

- Bash defaults to 120000 ms and allows at most 600000 ms
- RemoteTrigger uses a 20-second timeout
- Network tools rely on their own timeout policies

**Background execution**

Bash supports `run_in_background: true`, which detaches the process, returns immediately, and later surfaces completion through task-style notifications.

### 2.5 Hook System

The hook system lets users inject logic before and after tool execution.

**PreToolUse hooks**

These run before `call()` and can:

- block execution
- rewrite tool input
- emit audit signals

**PostToolUse hooks**

These run after execution and can:

- inspect or transform output
- trigger side effects
- emit progress messages

**Configuration format**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "command": "echo '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}' | validate_cmd"
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "command": "echo '{\"tool_name\":\"Edit\",\"tool_input\":{...}}' | post_process"
      }
    ]
  }
}
```

**Matcher syntax**

- Exact tool name: `"Bash"`, `"Write"`, `"Edit"`
- Regex: `"Write|Edit"`
- Wildcard: `"*"`

Hook input is passed as JSON through stdin. Hooks can return modified input or block instructions through stdout. Progress events are filtered via `hook_progress`, and helper functions such as `g_()` and `L5()` handle name and alias matching.

### 2.6 Result Formatting

Tool results are mapped into Anthropic-compatible `tool_result` blocks through `mapToolResultToToolResultBlockParam()`:

```javascript
{
  tool_use_id: K,
  type: "tool_result",
  content: "result text"
}
```

Error results add `is_error: true`, while multi-block tools such as Agent can return arrays of `{ type: "text", text: ... }`.

**Large-output truncation**

When output exceeds `MI1`, Claude Code saves the full result locally and returns a preview:

```text
Output too large (XMB). Full output saved to: /path/to/saved/output
Preview (first 2KB): ...
```

**Special formatting cases**

- Grep replaces very long matching lines with `"[Omitted long matching line]"`
- Task tools can include pagination hints
- Agent results append `agentId` so SendMessage can resume the session

### 2.7 BashTool Core Implementation

BashTool is the single most complex built-in tool. It covers command parsing, safety checks, sandboxing, background execution, and output capture.

#### 2.7.1 Command parsing and safety checks

Commands first go through `YC_()` to derive sandbox-log tags, then enter the safety pipeline.

**Excluded directories**

```javascript
function oG8() {
  return [...QS_.filter((q) => q !== ".git"), ".claude/commands", ".claude/agents"];
}
```

This excludes `.git` by default while preserving `.claude/commands` and `.claude/agents`, which are needed for command and skill discovery.

**Safe-path list** via `yn6()`

```javascript
function yn6() {
  let q = xh1();
  return [
    "/dev/stdout", "/dev/stderr", "/dev/null", "/dev/tty",
    "/dev/dtracehelper", "/dev/autofs_nowait",
    "/tmp/claude", "/private/tmp/claude",
    Lv.join(q, ".npm/_logs"),
    Lv.join(q, ".claude/debug")
  ];
}
```

**Path validation** via `rG8()`

```javascript
function rG8(q, K) {
  let _ = Lv.normalize(q), z = Lv.normalize(K);
  if (z === _) return false;
  if (_.startsWith("/tmp/") && z === "/private" + _) return false;
  if (_.startsWith("/var/") && z === "/private" + _) return false;
  if (z === "/") return true;
  if (z.split("/").filter(Boolean).length <= 1) return true;
  if (_.startsWith(z + "/")) return true;
  return false;
}
```

The implementation accounts for macOS path aliases such as `/tmp` to `/private/tmp` and guards against root-level or overly broad directory access.

#### 2.7.2 Sandboxing

BashTool uses operating-system-level sandboxing to isolate command execution.

**macOS sandboxing: `sandbox-exec` plus Seatbelt**

```javascript
function H54(q) {
  let {
    command: K,
    needsNetworkRestriction: _,
    httpProxyPort: z,
    socksProxyPort: Y,
    allowUnixSockets: $,
    allowAllUnixSockets: A,
    allowLocalBinding: O,
    readConfig: w,
    writeConfig: j,
    allowPty: H,
    allowGitConfig: J = false,
    enableWeakerNetworkIsolation: M = false,
    binShell: X
  } = q;

  let f = OC_({
    readConfig: w, writeConfig: j,
    httpProxyPort: z, socksProxyPort: Y,
    needsNetworkRestriction: _,
    allowUnixSockets: $, allowAllUnixSockets: A,
    allowLocalBinding: O, allowPty: H,
    allowGitConfig: J,
    enableWeakerNetworkIsolation: M,
    logTag: D
  });

  let v = O54.default.quote([
    "env", ...G,
    "sandbox-exec", "-p", f,
    T, "-c", K
  ]);

  return v;
}
```

The runtime injects environment variables such as:

```javascript
function aG8(z, Y) {
  let envVars = [
    "SANDBOX_RUNTIME=1",
    `TMPDIR=${process.env.CLAUDE_TMPDIR || "/tmp/claude"}`
  ];
  return envVars;
}
```

**Linux sandboxing: Bubblewrap**

Linux uses Bubblewrap (`bwrap`) with optional seccomp support from `@anthropic-ai/sandbox-runtime`. `socat` is used for Unix-socket proxying when required. If seccomp is unavailable, the runtime warns rather than fully blocking execution.

**Sandbox UI choices**

```javascript
options = [
  { label: "Sandbox BashTool, with auto-allow", value: "auto-allow" },
  { label: "Sandbox BashTool, with regular permissions", value: "regular" },
  { label: "No Sandbox", value: "disabled" }
];

overrideOptions = [
  { label: "Allow unsandboxed fallback", value: "open" },
  { label: "Strict sandbox mode", value: "closed" }
];
```

**Violation logging**

On macOS, `J54()` listens to the system log stream:

```javascript
let A = _C_("log", [
  "stream",
  "--predicate", `(eventMessage ENDSWITH "${w54}")`,
  "--style", "compact"
]);
```

#### 2.7.3 Background execution and timeout control

Background execution is implemented through `child_process.spawn`, wrapped by execa-style helpers:

```javascript
function m_(q, K, _) {
  let z = KL7(q, K, _);
  let A = rq1.spawn(z.file, z.args, z.options);

  A.kill = WE7.bind(null, A.kill.bind(A));
  A.cancel = DE7.bind(null, A, H);
}
```

Claude Code also kills process trees cross-platform:

```javascript
switch (process.platform) {
  case "win32":
    exec("taskkill /pid " + q + " /T /F", _);
    break;
  case "darwin":
    MN1(q, z, Y, ($) => Moq("pgrep", ["-P", $]), callback);
    break;
  default:
    MN1(q, z, Y, ($) => Moq("ps", ["-o", "pid", "--no-headers", "--ppid", $]), callback);
    break;
}
```

This is how timeouts and cancellation clean up the full subtree instead of just the top-level shell.

#### 2.7.4 stdout / stderr capture

The runtime merges stdout and stderr through execa's `all` stream.

For large output:

- truncation happens above `MI1`
- full output is stored under `~/.claude/projects/.../tool-results/`
- a 2 KB preview is shown inline

### 2.8 FileReadTool Core Implementation

#### 2.8.1 Multi-format support

FileReadTool supports multiple formats through extension checks and content-aware handling.

**Text files**

- Returned in `cat -n` style with line numbers
- Support `offset` and `limit`
- Default maximum read size is `mc6 = 2000` lines

**Image files**

- `uc6()` checks whether the active model supports vision
- Sharp is used for resizing
- Images are embedded as base64 in the tool result
- Standard formats such as PNG and JPG are supported

**PDF files**

- `KT6()` detects PDFs through the `VJ_` extension set
- `PN1()` parses page specifications:
  - `"3"` for a single page
  - `"1-5"` for a range
  - `"10-"` for open-ended ranges

```javascript
function PN1(q) {
  let K = q.trim();
  if (!K) return null;
  if (K.endsWith("-")) {
    let $ = parseInt(K.slice(0, -1), 10);
    if (isNaN($) || $ < 1) return null;
    return { firstPage: $, lastPage: Infinity };
  }
  let _ = K.indexOf("-");
  if (_ === -1) {
    let $ = parseInt(K, 10);
    if (isNaN($) || $ < 1) return null;
    return { firstPage: $, lastPage: $ };
  }
  let z = parseInt(K.slice(0, _), 10);
  let Y = parseInt(K.slice(_ + 1), 10);
  if (isNaN(z) || isNaN(Y) || z < 1 || Y < 1 || Y < z) return null;
  return { firstPage: z, lastPage: Y };
}
```

**Jupyter notebooks**

- Parse notebook JSON
- Render cells plus outputs
- Support both code and Markdown cells

#### 2.8.2 Partial reading

Large text files can be chunked through `offset` and `limit`, avoiding unnecessarily large reads. When file content exceeds roughly 10,000 tokens, the tool encourages partial reads explicitly.

#### 2.8.3 Read cache

Read implements a content-stability cache:

```javascript
var _T6 = "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.";
```

If a file has not changed since its last read, Claude Code returns this message instead of spending more tokens on duplicate content.

#### 2.8.4 Large-file handling

Binary files and extremely large files use special handling:

```javascript
var Mp6 = 104857600;  // 100 MB limit

async function YA8(q) {
  let { size: K } = await iR5(q);
  if (K <= Mp6) return LB(await nR5(q));
  let z = Buffer.allocUnsafe(Mp6);
  let $ = K - Mp6;
}
```

JSON and JSONL have dedicated parsing paths through `LB()` and `Ph7`, which uses a 50-entry LRU cache.

### 2.9 GrepTool Core Implementation

#### 2.9.1 Vendored ripgrep invocation

GrepTool does not rely on a system-installed `rg`. It uses the precompiled ripgrep binary shipped under `vendor/`.

```javascript
function FVY(q) {
  return q.includes("ripgrep");
}
```

**Exit-code handling**

```javascript
if (H === 1) return [];
throw Error(`ripgrep failed with exit code ${H}: ${j}`);
```

Exit code 1 means "no matches" and is treated as normal. Exit code 2 and above are real failures.

#### 2.9.2 Fifteen search parameters

The tool maps Claude Code parameters onto ripgrep flags:

| Grep Parameter | ripgrep Flag | Meaning |
|-----------|-------------|------|
| `pattern` | positional | Regex |
| `path` | positional | Search root |
| `glob` | `--glob` | File filter |
| `type` | `--type` | File type |
| `output_mode` | `-l` / `-c` / default | Output mode |
| `-A` | `-A` | Trailing context |
| `-B` | `-B` | Leading context |
| `-C` / `context` | `-C` | Symmetric context |
| `-n` | `-n` | Line numbers |
| `-i` | `-i` | Ignore case |
| `multiline` | `-U --multiline-dotall` | Multiline regex |
| `head_limit` | post-processing | Result limit |
| `offset` | post-processing | Pagination offset |

#### 2.9.3 Three output modes

**`files_with_matches`** is the default. It returns paths only:

```text
Found 5 file(s)
path/to/file1.ts
path/to/file2.js
...
```

**`content`** returns matching lines with optional context and line numbers. Extremely long lines are replaced with `"[Omitted long matching line]"`.

**`count`** returns:

```text
Found N total occurrences across M files.
```

#### 2.9.4 Result limiting and pagination

`ps1()` generates pagination prompts like `"Showing results with pagination = limit: N, offset: M"`. By default, `head_limit` is 250 so a single query cannot flood the context window.

### 2.10 AgentTool Core Implementation

#### 2.10.1 Subprocess lifecycle

AgentTool launches a child agent with its own message loop:

1. allocate a unique `agentId` and an `AbortController`
2. inherit working context such as cwd and permissions
3. run an independent message loop
4. return content blocks to the parent

**Result packaging**

```javascript
if (q.status === "completed") {
  let z = q;
  let Y = z.worktreePath ? `\nworktreeBranch: ${z.worktreeBranch}` : "";
  let $ = q.content.length > 0 ? q.content :
    [{ type: "text", text: "(Subagent completed but returned no output.)" }];

  return {
    tool_use_id: K,
    type: "tool_result",
    content: [
      ...$,
      { type: "text", text: `agentId: ${q.agentId} (use SendMessage with to: '${q.agentId}' to continue this agent)${Y}` }
    ]
  };
}
```

Remote launch mode exists as well and can return `"Remote agent launched in CCR."`

#### 2.10.2 System-prompt inheritance and specialization

Child-agent prompts are produced by `getSystemPrompt()`, but the strategy depends on type:

- Plan agents use `UQ_()` and are explicitly read-only
- Explore agents use `BQ_()` and focus on search and inspection
- General-purpose agents inherit the parent prompt
- Plugin agents load Markdown-defined prompt text and substitute path variables through `dF()`

```javascript
let _ = (Y) => process.platform === "win32" ? Y.replace(/\\/g, "/") : Y;
let z = q.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => _(K.path));
if (K.source) {
  let Y = K.source;
  z = z.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, () => _(ei(Y)));
}
```

#### 2.10.3 Tool-set trimming

Each agent type controls its tool set through `tools` and `disallowedTools`:

```javascript
disallowedTools: [v4, TL, X4, tK, nW]
tools: ["Read", "Glob", "Grep"]
tools: ["Read", "Edit"]
```

Plugin agents read these definitions from Markdown frontmatter:

```javascript
let W = Y76(j.tools);
let g = j.disallowedTools !== void 0 ? Y76(j.disallowedTools) : void 0;
```

When `memory` is enabled, Claude Code may auto-add Read, Edit, and Write so the agent can manage its memory files.

#### 2.10.4 Agent color system

Sub-agents are color-coded in the UI:

```javascript
var GJ = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"];

var vX = {
  red: "red_FOR_SUBAGENTS_ONLY",
  blue: "blue_FOR_SUBAGENTS_ONLY",
};

function wr(q) {
  if (q === "general-purpose") return;
  let _ = w38().get(q);
  if (_ && GJ.includes(_)) return vX[_];
}
```

The `_FOR_SUBAGENTS_ONLY` suffix avoids collisions with the main agent's color vocabulary.


## 3. Evolution Thought Experiment

### Level 1 → Level 2: From single tools to tool orchestration

**Level 1**: every tool is an independent function call, and the model manually chains outputs across turns.

**Level 2 proposal**: introduce a Tool Orchestration Layer.

```typescript
interface ToolPipeline {
  steps: Array<{
    tool: string;
    input: Record<string, any> | ((prevResult: any) => Record<string, any>);
    condition?: (prevResult: any) => boolean;
  }>;
  onError: "stop" | "skip" | "retry";
  maxConcurrency?: number;
}
```

This would let the model express multi-step actions such as `Grep → Read → Edit` inside a single tool use, reducing round trips and context pressure.

**Benefits**

- 40-60% fewer API rounds
- less intermediate serialization
- lower context-window burn

**Risks**

- more complex permission auditing
- every step would need separate checks
- transactional rollback becomes necessary when mid-pipeline steps fail

### Level 2 → Level 3: From CLI tools to a runtime platform

Assume orchestration already exists. Tools are still request-response and mostly stateless. Level 3 would turn the system into a stateful runtime.

Core shifts:

1. **Tool sessions**: Bash maintains persistent shell state instead of spawning a fresh process every time.
2. **File watchers**: Read/Edit/Write subscribe to file changes rather than relying on polling and `_T6`-style unchanged detection.
3. **Capability negotiation**: MCP tools actively advertise capabilities and participate in orchestration decisions.
4. **Cross-agent tool sharing**: Agents share selected tool instances, such as lock managers, under distributed coordination.

Architectural shift:

```text
Level 1: Tool = function(input) → output
Level 2: Tool = Pipeline(steps) → output
Level 3: Tool = Runtime.session(capabilities) → stream<events>
```

At that point, Claude Code would stop being only an AI-powered CLI and become an AI-native development runtime.

**Key challenges**

- state explosion and restore complexity
- blurry security boundaries around shared tool instances
- harder event-driven debugging and causality tracing


## 4. Verification

### 4.1 Tool-name verification

The following constants were verified directly inside `cli.js`:

| Variable | Value | Verification |
|------|-----|---------|
| `Cq` | `"Read"` | line 533 |
| `tK` | `"Write"` | line 540 |
| `X4` | `"Edit"` | line 520 |
| `_q` | `"Bash"` | line 510 |
| `i9` | `"Glob"` | line 540 |
| `n3` | `"Grep"` | line 520 |
| `nW` | `"NotebookEdit"` | line 540 |
| `Sj` | `"WebFetch"` | line 795 |
| `$N` | `"WebSearch"` | around line 915 |
| `TL` | `"ExitPlanMode"` | line 1021 |
| `wD` | `"SendMessage"` | confirmed through source search |
| `_H6` | `"RemoteTrigger"` | line 3615 |

### 4.2 Tool-interface verification

The default implementation object `KJ_` behind `sq()` was verified to contain:

```javascript
var KJ_ = {
  isEnabled: () => true,
  isConcurrencySafe: (q) => false,
  isReadOnly: (q) => false,
  isDestructive: (q) => false,
  checkPermissions: (q, K) => Promise.resolve({ behavior: "allow", updatedInput: q }),
  toAutoClassifierInput: (q) => "",
  userFacingName: (q) => ""
};
```

### 4.3 Sandbox verification

The macOS sandbox command structure is confirmed as:

```text
env SANDBOX_RUNTIME=1 TMPDIR=/tmp/claude sandbox-exec -p <profile> bash -c <command>
```

Linux dependency checks were also verified:

- `ripgrep (rg): found/not found`
- `bubblewrap (bwrap): installed/not installed`
- `socat: installed/not installed`
- `seccomp filter: installed/not installed`

### 4.4 Version verification

```text
VERSION: "2.1.88"
BUILD_TIME: "2026-03-30T21:59:52Z"
```

### 4.5 Tool-count cross-check

Derived counts from the runtime:

- roughly 30 core built-in tools, including Task, Cron, and Remote families
- dynamic MCP tools, whose count depends on connected servers
- plugin-defined agents under `.claude/agents/`
- Chrome browser tools exposed as MCP-based integrations

Verified enablement gates:

- Task tools: `IH()`
- Cron tools: `vN()`
- RemoteTrigger: `g8("tengu_surreal_dali", false) && OO("allow_remote_sessions")`
- WebSearch: regional gating plus feature flags
- Worktree tools: `bR6()` always returns `true`

### 4.6 Key data-structure verification

- Cron limit: `$MK = 50`
- Read defaults: `mc6 = 2000`, `Mp6 = 104857600`
- JSON parse cache: `Ph7` with a 50-entry LRU and threshold `rR5 = 8192`
- Grep default limit: `head_limit = 250`


> **Source path**: `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js` (16,667 bundled lines)
> **Tool-system coverage**: roughly 184 source files, inferred via source-map reconstruction
> **Analysis target**: v2.1.88, build time `2026-03-30T21:59:52Z`
