<p align="right"><a href="../cn/05_module_bridge.md">中文</a></p>

# Phase 5-A: Deep Dive into the Bridge Communication Layer

> This chapter breaks down the Claude Code CLI Bridge subsystem module by module, covering the full communication path from environment registration and work polling to session lifecycle management, JWT refresh, and permission callbacks. All analysis is grounded in reverse engineering of the `cli.js` minified bundle for v2.1.88 (build time `2026-03-30T21:59:52Z`) and cross-validated against the source map.


## Contents

1. Interface-Contract Overview
   - 1.1 What Bridge Is
   - 1.2 Core Source Files
   - 1.3 External Dependency Map
2. Communication Protocol and Transport Layer
   - 2.1 Transport-Channel Selection
   - 2.2 Message Formats and Serialization
   - 2.3 Upstream Proxy
3. Authentication System
   - 3.1 OAuth Token Acquisition
   - 3.2 JWT Lifecycle Management
   - 3.3 Trusted Devices
   - 3.4 401 Retry Logic
4. Bridge API Layer
   - 4.1 REST Endpoint Overview
   - 4.2 Environment Registration
   - 4.3 Poll for Work
   - 4.4 Heartbeats and Lease Renewal
   - 4.5 Session Archiving
   - 4.6 Permission Event Delivery
   - 4.7 Session Reconnect
   - 4.8 Error Handling and `BridgeFatalError`
5. Session Management
   - 5.1 Session Creation Flow
   - 5.2 Session Runner
   - 5.3 Session Activity Tracking
   - 5.4 Multi-session Capacity Control
   - 5.5 Spawn Modes and Worktrees
6. REPL Bridge
   - 6.1 REPL Bridge Entry Point
   - 6.2 Transport Implementation
   - 6.3 Bidirectional Message Forwarding
   - 6.4 Reconnection Strategy
7. Permission Callback System
   - 7.1 Remote Permission Request Flow
   - 7.2 The `control_request` Protocol
   - 7.3 Returning Permission Decisions
8. Bridge UI Layer
   - 8.1 Connection-State Rendering
   - 8.2 QR Code Generation
   - 8.3 Session List Rendering
9. Debugging and Fault Injection
   - 9.1 Debug Log Tags
   - 9.2 Bridge Debug Command
   - 9.3 Fault-Injection Hooks
10. Configuration Parameters
11. Evolution Thought Experiment
12. Architecture Assessment


## 1. Interface-Contract Overview

### 1.1 What Bridge Is

Bridge is Claude Code CLI's **Remote Control** subsystem. It connects a locally running CLI instance to `claude.ai/code` and the mobile Claude app, allowing the user to control the local CLI session from another device.

Architecturally, Bridge implements a distributed-agent model:

```text
claude.ai/code / mobile client
        ↕ HTTPS / WSS
Anthropic Bridge service
        ↕ message relay
local Claude Code CLI
        ↕ local tools and filesystem access
```

Core design principles:

- **The CLI is the actor**: tool execution, file access, and shell commands all happen locally.
- **The server is only a relay**: Anthropic does not directly operate on the user's filesystem.
- **Polling drives the flow**: the CLI fetches work from the server; the server does not push arbitrary execution directly.
- **Security is layered**: JWT auth, trusted-device checks, and workspace trust all participate.

### 1.2 Core Source Files

Source-map reconstruction shows that the Bridge subsystem spans **31** application files:

| File | Responsibility |
|--------|------|
| `bridgeApi.ts` | REST client wrapper for all Bridge HTTP calls |
| `bridgeClient.ts` | High-level Bridge client abstraction |
| `bridgeConfig.ts` | Bridge configuration loading and management |
| `bridgeDebug.ts` | Debug utilities and fault-injection handles |
| `BridgeDialog.ts` | Bridge-related dialog UI |
| `bridgeEnabled.ts` | Feature gating and capability detection |
| `bridgeMain.ts` | Main entry for `claude remote-control` |
| `bridgeMessaging.ts` | Protocol definitions and event serialization |
| `bridgePermissionCallbacks.ts` | Remote permission callback handlers |
| `bridgePointer.ts` | Active Bridge pointer management |
| `bridgeStatusUtil.ts` | Connection-status helpers |
| `bridgeUI.ts` | Terminal UI rendering, status line, animation, QR code |
| `bridge.ts` | Shared types and constants |
| `createSession.ts` | Remote session creation |
| `daemonBridge.ts` | Bridge integration for daemon mode |
| `envLessBridgeConfig.ts` | Fallback config when env vars are unavailable |
| `initReplBridge.ts` | REPL-mode Bridge initialization |
| `jwtUtils.ts` | JWT parsing and expiration extraction |
| `leaderPermissionBridge.ts` | Team-leader approval bridging |
| `migrateReplBridgeEnabledToRemoteControlAtStartup.ts` | Config migration from old REPL Bridge flags |
| `remoteBridgeCore.ts` | Core remote Bridge loop and environment registration |
| `remotePermissionBridge.ts` | Remote permission-request bridging |
| `replBridge.ts` | REPL-specific Bridge implementation |
| `replBridgeHandle.ts` | REPL Bridge handle management |
| `replBridgeTransport.ts` | REPL Bridge transport abstraction |
| `sessionRunner.ts` | Session subprocess management and stdio transport |
| `sessionActivity.ts` | Session activity parsing and UI updates |
| `sessionTitle.ts` | Session-title generation and updates |
| `trustedDevice.ts` | Trusted-device token management |
| `useMailboxBridge.ts` | React hook for Mailbox-mode Bridge integration |
| `useReplBridge.ts` | React hook for REPL-mode Bridge integration |

### 1.3 External Dependency Map

```text
Bridge subsystem
├── axios ($1)           HTTP client for REST APIs
├── ws                   WebSocket client/server support
│   ├── WebSocket
│   ├── WebSocketServer
│   ├── Sender / Receiver
│   └── createWebSocketStream
├── zod (L)             Config validation
├── readline            Line-oriented subprocess parsing
└── child_process       Session subprocess spawning
```


## 2. Communication Protocol and Transport Layer

### 2.1 Transport-Channel Selection

Bridge uses three transport classes, each with a different purpose:

| Channel | Protocol | Direction | Purpose |
|------|------|------|------|
| REST API | HTTPS | CLI → server | Environment registration, work polling, heartbeat, archiving |
| WebSocket | WSS | Bidirectional | Upstream proxy for tunneled outbound HTTPS |
| stdio | Pipes | CLI ↔ subprocess | Communication between the parent process and session subprocesses |

Why not use WebSocket for everything?

Bridge intentionally favors **polling plus REST** over a fully persistent push channel:

1. HTTP request-response semantics are easier to retry and reason about.
2. Enterprise networks often interfere with WebSocket traffic.
3. The server can stay simpler because it does not need to hold full execution state in long-lived connections.
4. Poll intervals naturally provide throttling.

WebSocket is reserved for the **upstream proxy**, where it solves a specific networking problem.

### 2.2 Message Formats and Serialization

Bridge messages are JSON-serialized. Core message shapes include:

```typescript
type BridgeStdinMessage =
  | { type: "update_environment_variables"; variables: Record<string, string> }
  | SessionEvent;

type SessionActivity =
  | { type: "tool_start"; summary: string; timestamp: number }
  | { type: "text"; summary: string; timestamp: number }
  | { type: "result"; summary: string; timestamp: number }
  | { type: "error"; summary: string; timestamp: number };

type ControlRequest = {
  type: "control_request";
  request: { subtype: "can_use_tool" };
};
```

Session subprocesses are launched with:

```text
--input-format stream-json --output-format stream-json
```

Each line is a separate JSON object, parsed incrementally through `readline`.

### 2.3 Upstream Proxy

The upstream proxy is the only major Bridge component built on WebSocket. It exists to tunnel outbound HTTPS traffic in restricted enterprise-network environments.

High-level flow:

```text
CLI subprocess HTTPS request
→ local proxy server on 127.0.0.1:${port}
→ WebSocket tunnel
→ Anthropic /v1/code/upstreamproxy/ws
```

Representative runtime details:

```javascript
let O = z.replace(/^http/, "ws") + "/v1/code/upstreamproxy/ws";
const HUK = 524288;  // 512 KB frame chunk size
const PxY = 30000;   // 30s heartbeat interval
```

Security measures include:

- only secure origins or localhost are accepted
- CA certificates can be downloaded dynamically from `/v1/code/upstreamproxy/ca-cert`
- Linux explicitly calls `prctl(PR_SET_DUMPABLE, 0)` to reduce the risk of leaking credentials via core dumps
- `NO_PROXY` allowlists common local and trusted domains such as `localhost`, `127.0.0.1`, `anthropic.com`, `github.com`, and `pypi.org`


## 3. Authentication System

### 3.1 OAuth Token Acquisition

Bridge starts from OAuth-backed authentication. The CLI retrieves credentials and base URL through `getBridgeAccessToken()` and `getBridgeBaseUrl()`. If the user is not signed in, Bridge exits with a message like:

```text
Remote Control requires a claude.ai subscription.
Run `claude auth login` to sign in with your claude.ai account.
```

### 3.2 JWT Lifecycle Management

`jwtUtils.ts` handles JWT parsing and expiry management.

Representative decode helpers:

```javascript
function VCY(token) {
  let parts = (token.startsWith("sk-ant-si-") ? token.slice(10) : token).split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function h_7(token) {
  let payload = VCY(token);
  if (payload !== null && typeof payload === "object" && "exp" in payload)
    return payload.exp;
  return null;
}
```

Refresh strategy:

| Parameter | Value | Meaning |
|------|-----|------|
| `refreshBufferMs` | 300000 ms | Refresh 5 minutes before expiry |
| periodic refresh | 1800000 ms | Refresh every 30 minutes afterward |
| retry interval | 60000 ms | Retry after failure |
| max retries | 3 | Maximum retry count when OAuth becomes unavailable |

Bridge also uses a **generation counter** per session to avoid stale refresh callbacks from winning races.

### 3.3 Trusted Devices

`trustedDevice.ts` manages a device-level trust token:

```javascript
let deviceToken = config.getTrustedDeviceToken?.();
if (deviceToken) {
  headers["X-Trusted-Device-Token"] = deviceToken;
}
```

That token is attached to Bridge API requests so the server can distinguish previously trusted physical devices.

### 3.4 401 Retry Logic

All Bridge API requests implement a single built-in 401 retry path:

```text
request
→ 200: success
→ 401: call onAuth401(oldToken)
      → refresh token
      → retry once
      → if still failing, surface the 401
```


## 4. Bridge API Layer

### 4.1 REST Endpoint Overview

`bridgeApi.ts` wraps the following endpoints:

| Method | Endpoint | Purpose | Timeout |
|------|------|------|------|
| `POST` | `/v1/environments/bridge` | Register Bridge environment | 15 s |
| `GET` | `/v1/environments/{id}/work/poll` | Poll for work | 10 s |
| `POST` | `/v1/environments/{id}/work/{workId}/ack` | Acknowledge work | 10 s |
| `POST` | `/v1/environments/{id}/work/{workId}/stop` | Stop work | 10 s |
| `POST` | `/v1/environments/{id}/work/{workId}/heartbeat` | Heartbeat | 10 s |
| `POST` | `/v1/environments/{id}/bridge/reconnect` | Reconnect session | 10 s |
| `DELETE` | `/v1/environments/bridge/{id}` | Unregister environment | 10 s |
| `POST` | `/v1/sessions/{id}/archive` | Archive session | 10 s |
| `POST` | `/v1/sessions/{id}/events` | Send permission or control events | 10 s |
| `PATCH` | `/v1/sessions/{id}` | Update session title | 10 s |
| `GET` | `/v1/sessions/{id}` | Fetch session details | 10 s |
| `POST` | `/v1/code/sessions` | Create a session | — |
| `GET` | `/v1/sessions/{id}/events` | Fetch session events | 30 s |

Standard headers include:

```javascript
{
  Authorization: `Bearer ${accessToken}`,
  "Content-Type": "application/json",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": LVY,
  "X-Trusted-Device-Token": deviceToken
}
```

Environment, session, and work IDs are validated through `XT()` so unsafe characters cannot be used to exploit path construction.

### 4.2 Environment Registration

Remote Control starts by registering a Bridge environment:

```javascript
POST /v1/environments/bridge
{
  machine_name: "hostname",
  directory: "/path/to/project",
  branch: "main",
  git_repo_url: "https://github.com/user/repo",
  max_sessions: capacity,
  metadata: { worker_type: "..." },
  environment_id: reuseEnvironmentId
}
```

