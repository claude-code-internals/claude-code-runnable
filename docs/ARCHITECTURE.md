# Claude Code — Comprehensive Architecture Analysis

> **Codebase**: ~1,884 TypeScript/TSX files | **Runtime**: Bun | **UI**: React + Custom Ink Fork | **API**: Anthropic SDK

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Startup & Initialization](#2-startup--initialization)
3. [Query Engine — The Agentic Core Loop](#3-query-engine--the-agentic-core-loop)
4. [Tool System](#4-tool-system)
5. [Terminal UI — Custom Ink Fork](#5-terminal-ui--custom-ink-fork)
6. [State Management](#6-state-management)
7. [Multi-Agent & Coordinator Architecture](#7-multi-agent--coordinator-architecture)
8. [Services Layer](#8-services-layer)
9. [Command System](#9-command-system)
10. [Permission System](#10-permission-system)
11. [Context Management & Compaction](#11-context-management--compaction)
12. [Bridge & Remote Sessions](#12-bridge--remote-sessions)
13. [Skills & Plugin System](#13-skills--plugin-system)
14. [Key Design Patterns](#14-key-design-patterns)

---

## 1. High-Level Architecture

```mermaid
graph TB
    subgraph Entrypoints
        CLI[cli.tsx<br/>CLI Bootstrap]
        SDK[sdk/<br/>SDK Entrypoint]
        MCP_E[mcp.ts<br/>MCP Server Mode]
    end

    subgraph Core["Core Engine"]
        MAIN[main.tsx<br/>Commander CLI Parser]
        QE[QueryEngine.ts<br/>Session Orchestrator]
        QL[query.ts<br/>Agentic Main Loop]
        API[services/api/claude.ts<br/>Streaming API Client]
    end

    subgraph UI["Terminal UI (Custom Ink Fork)"]
        REPL[screens/REPL.tsx]
        APP[components/App.tsx]
        MSG[components/Messages.tsx]
        PI[components/PromptInput/]
        INK[ink/<br/>Layout · DOM · Events · Renderer]
    end

    subgraph Tools["Tool System (~40 tools)"]
        TR[tools.ts<br/>Registry]
        TI[Tool.ts<br/>Interface]
        BASH[BashTool]
        AGENT[AgentTool]
        FE[FileEditTool]
        FR[FileReadTool]
        MCPT[MCPTool]
        SKILL[SkillTool]
        TEAM[TeamCreate/Delete/SendMessage]
    end

    subgraph Services
        MCP_S[services/mcp/<br/>MCP Servers]
        LSP[services/lsp/<br/>Code Intelligence]
        COMPACT[services/compact/<br/>Context Compaction]
        OAUTH[services/oauth/<br/>Authentication]
        ANALYTICS[services/analytics/<br/>GrowthBook + Telemetry]
        MEMORY[services/SessionMemory/<br/>+ extractMemories/]
        PLUGINS[services/plugins/<br/>Plugin Manager]
    end

    subgraph State["State & Infrastructure"]
        STORE[state/store.ts<br/>Pub-Sub Store]
        AS[state/AppState.tsx<br/>React Context Provider]
        HOOKS[hooks/<br/>100+ Custom Hooks]
        PERMS[utils/permissions/<br/>Permission Engine]
        CONFIG[utils/settings/<br/>Config Loader]
        BRIDGE[bridge/<br/>Remote Sessions]
    end

    CLI --> MAIN
    SDK --> QE
    MCP_E --> MCP_S
    MAIN --> QE
    MAIN --> REPL
    QE --> QL
    QL --> API
    QL --> TR
    TR --> TI
    TI --> BASH & AGENT & FE & FR & MCPT & SKILL & TEAM
    REPL --> APP --> MSG & PI
    APP --> INK
    AGENT --> QE
    MCPT --> MCP_S
    QL --> COMPACT
    QE --> STORE
    AS --> STORE
    REPL --> HOOKS
    TR --> PERMS
    MAIN --> CONFIG
    MAIN --> OAUTH
    MAIN --> ANALYTICS
```

### Layer Summary

| Layer | Key Files | Role |
|-------|-----------|------|
| **Entrypoints** | `cli.tsx`, `main.tsx`, `sdk/`, `mcp.ts` | Bootstrap, arg parsing, mode routing |
| **Core Engine** | `QueryEngine.ts`, `query.ts` | Agentic loop, message management, tool dispatch |
| **API Client** | `services/api/claude.ts`, `withRetry.ts` | Streaming, retry, fallback, auth |
| **Tool System** | `Tool.ts`, `tools.ts`, `tools/*/` | 40+ tools with permission-aware execution |
| **Terminal UI** | `ink/`, `screens/`, `components/` | Custom React-for-terminal rendering engine |
| **State** | `state/`, `context/` | Pub-sub store with React context providers |
| **Services** | `services/*/` | MCP, LSP, OAuth, analytics, compaction, memory |
| **Infrastructure** | `hooks/`, `utils/`, `bridge/`, `tasks/` | Permissions, config, remote bridge, background tasks |

---

## 2. Startup & Initialization

```mermaid
sequenceDiagram
    participant CLI as cli.tsx
    participant Main as main.tsx
    participant Init as init.ts
    participant Setup as setup.ts
    participant REPL as REPL Screen

    Note over CLI: Module-level side effects
    CLI->>CLI: Disable corepack auto-pin
    CLI->>CLI: Set NODE_OPTIONS (remote mode)
    CLI->>CLI: ABLATION_BASELINE env setup

    CLI->>CLI: Fast-path checks (--version, --daemon, etc.)
    alt Fast path matches
        CLI-->>CLI: Return immediately
    end

    CLI->>Main: Dynamic import main.tsx

    Note over Main: Module-level parallel prefetch
    Main->>Main: startMdmRawRead() [subprocess]
    Main->>Main: startKeychainPrefetch() [subprocess]
    Main->>Main: Import ~135ms of modules

    Main->>Main: Build Commander program

    Note over Main: preAction hook fires
    Main->>Init: await init()

    Note over Init: Initialization sequence
    Init->>Init: enableConfigs()
    Init->>Init: applySafeConfigEnvironmentVariables()
    Init->>Init: applyExtraCACertsFromConfig()
    Init->>Init: setupGracefulShutdown()

    par Parallel prefetch
        Init->>Init: initialize1PEventLogging()
        Init->>Init: populateOAuthAccountInfo()
        Init->>Init: detectCurrentRepository()
        Init->>Init: initPolicyLimitsLoading()
    end

    Init->>Init: configureGlobalMTLS()
    Init->>Init: configureGlobalAgents()
    Init->>Init: preconnectAnthropicApi() [background]

    Main->>Main: initSinks(), runMigrations()

    par Parallel with setup
        Main->>Setup: setup(cwd, options)
        Main->>Main: getCommands(cwd)
        Main->>Main: getAgentDefinitions(cwd)
    end

    Note over Setup: CWD & hooks setup
    Setup->>Setup: switchSession()
    Setup->>Setup: setCwd(cwd)
    Setup->>Setup: captureHooksConfigSnapshot()
    Setup->>Setup: Worktree creation (if enabled)
    Setup->>Setup: initSessionMemory()
    Setup->>Setup: Plugin & attribution prefetch

    Main->>Main: initializeTelemetryAfterTrust()
    Main->>Main: Await MCP config

    alt Interactive mode
        Main->>REPL: launchRepl(root, appProps, replProps)
        REPL->>REPL: Render <App><REPL/></App>
    else Non-interactive (-p flag)
        Main->>Main: runHeadless(QueryEngine)
    end
```

### Startup Optimization Techniques

| Technique | Details |
|-----------|---------|
| **Module-level prefetch** | MDM reads + keychain reads fire as subprocesses *during* import evaluation (~135ms overlap) |
| **Fast paths** | `--version` exits with zero imports; `--daemon`, `--bg` skip full CLI |
| **Deferred telemetry** | OpenTelemetry SDK (~400KB) loaded only after trust dialog |
| **Parallel init** | OAuth, repo detection, policy limits, 1P logging all run concurrently |
| **API preconnect** | TCP+TLS handshake starts before any user interaction |
| **Feature flag DCE** | `bun:bundle` `feature()` gates eliminate dead code at build time |
| **Memoized init** | `init()` is memoized — safe to call multiple times |

---

## 3. Query Engine — The Agentic Core Loop

```mermaid
graph TB
    subgraph QueryEngine["QueryEngine.ts — Session Manager"]
        SM[submitMessage<br/>User prompt entry]
        PI2[processUserInput<br/>Slash commands, attachments]
        SM --> PI2
        PI2 --> QF
    end

    subgraph QueryLoop["query.ts — Main Loop State Machine"]
        QF[query<br/>Entry wrapper]
        QL2[queryLoop<br/>while true loop]
        QF --> QL2

        subgraph PreAPI["Pre-API Processing"]
            MC[microcompactMessages<br/>Summarize old tool_use]
            AC[autoCompactIfNeeded<br/>Full conversation summary]
            CC[contextCollapse<br/>Progressive collapse]
            NORM[normalizeMessagesForAPI<br/>Format for API]
            UC[prependUserContext<br/>CWD, file edits, perms]
            SC[appendSystemContext<br/>Hooks, team notifications]
        end

        subgraph APICall["API Call"]
            QM[queryModelWithStreaming<br/>Build params, call API]
            WR[withRetry<br/>Retry, fallback, auth]
            STREAM[Stream response<br/>Text + tool_use blocks]
        end

        subgraph PostAPI["Post-API Processing"]
            TE[StreamingToolExecutor<br/>Parallel tool dispatch]
            TR2[runTools<br/>Sequential fallback]
            SH[handleStopHooks<br/>End-of-turn hooks]
            ATT[getAttachmentMessages<br/>Task notifications, queued cmds]
        end

        QL2 --> MC --> AC --> CC --> NORM --> UC --> SC
        SC --> QM --> WR --> STREAM
        STREAM --> TE & TR2
        TE --> SH
        TR2 --> SH
        SH --> ATT
    end

    subgraph Recovery["Recovery Paths"]
        RC[Reactive Compact<br/>413 prompt_too_long]
        MOT[Max Output Tokens<br/>Escalation 8K→64K]
        FB[Model Fallback<br/>529 overloaded → fallback model]
        SHB[Stop Hook Blocking<br/>Re-enter with errors]
    end

    ATT -->|"Tool results exist"| QL2
    ATT -->|"No tools, hooks pass"| DONE[Return completed]

    WR -->|"413"| RC -->|"Compacted"| QL2
    WR -->|"max_tokens"| MOT -->|"Escalated"| QL2
    WR -->|"529"| FB -->|"Switched"| QL2
    SH -->|"Blocking errors"| SHB --> QL2
```

### Single Turn Data Flow

```mermaid
sequenceDiagram
    participant User
    participant QE as QueryEngine
    participant Q as query()
    participant API as Anthropic API
    participant Tools as Tool Registry
    participant UI as Terminal UI

    User->>QE: submitMessage(prompt)
    QE->>QE: processUserInput (slash cmds, @mentions)
    QE->>Q: query(messages, tools, systemPrompt)

    loop Agentic Loop
        Q->>Q: microcompact + autocompact (if needed)
        Q->>Q: normalizeMessages + inject context
        Q->>API: queryModelWithStreaming()

        API-->>UI: Stream text deltas (real-time)
        API-->>Q: tool_use blocks

        par Streaming Tool Execution
            Q->>Tools: StreamingToolExecutor.addTool()
            Tools->>Tools: Execute in parallel
            Tools-->>Q: tool_result blocks
        end

        Q->>Q: handleStopHooks()

        alt Has tool results
            Q->>Q: Continue loop with results
        else No tools, hooks pass
            Q-->>QE: Return {reason: 'completed'}
        end
    end

    QE-->>User: Final response
```

### Token Budget & Context Management

| Mechanism | Trigger | Action |
|-----------|---------|--------|
| **Micro-compact** | Per-turn, old tool_use blocks | Summarize via cache editing |
| **Auto-compact** | Token count > (contextWindow - 13K) | Fork agent to summarize full conversation |
| **Context collapse** | Feature-gated progressive | Collapse old message sections |
| **Reactive compact** | 413 from API | Emergency full-conversation summary |
| **Max output recovery** | Stop reason = max_tokens | Escalate 8K→64K, then retry with recovery message |
| **Token budget** | SDK budget limit (90% threshold) | Inject nudge message, then stop |

### API Retry Strategy

```mermaid
graph TD
    ERR[API Error] --> AUTH{Auth Error?}
    AUTH -->|401/403| REFRESH[Refresh OAuth Token] --> RETRY
    AUTH -->|No| RATE{Rate Limited?}

    RATE -->|429 short| WAIT[Wait retry-after] --> RETRY
    RATE -->|429 long| COOLDOWN[Cooldown + disable fast mode] --> RETRY
    RATE -->|No| OVER{Overloaded?}

    OVER -->|529, attempt < 3| BACK[Exponential backoff] --> RETRY
    OVER -->|529, fallback available| FALLBACK[Switch to fallback model] --> RETRY
    OVER -->|529, exhausted| FAIL[Surface error]
    OVER -->|No| CTX{Context overflow?}

    CTX -->|413, reactive compact available| COMPACT[Reactive compact] --> RETRY
    CTX -->|413, already compacted| FAIL
    CTX -->|No| TRANSIENT{Transient?}

    TRANSIENT -->|ECONNRESET/EPIPE| RECONN[Disable keep-alive] --> RETRY
    TRANSIENT -->|Other| FAIL

    RETRY[Retry with updated params]
```

---

## 4. Tool System

```mermaid
graph TB
    subgraph Interface["Tool Interface (Tool.ts)"]
        NAME[name + aliases]
        SCHEMA[inputSchema: Zod]
        CALL[call: AsyncGenerator]
        PERMS[checkPermissions]
        DESC[description + prompt]
        RENDER[render* methods: 6 renderers]
        FLAGS[isEnabled / isReadOnly / isDestructive<br/>isConcurrencySafe / isOpenWorld]
    end

    subgraph Registry["Registry (tools.ts)"]
        BASE[getAllBaseTools<br/>~60 tool definitions]
        FILTER[getTools<br/>Permission + deny rule filtering]
        POOL[assembleToolPool<br/>Built-in + MCP merge, dedup]
        BASE --> FILTER --> POOL
    end

    subgraph Categories["Tool Categories"]
        direction LR
        subgraph Core_Tools["Core Tools"]
            BT[BashTool<br/>Shell execution]
            FRT[FileReadTool]
            FET[FileEditTool]
            FWT[FileWriteTool]
            GT[GlobTool]
            GRT[GrepTool]
        end

        subgraph Agent_Tools["Agent Tools"]
            AT[AgentTool<br/>Spawn subagents]
            SMT[SendMessageTool<br/>Agent messaging]
            TCT[TeamCreateTool]
            TDT[TeamDeleteTool]
        end

        subgraph External["External Integration"]
            MT[MCPTool<br/>MCP server bridge]
            ST[SkillTool<br/>Skill invocation]
            LSPT[LSPTool]
            WFT[WebFetchTool]
            WST[WebSearchTool]
        end

        subgraph Meta["Meta Tools"]
            EPT[EnterPlanModeTool]
            XPT[ExitPlanModeTool]
            EWT[EnterWorktreeTool]
            XWT[ExitWorktreeTool]
            AQT[AskUserQuestionTool]
            TST[ToolSearchTool]
        end

        subgraph Task_Tools["Task Tools"]
            TCrT[TaskCreateTool]
            TUT[TaskUpdateTool]
            TLT[TaskListTool]
            TGT[TaskGetTool]
            TOT[TaskOutputTool]
            TSoT[TaskStopTool]
        end
    end

    subgraph Conditional["Conditional Loading (Feature Flags)"]
        ANT["ant-only: REPLTool, ConfigTool, TungstenTool"]
        PROACTIVE["PROACTIVE: SleepTool"]
        TRIGGERS["AGENT_TRIGGERS: CronCreate/Delete/List"]
        KAIROS["KAIROS: SendUserFileTool, PushNotificationTool"]
        COORD["COORDINATOR_MODE: Enhanced tool filtering"]
    end

    POOL --> Categories
    Registry -.->|"feature() DCE"| Conditional
```

### Tool Execution Lifecycle

```mermaid
sequenceDiagram
    participant Loop as Query Loop
    participant Orch as Tool Orchestration
    participant Perm as Permission Engine
    participant Tool as Tool Implementation
    participant Hook as Hook System

    Loop->>Orch: runTools(toolUseBlocks)

    Orch->>Orch: partitionToolCalls<br/>(serial vs concurrent batches)

    loop Each batch
        loop Each tool in batch
            Orch->>Tool: validateInput(input)
            alt Invalid
                Orch-->>Loop: Error result
            end

            Orch->>Hook: Pre-tool-use hooks
            Orch->>Perm: checkPermissions(input, context)

            alt Denied
                Orch-->>Loop: Rejection result
            else Ask user
                Orch->>Perm: Prompt user
            end

            Orch->>Tool: call(input, context)
            Tool-->>Orch: Yield progress updates
            Tool-->>Orch: Final result

            Orch->>Hook: Post-tool-use hooks

            alt Result > maxResultSizeChars
                Orch->>Orch: Persist to disk, return preview
            end
        end
    end

    Orch-->>Loop: All tool results + context modifiers
```

### Tool Concurrency Model

```
Input: [BashTool(write), GlobTool, GrepTool, FileEditTool, GlobTool]

Partition into batches:
  Batch 1: [BashTool(write)]       → Serial (non-read-only)
  Batch 2: [GlobTool, GrepTool]    → Concurrent (both read-only)
  Batch 3: [FileEditTool]          → Serial (non-read-only)
  Batch 4: [GlobTool]              → Concurrent (read-only)

Max concurrency: CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY (default 10)
```

---

## 5. Terminal UI — Custom Ink Fork

```mermaid
graph TB
    subgraph React["React Layer"]
        JSX[JSX Components]
        REC[react-reconciler<br/>Fiber reconciliation]
        DOM[Custom DOM<br/>ink/dom.ts]
    end

    subgraph Layout["Layout Engine"]
        YOGA[Yoga Native<br/>Flexbox layout]
        MEAS[Text Measurement<br/>measure-text.ts]
        GEO[Geometry<br/>Position + Size]
    end

    subgraph Render["Render Pipeline"]
        RNO[renderNodeToOutput<br/>DOM → Operations]
        OUT[Output<br/>Write/Blit/Clear ops]
        SCREEN[Screen Buffer<br/>2D cell grid]
    end

    subgraph Display["Display Output"]
        FRONT[frontFrame<br/>Currently displayed]
        BACK[backFrame<br/>Being rendered]
        DIFF[LogUpdate Diff<br/>Compare frames]
        OPT[Patch Optimization<br/>Merge + deduplicate]
        ANSI[ANSI Serialization<br/>Terminal escape codes]
        STDOUT[stdout write]
    end

    subgraph Input["Input Pipeline"]
        STDIN[stdin raw mode]
        PARSE[parse-keypress.ts<br/>Key sequence parser]
        KBE[KeyboardEvent creation]
        DISP[Event Dispatcher<br/>Capture + Bubble phases]
        FOCUS[Focus Manager<br/>activeElement tracking]
    end

    JSX --> REC --> DOM
    DOM --> YOGA --> MEAS
    YOGA --> GEO
    GEO --> RNO --> OUT --> SCREEN
    SCREEN --> BACK
    BACK --> DIFF
    FRONT --> DIFF
    DIFF --> OPT --> ANSI --> STDOUT

    STDIN --> PARSE --> KBE --> DISP --> FOCUS
    FOCUS --> JSX
```

### Component Hierarchy

```mermaid
graph TB
    APP["App.tsx<br/>FpsMetrics + Stats + AppState + Mailbox + Voice"]
    REPL2["REPL.tsx<br/>Main screen layout"]
    FL["FullscreenLayout<br/>Alt screen switching"]

    MSG2["Messages.tsx<br/>Virtual scrolled list"]
    PI3["PromptInput/<br/>Text input + suggestions"]
    OV["Overlays<br/>Dialogs, modals"]

    LOGO["LogoHeader<br/>(memoized for perf)"]
    SN["StatusNotices"]
    VML["VirtualMessageList<br/>Windowed rendering"]
    MR["MessageRow"]
    M["Message.tsx<br/>Type-dispatched renderer"]

    UTM["UserTextMessage"]
    ATM["AssistantTextMessage"]
    ATUM["AssistantToolUseMessage"]
    CS["CompactSummary"]

    APP --> REPL2
    REPL2 --> FL
    FL --> MSG2 & PI3 & OV
    MSG2 --> LOGO & SN & VML
    VML --> MR --> M
    M --> UTM & ATM & ATUM & CS
```

### Rendering Optimizations

| Optimization | Description |
|-------------|-------------|
| **Double buffering** | frontFrame/backFrame swap prevents flicker |
| **Blit optimization** | Unchanged regions copied from previous screen (avoid full redraw) |
| **Patch merging** | Consecutive ANSI writes merged to reduce I/O |
| **Style pooling** | Deduplicated style objects (CharPool, StylePool, HyperlinkPool) |
| **Scroll draining** | `SCROLL_MAX_PER_FRAME` rows animated per frame for smooth scroll |
| **60fps throttle** | `scheduleRender` throttled to 16.67ms intervals |
| **Logo memoization** | LogoHeader memoized to prevent dirty cascade in large sessions |
| **Layout shift detection** | Only full-redraw when Yoga dimensions actually change |

---

## 6. State Management

```mermaid
graph TB
    subgraph Store["Pub-Sub Store (store.ts)"]
        GS[getState: T]
        SS[setState: updater → T]
        SUB[subscribe: listener → unsubscribe]
        OC[onChange callback<br/>Side effects on mutation]
    end

    subgraph AppState["AppState (~50 properties)"]
        SETTINGS[settings: SettingsJson]
        MSGS[messages: Message array]
        TASKS[tasks: Record UUID → TaskState]
        MODEL[mainLoopModel: ModelSetting]
        PERM_CTX[toolPermissionContext]
        NOTIF[notifications: queue + current]
        SPEC[speculationState: idle/active]
        VIEW[expandedView: none/tasks/teammates]
    end

    subgraph Contexts["React Contexts"]
        ASC[AppStoreContext<br/>Store access]
        NC[NotificationContext<br/>Queue-based, priority levels]
        MC2[MailboxContext<br/>Inter-agent communication]
        MOD[ModalContext<br/>Dialog sizing]
        SC2[StatsContext<br/>Histogram metrics]
        FPS[FpsMetricsContext<br/>Frame timing]
        VC[VoiceContext<br/>Voice mode state]
    end

    subgraph Hooks2["Access Patterns"]
        UAS["useAppState()<br/>Full snapshot + re-render"]
        UASS["useAppStateStore()<br/>Raw store reference"]
        USAS["useSetAppState()<br/>setState updater"]
        USES["useSyncExternalStore()<br/>Selective subscription"]
    end

    Store --> AppState
    AppState --> ASC
    ASC --> Hooks2
    Contexts --> Hooks2

    OC -->|"Mode changes"| CCR[CCR/SDK status stream]
    OC -->|"Settings changes"| DISK[Persist to disk]
    OC -->|"Auth changes"| CACHE[Clear auth caches]
```

---

## 7. Multi-Agent & Coordinator Architecture

```mermaid
graph TB
    subgraph Coordinator["Coordinator Mode"]
        LEADER[Leader Agent<br/>Orchestrates workers]
        LEADER -->|"AgentTool"| W1[Worker 1<br/>Background agent]
        LEADER -->|"AgentTool"| W2[Worker 2<br/>Background agent]
        LEADER -->|"AgentTool"| W3[Worker 3<br/>In-process teammate]

        W1 -->|"task-notification"| LEADER
        W2 -->|"task-notification"| LEADER
        W3 -->|"SendMessage"| LEADER
        LEADER -->|"SendMessage"| W3
    end

    subgraph TaskTypes["Task Execution Types"]
        LAT[LocalAgentTask<br/>In-memory async agent]
        IPT[InProcessTeammateTask<br/>Team coordination]
        RAT[RemoteAgentTask<br/>CCR cloud session]
        LST[LocalShellTask<br/>Background shell]
        DT[DreamTask<br/>Placeholder/preview]
    end

    subgraph Lifecycle["Agent Lifecycle"]
        SPAWN[Spawn] --> INIT[Initialize context]
        INIT --> RUN[Run query loop]
        RUN --> TOOLS[Execute tools]
        TOOLS --> RUN
        RUN --> COMPLETE[Complete / Fail]
        COMPLETE --> NOTIFY[Emit task-notification]
    end

    W1 -.-> LAT
    W3 -.-> IPT
```

### Agent Spawning Modes

```mermaid
graph LR
    AT2[AgentTool.call] --> MODE{Execution Mode?}

    MODE -->|"Default"| INLINE[Inline<br/>Block until done]
    MODE -->|"run_in_background"| BG[Background<br/>Return task ID]
    MODE -->|"team_name"| TEAM2[Teammate<br/>In-process with identity]
    MODE -->|"isolation: worktree"| WT[Worktree<br/>Isolated git copy]
    MODE -->|"isolation: remote"| REM[Remote<br/>CCR cloud session]

    INLINE --> QE2[New QueryEngine loop]
    BG --> LAT2[LocalAgentTask]
    TEAM2 --> IPT2[InProcessTeammateTask]
    WT --> QE2
    REM --> RAT2[RemoteAgentTask]
```

### Inter-Agent Communication

```mermaid
sequenceDiagram
    participant Leader
    participant SendMsg as SendMessageTool
    participant Mailbox as Mailbox Queue
    participant Worker as Teammate Worker

    Leader->>SendMsg: {to: "worker-1", message: "Implement caching"}
    SendMsg->>Mailbox: Queue message for worker-1
    Mailbox-->>Worker: Deliver on next idle

    Worker->>Worker: Process task
    Worker->>SendMsg: {to: "leader", message: "Done, found 3 API calls"}
    SendMsg->>Mailbox: Queue for leader

    Note over Worker: Worker goes idle (automatic)
    Mailbox-->>Leader: Deliver message

    Leader->>Leader: Synthesize findings
    Leader->>SendMsg: {to: "*", message: "All tasks complete"}
    Note over SendMsg: Broadcast to all teammates
```

---

## 8. Services Layer

```mermaid
graph TB
    subgraph API["API Service"]
        CLAUDE[claude.ts<br/>queryModel + streaming]
        RETRY[withRetry.ts<br/>Retry + fallback logic]
        ERRORS[errors.ts<br/>Error classification]
        LOGGING[logging.ts<br/>Usage tracking]
    end

    subgraph MCP_SVC["MCP Service (22 files)"]
        CLIENT[client.ts<br/>MCP client factory]
        TYPES[types.ts<br/>Server configs]
        AUTH2[auth.ts + xaa.ts<br/>Authentication]
        TRANS[Transports<br/>stdio, SSE, HTTP]
        REG[officialRegistry.ts<br/>Well-known servers]
        CONN[MCPConnectionManager.tsx<br/>Lifecycle management]
    end

    subgraph LSP_SVC["LSP Service"]
        LSPMGR[LSPServerManager.ts<br/>Multi-server management]
        LSPINST[LSPServerInstance.ts<br/>Server lifecycle]
        LSPCLI[LSPClient.ts<br/>Protocol client]
        LSPDIAG[LSPDiagnosticRegistry.ts<br/>Diagnostic aggregation]
    end

    subgraph Analytics_SVC["Analytics Service"]
        GB[growthbook.ts<br/>Feature flags + remote eval]
        EVT[index.ts<br/>Event logging]
        DD[datadog.ts<br/>Metrics sink]
        FP[firstPartyEventLogger.ts<br/>1P logging]
    end

    subgraph Memory_SVC["Memory Services"]
        SM2[SessionMemory/<br/>Conversation notes]
        EM[extractMemories/<br/>Durable project memories]
        MD[MagicDocs/<br/>Auto-doc updates]
        AS2[AgentSummary/<br/>Worker summaries]
    end

    subgraph Compact_SVC["Compaction Service (11 files)"]
        AC2[autoCompact.ts<br/>Threshold detection]
        CP[compact.ts<br/>Fork agent + summarize]
        MC3[microCompact.ts<br/>Per-turn tool_use cleanup]
        RC2[reactiveCompact.ts<br/>Emergency 413 recovery]
        WARN[compactWarningState.ts<br/>User notifications]
    end
```

### Memory Service Architecture

```mermaid
graph LR
    subgraph Triggers
        STOP[Stop Hooks<br/>End of turn]
        POST[Post-Sampling<br/>After model response]
        PERIODIC[Periodic Timer<br/>Every N tool calls]
    end

    subgraph Forked["Forked Agent Pattern"]
        FORK[runForkedAgent<br/>Cache-sharing subagent]
    end

    subgraph Memory_Targets["Memory Targets"]
        SM3[SessionMemory<br/>~/.claude/session-memory.md]
        EM2[extractMemories<br/>~/.claude/projects/.../memory/]
        MD2[MagicDocs<br/>In-file MAGIC DOC sections]
        AS3[AgentSummary<br/>Coordinator UI updates]
    end

    STOP --> EM2
    POST --> MD2
    PERIODIC --> SM3
    PERIODIC --> AS3

    SM3 & EM2 & MD2 & AS3 -->|"All use"| FORK
```

---

## 9. Command System

```mermaid
graph TB
    subgraph Types["Command Types"]
        PROMPT[PromptCommand<br/>type: 'prompt'<br/>Expands into model context]
        LOCAL[LocalCommand<br/>type: 'local'<br/>Terminal text output]
        JSX[LocalJSXCommand<br/>type: 'local-jsx'<br/>Interactive Ink UI]
    end

    subgraph Sources["Command Sources"]
        BUILTIN[Built-in Commands<br/>58+ commands]
        BUNDLED[Bundled Skills<br/>15+ skills]
        PLUGIN[Plugin Commands<br/>MCP-provided]
        SKILLDIR[Skill Directory<br/>~/.claude/skills/]
        DYNAMIC[Dynamic Skills<br/>Discovered during session]
    end

    subgraph Registry2["Registry (commands.ts)"]
        LOAD[loadAllCommands<br/>Async, memoized]
        GET[getCommands<br/>Filter + merge + dedup]
        FIND[findCommand<br/>Name or alias lookup]
    end

    subgraph Exec["Execution"]
        SLASH["/command args"]
        SLASH --> FIND
        FIND --> PROMPT -->|"getPromptForCommand()"| MODEL[Inject into model context]
        FIND --> LOCAL -->|"load() → call()"| TEXT[Return text output]
        FIND --> JSX -->|"load() → call()"| INK2[Render Ink component]
    end

    Sources --> LOAD --> GET
```

### Command Catalog (100+ commands)

| Category | Examples |
|----------|---------|
| **Git** | `/commit`, `/branch`, `/diff`, `/pr_comments`, `/review` |
| **Session** | `/compact`, `/clear`, `/resume`, `/export`, `/share` |
| **Navigation** | `/files`, `/context`, `/stats`, `/cost`, `/usage` |
| **Tools** | `/mcp`, `/hooks`, `/permissions`, `/plugins`, `/skills` |
| **Configuration** | `/config`, `/model`, `/theme`, `/vim`, `/voice` |
| **Development** | `/debug-tool-call`, `/doctor`, `/env`, `/sandbox-toggle` |
| **Agent** | `/agents`, `/tasks`, `/teleport` |
| **UI** | `/help`, `/keybindings`, `/statusline`, `/output-style` |

---

## 10. Permission System

```mermaid
graph TB
    subgraph Modes["Permission Modes"]
        DEFAULT["default<br/>Ask on suspicious"]
        ACCEPT["acceptEdits<br/>Auto-approve file writes"]
        BYPASS["bypassPermissions<br/>Auto-allow all"]
        DONTASK["dontAsk<br/>Auto-deny suspicious"]
        PLAN["plan<br/>Require plan approval"]
        AUTO["auto<br/>ML classifier decides"]
    end

    subgraph Rules["Rule Sources (Priority Order)"]
        CLI_R["CLI args<br/>--allow/--deny"]
        POLICY["Policy settings<br/>Org-wide"]
        USER["User settings<br/>~/.claude/settings.json"]
        PROJECT["Project settings<br/>.claude/settings.json"]
        SESSION["Session grants<br/>Temporary"]
    end

    subgraph Decision["Decision Flow"]
        INPUT[Tool input] --> VALIDATE[validateInput]
        VALIDATE --> HOOKS3[Pre-tool-use hooks]
        HOOKS3 --> CHECK[checkPermissions]
        CHECK --> MATCH{Rule match?}

        MATCH -->|"Allow rule"| ALLOW[Execute tool]
        MATCH -->|"Deny rule"| DENY[Block tool]
        MATCH -->|"No match"| MODE{Permission mode?}

        MODE -->|"bypass"| ALLOW
        MODE -->|"dontAsk"| CLASSIFY{Read-only?}
        CLASSIFY -->|"Yes"| ALLOW
        CLASSIFY -->|"No"| DENY
        MODE -->|"auto"| ML[ML Classifier]
        ML --> ALLOW & DENY & ASK
        MODE -->|"default"| ASK[Prompt user]
    end

    subgraph Classifiers["Classifiers"]
        BASH_CL[bashClassifier<br/>Command analysis]
        YOLO_CL[yoloClassifier<br/>Dangerous pattern detection]
        TRANS_CL[transcriptClassifier<br/>ML-based (feature-gated)]
    end

    ASK --> Classifiers
```

### Permission Rule Format

```
Tool: Bash(git commit *)     → Allow git commits
Tool: Bash(rm -rf *)         → Deny recursive deletes
Tool: FileEdit(src/**)       → Allow edits under src/
Tool: MCPTool(mcp__notion__*)→ Allow all Notion MCP tools
```

---

## 11. Context Management & Compaction

```mermaid
graph TB
    subgraph Budget["Context Window Budget"]
        CW[Context Window<br/>e.g., 200K tokens]
        MOT2[Max Output Tokens<br/>20K reserved]
        ACB[Autocompact Buffer<br/>13K reserved]
        EFF[Effective Budget<br/>CW - MOT - ACB = 167K]
    end

    subgraph Layers["Compaction Layers"]
        L1[Layer 1: Micro-compact<br/>Summarize old tool_use blocks<br/>Cheapest, per-turn]
        L2[Layer 2: Context Collapse<br/>Progressive section collapse<br/>Moderate cost]
        L3[Layer 3: Auto-compact<br/>Full conversation summary<br/>Fork agent, expensive]
        L4[Layer 4: Reactive compact<br/>Emergency on 413 error<br/>Last resort]
    end

    subgraph Flow["Trigger Flow"]
        TURN[New Turn] --> L1
        L1 --> CHECK2{Above threshold?}
        CHECK2 -->|No| API2[Make API call]
        CHECK2 -->|Yes| L2
        L2 --> CHECK3{Still above?}
        CHECK3 -->|No| API2
        CHECK3 -->|Yes| L3
        L3 --> API2
        API2 --> ERR{413 Error?}
        ERR -->|Yes| L4
        ERR -->|No| OK[Continue]
        L4 --> API2
    end
```

### Compaction Process

```mermaid
sequenceDiagram
    participant Loop as Query Loop
    participant AC as Auto-Compact
    participant Fork as Forked Agent
    participant API as Anthropic API

    Loop->>AC: calculateTokenWarningState()
    AC-->>Loop: isAboveAutoCompactThreshold = true

    Loop->>Fork: runForkedAgent(CompactSystemPrompt)
    Fork->>API: Summarize conversation (with cache sharing)
    API-->>Fork: Summary response
    Fork-->>Loop: compactionResult

    Loop->>Loop: buildPostCompactMessages()
    Note over Loop: Summary + file restorations (5 files)<br/>+ skill injections (5 skills)<br/>+ MCP instructions delta

    Loop->>Loop: Insert CompactBoundaryMessage
    Loop->>Loop: Reset tracking, continue loop
```

---

## 12. Bridge & Remote Sessions

```mermaid
graph TB
    subgraph Local["Local Environment"]
        CLI2[Claude Code CLI]
        BRIDGE[bridge/<br/>31 files]
        JWT[JWT Auth<br/>+ Work Secret]
    end

    subgraph Remote["Remote Environments"]
        WEB[Web App<br/>claude.ai/code]
        DESK[Desktop App<br/>Mac/Windows]
        CCR[CCR<br/>Cloud Session]
    end

    subgraph Transport["Transport Layer"]
        WS[WebSocket/SSE]
        POLL[Polling<br/>5s interval, 30min timeout]
    end

    subgraph Session["Session Management"]
        CREATE[createSession.ts]
        RUNNER[sessionRunner.ts]
        HANDLE[replBridgeHandle.ts]
    end

    CLI2 --> BRIDGE
    BRIDGE --> JWT
    JWT --> WS
    WS --> WEB & DESK

    CLI2 -->|"isolation: remote"| CCR
    CCR --> POLL
    POLL --> CLI2

    BRIDGE --> Session
```

### Bridge Modes

| Mode | Description |
|------|-------------|
| `single-session` | One remote session per bridge |
| `worktree` | Isolated git worktree per session |
| `same-dir` | Shared directory, multiple sessions |

---

## 13. Skills & Plugin System

```mermaid
graph TB
    subgraph Skills["Skill System"]
        BS[bundledSkills.ts<br/>15+ compiled skills]
        LS[loadSkillsDir.ts<br/>Dynamic loading]
        MSB[mcpSkillBuilders.ts<br/>MCP-provided skills]

        subgraph Bundled["Bundled Skills"]
            BATCH[batch.ts]
            CLAUDE_API[claudeApi.ts]
            LOOP2[loop.ts]
            SIMPLIFY[simplify.ts]
            VERIFY[verify.ts]
            REMEMBER[remember.ts]
            SKILLIFY[skillify.ts]
            CONFIG2[updateConfig.ts]
        end
    end

    subgraph Plugins["Plugin System"]
        BP[builtinPlugins.ts<br/>Default plugins]
        PIM[PluginInstallationManager.ts<br/>Background install]
        PMK[Marketplace<br/>Reconciliation]
    end

    subgraph Loading["Loading Pipeline"]
        INIT2[Startup] --> BS
        INIT2 --> BP
        BS --> REG2[Register in command registry]
        LS --> REG2
        MSB --> REG2
        BP --> MCP2[Connect MCP servers]
        MCP2 --> MSB
    end

    subgraph Invocation["Skill Invocation"]
        USER2["/skill-name args"]
        USER2 --> FIND2[findCommand]
        FIND2 --> EXPAND[getPromptForCommand]
        EXPAND --> INJECT[Inject into model context]
        INJECT --> EXECUTE[Model executes with skill prompt]
    end
```

---

## 14. Key Design Patterns

### Pattern Catalog

```mermaid
graph TB
    subgraph Patterns
        P1["AsyncGenerator Streaming<br/>query(), tool.call(), API streaming<br/>→ Yields events in real-time"]
        P2["Feature Flag DCE<br/>bun:bundle feature()<br/>→ Dead code eliminated at build time"]
        P3["Forked Agent<br/>runForkedAgent()<br/>→ Cache-sharing subagent for background work"]
        P4["Pub-Sub Store<br/>createStore()<br/>→ Lightweight state management"]
        P5["Continue-Based State Machine<br/>while(true) + state reset + continue<br/>→ Recovery without recursion"]
        P6["Parallel Prefetch<br/>void Promise at module level<br/>→ Overlap I/O with import evaluation"]
        P7["Memoized Lazy Init<br/>memoize(async () => ...)<br/>→ Safe multi-call initialization"]
        P8["Template Cloning<br/>MCPTool cloned per server tool<br/>→ Single definition, many instances"]
    end
```

### Architectural Principles

| Principle | Implementation |
|-----------|---------------|
| **Startup speed** | Module-level prefetch, deferred telemetry, fast paths, memoized init |
| **Streaming first** | AsyncGenerators throughout: API → tools → UI. Real-time updates, never block |
| **Fail gracefully** | Multi-stage recovery (collapse → compact → reactive → escalate → fallback model) |
| **Permission-aware** | Every tool call passes through permission engine. Rules from 7 sources, 6 modes |
| **Build-time optimization** | `feature()` flags eliminate ant-only code from external builds |
| **Cache efficiency** | Prompt cache sharing between parent/child agents. Micro-compact edits cache in-place |
| **Extensibility** | MCP for external tools, skills for prompts, plugins for packages, hooks for lifecycle |
| **Parallel by default** | Read-only tools run concurrently. Agent workers run in background. Prefetch everything |

### File Size Distribution (Top Files)

| File | Size | Role |
|------|------|------|
| `tools/AgentTool/AgentTool.tsx` | ~233KB | Agent spawning, all execution modes |
| `tools/BashTool/BashTool.tsx` | ~160KB | Shell execution with security layers |
| `components/PromptInput/PromptInput.tsx` | ~355KB | Text input, history, suggestions |
| `screens/REPL.tsx` | ~150KB+ | Main REPL screen orchestration |
| `query.ts` | ~100KB | Core agentic loop state machine |
| `QueryEngine.ts` | ~80KB | Session lifecycle management |
| `services/api/claude.ts` | ~100KB+ | API client with streaming + retry |

---

## Appendix: Module Dependency Flow

```mermaid
graph LR
    CLI3[cli.tsx] --> MAIN2[main.tsx]
    MAIN2 --> INIT3[init.ts]
    MAIN2 --> SETUP2[setup.ts]
    MAIN2 --> QE3[QueryEngine.ts]
    MAIN2 --> REPL3[replLauncher.tsx]

    QE3 --> QUERY2[query.ts]
    QUERY2 --> CLAUDE2[services/api/claude.ts]
    QUERY2 --> TOOLS2[tools.ts]
    QUERY2 --> COMPACT2[services/compact/]

    TOOLS2 --> TOOL2[Tool.ts]
    TOOLS2 --> BASH2[tools/BashTool/]
    TOOLS2 --> AGENT2[tools/AgentTool/]
    TOOLS2 --> MCP3[tools/MCPTool/]

    AGENT2 --> QE3
    MCP3 --> MCP4[services/mcp/]

    REPL3 --> APP2[components/App.tsx]
    APP2 --> STATE2[state/AppState.tsx]
    APP2 --> REPL4[screens/REPL.tsx]
    REPL4 --> MSG3[components/Messages.tsx]
    REPL4 --> PI4[components/PromptInput/]

    STATE2 --> STORE2[state/store.ts]
```

---

*Generated by deep codebase analysis — 6 parallel exploration agents across 1,884 source files.*
