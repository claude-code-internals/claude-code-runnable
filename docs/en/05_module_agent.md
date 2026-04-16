<p align="right"><a href="../cn/05_module_agent.md">中文</a></p>

# Phase 5-A: Deep Dive into the Agent Subprocess System

> This chapter provides a full architectural teardown of Claude Code's Agent subprocess concurrency framework. The Agent system is one of the most complex subsystems in Claude Code: it turns the CLI from a "single-turn conversation tool" into a "multi-process coordinated execution framework" with task decomposition, parallel execution, process isolation, and inter-agent communication. All analysis is reverse-validated against the `cli.js` source bundle (16,667 lines), with public type definitions in `sdk-tools.d.ts` used for cross-checking.


## Contents

1. Interface Contracts
   - 1.1 AgentInput - Input Parameter Specification
   - 1.2 AgentOutput - Output Type Specification
   - 1.3 Zod Schema Definitions
2. Implementation Mechanisms
   - 2.1 Agent Execution Core - The `Qm8` Tool Definition
   - 2.2 Built-in Agent Types
   - 2.3 Agent Execution Modes
   - 2.4 Forking - Context Inheritance and Branching
   - 2.5 Inter-Agent Communication - SendMessage
   - 2.6 Worktree Isolation
   - 2.7 Agent Lifecycle Management
   - 2.8 Team Collaboration in Swarm Mode
   - 2.9 Hook Integration
   - 2.10 Automatic Backgrounding and Input-Block Detection
3. Evolution Thought Experiment
4. Verification Strategy


## 1. Interface Contracts

The Agent subprocess system is Claude Code's concurrency framework. It expands the model from "one Claude process does everything" to "multiple Agent processes coordinate to complete complex tasks," with each Agent owning its own context window, tool set, and lifecycle.

### 1.1 AgentInput - Input Parameter Specification

The Agent tool validates its inputs strictly through Zod Schema definitions. The following complete parameter table is extracted from `cli.js`:

| Parameter | Type | Required | Description |
|------|------|------|------|
| `description` | `string` | Yes | A 3-5 word task summary used for UI display and background notifications |
| `prompt` | `string` | Yes | The full task description; this becomes the instruction body received by the child Agent |
| `subagent_type` | `string` | No | Identifier for a specialized agent type. If omitted, behavior depends on fork support: with forking enabled it creates a fork of the current agent; otherwise it falls back to `general-purpose` |
| `model` | `enum("sonnet","opus","haiku")` | No | Model override. Takes precedence over the Agent definition's frontmatter `model` field, but remains subject to permission-mode restrictions |
| `run_in_background` | `boolean` | No | Asynchronous execution switch. When `true`, the Agent runs in the background and the parent process does not wait |
| `name` | `string` | No | Optional Agent name. When set, it can be targeted by name through the `to` field of SendMessage |
| `team_name` | `string` | No | Team-context name. If omitted, the current session's team context is used |
| `mode` | `enum("acceptEdits","bypassPermissions","default","dontAsk","plan")` | No | Permission-mode override, for example `plan` to require approval before execution |
| `isolation` | `enum("worktree")` | No | Isolation mode. Setting `"worktree"` creates a temporary Git worktree |
| `cwd` | `string` | No | Working-directory override. Must be an absolute path and is mutually exclusive with `isolation: "worktree"` |

**Conditional constraints** (validated from source):

- In teammate context, the `name`, `team_name`, and `mode` parameters are unavailable. A teammate cannot spawn additional teammates.
- In in-process teammate context, `run_in_background` is unavailable.
- `cwd` and `isolation: "worktree"` are mutually exclusive and cannot be specified together.

### 1.2 AgentOutput - Output Type Specification

The output is modeled as a Zod union (`z.union`) with three mutually exclusive states:

**State 1: `completed` (synchronous completion)**

```json
{
  "status": "completed",
  "prompt": "string",
  "content": "ContentBlock[]",
  "totalToolUseCount": 0,
  "totalDurationMs": 0,
  "totalTokens": 0,
  "agentId": "string",
  "agentType": "string",
  "worktreePath": "string | undefined",
  "worktreeBranch": "string | undefined"
}
```