The server returns an `environment_id`, which becomes the anchor for polling, heartbeats, and reconnects.

### 4.3 Poll for Work

Polling is the main driver of Bridge execution. The CLI repeatedly calls `pollForWork()`:

```text
poll → poll → poll → work arrives → acknowledge → spawn session
```

The poll interval changes based on capacity. Representative defaults:

| Scenario | Config Key | Default |
|------|------|--------|
| single-session, not full | `poll_interval_ms_not_at_capacity` | 2000 ms |
| single-session, full | `poll_interval_ms_at_capacity` | 600000 ms |
| multi-session, not full | `multisession_poll_interval_ms_not_at_capacity` | 2000 ms |
| multi-session, partially full | `multisession_poll_interval_ms_partial_capacity` | 2000 ms |
| multi-session, full | `multisession_poll_interval_ms_at_capacity` | 600000 ms |
| reclaim threshold | `reclaim_older_than_ms` | 5000 ms |
| session keepalive | `session_keepalive_interval_v2_ms` | 120000 ms |

To prevent log spam, empty polls are logged only on the first empty result and then every hundredth empty result.

### 4.4 Heartbeats and Lease Renewal

Once work is assigned, the CLI can send heartbeats to maintain the lease:

```javascript
POST /v1/environments/{envId}/work/{workId}/heartbeat
```

Representative response:

```javascript
{
  lease_extended: true,
  state: "active"
}
```

Heartbeat frequency is controlled by `non_exclusive_heartbeat_interval_ms`, which defaults to `0` and is often effectively disabled in favor of poll-based liveness.

### 4.5 Session Archiving

When a session completes or is interrupted, the CLI archives it:

```javascript
POST /v1/sessions/{sessionId}/archive
```

A `409` response, meaning "already archived," is treated as success.

### 4.6 Permission Event Delivery

When the user approves or denies a remote permission request in the web UI, Bridge forwards that response through:

```javascript
POST /v1/sessions/{sessionId}/events
{
  events: [{ type: "permission_response" }]
}
```

### 4.7 Session Reconnect

Bridge supports reconnecting a dropped session:

```javascript
POST /v1/environments/{envId}/bridge/reconnect
{ session_id: "sess-xxx" }
```

This covers network interruptions, CLI restarts, and token refresh resets.

### 4.8 Error Handling and `BridgeFatalError`

`bridgeApi.ts` uses layered HTTP error handling:

| Status | Behavior | Notes |
|------------|------|------|
| 200 / 204 | success | — |
| 401 | refresh token and retry once | at most one retry |
| 403 | throw `BridgeFatalError` | check `session_expired` subtype |
| 404 | throw `BridgeFatalError` | Remote Control unavailable |
| 410 | throw `BridgeFatalError` | session expired |
| 5xx | allow through | handled by caller |

Representative runtime shape:

```javascript
class BridgeFatalError extends Error {
  constructor(message, status, errorType) {}
}
```

There is also custom handling for `403 + session_expired`, which turns into a restart instruction for `claude remote-control` or `/remote-control`.


## 5. Session Management

### 5.1 Session Creation Flow

When `pollForWork()` yields work, Bridge spins up a new session subprocess:

```text
pollForWork()
→ acknowledgeWork()
→ inspect work.data
→ create_session or reconnect
→ spawn subprocess
```

The subprocess is launched with arguments such as:

```text
--print
--sdk-url ${sdkUrl}
--session-id ${sessionId}
--input-format stream-json
--output-format stream-json
--replay-user-messages
```

Representative environment variables:

- `CLAUDE_CODE_SESSION_ACCESS_TOKEN`
- `CLAUDE_CODE_ENVIRONMENT_KIND=bridge`
- `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2=1`
- `CLAUDE_CODE_FORCE_SANDBOX=1` when sandboxing is enabled

### 5.2 Session Runner

`sessionRunner.ts` exposes a factory that spawns and manages session subprocesses. Each child process is a full Claude Code CLI instance connected to the parent over stdin/stdout.

High-level lifecycle:

- stdout lines are parsed as JSON
- tool events, text events, `control_request`s, and first-user-message events are detected
- optional transcript logs can be written
- stderr is buffered, keeping the last 10 lines
- exit status is normalized to `completed`, `failed`, or `interrupted`

Representative handle shape:

```typescript
interface SessionHandle {
  sessionId: string;
  done: Promise<"completed" | "failed" | "interrupted">;
  activities: SessionActivity[];
  currentActivity: SessionActivity;
  accessToken: string;
  lastStderr: string[];

  kill(): void;
  forceKill(): void;
  writeStdin(data): void;
  updateAccessToken(token): void;
}
```

JWT refreshes do not require a subprocess restart. Instead, the parent sends:

```javascript
{
  type: "update_environment_variables",
  variables: { CLAUDE_CODE_SESSION_ACCESS_TOKEN: newToken }
}
```

### 5.3 Session Activity Tracking

`sessionActivity.ts` parses subprocess stdout into UI-facing activity summaries.

Representative mapping:

| Message Type | Parsed Content | Activity Type |
|----------|----------|----------|
| `assistant.tool_use` | Tool name plus summarized inputs | `tool_start` |
| `assistant.text` | First ~80 characters | `text` |
| `result.success` | Completion summary | `result` |
| `result.error` | Error summary | `error` |

To make the UI easier to read, tool names are mapped into friendlier verbs such as:

```javascript
{
  Read: "Reading",
  Write: "Writing",
  Edit: "Editing",
  Bash: "Running",
  Glob: "Searching",
  Grep: "Searching",
  WebFetch: "Fetching",
  WebSearch: "Searching"
}
```

### 5.4 Multi-session Capacity Control

Bridge can manage multiple remote sessions at once, subject to `max_sessions`.

Representative model:

```text
Bridge environment, capacity = 3
├── Session 1 active
├── Session 2 active
├── Session 3 idle
└── polling interval depends on current fill level
```

Multi-session support is account-gated. If the feature is not enabled, Bridge surfaces an explicit error explaining that multi-session Remote Control is not yet available for the account.

### 5.5 Spawn Modes and Worktrees

New sessions can start in three modes:

| Mode | Meaning | Requirements |
|------|------|------|
| `single-session` | One session, exit when complete | default |
| `same-dir` | Start another session in the current directory | multi-session permission |
| `worktree` | Start an isolated session inside a Git worktree | Git repo plus multi-session permission |

If the saved mode is `worktree` but the directory is not a Git repo, Bridge automatically falls back to `same-dir`.


## 6. REPL Bridge

### 6.1 REPL Bridge Entry Point

REPL Bridge is the Bridge integration for normal interactive CLI sessions, rather than the dedicated `remote-control` command. It allows a user to enable remote connectivity from a regular CLI session via `/remote-control`.

Relevant file chain:

```text
initReplBridge.ts → replBridge.ts → replBridgeTransport.ts
                                ↘ useReplBridge.ts
                                 ↘ replBridgeHandle.ts
```

### 6.2 Transport Implementation

Unlike the dedicated `remote-control` flow, REPL Bridge runs inside the current process. `replBridgeTransport.ts` bridges between the REPL loop and the remote event channel.

Its core responsibilities are:

- inject remote user messages into the local REPL input stream
- capture local REPL outputs and forward them upstream
- maintain transport states such as `connecting`, `connected`, `idle`, and `reconnecting`

### 6.3 Bidirectional Message Forwarding

The full path looks like this:

```text
web user input
→ Bridge service
→ REPL Bridge transport
→ local REPL loop
→ Claude API/tool execution
→ REPL Bridge transport
→ Bridge service
→ web UI
```

When `isBridge` is set, writes can emit extra debug logging:

```javascript
if (this.isBridge) {
  if (event.type === "control_request" || this.isDebug) {
    log(serialize(event) + "\n");
  }
}
```

### 6.4 Reconnection Strategy

REPL Bridge uses layered recovery:

```text
transport disconnect
→ check reconnect budget
→ if budget remains: reconnect transport
→ otherwise attempt environment-level reconnect
→ if that fails and no abort signal is set: report connection loss
```

The UI moves through `reconnecting` and, if recovery fails, eventually `failed`.


## 7. Permission Callback System

### 7.1 Remote Permission Request Flow

When a remote Claude session wants to perform a privileged action, the permission request travels through Bridge to the web UI:

```text
CLI subprocess decides it needs permission
→ emits control_request JSON on stdout
→ sessionRunner parses it
→ onPermissionRequest fires
→ bridgePermissionCallbacks.ts handles it
→ sendPermissionResponseEvent() posts to session events
→ web UI shows approval dialog
→ user allows or denies
→ decision is delivered back to the subprocess
```

