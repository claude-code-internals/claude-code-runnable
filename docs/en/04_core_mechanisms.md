<p align="right"><a href="../cn/04_core_mechanisms.md">中文</a></p>

# Phase 4: Core Data Structures and Algorithms

> This chapter examines Claude Code's key state containers, control-flow algorithms, and the module-selection strategy used for Phase 5. The analysis is grounded in cross-validation between 1,906 application source files reconstructed from source maps and the public type definitions in `sdk-tools.d.ts`.


## Contents

1. Key State Containers
   - 1.1 AppState - Global Application State Store
   - 1.2 Message / ContentBlock - Conversation Message Data Model
   - 1.3 Tool - Base Tool Definition
   - 1.4 Task - Task Management
   - 1.5 PermissionRule / PermissionResult - Permission Rules and Decision Results
   - 1.6 CostTracker - Cost Tracking
2. Control-flow Algorithm Diagrams
   - 2.1 Conversation Scheduling (Core Loop)
   - 2.2 Tool Scheduling
   - 2.3 Permission-control Algorithm
   - 2.4 Context Management
   - 2.5 Communication Architecture
3. Phase 5 Module Selection Strategy


## 1. Key State Containers

Claude Code's runtime is driven by six core state containers. Each serves a different role, and together they form the full data flow from user input to API calls, and from tool execution to permission decisions.

### 1.1 AppState - Global Application State Store

**Role**: The single source of truth for global application state, using a centralized state-management pattern similar to Redux.

**Source files**:

| File | Responsibility |
|------|------|
| `src/state/AppState.tsx` | State-type definitions and the React Context provider |
| `src/state/AppStateStore.ts` | Store implementation and read/write operations |
| `src/state/store.ts` | Global store creation and initialization |
| `src/state/selectors.ts` | Selector pattern for derived state |
| `src/state/onChangeAppState.ts` | State-change listeners and side-effect triggers |
| `src/state/teammateViewHelpers.ts` | State helpers for teammate views |

**State dimensions it manages**:

```
AppState
├── Tool execution state
│   ├── Currently running tools
│   ├── Tool-result cache
│   └── Streaming execution progress
├── Permission decision cache
│   ├── Authorized rules
│   ├── Denied rules
│   └── Auto-approval mode state
├── UI state
│   ├── Modal stack (permission dialogs, settings panels, etc.)
│   ├── Notification queue
│   ├── Currently focused component
│   └── Terminal size and layout
├── Session information
│   ├── Conversation history (message array)
│   ├── Session ID and metadata
│   ├── Current model configuration
│   └── API connection status
├── Task management
│   ├── Background task list
│   ├── Agent subprocess status
│   └── Swarm collaboration state
└── Configuration snapshot
    ├── User settings
    ├── Project settings
    └── Managed settings (MDM)
```

**Selector pattern** (`selectors.ts`):

Selectors are pure functions that derive computed values from raw state. Claude Code wraps frequently accessed derived data in selectors so consumers do not need to recompute the same values repeatedly. A typical pattern looks like this:

```typescript
// Pseudocode inferred from the source map
function selectActiveTools(state: AppState): Tool[] {
  return state.tools.filter(t => t.status === 'executing');
}

function selectTotalCost(state: AppState): number {
  return state.costTracker.getTotalCostUSD();
}

function selectCurrentPermissionMode(state: AppState): PermissionMode {
  return state.settings.toolPermissionMode ?? 'default';
}
```

**Change-listening mechanism** (`onChangeAppState.ts`):

Whenever state changes, registered side-effect handlers are triggered. These effects include:

- Persisting sessions to disk automatically through `sessionStorage.ts`
- Updating the terminal title through `useTerminalTitle.ts`
- Triggering Bridge synchronization to push state to claude.ai
- Refreshing MCP connection state
- Updating the status line

**Integration with React/Ink**:

AppState is injected into the Ink component tree through React Context. Components read it via `useAppState()` and update it through `setAppState()`. Because Ink renders terminal UI through the React Reconciler, state changes trigger the normal diff-and-patch cycle across the component tree.


### 1.2 Message / ContentBlock - Conversation Message Data Model

**Role**: Conversation messages are the core data carrier in Claude Code. They hold all user input, model output, tool invocations, and tool results.

**Source files**:

| File | Responsibility |
|------|------|
| `src/utils/messages.ts` | Message utility functions for construction, filtering, and transformation |
| `src/utils/messages/mappers.ts` | Mapping between internal and API message formats |
| `src/utils/messages/systemInit.ts` | System-message initialization |
| `src/utils/messagePredicates.ts` | Message-type predicate helpers |
| `src/utils/contentArray.ts` | `ContentBlock[]` operations |
| `src/components/Message.tsx` | Message rendering component |
| `src/components/MessageRow.tsx` | Message-row layout |
| `src/components/Messages.tsx` | Message-list container |

**Message type hierarchy**:

```
Message
├── UserMessage
│   ├── User text input (prompt)
│   ├── Tool execution result (tool_result)
│   ├── Image attachments
│   ├── Bash input / output
│   ├── Command output
│   ├── Agent notifications
│   ├── Resource updates
│   ├── Memory-file input
│   └── Channel messages (Bridge)
└── AssistantMessage
    ├── Text response (text)
    ├── Reasoning trace (thinking / redacted_thinking)
    ├── Tool invocation request (tool_use)
    └── Server-side tool use
```

**ContentBlock type enumeration**:

ContentBlock is the atomic content unit inside a message. Anthropic's Messages API defines the following block types:

| Type | Description | Direction |
|------|------|------|
| `text` | Plain-text content | Bidirectional |
| `tool_use` | Tool invocation request containing tool name and input JSON | Assistant -> system |
| `tool_result` | Tool execution result containing output and errors | System -> API |
| `image` | Base64-encoded image supporting JPEG, PNG, GIF, and WebP | User -> API |
| `thinking` | Extended thinking content | Internal to assistant output |
| `redacted_thinking` | Redacted thinking content | Internal to assistant output |
| `server_tool_use` | Server-side tool usage such as `web_search` | Internal to API flow |

**Message normalization and cleanup**:

Before messages are sent to the API, Claude Code performs several normalization steps:

1. **Message merging**: Consecutive messages from the same role are merged because the API expects a strictly alternating user/assistant sequence.
2. **Media stripping**: When media items exceed the API limit of 100, `stripExcessMediaItems` removes the oldest ones.
3. **Thinking-block cleanup**: Thinking blocks are kept or removed depending on configuration and model support.
4. **Tool-result truncation**: Very large tool outputs are truncated or persisted to disk, with only a summary kept inline.
5. **System-message injection**: The system prompt is injected at the front of the effective message list, including CLAUDE.md, tool definitions, permission rules, and related context.

**Message predicates** (`messagePredicates.ts`):

Type-safe predicate helpers are provided for tasks such as:

- `isUserMessage(msg)` / `isAssistantMessage(msg)`
- `hasToolUse(msg)` / `hasToolResult(msg)`
- `isThinkingBlock(block)` / `isTextBlock(block)`

These predicates are used extensively in rendering, message filtering, and context compaction.


### 1.3 Tool - Base Tool Definition

**Role**: Tool is one of Claude Code's core abstractions. Each tool encapsulates one discrete capability such as reading a file, executing a command, or searching code, and Claude can invoke these capabilities during a conversation.

**Source files**:

| File | Responsibility |
|------|------|
| `src/Tool.ts` | Base Tool class / interface definition |
| `src/tools.ts` | Tool registry and discovery |
| `sdk-tools.d.ts` | TypeScript input/output definitions for all tools |
| `src/utils/toolPool.ts` | Tool-pool management including lazy loading and on-demand activation |
| `src/utils/toolSchemaCache.ts` | JSON Schema cache for tools |
| `src/utils/toolSearch.ts` | Tool search and fuzzy matching |
| `src/utils/embeddedTools.ts` | Embedded-tool configuration |

**Tool interface** (inferred from `sdk-tools.d.ts`):

```typescript
interface Tool {
  // Core properties
  name: string;                    // Unique tool identifier
  description: string;             // Tool description injected into the system prompt
  inputSchema: JSONSchema;         // JSON Schema for tool input

  // Execution
  execute(input: ToolInput): Promise<ToolResult>;

  // Permissions
  isReadOnly?(): boolean;          // Whether the tool is read-only
  needsPermission?(): boolean;     // Whether the tool requires user approval

  // UI
  renderToolUse?(props): ReactNode;      // Render UI while the tool is running
  renderToolResult?(props): ReactNode;   // Render UI for the tool result

  // Prompting
  prompt?(): string;               // Detailed usage instructions for the tool
}
```

**Representative tool inventory** (from `src/tools/` in the source map):

| Tool Category | Tool Name | Source Directory | Description |
|----------|----------|--------|------|
| **Filesystem** | FileRead | `FileReadTool/` | Reads file content including text, images, PDFs, and notebooks |
| | FileEdit | `FileEditTool/` | Precise string-replacement editing |
| | FileWrite | `FileWriteTool/` | Creates or fully overwrites files |
| | Glob | `GlobTool/` | File-pattern search |
| | Grep | `GrepTool/` | Content search via ripgrep |
| | NotebookEdit | `NotebookEditTool/` | Jupyter Notebook cell editing |
| **Command execution** | Bash | `BashTool/` | Executes shell commands, with 18 submodules |
| | PowerShell | `PowerShellTool/` | Runs Windows PowerShell commands |
| **Agent system** | Agent | `AgentTool/` | Creates and runs sub-agents, with 20 submodules |
| | SendMessage | `SendMessageTool/` | Sends messages to a specific agent |
| **Task management** | TaskCreate | `TaskCreateTool/` | Creates tracked tasks |
| | TaskGet | `TaskGetTool/` | Retrieves task status |
| | TaskList | `TaskListTool/` | Lists all tasks |
| | TaskUpdate | `TaskUpdateTool/` | Updates task state |
| | TaskOutput | `TaskOutputTool/` | Retrieves background-task output |
| | TaskStop | `TaskStopTool/` | Stops a running task |
| | TodoWrite | `TodoWriteTool/` | Writes todo lists |
| **MCP integration** | MCP | `MCPTool/` | Invokes tools provided by MCP servers |
| | ListMcpResources | `ListMcpResourcesTool/` | Lists MCP resources |
| | ReadMcpResource | `ReadMcpResourceTool/` | Reads MCP resource content |
| | McpAuth | `McpAuthTool/` | Handles MCP authentication |
| **Network** | WebFetch | `WebFetchTool/` | Fetches web-page content |
| | WebSearch | `WebSearchTool/` | Searches the web |
| **Conversation control** | AskUserQuestion | `AskUserQuestionTool/` | Asks the user a multiple-choice question |
| | EnterPlanMode | `EnterPlanModeTool/` | Enters plan mode |
| | ExitPlanMode | `ExitPlanModeTool/` | Exits plan mode and submits the plan |
| **Configuration** | Config | `ConfigTool/` | Reads and writes runtime configuration |
| **Workspace** | EnterWorktree | `EnterWorktreeTool/` | Creates an isolated Git worktree |
| | ExitWorktree | `ExitWorktreeTool/` | Exits and optionally cleans up a worktree |
| **Skills** | Skill | `SkillTool/` | Invokes registered skills |
| **Remote triggering** | RemoteTrigger | `RemoteTriggerTool/` | Triggers a remote agent |
| **Scheduled tasks** | CronCreate | `ScheduleCronTool/` | Creates scheduled jobs |
| | CronDelete | `ScheduleCronTool/` | Deletes scheduled jobs |
| | CronList | `ScheduleCronTool/` | Lists scheduled jobs |
| **Tool search** | ToolSearch | `ToolSearchTool/` | Searches available tool definitions |
| **Code analysis** | LSP | `LSPTool/` | Language Server Protocol interaction |
| **Briefing** | Brief | `BriefTool/` | Generates brief summaries |
| **Other** | SyntheticOutput | `SyntheticOutputTool/` | Internal synthetic-output tool |
| | REPL | `REPLTool/` | Interactive evaluation via primitive tools |
| | TeamCreate | `TeamCreateTool/` | Creates a team |
| | TeamDelete | `TeamDeleteTool/` | Deletes a team |

**Tool registry architecture**:

```
Tool Registry (tools.ts)
├── Built-in tools (src/tools/*)
│   └── 30+ tool classes, each typically containing:
│       ├── *Tool.ts      - tool logic
│       ├── UI.tsx        - terminal UI rendering
│       ├── prompt.ts     - prompt text injected into the system prompt
│       └── constants.ts  - tool-name and related constants
├── MCP dynamic tools (src/tools/MCPTool/)
│   └── Discovered and registered from MCP servers at runtime
├── Plugin tools (src/plugins/)
│   └── Third-party tools supplied through the plugin system
└── Lazy-loaded tools (toolPool.ts)
    └── Activated on demand to reduce startup cost
```

**Tool pool and lazy loading**:

`toolPool.ts` implements lazy loading. Not all 30+ tools are initialized at startup; lower-frequency tools such as cron and team-management tools are only initialized when first needed. The ToolSearch tool exists partly for this reason: Claude can inspect schema definitions first and then decide whether a tool should actually be invoked.


### 1.4 Task - Task Management

**Role**: Task is the basic unit of Claude Code's concurrent execution framework. A task represents an independent execution context such as a local shell command, a sub-agent process, a remote agent session, or even a background Dream task.

**Source files**:

| File | Responsibility |
|------|------|
| `src/Task.ts` | Core task-type definitions |
| `src/tasks.ts` | Task manager and collection operations |
| `src/tasks/types.ts` | Extended task-type definitions |
| `src/tasks/DreamTask/DreamTask.ts` | Dream background-thinking task |
| `src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx` | In-process teammate task |
| `src/tasks/LocalAgentTask/LocalAgentTask.tsx` | Local sub-agent task |
| `src/tasks/LocalMainSessionTask.ts` | Main-session task |
| `src/tasks/LocalShellTask/LocalShellTask.tsx` | Local shell-command task |
| `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx` | Remote-agent task |
| `src/tasks/stopTask.ts` | Task-stopping logic |
| `src/tasks/pillLabel.ts` | Task-status badge rendering |

**TaskType enumeration**:

```typescript
type TaskType =
  | 'local_bash'              // Local Bash / shell command execution
  | 'local_agent'             // Local agent subprocess
  | 'remote_agent'            // Remote agent via API
  | 'in_process_teammate'     // In-process teammate in swarm mode
  | 'local_workflow'          // Local workflow
  | 'monitor_mcp'             // MCP server monitoring
  | 'dream';                  // Background Dream thinking
```