**State 2: `async_launched` (launched asynchronously)**

```json
{
  "status": "async_launched",
  "agentId": "string",
  "description": "string",
  "prompt": "string",
  "outputFile": "string",
  "canReadOutputFile": "boolean | undefined"
}
```

**State 3: `teammate_spawned` (Swarm-mode teammate spawn only)**

```json
{
  "status": "teammate_spawned",
  "teammate_id": "string",
  "name": "string",
  "team_name": "string"
}
```

### 1.3 Zod Schema Definitions

In the source, the schema is defined via lazy evaluation (`B6(() => ...)`) to avoid circular dependencies and startup overhead:

```javascript
// Base input schema
T4Y = B6(() => L.object({
  description: L.string().describe("A short (3-5 word) description of the task"),
  prompt: L.string().describe("The task for the agent to perform"),
  subagent_type: L.string().optional(),
  model: L.enum(["sonnet","opus","haiku"]).optional(),
  run_in_background: L.boolean().optional()
}))

// Extended input schema (adds team-related fields)
v4Y = B6(() => {
  let q = L.object({
    name: L.string().optional(),
    team_name: L.string().optional(),
    mode: Bh7().optional()
  });
  return T4Y().merge(q).extend({
    isolation: L.enum(["worktree"]).optional(),
    cwd: L.string().optional()
  })
})

// Final externally exposed schema (fields trimmed based on environment)
xr1 = B6(() => {
  let q = v4Y().omit({ cwd: true });
  return mR6 || Lb() ? q.omit({ run_in_background: true }) : q
})
```

This conditional schema trimming demonstrates an **environment-adaptive** design. When the `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` environment variable is enabled or fork mode is disabled, the `run_in_background` field is removed directly from the schema. In other words, the schema itself becomes the clearest documentation that the parameter is unavailable.


## 2. Implementation Mechanisms

### 2.1 Agent Execution Core - The `Qm8` Tool Definition

The Agent tool is registered in `cli.js` under the obfuscated name `Qm8`, with the following core properties:

```javascript
Qm8 = sq({
  name: v4,                           // Tool name ("Agent")
  searchHint: "delegate work to a subagent",
  aliases: [CB],                      // Aliases
  maxResultSizeChars: 1e5,            // Max result size: 100K chars
  isReadOnly() { return true },       // Marked read-only at the metadata level
  isConcurrencySafe() { return true }, // Safe for concurrent use

  async call({prompt, subagent_type, description, model,
              run_in_background, name, team_name, mode,
              isolation, cwd}, toolUseContext, canUseTool, metadata, onProgress) {
    // ... core execution logic
  }
})
```

**Key design decision**: `isReadOnly()` returns `true`. The Agent tool call itself is treated as a read-only operation because any actual reads or writes happen inside the child Agent, where they are governed by that child Agent's own permission system.

### 2.2 Built-in Agent Types

The following built-in Agent types can be extracted from `cli.js`:

| agentType | Source | Purpose | Capability Limits |
|-----------|------|------|----------|
| `general-purpose` | `built-in` | General-purpose agent (default), with the full tool set | Full capability |
| `Explore` | `built-in` | Exploration / research agent, limited to search and read operations | Read-only, cannot edit files |
| `Plan` | `built-in` | Planning agent for analysis and execution-plan generation | Read-only, cannot edit files |
| `statusline-setup` | `built-in` | Dedicated to HUD status-line configuration | Narrowly scoped functionality |
| `magic-docs` | `built-in` | Documentation-generation agent used in the `CLAUDE.md` generation flow | Read-write |

**Custom Agent definitions**

Users can define custom Agents under `.claude/agents/` using Markdown frontmatter. These definitions are scheduled together with built-in types through the `agentDefinitions.activeAgents` array. In source, custom agents are marked with `source: "projectSettings" | "userSettings" | "localSettings" | "flagSettings" | "policySettings" | "plugin"`, in contrast to built-ins, which use `source: "built-in"`.

Inferred Agent definition structure from reverse engineering:

```typescript
AgentDefinition {
  agentType: string               // Unique type identifier
  whenToUse: string               // Description of intended usage
  source: string                  // Source tag
  model?: string                  // Default model
  color?: string                  // UI color identifier
  background?: boolean            // Whether it defaults to background mode
  isolation?: "worktree"          // Default isolation mode
  permissionMode?: string         // Permission mode
  memory?: string                 // Memory scope
  requiredMcpServers?: string[]   // Required MCP servers
  tokens?: number                 // Token budget
  allowedTools?: string[]         // Tool allowlist
  getSystemPrompt(): string       // Returns the system prompt
}
```

### 2.3 Agent Execution Modes

The Agent tool supports three execution paths, chosen by conditional branches inside `call()`:

#### Path A: Teammate spawn (Swarm mode)

```text
Trigger condition: team_name exists && name exists && nq() returns true (Swarm is available)

Flow:
1. Validate that nested teammate spawning is not allowed
2. Call VXK() to create a tmux-pane process
3. Return { status: "teammate_spawned", teammate_id, name, team_name }
```

#### Path B: Asynchronous background Agent

```text
Trigger condition: run_in_background === true || agent.background === true
(and background tasks are not disabled)

Flow:
1. Generate a unique agentId (random 8-character ID)
2. Register the task into global task state via Fm8()
3. Start the iN() streaming inference loop (the same ReAct loop used by the main process)
4. Immediately return { status: "async_launched", agentId, outputFile }
5. Notify the parent process on completion through the task-notification system
```

#### Path C: Synchronous foreground Agent

```text
Trigger condition: default path

Flow:
1. Generate agentId and register the task
2. Start the iN() streaming inference loop
3. Consume messages yielded by the AsyncIterator incrementally
4. Wait for completion and collect the results
5. Return { status: "completed", content, totalToolUseCount, ... }
```

**Automatic backgrounding**

Even a synchronous Agent can be switched into background mode automatically during execution. The `G4Y()` function checks the `CLAUDE_AUTO_BACKGROUND_TASKS` environment variable or the `tengu_auto_background_agents` feature flag and returns the auto-background timeout (default `120000ms`, or 2 minutes). When `EXK()` registers the task, it creates a `setTimeout`; once the timer fires, it uses the `backgroundSignal` promise to notify the main loop that this Agent should be moved to the background:

```javascript
// Automatic backgrounding logic
let X = setTimeout((P, W) => {
  P((f) => {  // setAppState
    let G = f.tasks[W];
    if (!EJ(G) || G.isBackgrounded) return f;
    return { ...f, tasks: { ...f.tasks, [W]: { ...G, isBackgrounded: true } } };
  });
  let D = gR6.get(W);  // backgroundSignal resolver
  if (D) D(), gR6.delete(W);
}, autoBackgroundMs, setAppState, taskId);
```

### 2.4 Forking - Context Inheritance and Branching

When `subagent_type` is omitted and fork mode is available, the Agent tool does not create a completely new subprocess. Instead, it **forks itself**: the new Agent inherits the parent process's full conversation context (system prompt plus message history), effectively creating a clone with the same memory.

**Key properties of a fork**

1. **Context inheritance**: the parent process's `H.messages` are passed through `forkContextMessages`
2. **System-prompt reuse**: the fork uses the parent process's `renderedSystemPrompt` directly, or rebuilds it if needed
3. **Directive injection**: `UMK()` appends a Fork directive block, `<fork_directive>`, to the end of the message stream

Fork directive body, extracted verbatim from the source:

```text
<fork_directive>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT. You ARE the fork.
   Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: Bash, Read, Write, etc.
5. If you modify files, commit your changes before reporting.
6. Do NOT emit text between tool calls.
7. Stay strictly within your directive's scope.
8. Keep your report under 500 words unless specified otherwise.
9. Your response MUST begin with "Scope:".
10. REPORT structured facts, then stop

Output format:
  Scope: <echo back your assigned scope>
  Result: <key findings>
  Key files: <relevant file paths>
  Files changed: <list with commit hash>
  Issues: <list if any>
</fork_directive>
```