### 7.2 The `control_request` Protocol

The core message looks like:

```javascript
{
  type: "control_request",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    tool_input: { command: "npm install" }
  }
}
```

The child process emits it on stdout, and the parent process turns it into a remote approval flow.

### 7.3 Returning Permission Decisions

Permission responses flow back through:

```javascript
POST /v1/sessions/{sessionId}/events
{
  events: [{
    type: "permission_response"
  }]
}
```


## 8. Bridge UI Layer

### 8.1 Connection-State Rendering

`bridgeUI.ts` renders Bridge state directly in the terminal using ANSI control sequences.

Observed state machine:

```text
idle → connecting → connected → titled
  ↑         ↓            ↓
  └── failed ← reconnecting
```

Representative state presentation:

| State | Color | Indicator | Meaning |
|------|------|------|------|
| `connecting` | yellow | spinner | connecting |
| `idle` | green | static icon | waiting for a session |
| `connected` | cyan | static icon | active session |
| `titled` | cyan | static icon | session named |
| `reconnecting` | yellow | spinner | reconnecting |
| `failed` | red | none | connection failed |

The spinner updates every 150 ms and uses the `Pp6` character array.

### 8.2 QR Code Generation

Bridge UI can generate a QR code so a mobile device can connect quickly:

```javascript
const qrOptions = {
  type: "utf8",
  errorCorrectionLevel: "L",
  small: true
};
```

The QR view is toggled with the space bar. Generation is asynchronous, and failures degrade silently except for debug logging.

### 8.3 Session List Rendering

In multi-session mode, the UI shows a list of active sessions:

```text
◉ Connected
    Capacity: 2/3 · New sessions will be created in an isolated worktree
    Fix login bug   https://claude.ai/code/xxx ── Running Bash
    Refactor API    https://claude.ai/code/yyy ── Editing src/api.ts
```

Each item includes:

- title, truncated to about 35 characters
- a deep-link URL
- current activity summary, truncated to roughly 40 characters


## 9. Debugging and Fault Injection

### 9.1 Debug Log Tags

Bridge uses layered log tags:

| Tag | Source | Meaning |
|------|------|------|
| `[bridge:api]` | `bridgeApi.ts` | REST request / response activity |
| `[bridge:session]` | `sessionRunner.ts` | Session subprocess lifecycle |
| `[bridge:ws]` | `sessionRunner.ts` | stdin / stdout message traffic |
| `[bridge:activity]` | `sessionActivity.ts` | Session activity parsing |
| `[bridge:ui]` | `bridgeUI.ts` | UI rendering |
| `[bridge:repl]` | `replBridge*.ts` | REPL Bridge transport activity |
| `[bridge:poll]` | `remoteBridgeCore.ts` | Poll-loop state |
| `[bridge:token]` | `jwtUtils.ts` | JWT refresh logic |
| `[upstreamproxy]` | upstream proxy | tunnel behavior |

These logs typically include the `sessionId`, operation type, and critical parameters so multi-session debugging stays tractable.

### 9.2 Bridge Debug Command

Claude Code includes a hidden `/_bridge-debug` command:

```text
Usage: _bridge-debug <subcommand>

  close <code>
  poll <status> [type]
  poll transient
  reconnect-session fail
  heartbeat <status>
  status
```

It is only available while Bridge is active and `USER_TYPE=ant`.

### 9.3 Fault-Injection Hooks

Fault injection is wired through handles registered in `bridgeDebug.ts`:

```javascript
handle.fireClose(code);

handle.injectFault({
  method: "pollForWork",
  kind: "transient",
  status: 503,
  count: 1
});

handle.wakePollLoop();
```

This allows developers to simulate network or transport failures without actually disconnecting the machine.


## 10. Configuration Parameters

Bridge behavior is controlled by both environment variables and persisted settings.

**Environment variables**