**TaskStatus state machine**:

```
                    ┌──────────┐
                    │ pending  │  Task created, waiting for scheduling
                    └────┬─────┘
                         │ scheduled
                         ▼
                    ┌──────────┐
                    │ running  │  Task executing
                    └────┬─────┘
                    ╱    │    ╲
        normal exit╱     │     ╲ abnormal exit
                 ╱       │       ╲
    ┌───────────┐  ┌─────┴────┐  ┌─────────┐
    │ completed │  │  failed  │  │ killed  │
    └───────────┘  └──────────┘  └─────────┘
      terminal        terminal      terminal
```

```typescript
type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed';

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed';
}
```

**TaskContext runtime context**:

Each task holds a TaskContext that includes:

```typescript
interface TaskContext {
  abortController: AbortController;   // Cancellation signal controller
  getAppState: () => AppState;        // Read current application state
  setAppState: (patch) => void;       // Update application state
  taskId: string;                     // Unique task ID
  parentTaskId?: string;              // Parent task ID for nested scenarios
}
```

**Task execution lifecycle**:

```
Create task
    │
    ├── Register in AppState.tasks
    ├── Create AbortController
    └── Initialize TaskOutput
         │
         ▼
    Schedule execution
    │
    ├── local_bash: spawn child process + stdin/stdout pipes
    ├── local_agent: fork child process + message passing
    ├── in_process_teammate: create a new agent loop inside the same process
    ├── remote_agent: create a remote session through the API
    ├── dream: background API call for thinking
    └── monitor_mcp: establish and monitor MCP connections
         │
         ▼
    Update state (running -> completed / failed / killed)
    │
    ├── Collect output (TaskOutput)
    ├── Persist output to disk (diskOutput.ts)
    ├── Update AppState
    └── Clean up resources (AbortController.abort())
```

**Special handling for shell tasks** (`LocalShellTask/`):

Shell tasks include additional safeguards:

- `guards.ts` for pre-execution safety checks
- `killShellTasks.ts` for bulk termination logic
- Timeout control, up to `600000ms` / 10 minutes
- Backgrounding support, either through `Ctrl+B` or automatic backgrounding for long-running commands


### 1.5 PermissionRule / PermissionResult - Permission Rules and Decision Results

**Role**: Claude Code implements a fine-grained permission engine that governs what Claude is allowed to do. This system is the core of the product's safety model.

**Source files**:

| File | Responsibility |
|------|------|
| `src/utils/permissions/PermissionMode.ts` | Permission-mode definitions |
| `src/utils/permissions/PermissionResult.ts` | Result type for permission decisions |
| `src/utils/permissions/PermissionRule.ts` | Permission-rule data structure |
| `src/utils/permissions/PermissionUpdate.ts` | Rule-update operations |
| `src/utils/permissions/permissions.ts` | Core permission-engine logic |
| `src/utils/permissions/permissionsLoader.ts` | Permission-configuration loading |
| `src/utils/permissions/permissionRuleParser.ts` | Rule parser |
| `src/utils/permissions/permissionExplainer.ts` | Human-readable decision explanations |
| `src/utils/permissions/pathValidation.ts` | Path-level permission validation |
| `src/utils/permissions/filesystem.ts` | Filesystem permissions |
| `src/utils/permissions/bashClassifier.ts` | Safety classifier for Bash commands |
| `src/utils/permissions/dangerousPatterns.ts` | Dangerous-command pattern detection |
| `src/utils/permissions/yoloClassifier.ts` | Safety classifier for auto-approval mode |
| `src/utils/permissions/classifierDecision.ts` | Classifier decision structure |
| `src/utils/permissions/classifierShared.ts` | Shared classifier logic |
| `src/utils/permissions/shellRuleMatching.ts` | Rule-matching algorithm for shell commands |
| `src/utils/permissions/denialTracking.ts` | Tracking denied decisions |
| `src/utils/permissions/shadowedRuleDetection.ts` | Detection of shadowed rules |
| `src/utils/permissions/autoModeState.ts` | Auto-mode state |
| `src/utils/permissions/getNextPermissionMode.ts` | Permission-mode transitions |
| `src/utils/permissions/permissionSetup.ts` | Permission-system initialization |
| `src/utils/permissions/bypassPermissionsKillswitch.ts` | Emergency kill switch for bypass mode |
| `src/types/permissions.ts` | Exported permission types |

**Five permission modes**:

```typescript
type PermissionMode =
  | 'default'           // Ask the user about every sensitive operation
  | 'plan'              // Generate a plan first, then execute only after approval
  | 'acceptEdits'       // Auto-approve file edits, ask about everything else
  | 'bypassPermissions' // Skip all permission checks (dangerous)
  | 'dontAsk';          // Never ask; reject any operation that would require approval
```

**Permission-rule data structure**:

```typescript
interface PermissionRule {
  tool: string;                 // Target tool, e.g. 'Bash' or 'FileEdit'
  action: 'allow' | 'deny';     // Allow or deny
  pattern?: string;             // Regex or glob-style match pattern
  scope?: 'session' | 'project' | 'global';
  reason?: string;              // Explanation for the rule
}
```

**Permission decision result**:

```typescript
interface PermissionResult {
  allowed: boolean;             // Whether execution is allowed
  reason: string;               // Human-readable decision reason
  rule?: PermissionRule;        // The matching rule, if any
  needsUserApproval?: boolean;  // Whether a confirmation dialog is required
}
```

**Rule-matching priority** from highest to lowest:

```
1. Global bypassPermissions switch -> allow everything
2. Session-level rules created explicitly during this session
3. Project-level rules from .claude/settings.json
4. Global rules from ~/.claude/settings.json
5. Managed enterprise rules delivered through MDM
6. Tool default behavior
```

### 1.6 CostTracker - Cost Tracking

**Role**: Tracks token usage and API cost in real time so that users can see consumption and stay within budget.

**Source files**:

| File | Responsibility |
|------|------|
| `src/cost-tracker.ts` | Core cost-tracker implementation, about 324 lines |
| `src/costHook.ts` | React Hook wrapper for UI consumption |
| `src/utils/modelCost.ts` | Per-model pricing configuration |
| `src/utils/tokens.ts` | Token counting and estimation |
| `src/services/tokenEstimation.ts` | Token-estimation service |
| `src/commands/cost/cost.ts` | `/cost` command |
| `src/commands/usage/usage.tsx` | `/usage` command |
| `src/services/api/usage.ts` | API-usage query support |
| `src/services/claudeAiLimits.ts` | claude.ai usage-limit handling |

**Tracking dimensions**:

```typescript
interface CostTracker {
  // Token counts
  getTotalInputTokens(): number;
  getTotalOutputTokens(): number;
  getCacheCreationInputTokens(): number;
  getCacheReadInputTokens(): number;

  // Cost
  getTotalCostUSD(): number;

  // Performance metrics
  getTotalAPIDuration(): number;
  getTotalToolDuration(): number;

  // Rate-limit tracking
  getRateLimitStatus(): {
    five_hour: RateLimitInfo;
    seven_day: RateLimitInfo;
    seven_day_opus: RateLimitInfo;
    extra_usage: RateLimitInfo;
  };
}
```

**Cache economics**:

CostTracker distinguishes four token categories so it can model cost precisely:

| Token Type | Relative Cost | Description |
|-----------|----------|------|
| Standard input token | 1x | Input that misses cache |
| Cache-creation token | 1.25x | Cost of writing a prompt into cache for the first time |
| Cache-read token | 0.1x | Cost of reading input from cache |
| Output token | 5x relative to input | Model-generated output |

Caching directly affects cost. Claude Code's prompt-cache break detection in `promptCacheBreakDetection.ts` watches for situations where the cache is invalidated and tries to preserve cache stability at the system-prompt level.

**Rate-limit tracking**:

```
Rate-limit windows
├── five_hour       - usage cap in a rolling 5-hour window
├── seven_day       - overall 7-day usage cap
├── seven_day_opus  - 7-day cap specific to Opus usage
└── extra_usage     - purchased extra-usage quota
```

When usage approaches a limit, `useRateLimitWarningNotification.tsx` displays a warning at the bottom of the terminal, and `rateLimitMessages.ts` generates readable explanations.


## 2. Control-flow Algorithm Diagrams

### 2.1 Conversation Scheduling (Core Loop)

At the center of Claude Code is an **agent loop**, also described as a **ReAct loop**: reasoning followed by action. This is the application's main heartbeat.

**Core-loop pseudocode**:

```typescript
// Simplified core logic of the agent loop
async function agentLoop(context: TaskContext) {
  while (!context.abortController.signal.aborted) {
    // 1. Collect user input
    const userInput = await waitForUserInput();

    // 2. Process input: commands, text, attachments
    const processedInput = processUserInput(userInput);
    // processUserInput.ts -> processBashCommand.tsx
    //                     -> processSlashCommand.tsx
    //                     -> processTextPrompt.ts

    // 3. Build the message list with full history
    let messages = buildMessageList(
      context.getAppState().conversationHistory,
      processedInput
    );

    // 4. Check context-window capacity
    if (shouldAutoCompact(messages)) {
      messages = await autoCompact(messages);
    }

    // 5. Inner API loop to resolve tool chains
    let continueLoop = true;
    while (continueLoop) {
      const stream = await claude.messages.create({
        model: currentModel,
        system: buildSystemPrompt(),
        messages,
        stream: true,
        tools: getAvailableTools(),
      });

      const response = await processStream(stream);

      if (response.hasToolUse()) {
        const toolResults = await executeTools(response.toolUses);
        messages.push(assistantMessage(response));
        messages.push(userMessage(toolResults));
        continueLoop = true;
      } else {
        displayResponse(response);
        continueLoop = false;
      }
    }
  }
}
```

**Stream-processing pipeline**:

```
API Server (Anthropic / AWS Bedrock / Google Vertex)
    │
    │ SSE (Server-Sent Events) stream
    ▼
StreamProcessor (src/utils/stream.ts)
    │
    ├── message_start         -> initialize message container
    ├── content_block_start   -> create ContentBlock
    ├── content_block_delta   -> incrementally update content
    │   ├── text_delta        -> render text progressively
    │   ├── input_json_delta  -> build tool-input JSON progressively
    │   └── thinking_delta    -> update thinking content
    ├── content_block_stop    -> finalize a ContentBlock
    │   └── if tool_use -> trigger tool execution
    ├── message_delta         -> update message-level metadata
    │   ├── stop_reason: end_turn | tool_use | max_tokens
    │   └── usage statistics
    └── message_stop          -> finalize the message
         │
         ▼
    Ink UI renders incrementally through React Reconciler
```

**`stop_reason` branching**:

| `stop_reason` | Meaning | Follow-up |
|-------------|------|---------|
| `end_turn` | Claude ended the reply on its own | Exit the inner loop and wait for user input |
| `tool_use` | Claude requested one or more tools | Execute tools, feed results back, and continue |
| `max_tokens` | Output token cap reached | May trigger continuation or prompt the user |

**Message-flow diagram**:

```
User terminal input
    │
    ▼
processUserInput()
    │
    ├── /command -> processSlashCommand() -> local execution
    ├── !bash    -> processBashCommand()  -> direct shell execution
    └── text     -> processTextPrompt()   -> API call path
         │
         ▼
    ┌─────────────────────────────────┐
    │        Message Pipeline         │
    │                                 │
    │  System messages                │
    │  ├── System Prompt              │
    │  │   ├── CLAUDE.md              │
    │  │   ├── Tool definitions       │
    │  │   ├── Permission summary     │
    │  │   └── Output-style guidance  │
    │  │                              │
    │  Conversation history           │
    │  ├── User: previous inputs      │
    │  ├── Assistant: previous replies│
    │  ├── User: tool results         │
    │  └── ... (possibly compacted)   │
    │  │                              │
    │  Current input                  │
    │  └── User: latest input         │
    └────────────┬────────────────────┘
                 │
                 ▼
          Anthropic Messages API
                 │
                 ▼
          Streamed response handling
                 │
          ┌──────┴──────┐
          │             │
       tool_use      text only
          │             │
          ▼             ▼
    Tool-execution     Ink UI render
    pipeline (2.2)     (display to user)
          │
          ▼
    Feed results back to API
    (continue the inner loop)
```


### 2.2 Tool Scheduling

**Tool execution pipeline** (`src/services/tools/`):

| File | Responsibility |
|------|------|
| `StreamingToolExecutor.ts` | Streaming executor that manages the tool lifecycle |
| `toolExecution.ts` | Core tool-execution logic: validation, execution, output formatting |
| `toolHooks.ts` | Pre- and post-execution hooks |
| `toolOrchestration.ts` | Orchestration strategy for parallel and serial tool execution |

**Full scheduling flow**:

```
API response contains a tool_use ContentBlock
    │
    ▼
Step 1: Parse the invocation
    ├── Extract tool name from the content block
    ├── Build input arguments incrementally from input_json_delta
    └── Obtain full input on content_block_stop
    │
    ▼
Step 2: Lookup the tool
    ├── Search built-in tool registry
    ├── If not found, search MCP tool registry
    ├── If still not found, search plugin tools
    └── If still missing -> return a tool-not-found error
    │
    ▼
Step 3: Validate input
    ├── Validate against the tool's inputSchema (JSON Schema)
    ├── Check required fields
    ├── Type-check primitives and composite types
    └── Run tool-specific validation such as FileEdit path checks
    │
    ▼
Step 4: Permission check (see 2.3)
    ├── Evaluate matching permission rules
    ├── If allowed -> continue
    ├── If denied -> return denial result
    ├── If user approval is required -> show permission dialog
    │   ├── User approves -> record rule, continue
    │   └── User denies -> record rule, return denial result
    └── Read-only tools such as Glob, Grep, and FileRead are usually auto-allowed
    │
    ▼
Step 5: Pre-execution hooks (toolHooks.ts)
    ├── Inspect hook configuration from settings.json
    ├── Initialize file-change watchers (fileChangedWatcher.ts)
    ├── Start Git-operation tracking (gitOperationTracking.ts)
    └── Run user-configured pre hooks
    │
    ▼
Step 6: Execute the tool (toolExecution.ts)
    │
    ├── Bash tools:
    │   ├── Check whether sandboxing should be enabled
    │   ├── spawn subprocess
    │   ├── manage stdin/stdout/stderr pipes
    │   ├── enforce timeouts (default 120s, max 600s)
    │   ├── truncate oversized output and persist it to disk
    │   └── support backgrounding
    │
    ├── File tools:
    │   ├── normalize and validate absolute paths
    │   ├── use fileReadCache.ts
    │   ├── preserve atomicity for edits
    │   ├── store file-history snapshots
    │   └── generate Git-style diffs
    │
    ├── Agent tools:
    │   ├── create sub-agents
    │   ├── isolate context with separate message history and state
    │   ├── select model independently from parent if needed
    │   ├── support background execution
    │   └── aggregate and summarize results
    │
    └── MCP tools:
        ├── invoke the MCP client
        ├── serialize / deserialize payloads
        └── apply timeout and retry logic
    │
    ▼
Step 7: Post-execution hooks (toolHooks.ts)
    ├── Detect and notify file changes
    ├── finalize Git-operation tracking
    ├── send analytics events
    └── run user-configured post hooks
    │
    ▼
Step 8: Format the result
    ├── Build tool_result ContentBlock
    ├── Truncate oversized output and reference persisted content
    ├── Assemble structured output such as line numbers or diffs
    ├── Format error content
    └── Append the result to the message list as a user message and send it back to the API
```