**Recursion protection for forks**

`FMK()` checks whether `<fork_directive>` already exists in the message history. If the current process is already a fork worker, another fork attempt throws `"Fork is not available inside a forked worker."`

**Fork vs. fresh Agent: selection guidance**

From the system prompt in the source:

> Fork yourself (omit `subagent_type`) when the intermediate tool output isn't worth keeping in your context. The criterion is qualitative -- "will I need this output again" -- not task size.
>
> - **Research**: fork open-ended questions. If research can be broken into independent questions, launch parallel forks in one message. A fork beats a fresh subagent for this -- it inherits context and shares your cache.

### 2.5 Inter-Agent Communication - SendMessage

`SendMessage` is the only communication channel between Agents. Its key properties are:

| Feature | Description |
|------|------|
| **Name-based addressing** | `to: "<name>"` sends a message to a specific teammate by name |
| **ID-based addressing** | `to: "<agentId>"` sends to an internal ID directly, also used to resume completed Agents |
| **Broadcast** | `to: "*"` broadcasts to the whole team; recommended only with care |
| **Structured messages** | Supports special payloads such as `{type: "shutdown_request"}` |
| **Automatic delivery** | Messages are pushed into the target Agent's inbox automatically; no manual polling is required |

**Message queue mechanism**

```javascript
// Push a message into the Agent's pending queue
function Um8(taskId, message, setAppState) {
  A3(taskId, setAppState, (state) => ({
    ...state,
    pendingMessages: [...state.pendingMessages, message]
  }))
}

// Consume the Agent's pending messages
function QXK(taskId, getAppState, setAppState) {
  let state = getAppState().tasks[taskId];
  if (!EJ(state) || state.pendingMessages.length === 0) return [];
  let messages = state.pendingMessages;
  A3(taskId, setAppState, (s) => ({ ...s, pendingMessages: [] }));
  return messages;
}
```

For teammates, messages also include brief summaries in idle notifications so the coordinator can see what changed without opening the full exchange.

### 2.6 Worktree Isolation

`isolation: "worktree"` creates a fully isolated Git working environment for the Agent.

**Creation flow**

```text
1. Generate a worktree name: `agent-${agentId.slice(0,8)}`
2. Call c88() to create the worktree:
   - Inside a Git repo: create a new git worktree plus a new branch under `.claude/worktrees/`
   - Outside a Git repo: delegate to WorktreeCreate / WorktreeRemove hooks
     (a VCS-agnostic isolation path)
3. If this is fork mode, inject the worktree-switch prompt via QMK()
4. The Agent performs all work inside the worktree directory
```

**Cleanup strategy** (`M6()` function):

```javascript
async function getWorktreeResult() {
  // Hook-based worktree: always retain it
  if (hookBased) return { worktreePath };

  // Check for changes (compare against the HEAD commit captured at creation)
  if (headCommit && !(await hasChanges(worktreePath, headCommit))) {
    // No changes: remove worktree + delete branch + clear metadata
    await removeWorktree(worktreePath, worktreeBranch, gitRoot);
    return {};
  }

  // Changes detected: keep the worktree and return its path and branch
  return { worktreePath, worktreeBranch };
}
```

This "auto-clean when unchanged, auto-preserve when modified" policy prevents resource leaks without losing work.

**EnterWorktree / ExitWorktree**

These two tools let users (not Agents) manage worktree sessions manually:

- `EnterWorktree`
  - Used only when the user explicitly asks for a "worktree"
  - Cannot be called when already inside a worktree
  - Can optionally specify a name and branch
  - Switches the session working directory into the new worktree

- `ExitWorktree`
  - Operates only on the current session's worktree created by `EnterWorktree`
  - `action: "keep"` preserves the worktree directory and branch
  - `action: "remove"` deletes the worktree; if uncommitted changes exist, `discard_changes: true` is required
  - Restores the session working directory to where it was before entering the worktree

### 2.7 Agent Lifecycle Management

From creation to teardown, an Agent moves through a full state-machine lifecycle:

```text
                           ┌──────────────────────────────────┐
                           │                                  ▼
  call() ──> parameter validation ──> agent-definition lookup ──> MCP dependency check
                                                            │
                                                            ▼
                                 ┌──────────────────> model selection (BN6)
                                 │                      │
                                 │                      ▼
                                 │              system-prompt construction
                                 │                      │
                                 │         ┌────────────┼────────────┐
                                 │         ▼            ▼            ▼
                                 │    Teammate     Async Agent   Sync Agent
                                 │    (tmux)      (background)  (foreground)
                                 │         │            │            │
                                 │         ▼            ▼            ▼
                                 │    VXK() spawn  Fm8() register  EXK() register
                                 │         │            │            │
                                 │         ▼            ▼            ▼
                                 │    teammate_    iN() stream     iN() stream
                                 │    spawned           loop           loop
                                 │                      │            │
                                 │                      ▼            ▼
                                 │               task-notification  NL8() collect
                                 │                      │            │
                                 │                      ▼            ▼
                                 └───────────────  worktree cleanup  worktree cleanup
                                                        │            │
                                                        ▼            ▼
                                                   return result  return result
```

**Task state management** (`gP`, i.e. `localAgentTasks`)

The core task type is `local_agent`, with the following state fields:

```typescript
LocalAgentTask {
  type: "local_agent"
  status: "running" | "completed" | "failed" | "killed"
  agentId: string
  prompt: string
  selectedAgent: AgentDefinition
  agentType: string
  abortController: AbortController
  unregisterCleanup: () => void
  retrieved: boolean
  lastReportedToolCount: number
  lastReportedTokenCount: number
  isBackgrounded: boolean
  pendingMessages: Message[]
  retain: boolean
  diskLoaded: boolean
  progress?: { tokenCount, toolUseCount, recentActivities, summary }
  messages?: Message[]
  toolUseId?: string
  endTime?: number
  evictAfter?: number
}
```

**Cleanup and notifications**

- `aq6()` terminates a running Agent by calling `abortController.abort()` and setting the status to `killed`
- `hL8()` marks an Agent as completed, updates state, and stores the result
- `SL8()` marks an Agent as failed and records the error
- `iq6()` triggers the completion notification by sending a `task-notification` XML message through `IO()`
- `dXK()` terminates all running Agents in bulk, typically during session shutdown

**Automatic resource reclamation**

Each Agent registers a cleanup callback through `pq()` (`unregisterCleanup`) so it is terminated correctly when the process exits. Completed Agents receive an `evictAfter` timestamp (`Date.now() + BN8`) and are removed from global state after expiry.

### 2.8 Team Collaboration in Swarm Mode

Swarm is the highest-level orchestration mode in the Agent system and requires tmux support.

#### TeamCreate

Creates a team and initializes its task list:

```javascript
// Team configuration file structure
{
  name: "team-name",
  description: "Working on feature X",
  createdAt: Date.now(),
  leadAgentId: "...",
  leadSessionId: "...",
  members: [{
    agentId: "...",
    name: "lead",           // Addressable by name
    agentType: "...",
    model: "...",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    cwd: "...",
    subscriptions: []
  }]
}
```

Creation flow:

1. Verify that the current session is not already leading another team
2. Generate a team config file at `~/.claude/teams/{team-name}/config.json`
3. Create the corresponding task-list directory at `~/.claude/tasks/{team-name}/`
4. Register the creator as the team leader
5. Update `AppState.teamContext`

#### TeamDelete

Cleans up team resources:

1. Check whether the team still has active members; if so, deletion is refused
2. Delete the `~/.claude/teams/{team-name}/` directory
3. Delete the `~/.claude/tasks/{team-name}/` directory
4. Clear `AppState.teamContext` and `inbox`

#### Teammate workflow

Standardized Swarm workflow:

```text
1. The Leader creates a team through TeamCreate
2. The Leader spawns Teammates via the Agent tool (with team_name + name)
   └── Each Teammate runs in its own tmux pane
3. The Leader creates tasks via TaskCreate
4. The Leader assigns tasks to Teammates via TaskUpdate (setting owner)
5. Teammates execute tasks and mark them complete with TaskUpdate
6. After each round, a Teammate automatically enters the idle state
   └── An idle notification is sent to the Leader automatically
7. The Leader continues guiding or reassigning work through SendMessage
8. When finished, the Leader sends {type: "shutdown_request"} through SendMessage
9. After all Teammates exit, the Leader calls TeamDelete for cleanup
```

**Teammate idle-state management**

After each round, Teammates automatically enter `idle`. This is normal behavior, not an error. The prompt emphasizes this repeatedly:

> Idle teammates can receive messages. Sending a message to an idle teammate wakes them up.
> Do not treat idle as an error.

This prevents the Leader Agent from misdiagnosing normal idle state as failure and taking unnecessary recovery actions.

**Agent-type selection guidance** (team-mode-only prompt excerpt):

```text
- Read-only agents (e.g., Explore, Plan) cannot edit or write files.
  Only assign them research, search, or planning tasks.
- Full-capability agents (e.g., general-purpose) have access to
  all tools including file editing, writing, and bash.
- Custom agents defined in .claude/agents/ may have their own
  tool restrictions.
```

### 2.9 Hook Integration

The Agent system is deeply integrated with the Hook event system and exposes the following hook points:

| Hook Event | Trigger Time | Input | Exit-code Behavior |
|-----------|---------|------|-----------|
| `SubagentStart` | When a child Agent starts | `{agent_id, agent_type}` | `0`: stdout is shown to the child Agent |
| `SubagentStop` | Before a child Agent completes | `{agent_id, agent_type, agent_transcript_path}` | `0`: not shown; `2`: stderr is shown to the child Agent and execution continues |
| `TaskCreated` | When a task is created | `{task_id, task_subject, task_description, teammate_name, team_name}` | Standard handling |

The `PreToolUse`, `PostToolUse`, and `PostToolUseFailure` events inside hook callbacks all include `agent_id` and `agent_type`, allowing hooks to distinguish between tool invocations from the main process and from child Agents.

### 2.10 Automatic Backgrounding and Input-Block Detection

**Delayed UI display**

If a synchronous Agent runs longer than `2000ms` (`Z4Y = 2000`), Claude Code shows a progress indicator in the UI:

```javascript
if (!mR6 && !J6 && I6 >= Z4Y && H.setToolJSX)
  J6 = true,
  H.setToolJSX({
    jsx: T67.createElement(NL6, null),
    shouldHidePromptInput: false,
    shouldContinueAnimation: true,
    showSpinner: true
  });
```

**Input-block detection**

`R67()` monitors the Agent output file to detect whether a command is stuck waiting for interactive input. It periodically checks whether the file size is still growing. If growth stalls beyond a threshold, it reads the last few lines of output and matches them against a regex pattern set (`a4Y`, which contains common interactive prompt patterns). If a match is found, the system sends a notification recommending pipe input or non-interactive flags.

**Resource tracking**

The counter structure created by `dw6()` tracks, for each Agent:

- `toolUseCount`: number of tool invocations
- `latestInputTokens`: latest input token count
- `cumulativeOutputTokens`: cumulative output token count
- `recentActivities`: recent activity records, keeping only the latest 5 (`c4Y = 5`)


## 3. Evolution Thought Experiment

This section explains why the current design becomes almost inevitable when examined step by step.

### Level 1 (Naive): Single-threaded sequential execution

```text
User request ──> main process parses ──> call API ──> execute tools ──> return result
                                       │
                                       └── Every operation is serialized, one after another
```

**Limitations**

- Long-running tasks, such as full test runs, block user interaction
- Independent subtasks, such as searching multiple directories, cannot run in parallel
- Intermediate tool output quickly fills the context window
- Complex tasks cannot be decomposed into specialized roles

### Level 2 (Bottleneck identified): Concurrency is needed, but the model is unclear

Attempting to add simple concurrency inside the main process:

```text
User request ──> main process parses ──> Promise.all([
                                       API call 1,
                                       API call 2,
                                       API call 3
                                     ]) ──> merge results
```

**New problems**