| Variable | Meaning |
|------|------|
| `CLAUDE_CODE_REMOTE` | Marks execution inside a remote Bridge environment |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | Remote session ID |
| `CLAUDE_CODE_SESSION_ACCESS_TOKEN` | Session access token |
| `CLAUDE_CODE_ENVIRONMENT_KIND` | Environment type, set to `"bridge"` |
| `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2` | Enables v2 session ingress |
| `CLAUDE_CODE_USE_CCR_V2` | Enables CCR v2 |
| `CLAUDE_CODE_WORKER_EPOCH` | Worker epoch number |
| `CLAUDE_CODE_FORCE_SANDBOX` | Forces sandbox mode |
| `CCR_UPSTREAM_PROXY_ENABLED` | Enables the upstream proxy |

**Global settings**

| Setting Key | Meaning |
|--------|------|
| `remoteDialogSeen` | Whether the user has already seen the Remote Control confirmation dialog |
| `remoteControlSpawnMode` | Spawn mode for new sessions, such as `same-dir` or `worktree` |

**Polling configuration**

Feature flags can remotely supply:

```typescript
const defaults = {
  poll_interval_ms_not_at_capacity: 2000,
  poll_interval_ms_at_capacity: 600000,
  non_exclusive_heartbeat_interval_ms: 0,
  multisession_poll_interval_ms_not_at_capacity: 2000,
  multisession_poll_interval_ms_partial_capacity: 2000,
  multisession_poll_interval_ms_at_capacity: 600000,
  reclaim_older_than_ms: 5000,
  session_keepalive_interval_v2_ms: 120000,
};
```

These values are validated through Zod to keep them within safe operating ranges.


## 11. Evolution Thought Experiment

Why does Bridge look the way it does? A three-step progression explains the design.

### Level 1: Pure local CLI

```text
user → terminal → Claude Code CLI → Anthropic API
                    ↘ local tool execution
```

Limitations:

- only usable on the device where the CLI is running
- no easy continuation while away from that machine
- no browser-based review and approval loop

### Level 2: Expose a simple HTTP API

```text
user → browser → CLI-exposed HTTP API → local tool execution
```

Problems:

- local ports would need to be exposed to the internet
- NAT and firewall traversal is hard
- it would not reuse Anthropic's authentication and infrastructure
- bidirectional approval flows would be awkward

### Level 3: Server relay plus polling

```text
user → claude.ai → Anthropic relay ← CLI polling
                             ↕
                   bidirectional events and permission callbacks
```

Advantages:

- zero inbound ports on the user's machine
- HTTPS-only outbound traffic works in most enterprise environments
- authentication reuses Anthropic account infrastructure
- browser-side permission approval is possible
- one CLI can serve multiple remote sessions
- reconnection is straightforward because the model is poll-driven
- Bridge remains optional; the CLI does not depend on remote control to function


## 12. Architecture Assessment

### Strengths

1. **Strong security posture**: OAuth, JWT, trusted-device tokens, workspace trust, and sandbox support form a layered defense.
2. **Subprocess isolation**: each remote session runs in its own child process, so one session failure does not take down the Bridge parent.
3. **Hot token updates**: JWT refreshes are pushed into children over stdin, avoiding process restarts.
4. **Adaptive polling**: poll frequency changes with capacity, dropping to 10 minutes when the environment is full.
5. **Built-in fault injection**: the debug command makes transport and server-failure scenarios testable.
6. **Clean file organization**: the 31 source files follow a strong responsibility split.

### Design tensions

1. **Polling latency vs. responsiveness**: a 2-second poll interval means remote input can wait up to 2 seconds before the CLI sees it. In practice this is usually acceptable because model thinking time dominates, but it is still a real tradeoff.
2. **Subprocess cost**: every remote session starts a full Node.js/Bun process. This consumes memory, but it buys clean isolation and simpler state management.
3. **Server-delivered poll tuning**: Anthropic can change poll behavior centrally through feature flags such as `tengu_bridge_poll_interval_config`. That is operationally useful, but it also introduces a soft dependency on remote config availability.
4. **Upstream proxy complexity**: the proxy path only matters in restrictive enterprise networks, yet it introduces certificate management, WebSocket maintenance, and extra failure modes.

### Reference Metrics

| Metric | Value |
|------|-----|
| Source files | 31 |
| REST endpoints | 13 |
| Environment-variable toggles | 8 |
| Default poll interval when not full | 2 s |
| Default poll interval when full | 10 min |
| JWT refresh buffer | 5 min |
| Activity buffer size | 10 entries |
| WebSocket frame chunk size | 512 KB |