**Streaming behavior in `StreamingToolExecutor`**:

```typescript
class StreamingToolExecutor {
  onInputJsonDelta(delta: string) {
    this.partialInput += delta;
    this.updateUI(this.partialInput);
  }

  onContentBlockStop() {
    const input = JSON.parse(this.partialInput);
    this.execute(input);
  }
}
```

The key idea is that Claude Code starts preparing the execution environment while the `tool_use` input JSON is still streaming, instead of waiting until the full input payload has already arrived.

**Multi-tool orchestration** (`toolOrchestration.ts`):

When Claude emits several `tool_use` blocks in one response, Claude Code chooses an execution strategy:

```
Multiple tool_use blocks in one response
    │
    ├── Independent tools, e.g. several FileRead calls -> run in parallel
    │
    ├── Dependent tools, e.g. FileRead -> FileEdit -> run serially
    │
    └── Mixed cases -> grouped execution
         └── run independent groups in parallel, then dependent groups serially
```


### 2.3 Permission-control Algorithm

Claude Code implements a three-layer permission-control system so that AI actions stay inside safety boundaries that remain visible and understandable to the user.

**Three-layer permission architecture**:

```
┌─────────────────────────────────────────────┐
│          Global Layer                       │
│                                             │
│  toolPermissionMode determines strategy     │
│  ├── default           -> continue to tool layer
│  ├── plan              -> require plan-first flow
│  ├── acceptEdits       -> auto-approve file edits
│  ├── bypassPermissions -> skip checks
│  └── dontAsk           -> deny everything requiring approval
└─────────────────┬───────────────────────────┘
                  │ (in default mode)
                  ▼
┌─────────────────────────────────────────────┐
│          Tool Layer                         │
│                                             │
│  PermissionRule[] matching per tool         │
│  ├── allow match -> allow                   │
│  ├── deny match  -> deny                    │
│  └── no match    -> fall back to tool default
│                                             │
│  Tool defaults                              │
│  ├── read-only tools -> allow by default
│  ├── write tools     -> ask user by default
│  └── execution tools -> continue to command layer
└─────────────────┬───────────────────────────┘
                  │ (for Bash-like tools)
                  ▼
┌─────────────────────────────────────────────┐
│          Command Layer                      │
│                                             │
│  Bash-specific safety analysis              │
│  ├── dangerousPatterns checks              │
│  ├── bashClassifier classification         │
│  ├── yoloClassifier auto-mode evaluation   │
│  └── pathValidation                        │
└─────────────────────────────────────────────┘
```

**Dangerous pattern detection** (`dangerousPatterns.ts`):

```
Risk level 1: remote code execution
├── curl ... | sh/bash
├── wget -O - ... | bash
├── eval $(curl ...)
└── python -c "$(curl ...)"

Risk level 2: data destruction
├── rm -rf /
├── rm -rf ~
├── mkfs.*
├── dd if=/dev/zero of=...
└── > /dev/sda

Risk level 3: system-level operations
├── sudo ...
├── chmod -R 777 /
├── chown -R ...
└── iptables ...

Risk level 4: network exposure
├── nc -l ...
├── ssh -R ...
└── scp / rsync to external addresses
```

**Bash classifier** (`bashClassifier.ts`):

```typescript
type BashClassification =
  | 'readonly'    // ls, cat, grep, find, etc.
  | 'safe_write'  // git add, npm install, similar bounded writes
  | 'dangerous'   // never auto-approved
  | 'unknown';    // requires user confirmation
```

Classifier decision flow:

```
Input: Bash command string
    │
    ▼
Step 1: Parse command
    ├── extract the primary command, accounting for pipes, redirects, and subshells
    ├── parse flags and arguments
    └── handle heredocs and command substitution
    │
    ▼
Step 2: Read-only detection
    ├── check whether the command is in the read-only allowlist
    ├── classify git subcommands
    │   ├── git status/log/diff/show -> readonly
    │   ├── git add/commit/push      -> write
    │   └── git reset --hard         -> dangerous
    └── if all commands in a pipeline are readonly -> whole pipeline is readonly
    │
    ▼
Step 3: sed edit validation
    ├── parse sed expressions
    ├── detect in-place edits via -i
    ├── if in-place -> treat like FileEdit
    └── if stdout only -> treat like readonly
    │
    ▼
Step 4: Path validation
    ├── extract file paths referenced by the command
    ├── ensure paths remain inside allowed working directories
    ├── detect access to critical system paths
    └── crossing workspace boundaries -> require extra review
    │
    ▼
Step 5: Semantic analysis
    ├── analyze expected side effects
    ├── detect destructive actions
    └── validate against active mode rules
```

**`yoloClassifier` as the last safety line**:

Even when the user enables `bypassPermissions`, Claude Code still applies a final sanity check:

```
yoloClassifier safety tiers
├── absolutely blocked, even in bypass mode
│   ├── rm -rf /
│   ├── curl | sh
│   ├── dd if=/dev/zero of=/dev/sda
│   └── similar destructive system-level commands
├── high-risk warning, allowed in bypass mode but surfaced as dangerous
│   ├── sudo commands
│   ├── large-scale deletion
│   └── system-configuration changes
└── normal pass-through in bypass mode
    └── all other commands
```

**Permission UI interaction**:

When execution requires explicit approval, Claude Code renders a dedicated permission dialog. Each tool family has specialized components under `src/components/permissions/`, including:

- `PermissionDialog.tsx`
- `PermissionRequest.tsx`
- `PermissionPrompt.tsx`
- `PermissionExplanation.tsx`
- `PermissionRuleExplanation.tsx`
- `BashPermissionRequest/`
- `FileEditPermissionRequest/`
- `FileWritePermissionRequest/`
- `FilesystemPermissionRequest/`
- `NotebookEditPermissionRequest/`
- `SedEditPermissionRequest/`
- `PowerShellPermissionRequest/`
- `WebFetchPermissionRequest/`
- `SandboxPermissionRequest.tsx`
- `SkillPermissionRequest/`
- `ComputerUseApproval/`
- `EnterPlanModePermissionRequest/`
- `ExitPlanModePermissionRequest/`
- `AskUserQuestionPermissionRequest/`
- the rules-management UI under `rules/`
- worker and swarm-related components such as `WorkerBadge.tsx` and `WorkerPendingPermission.tsx`