- All concurrent operations share the same context window, so the window is exhausted even faster
- Permission state and tool state race against each other across concurrent operations
- Failed operations can pollute global state
- Different operations cannot be assigned different models, tool sets, or permission modes
- File modifications from one operation can conflict with another

### Level 3 (Current design): Process-level isolation plus message passing

```text
User request ──> main process (Coordinator)
                  ├──> Fork Worker A (inherits context, research task)
                  ├──> Agent B (independent context, general-purpose coding)
                  │       └── [worktree isolation, separate branch]
                  ├──> Agent C (independent context, Explore read-only search)
                  └──> Teammate D (tmux pane, separate process, communicates via SendMessage)
                           │
                           ├── Share task state through TaskList
                           ├── Exchange messages through SendMessage
                           └── Discover one another through Team Config
```

**Key advantages of the current design**

| Design decision | Problem solved |
|---------|-----------|
| Process-level isolation (independent context windows) | Intermediate output does not pollute the parent process context |
| Fork mechanism (inherited context) | Research tasks can reuse cache and avoid restating background information |
| Fresh Agent (independent context) | Clean-slate startup for tasks that are self-contained and well-defined |
| Worktree isolation | File modifications do not conflict with the main branch |
| Async Agents + task notifications | Long-running tasks do not block user interaction |
| SendMessage communication | Agents coordinate without shared memory |
| Built-in specialized types (`Explore` / `Plan`) | Tool-set restrictions prevent accidental misuse |
| Automatic backgrounding | Balances interactivity against task completion |
| Recursion protection (no fork within a fork) | Prevents infinite recursion |

**Deeper architectural insight**

At its core, the Agent system is a **user-space process scheduler**:

- `Qm8.call()` is analogous to `fork()` / `exec()`
- `Fm8()` and `EXK()` act as the process registry
- `SendMessage` serves as inter-process communication (IPC)
- `TeamCreate` and `TeamDelete` correspond to process-group management
- `AbortController` acts as a signaling mechanism (`SIGTERM` / `SIGKILL`)
- The global `tasks` state is analogous to a `/proc` filesystem
- `evictAfter` is zombie-process collection


## 4. Verification Strategy

### 4.1 Interface-contract verification

The Agent system's inputs and outputs are strictly validated at runtime through Zod schemas. This means:

- **Type safety**: any input that does not satisfy the schema is rejected before invocation
- **Conditional fields**: dynamic `.omit()` trimming ensures unavailable parameters do not exist even at the syntax level
- **Union output types**: `z.union([completed, async_launched])` forces callers to handle multiple states explicitly

### 4.2 Permission-system integration

Each Agent's tool calls are governed by an independent permission context:

```javascript
let c = {
  ...D.toolPermissionContext,
  mode: V.permissionMode ?? "acceptEdits"
};
let K6 = nQ(c, D.mcp.tools);  // Filter available tools based on permissions
```

The `allowedAgentTypes` field in Agent definitions further constrains which child Agent types can be spawned under a given permission regime. When permissions deny a spawn, the system throws a clear error:

```text
Agent type 'X' has been denied by permission rule 'Agent(X)' from settings.
```

### 4.3 MCP-server dependency verification

Agent definitions can declare `requiredMcpServers`, and the runtime verifies before startup that the required MCP servers are connected and exposing tools:

```javascript
// Wait up to 30 seconds for pending MCP servers to connect
let a = Date.now() + 30000;
while (Date.now() < a) {
  if (await R7(500), ... ) break;
}
// Verify required MCP servers are ready
if (!Wk8(V, w6)) {
  throw Error(`Agent '${V.agentType}' requires MCP servers matching: ...`);
}
```

### 4.4 Protection against recursion and infinite loops

Multiple defensive mechanisms keep the Agent system from spiraling into recursive failure:

1. **Fork recursion protection**: `FMK()` checks for an existing `<fork_directive>` in the message stream
2. **No nested teammate spawning**: teammate context checks `$Y()` and refuses to create new teammates
3. **Forced validation agent**: after 3 or more completed tasks without a validation step, the system injects a prompt requiring a validation Agent (`vA8`)
4. **AbortController propagation**: if the parent process is aborted, the child `AbortController` created through `bC()` aborts the sub-Agent automatically

### 4.5 Telemetry and observability

The Agent system emits structured telemetry through `d()` (the telemetry event dispatcher):

| Event name | Trigger time | Included data |
|--------|---------|---------|
| `tengu_agent_tool_selected` | When an Agent is created | `agent_type`, `model`, `source`, `is_fork`, `is_async` |
| `tengu_agent_tool_terminated` | When an Agent terminates | `agent_type`, `model`, `duration_ms`, `is_async`, `reason` |
| `tengu_team_created` | When a team is created | `team_name`, `teammate_count`, `lead_agent_type` |
| `tengu_team_deleted` | When a team is deleted | `team_name` |
| `tengu_agent_memory_loaded` | When Agent memory is loaded | `scope`, `source` |

### 4.6 State-consistency guarantees

Task state is modified through `A3()` (the atomic state updater), following a "check first, then mutate immutably" pattern that prevents races:

```javascript
// Typical pattern: atomic update + state predicate
A3(taskId, setAppState, (state) => {
  if (state.status !== "running") return state;  // Preconditions
  return { ...state, status: "completed", ... };  // Immutable update
});
```

Notification deduplication is handled through a `notified` flag. In `iq6()`, `A3()` is first used to atomically check and set `notified: true`; only the caller that succeeds in setting it continues to send the actual notification.


## Appendix A: Agent System Source Index

The following table maps the key Agent-system symbols found in `cli.js` (based on the 16,667-line version):

| Symbol / Module | Approximate Lines | Description |
|-----------|---------|------|
| `Qm8` (Agent tool definition) | ~3900-3970 | Main `sq({...})` entry point |
| `T4Y` (base input schema) | ~3806 | Zod base parameters |
| `v4Y` (extended input schema) | ~3806 | Adds team / isolation fields |
| `xr1` (public input schema) | ~3806 | Environment-conditional field trimming |
| `k4Y` (output schema) | ~3806 | Union type for `completed` / `async` |
| `Fm8` (async task registration) | ~3968 | Creates the `running` task state |
| `EXK` (sync registration + auto backgrounding) | ~3968 | Registration with timeout support |
| `GMK` (TeamCreate prompt) | ~3627 | Full workflow documentation |
| `VMK` (TeamDelete prompt) | ~3737 | Cleanup instructions |
| `gMK` (fork directive body) | ~3755 | `fork_directive` template |
| `FMK` (fork recursion detection) | ~3755 | Checks message history |
| `UMK` (fork message construction) | ~3755 | Injects the directive into the message tail |
| `LqY` (TeamCreate tool) | ~3736 | `sq({...})` definition |
| `hqY` (TeamDelete tool) | ~3749 | `sq({...})` definition |
| Hook event definitions | ~6530-6536 | `SubagentStart` / `SubagentStop` |
| `dw6` (counter initialization) | ~3960-3975 | `tokenCount` / `toolUseCount` tracking |
| `iq6` (completion notification) | ~3963-3972 | `task-notification` XML |


## Appendix B: Glossary

| Term | Definition |
|------|------|
| **Agent** | A child process with its own context window and tool set, responsible for a specific task and returning results |
| **Fork** | An Agent branch that inherits the parent process's full conversation context; triggered when `subagent_type` is omitted |
| **Teammate** | An Agent running in a separate tmux pane in Swarm mode and communicating through SendMessage |
| **Swarm** | Multi-Agent coordination mode with a Leader, Teammates, and a shared TaskList |
| **Worktree** | Git working-tree isolation, where the Agent operates in an isolated directory copy on a separate branch |
| **Coordinator** | The Leader Agent in Swarm mode, responsible for task assignment and team coordination |
| **task-notification** | The XML-formatted notification message sent through `IO()` when an Agent completes or fails |
| **AgentDefinition** | The full definition of an Agent type, including type ID, system prompt, tool set, and permission configuration |
| **ReAct loop** | The Agent's core execution loop: Reason, Act, Observe, and repeat |