### 2.4 Context Management

Context management is central to the quality and efficiency of long-running conversations. Because LLM context windows are finite, Claude Code must balance information retention against space efficiency.

**Context-management subsystem** (`src/services/compact/`):

| File | Responsibility |
|------|------|
| `compact.ts` | Full-history compaction logic |
| `autoCompact.ts` | Automatic compaction trigger based on context usage |
| `microCompact.ts` | Lightweight local compaction |
| `apiMicrocompact.ts` | API-driven micro-compaction |
| `grouping.ts` | Message grouping for compactable regions |
| `prompt.ts` | Prompt instructions for compaction |
| `postCompactCleanup.ts` | Cleanup after compaction |
| `sessionMemoryCompact.ts` | Compaction based on session memory |
| `compactWarningHook.ts` | Warning hook for compaction thresholds |
| `compactWarningState.ts` | State management for warnings |
| `timeBasedMCConfig.ts` | Time-based micro-compaction configuration |

**Three-level compaction strategy**:

```
Context-window usage
    │
    0%                    70%              85%              95%        100%
    ├─────────────────────┼────────────────┼────────────────┼──────────┤
    │ Normal              │ Micro-compact  │ Auto-compact   │ Emergency │
    │ (no action)         │ zone           │ zone           │ compact   │
    │                     │                │                │           │
    │                     │ trim low-value │ summarize full │ aggressive│
    │                     │ tool output    │ history        │ pruning   │
    │                     │                │ keep essentials│ keep only │
    │                     │                │                │ recent ctx│
```

**Full compaction algorithm** (`compact.ts`):

```
Compaction flow
    │
    ▼
Step 1: Group messages (grouping.ts)
    ├── identify tool-use / tool-result pairs
    ├── identify multi-turn topic segments
    └── mark message groups as important or less important
    │
    ▼
Step 2: Score importance
    ├── recent messages -> high score
    ├── messages with key decisions -> high score
    ├── file-operation messages -> medium score
    ├── large tool output -> low score
    └── repeated read operations -> lowest score
    │
    ▼
Step 3: Compact
    ├── call Claude API to generate a summary
    │   ├── provide a dedicated compaction prompt
    │   ├── require retention of decisions, file paths, and change summaries
    │   └── allow verbose or repetitive tool output to be dropped
    ├── replace the original message region with the compact summary
    │   └── insert CompactBoundary markers in the UI
    └── cleanup
        ├── remove orphaned tool_result entries
        ├── merge adjacent text blocks
        └── update message-ID mappings
```

**Automatic compaction trigger** (`autoCompact.ts`):

```typescript
function shouldAutoCompact(messages: Message[]): boolean {
  const totalTokens = estimateTokenCount(messages);
  const windowSize = getContextWindowSize(currentModel);
  const usageRatio = totalTokens / windowSize;

  if (usageRatio > 0.85) return true;
  if (messages.length > MAX_MESSAGE_COUNT) return true;

  return false;
}
```

**Micro-compaction** (`microCompact.ts`):

Micro-compaction is a lighter-weight strategy that does not call Claude. It applies local rules to trim oversized tool output:

```
microCompact rules
├── Large file-read output -> keep first N lines plus a summary
├── Bash output -> keep head/tail segments
├── Grep results -> limit match count
├── Glob results -> limit list length
├── Error stack traces -> keep only key frames
└── Repeated tool invocations -> merge into a counted summary
```

**Cache optimization** (`promptCacheBreakDetection.ts`):

Anthropic's API supports prompt caching. If the system prompt and prefix messages remain stable across requests, Claude Code can reuse cached key/value state and significantly reduce latency and cost.

```
Cache-break detection
    │
    ▼
Compare current request prefix with previous prefix
    │
    ├── system prompt changed -> cache fully invalidated
    │   └── e.g. CLAUDE.md changed, tool list changed, permission rules changed
    ├── early messages changed -> partial cache invalidation
    │   └── e.g. conversation history was compacted or edited
    └── only new messages appended -> cache remains valid
```

Claude Code intentionally tries to keep the system prompt stable so that cache reuse remains effective.

**Media-item limit management**:

Anthropic's Messages API limits the number of media items such as images and PDFs in one request. `stripExcessMediaItems` handles the overflow case:

```
If media items in messages exceed 100
    │
    ▼
Start from the earliest messages
    ├── replace images with textual placeholders
    │   └── "[Image was here: {description}]"
    ├── replace PDFs with textual references
    │   └── "[PDF was here: {filename}]"
    └── keep the most recent media items until the count falls below the limit
```

**CLAUDE.md and project memory**:

CLAUDE.md acts as Claude Code's project-memory file. It stores project-specific context and instructions and is injected into the system prompt.

```
CLAUDE.md loading hierarchy
├── ~/.claude/CLAUDE.md         - global memory
├── {project}/.claude/CLAUDE.md - project-level memory
├── {project}/CLAUDE.md         - project-root memory
└── subdirectory CLAUDE.md      - directory-scoped memory
    └── loaded only when Claude accesses that directory
```

Related files include:

- `src/utils/claudemd.ts`
- `src/utils/markdownConfigLoader.ts`
- `src/services/SessionMemory/`
- `src/services/extractMemories/`
- `src/memdir/`
- `src/projectOnboardingState.ts`


### 2.5 Communication Architecture

Claude Code maintains five parallel communication channels, each serving a different transport role.

**Overall communication topology**:

```
                         Claude Code CLI process
                               │
          ┌────────────────────┼───────────────────────┐
          │                    │                       │
     ┌────┴────┐         ┌─────┴────┐            ┌─────┴────┐
     │Anthropic│         │  Bridge  │            │   MCP    │
     │  API    │         │  (Web)   │            │ Servers  │
     └────┬────┘         └─────┬────┘            └────┬─────┘
          │                    │                       │
     HTTP/HTTPS           WebSocket                stdio + SSE
     (streaming)            + SSE                  (interprocess)
          │                    │                       │
          │              ┌─────┴────┐                 │
          │              │claude.ai │                 │
          │              │web app   │                 │
          │              └──────────┘                 │
          │                                           │
          │          ┌──────────┐              ┌──────┴──────┐
          │          │Agent IPC │              │MCP Server 1 │
          │          │subprocess│              │MCP Server 2 │
          │          └────┬─────┘              │MCP Server N │
          │               │                    └─────────────┘
          │          fork/exec
          │          + message passing
          │               │
          │          ┌────┴─────┐
          │          │Sub-agent │
          │          │process   │
          │          └──────────┘
          │
          │          ┌──────────┐
          │          │  Bash    │
          │          │ (Shell)  │
          │          └────┬─────┘
          │               │
          │          spawn + pipe
          │          stdin/stdout/stderr
          │               │
          │          ┌────┴─────┐
          │          │Shell proc│
          │          └──────────┘
```

#### Channel 1: Anthropic API (HTTP / HTTPS Streaming)

**Role**: Communicates with Claude itself by sending messages and receiving streamed responses.

**Source files**:

| File | Responsibility |
|------|------|
| `src/services/api/claude.ts` | Claude API client wrapper |
| `src/services/api/client.ts` | HTTP-client configuration |
| `src/services/api/bootstrap.ts` | API-client bootstrap |
| `src/services/api/errors.ts` | API error handling |
| `src/services/api/errorUtils.ts` | API error utilities |
| `src/services/api/withRetry.ts` | Retry logic |
| `src/services/api/logging.ts` | Request/response logging |
| `src/services/api/promptCacheBreakDetection.ts` | Cache-break detection |
| `src/services/api/dumpPrompts.ts` | Debug export of the full prompt |
| `src/services/api/emptyUsage.ts` | Empty usage initializer |
| `src/services/api/firstTokenDate.ts` | Timestamp tracking for the first token |

**Communication flow**:

```typescript
claude.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 16384,
  system: [systemPrompt],
  messages: conversationHistory,
  tools: toolDefinitions,
  stream: true,
  metadata: {
    user_id: hashedUserId,
  },
  thinking: {
    type: "enabled",
    budget_tokens: thinkingBudget,
  },
})
```

**Provider adaptation** (`src/utils/model/providers.ts`):

Claude Code supports multiple providers:

- Anthropic Direct
- AWS Bedrock
- Google Vertex AI
- Custom proxy endpoints via `ANTHROPIC_BASE_URL`

#### Channel 2: Bridge (WebSocket + SSE)

**Role**: Provides bidirectional communication with claude.ai so that terminal sessions can be viewed or controlled from the web app.

**Representative source files** from `src/bridge/`:

- `bridgeApi.ts`
- `bridgeConfig.ts`
- `bridgeDebug.ts`
- `bridgeEnabled.ts`
- `bridgeMain.ts`
- `bridgeMessaging.ts`
- `bridgePermissionCallbacks.ts`
- `bridgePointer.ts`
- `bridgeStatusUtil.ts`
- `bridgeUI.ts`
- `capacityWake.ts`
- `codeSessionApi.ts`
- `createSession.ts`
- `debugUtils.ts`
- `envLessBridgeConfig.ts`
- `flushGate.ts`
- `inboundAttachments.ts`
- `inboundMessages.ts`
- `initReplBridge.ts`
- `jwtUtils.ts`
- `pollConfig.ts`
- `pollConfigDefaults.ts`
- `remoteBridgeCore.ts`
- `replBridge.ts`
- `replBridgeHandle.ts`
- `replBridgeTransport.ts`
- `sessionIdCompat.ts`
- `sessionRunner.ts`
- `trustedDevice.ts`
- `types.ts`
- `workSecret.ts`

**Bridge protocol**:

```
Claude Code CLI                          claude.ai Web
     │                                        │
     │ 1. Create session (POST /session)      │
     │ ──────────────────────────────────────> │
     │                                        │
     │ 2. Establish WebSocket connection       │
     │ <======================================>│
     │                                        │
     │ 3. Push conversation state (message stream)
     │ ───────────────── SSE ────────────────> │
     │                                        │
     │ 4. Receive user actions (messages / approvals)
     │ <──────────── WebSocket ─────────────── │
     │                                        │
     │ 5. Permission callbacks                 │
     │ <────────────────────────────────────── │
     │                                        │
     │ 6. Transfer attachments                 │
     │ <──────── inboundAttachments ────────── │
```

#### Channel 3: MCP (Model Context Protocol)

**Role**: Communicates with external MCP servers to extend Claude Code's tool and resource model.

**Representative source files** from `src/services/mcp/`:

- `InProcessTransport.ts`
- `MCPConnectionManager.tsx`
- `SdkControlTransport.ts`
- `auth.ts`
- `channelAllowlist.ts`
- `channelNotification.ts`
- `channelPermissions.ts`
- `claudeai.ts`
- `client.ts`
- `config.ts`
- `elicitationHandler.ts`
- `envExpansion.ts`
- `headersHelper.ts`
- `mcpStringUtils.ts`
- `normalization.ts`
- `oauthPort.ts`
- `officialRegistry.ts`
- `types.ts`
- `useManageMCPConnections.ts`
- `utils.ts`
- `vscodeSdkMcp.ts`
- `xaa.ts`
- `xaaIdpLogin.ts`

**MCP protocol flow**:

```
Claude Code                              MCP Server
     │                                        │
     │ Transport 1: stdio                     │
     │   spawn MCP server process             │
     │   stdin  ──────────────────────────>   │
     │   stdout <──────────────────────────   │
     │   stderr <──── logs / errors ──────    │
     │                                        │
     │ Transport 2: SSE                       │
     │   HTTP GET /sse ──────────────────>    │
     │   <──── SSE event stream ─────────    │
     │   HTTP POST /message ─────────────>   │
     │                                        │
     │ Transport 3: in-process                │
     │   direct function call                 │
     │                                        │
     │ Protocol:
     │ 1. initialize -> negotiate capabilities
     │ 2. tools/list -> enumerate tools
     │ 3. resources/list -> enumerate resources
     │ 4. tools/call -> invoke tool
     │ 5. resources/read -> read resource
```

#### Channel 4: Agent IPC (Inter-process Communication)

**Role**: Supports communication between the main agent and sub-agents so that work can be delegated and results aggregated.

**Source files**:

| File | Responsibility |
|------|------|
| `src/utils/forkedAgent.ts` | Forks sub-agent processes |
| `src/tools/AgentTool/forkSubagent.ts` | Sub-agent creation |
| `src/tools/AgentTool/runAgent.ts` | Agent execution management |
| `src/tools/shared/spawnMultiAgent.ts` | Concurrent creation of multiple agents |
| `src/utils/swarm/` | Swarm collaboration framework |

**Agent communication model**:

```
Main agent (leader)
    │
    ├── fork/exec sub-agent processes
    │   └── pass prompt, tool permissions, model choice, working directory
    │
    ├── message passing
    │   ├── Leader -> Worker: task dispatch, context injection
    │   ├── Worker -> Leader: progress updates, result return
    │   └── Worker <-> Worker: SendMessage-based peer communication
    │
    └── lifecycle management
        ├── monitor worker state
        ├── enforce timeouts
        ├── recover from worker crashes
        └── clean up resources
```

**Swarm framework** (`src/utils/swarm/`):

Swarm is Claude Code's multi-agent collaboration layer and supports running agents concurrently across multiple terminal panes:

```
src/utils/swarm/
├── constants.ts
├── inProcessRunner.ts
├── leaderPermissionBridge.ts
├── permissionSync.ts
├── reconnection.ts
├── spawnInProcess.ts
├── spawnUtils.ts
├── teamHelpers.ts
├── teammateInit.ts
├── teammateLayoutManager.ts
├── teammateModel.ts
├── teammatePromptAddendum.ts
└── backends/
    ├── ITermBackend.ts
    ├── InProcessBackend.ts
    ├── PaneBackendExecutor.ts
    ├── TmuxBackend.ts
    ├── detection.ts
    ├── it2Setup.ts
    ├── registry.ts
    ├── teammateModeSnapshot.ts
    └── types.ts
```

#### Channel 5: Bash / Shell (spawn + pipe)

**Role**: Executes local shell commands and acts as Claude Code's main channel into the operating system.

**Source files**:

| File | Responsibility |
|------|------|
| `src/utils/Shell.ts` | Shell abstraction |
| `src/utils/ShellCommand.ts` | Shell command wrapper |
| `src/utils/shell/shellProvider.ts` | Shell provider interface |
| `src/utils/shell/bashProvider.ts` | Bash provider |
| `src/utils/shell/powershellProvider.ts` | PowerShell provider |
| `src/utils/shell/resolveDefaultShell.ts` | Default-shell detection |
| `src/utils/shell/outputLimits.ts` | Output-limit management |
| `src/utils/shell/shellToolUtils.ts` | Shell utility helpers |
| `src/utils/shell/prefix.ts` | Shell prefix and environment initialization |
| `src/utils/shell/readOnlyCommandValidation.ts` | Read-only command validation |

**Shell execution flow**:

```
BashTool.execute(command)
    │
    ▼
Inject shell prefix (prefix.ts)
    ├── set PATH
    ├── set HOME
    ├── inject shell configuration
    └── prepend sandbox wrapper if enabled
    │
    ▼
spawn(shell, ['-c', prefixedCommand])
    │
    ├── stdin  -> pipe for interactive input
    ├── stdout -> pipe for streamed output capture
    └── stderr -> pipe for error capture
    │
    ▼
Process output
    ├── stream output into the UI
    ├── enforce output-size limits
    │   ├── if exceeded -> truncate and persist to disk
    │   └── record persisted path in tool_result
    ├── enforce timeout, default 120s
    │   ├── on timeout -> send SIGTERM
    │   └── if still running -> send SIGKILL
    └── handle exit code
        ├── 0 -> success
        ├── non-zero -> include returnCodeInterpretation
        └── signal termination -> mark as interrupted
```


## 3. Phase 5 Module Selection Strategy

Based on the core mechanisms above, the next deep-dive phase focuses on six modules. The selection criteria are: **high architectural complexity, large source-file footprint, tight coupling to the core data flow, and distinctive engineering decisions**.

### Module 1: Tool System

**Why it was selected**: The tool system is the largest subsystem in Claude Code. It contains 30+ tool classes and more than 184 tool-related source files, and it defines every boundary where AI can act on the outside world.

**Deep-dive topics**:

- The complete interface contract of the Tool base class
- Discovery and loading in the tool registry
- Lazy loading in the tool pool
- The streaming execution pipeline in `StreamingToolExecutor`
- Concurrency versus serial orchestration decisions
- The 18-submodule safety architecture inside BashTool
- The 20-submodule recursive execution framework inside AgentTool
- JSON Schema validation for tool input
- Output truncation and persistence strategy

**Core source-file footprint**: about 120+ files across `src/tools/`, `src/services/tools/`, and related tool classes

### Module 2: Permission System

**Why it was selected**: The permission system is Claude Code's security core. It spans 22 dedicated source files and 34 UI component files, implementing a multi-layer safety model from global policy down to individual commands.

**Deep-dive topics**:

- State machine for the five PermissionMode variants
- Rule-matching algorithms including priority, scope, and pattern matching
- AST-like parsing of Bash commands inside `bashClassifier`
- Maintenance strategy for the dangerous-pattern library
- Safety boundaries enforced by `yoloClassifier`
- Edit detection through `sedEditParser`
- Component hierarchy of the permission UI
- Shadowed-rule detection
- Denial tracking and analytics
- Enterprise overrides through MDM-managed settings

**Core source-file footprint**: about 56 files across `src/utils/permissions/` and `src/components/permissions/`

### Module 3: Agent Subprocess System

**Why it was selected**: The agent system implements a complete multi-agent concurrency framework and is one of Claude Code's defining capabilities for complex work. It brings in operating-system-level concerns such as process management, IPC, and state synchronization.

**Deep-dive topics**:

- Responsibility breakdown across the 20 AgentTool submodules
- Sub-agent creation strategies: fork vs in-process vs remote
- Built-in agent types such as `generalPurpose`, `explore`, `plan`, `verification`, and `claudeCodeGuide`
- Terminal backend integration for Swarm across iTerm2, Tmux, and in-process execution
- Leader-worker permission bridging
- Teammate initialization and prompt injection
- Async agent management and result aggregation
- Agent context-isolation strategy
- Worktree-based isolation

**Core source-file footprint**: about 55 files across `src/tools/AgentTool/`, `src/utils/swarm/`, and `src/tasks/`

### Module 4: MCP Integration

**Why it was selected**: MCP is Claude Code's standard extension protocol. The codebase contains a full MCP client supporting three transport modes and several authentication paths.

**Deep-dive topics**:

- Full MCP client implementation in `client.ts`
- Transport adapters for stdio, SSE, and in-process execution
- Connection pooling in the MCP connection manager
- Tool bridging from MCP tools into Claude Code's internal tool model
- Resource reading and caching
- MCP server approval flow
- OAuth integration
- Elicitation handling for interactive information gathering
- Official MCP registry integration
- VS Code SDK MCP integration

**Core source-file footprint**: about 30 files across `src/services/mcp/`, `src/tools/MCPTool/`, `src/tools/ListMcpResourcesTool/`, and `src/tools/ReadMcpResourceTool/`

### Module 5: Bridge Communication Layer

**Why it was selected**: Bridge is the live synchronization layer between Claude Code and the claude.ai web application. It solves a distinctive engineering problem: mapping a terminal-native workflow into a synchronized web UI.

**Deep-dive topics**:

- Bridge architecture and lifecycle
- Dual-channel design with WebSocket plus SSE
- Message serialization and deserialization
- Permission callback bridging so approvals can happen on the web side
- Connection-state management and reconnection logic
- Trusted-device handling and JWT authentication
- Inbound message and attachment handling
- FlushGate batching and message buffering
- Session-sync pointers such as `bridgePointer`
- The remote Bridge core in `remoteBridgeCore`

**Core source-file footprint**: about 31 files in `src/bridge/`

### Module 6: Context and Memory Management

**Why it was selected**: Context management directly determines Claude Code's quality and efficiency in long-running conversations. It implements a sophisticated system of compaction, caching, and persistent memory.

**Deep-dive topics**:

- The three-tier compaction strategy: `compact`, `autoCompact`, and `microCompact`
- Message grouping and importance scoring
- Prompt design for compaction itself
- Prompt Cache Break Detection optimization
- CLAUDE.md loading hierarchy and merge rules
- SessionMemory for automatic memory extraction and persistence
- Memory directory layout (`memdir`)
- Token estimation and budget allocation (`tokenBudget`)
- Project onboarding-state detection
- Dream-task integration

**Core source-file footprint**: about 25 files across `src/services/compact/`, `src/memdir/`, `src/services/SessionMemory/`, and `src/services/extractMemories/`


### Module Selection Summary

| No. | Module | Approx. Core Files | Key Entrypoint | Architectural Complexity |
|------|---------|------------|-------------|-----------|
| 1 | Tool system | ~120 | `src/tools.ts`, `src/Tool.ts` | ★★★★★ |
| 2 | Permission system | ~56 | `src/utils/permissions/permissions.ts` | ★★★★★ |
| 3 | Agent subprocess system | ~55 | `src/tools/AgentTool/AgentTool.tsx` | ★★★★☆ |
| 4 | MCP integration | ~30 | `src/services/mcp/client.ts` | ★★★★☆ |
| 5 | Bridge communication layer | ~31 | `src/bridge/bridgeMain.ts` | ★★★★☆ |
| 6 | Context and memory management | ~25 | `src/services/compact/compact.ts` | ★★★★☆ |
| **Total** | | **~317** | | |

These 317 source files cover roughly 16.6% of Claude Code's 1,906 application source files, but they represent the system's most important logic paths. A deep study of these six modules is enough to understand the full end-to-end path from user input to final output.
