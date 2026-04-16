<p align="right"><a href="../en/05_module_bridge.md">English</a></p>

# 阶段 5-A：Bridge 通信层深度解剖

> 本章对 Claude Code CLI 的 Bridge 子系统进行逐模块拆解，覆盖从环境注册、工作轮询、会话生命周期、JWT 令牌刷新到权限回调的完整通信链路。所有分析基于 `cli.js`（v2.1.88，构建时间 2026-03-30T21:59:52Z）的 minified bundle 反向工程与 Source Map 交叉验证。


## 目录

1. [接口契约概览](#1-接口契约概览)
   - 1.1 [Bridge 是什么](#11-bridge-是什么)
   - 1.2 [核心源文件清单](#12-核心源文件清单)
   - 1.3 [外部依赖映射](#13-外部依赖映射)
2. [通信协议与传输层](#2-通信协议与传输层)
   - 2.1 [传输通道选型](#21-传输通道选型)
   - 2.2 [消息格式与序列化](#22-消息格式与序列化)
   - 2.3 [上行代理（Upstream Proxy）](#23-上行代理upstream-proxy)
3. [认证体系](#3-认证体系)
   - 3.1 [OAuth 令牌获取](#31-oauth-令牌获取)
   - 3.2 [JWT 令牌生命周期管理](#32-jwt-令牌生命周期管理)
   - 3.3 [可信设备（Trusted Device）](#33-可信设备trusted-device)
   - 3.4 [401 重试机制](#34-401-重试机制)
4. [Bridge API 层](#4-bridge-api-层)
   - 4.1 [REST 端点总览](#41-rest-端点总览)
   - 4.2 [环境注册](#42-环境注册)
   - 4.3 [工作轮询（Poll for Work）](#43-工作轮询poll-for-work)
   - 4.4 [心跳与续租](#44-心跳与续租)
   - 4.5 [会话归档](#45-会话归档)
   - 4.6 [权限事件发送](#46-权限事件发送)
   - 4.7 [会话重连](#47-会话重连)
   - 4.8 [错误处理与 BridgeFatalError](#48-错误处理与-bridgefatalerror)
5. [会话管理](#5-会话管理)
   - 5.1 [会话创建流程](#51-会话创建流程)
   - 5.2 [会话运行器（Session Runner）](#52-会话运行器session-runner)
   - 5.3 [会话活动追踪](#53-会话活动追踪)
   - 5.4 [多会话与容量控制](#54-多会话与容量控制)
   - 5.5 [Spawn 模式与 Worktree](#55-spawn-模式与-worktree)
6. [REPL Bridge](#6-repl-bridge)
   - 6.1 [REPL Bridge 入口](#61-repl-bridge-入口)
   - 6.2 [传输层实现](#62-传输层实现)
   - 6.3 [双向消息转发](#63-双向消息转发)
   - 6.4 [断线重连策略](#64-断线重连策略)
7. [权限回调系统](#7-权限回调系统)
   - 7.1 [远程权限请求流程](#71-远程权限请求流程)
   - 7.2 [control_request 协议](#72-control_request-协议)
   - 7.3 [权限结果回传](#73-权限结果回传)
8. [Bridge UI 层](#8-bridge-ui-层)
   - 8.1 [连接状态渲染](#81-连接状态渲染)
   - 8.2 [QR Code 生成](#82-qr-code-生成)
   - 8.3 [会话列表展示](#83-会话列表展示)
9. [调试与故障注入](#9-调试与故障注入)
   - 9.1 [调试日志标签体系](#91-调试日志标签体系)
   - 9.2 [Bridge Debug 命令](#92-bridge-debug-命令)
   - 9.3 [故障注入接口](#93-故障注入接口)
10. [配置参数体系](#10-配置参数体系)
11. [演进思维实验](#11-演进思维实验)
12. [架构评估](#12-架构评估)


## 1. 接口契约概览

### 1.1 Bridge 是什么

Bridge 是 Claude Code CLI 的 **Remote Control** 子系统——它将本地终端中运行的 CLI 实例与 `claude.ai/code` 网页端（以及移动端 Claude 应用）双向连接，使用户可以从任何设备远程控制本地 CLI 会话。

从架构角度看，Bridge 实现了一个「分布式代理人」模式：

```
┌──────────────────┐     HTTPS/WSS      ┌───────────────────┐      ┌──────────────────┐
│   claude.ai/code │ ◄──────────────────► │  Anthropic API    │ ◄───► │  Claude Code CLI  │
│   (网页/移动端)   │                      │  Bridge 服务端    │       │  (本地终端)        │
└──────────────────┘                      └───────────────────┘      └──────────────────┘
      用户交互                                 消息中继                    工具执行
```

核心设计原则：

- **CLI 是主体**：所有工具执行、文件操作、命令运行均在本地 CLI 进程中完成
- **服务端是中继**：Anthropic API 充当消息代理，不直接访问用户文件系统
- **轮询驱动**：CLI 端主动轮询服务端获取工作，而非服务端直接推送
- **安全第一**：JWT 认证 + 可信设备 + 工作区信任检查的三层安全模型

### 1.2 核心源文件清单

通过 Source Map 反向解析，Bridge 子系统涉及以下 **31** 个应用源文件（`.ts` 扩展名）：

| 源文件 | 职责 |
|--------|------|
| `bridgeApi.ts` | REST API 客户端封装，所有与 Bridge 服务端的 HTTP 交互 |
| `bridgeClient.ts` | Bridge 客户端高级封装，整合 API 与状态管理 |
| `bridgeConfig.ts` | Bridge 相关配置项读取与管理 |
| `bridgeDebug.ts` | 调试工具注册，故障注入句柄 |
| `BridgeDialog.ts` | Bridge 相关对话框 UI 组件 |
| `bridgeEnabled.ts` | Bridge 功能开关与能力检测 |
| `bridgeMain.ts` | Bridge 主入口，`claude remote-control` 命令的启动逻辑 |
| `bridgeMessaging.ts` | 消息协议定义，事件序列化/反序列化 |
| `bridgePermissionCallbacks.ts` | 远程权限请求的回调处理器 |
| `bridgePointer.ts` | Bridge 指针管理（当前活跃 Bridge 引用） |
| `bridgeStatusUtil.ts` | Bridge 连接状态工具函数 |
| `bridgeUI.ts` | 终端 UI 渲染（状态行、连接动画、QR Code） |
| `bridge.ts` | 公共类型定义与常量 |
| `createSession.ts` | 远程会话创建逻辑 |
| `daemonBridge.ts` | 守护进程模式下的 Bridge 集成 |
| `envLessBridgeConfig.ts` | 无环境变量时的 Bridge 配置降级 |
| `initReplBridge.ts` | REPL 模式下 Bridge 的初始化 |
| `jwtUtils.ts` | JWT 令牌解析与过期时间提取 |
| `leaderPermissionBridge.ts` | 团队 Leader 权限审批的 Bridge 适配 |
| `migrateReplBridgeEnabledToRemoteControlAtStartup.ts` | 配置迁移：旧版 replBridge 到新版 Remote Control |
| `remoteBridgeCore.ts` | 远程 Bridge 核心逻辑（环境注册、轮询循环） |
| `remotePermissionBridge.ts` | 远程权限请求的 Bridge 通道 |
| `replBridge.ts` | REPL Bridge 实现——将 CLI REPL 模式连接到远程 |
| `replBridgeHandle.ts` | REPL Bridge 句柄管理 |
| `replBridgeTransport.ts` | REPL Bridge 传输层抽象 |
| `sessionRunner.ts` | 会话运行器——子进程管理与 stdio 通信 |
| `sessionActivity.ts` | 会话活动解析与 UI 更新 |
| `sessionTitle.ts` | 会话标题生成与更新 |
| `trustedDevice.ts` | 可信设备令牌管理 |
| `useMailboxBridge.ts` | React Hook：Mailbox 模式下的 Bridge 集成 |
| `useReplBridge.ts` | React Hook：REPL 模式下的 Bridge 集成 |

### 1.3 外部依赖映射

```
Bridge 子系统
├── axios ($1) ─── HTTP 客户端，用于所有 REST API 调用
├── ws (WebSocket) ─── WebSocket 全双工通信（上行代理）
│   ├── WebSocket ── 客户端连接
│   ├── WebSocketServer ── 本地代理服务器
│   ├── Sender / Receiver ── 帧级别控制
│   └── createWebSocketStream ── 流化适配
├── zod (L) ─── 配置验证（轮询间隔、心跳参数等）
├── readline ─── 子进程 stdout/stderr 行解析
└── child_process (spawn) ─── 会话子进程创建
```


## 2. 通信协议与传输层

### 2.1 传输通道选型

Bridge 系统使用 **三种** 传输通道，各承担不同职责：

| 通道 | 协议 | 方向 | 用途 |
|------|------|------|------|
| REST API（axios） | HTTPS | CLI → 服务端 | 环境注册、工作轮询、心跳、归档 |
| WebSocket（ws） | WSS | 双向 | 上行代理（upstream proxy）——透传 CLI 出站 HTTPS 流量 |
| stdio（子进程） | Pipe | CLI ↔ 子进程 | 会话运行器与 CLI 子进程之间的消息传递 |

**为什么不使用纯 WebSocket 做所有通信？**

Bridge 采用的是**轮询（polling）+ REST**架构而非长连接。原因包括：

1. **可靠性优先**：HTTP 请求具有明确的请求-响应语义，便于重试和错误处理
2. **防火墙友好**：企业网络环境中 WebSocket 常被代理拦截，HTTP 轮询更可靠
3. **服务端简化**：无需维护大量长连接状态
4. **自然节流**：轮询间隔即是内置的流量控制

WebSocket 仅用于 **上行代理**，将 CLI 子进程发起的 HTTPS 请求通过 WSS 隧道转发出去，绕过受限网络环境。

### 2.2 消息格式与序列化

所有通信消息使用 **JSON 序列化**，核心消息类型包括：

```typescript
// 会话子进程 → stdin/stdout 的消息格式（stream-json）
type BridgeStdinMessage =
  | { type: "update_environment_variables"; variables: Record<string, string> }
  | SessionEvent;       // 其他会话事件

// 会话活动解析结果
type SessionActivity =
  | { type: "tool_start"; summary: string; timestamp: number }
  | { type: "text"; summary: string; timestamp: number }
  | { type: "result"; summary: string; timestamp: number }
  | { type: "error"; summary: string; timestamp: number };

// 权限相关消息
type ControlRequest = {
  type: "control_request";
  request: { subtype: "can_use_tool"; /* ... */ };
};
```

会话子进程通过 `--input-format stream-json --output-format stream-json` 启动，每行一个 JSON 对象，通过 `readline` 逐行解析。

### 2.3 上行代理（Upstream Proxy）

上行代理是 Bridge 系统中唯一使用 WebSocket 的组件，用于解决企业受限网络环境下的出站连接问题：

```
CLI 子进程 HTTPS 请求
        │
        ▼
┌───────────────────┐
│ 本地 Proxy Server │  127.0.0.1:${port}
│  (HTTP CONNECT)   │
└───────┬───────────┘
        │ WebSocket 隧道
        ▼
┌───────────────────┐
│ Anthropic API     │
│ /v1/code/         │
│ upstreamproxy/ws  │
└───────────────────┘
```

关键实现细节（来自 `cli.js` 反编译）：

```javascript
// WebSocket 连接建立
let O = z.replace(/^http/, "ws") + "/v1/code/upstreamproxy/ws";
// 帧分片大小：524,288 字节（512KB）
const HUK = 524288;
// 心跳间隔：30,000ms
const PxY = 30000;
```

安全措施：
- **仅 HTTPS 或 localhost**：启动时校验 `baseUrl`，拒绝非安全连接
- **CA 证书动态下载**：从 `/v1/code/upstreamproxy/ca-cert` 获取 CA 证书，注入到子进程环境
- **Linux 特殊处理**：调用 `prctl(PR_SET_DUMPABLE, 0)` 防止核心转储泄露令牌
- **NO_PROXY 白名单**：`localhost`、`127.0.0.1`、`anthropic.com`、`github.com`、`pypi.org` 等常用域名绕过代理


## 3. 认证体系

### 3.1 OAuth 令牌获取

Bridge 认证的起点是 OAuth 令牌。CLI 通过 `getBridgeAccessToken()` 和 `getBridgeBaseUrl()` 获取凭证和服务端地址。未登录时输出错误信息并退出：

```
Remote Control requires a claude.ai subscription.
Run `claude auth login` to sign in with your claude.ai account.
```

### 3.2 JWT 令牌生命周期管理

`jwtUtils.ts` 实现了完整的 JWT 令牌生命周期管理，这是 Bridge 认证的核心：

```
JWT 令牌刷新时间线
──────────────────────────────────────────────────────►
│                                              │     │
│              正常使用期                       │缓冲 │过期
│                                              │300s │
│                                              │     │
                                     定时刷新触发 ──►
```

**令牌解码**：

```javascript
// JWT 格式检测（sk-ant-si- 前缀）
function VCY(token) {
  let parts = (token.startsWith("sk-ant-si-") ? token.slice(10) : token).split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

// 过期时间提取
function h_7(token) {
  let payload = VCY(token);
  if (payload !== null && typeof payload === "object" && "exp" in payload)
    return payload.exp;  // Unix 时间戳
  return null;
}
```

**定时刷新策略**：

| 参数 | 值 | 说明 |
|------|-----|------|
| `refreshBufferMs` | 300,000ms (5min) | 过期前提前刷新的缓冲时间 |
| 后续刷新间隔 | 1,800,000ms (30min) | 首次刷新后的定期刷新间隔 |
| 重试间隔 | 60,000ms (1min) | 刷新失败后的重试间隔 |
| 最大重试次数 | 3 | OAuth 令牌不可用时的最大重试 |

令牌刷新使用 **世代（generation）机制** 防止竞态条件——每个 sessionId 维护一个单调递增的 generation 计数器，过期的刷新回调通过比对 generation 自动跳过。

### 3.3 可信设备（Trusted Device）

`trustedDevice.ts` 管理设备级别的信任令牌：

```javascript
// API 请求中添加可信设备头
let deviceToken = config.getTrustedDeviceToken?.();
if (deviceToken) {
  headers["X-Trusted-Device-Token"] = deviceToken;
}
```

可信设备令牌在每次 API 请求中作为 HTTP 头发送，服务端据此判断请求是否来自已授权的物理设备。

### 3.4 401 重试机制

所有 Bridge API 调用内置了 **单次 401 重试** 逻辑：

```
请求 ─── 200 ──► 返回结果
  │
  └── 401 ──► 调用 onAuth401(oldToken) ──► 令牌刷新 ──► 重试请求
                                              │
                                              └── 失败 ──► 返回 401 响应
```


## 4. Bridge API 层

### 4.1 REST 端点总览

`bridgeApi.ts` 封装的完整 API 端点清单：

| 方法 | 端点 | 功能 | 超时 |
|------|------|------|------|
| `POST` | `/v1/environments/bridge` | 注册 Bridge 环境 | 15s |
| `GET` | `/v1/environments/{id}/work/poll` | 轮询待处理工作 | 10s |
| `POST` | `/v1/environments/{id}/work/{workId}/ack` | 确认工作 | 10s |
| `POST` | `/v1/environments/{id}/work/{workId}/stop` | 停止工作 | 10s |
| `POST` | `/v1/environments/{id}/work/{workId}/heartbeat` | 工作心跳 | 10s |
| `POST` | `/v1/environments/{id}/bridge/reconnect` | 会话重连 | 10s |
| `DELETE` | `/v1/environments/bridge/{id}` | 注销 Bridge 环境 | 10s |
| `POST` | `/v1/sessions/{id}/archive` | 归档会话 | 10s |
| `POST` | `/v1/sessions/{id}/events` | 发送权限响应事件 | 10s |
| `PATCH` | `/v1/sessions/{id}` | 更新会话标题 | 10s |
| `GET` | `/v1/sessions/{id}` | 获取会话详情 | 10s |
| `POST` | `/v1/code/sessions` | 创建新会话 | - |
| `GET` | `/v1/sessions/{id}/events` | 获取会话事件 | 30s |

所有请求携带统一认证头：

```javascript
headers = {
  "Authorization": `Bearer ${accessToken}`,
  "Content-Type": "application/json",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": LVY,  // beta 特性标识
  "X-Trusted-Device-Token": deviceToken  // 可选
};
```

**输入安全**：所有 environmentId、sessionId、workId 参数均通过正则 `XT()` 校验，禁止包含不安全字符，防止路径遍历攻击。

### 4.2 环境注册

CLI 启动 Remote Control 时的第一步是向服务端注册 Bridge 环境：

```javascript
POST /v1/environments/bridge
{
  machine_name: "hostname",
  directory: "/path/to/project",
  branch: "main",
  git_repo_url: "https://github.com/user/repo",
  max_sessions: capacity,
  metadata: { worker_type: "..." },
  environment_id: reuseEnvironmentId  // 可选：复用已有环境
}

// 响应
{ environment_id: "env-xxx-xxx" }
```

注册成功后，CLI 获得 `environment_id`，后续所有轮询和心跳操作均基于此 ID。

### 4.3 工作轮询（Poll for Work）

轮询是 Bridge 通信的核心驱动力。CLI 持续调用 `pollForWork()` 从服务端拉取待处理工作：

```
轮询循环
────────────────────────────────────────────────────►
│       │       │       │       │
poll    poll    poll    poll    poll
 │       │       │       │       │
null    null   work!   null    null
                 │
            acknowledge
                 │
            spawn session
```

**轮询间隔动态调整**（通过 Zod 验证的配置）：

| 场景 | 参数 | 默认值 |
|------|------|--------|
| 单会话 - 未满 | `poll_interval_ms_not_at_capacity` | 2,000ms |
| 单会话 - 已满 | `poll_interval_ms_at_capacity` | 600,000ms (10min) |
| 多会话 - 未满 | `multisession_poll_interval_ms_not_at_capacity` | 2,000ms |
| 多会话 - 部分满 | `multisession_poll_interval_ms_partial_capacity` | 2,000ms |
| 多会话 - 全满 | `multisession_poll_interval_ms_at_capacity` | 600,000ms |
| 工作回收阈值 | `reclaim_older_than_ms` | 5,000ms |
| 会话保活 | `session_keepalive_interval_v2_ms` | 120,000ms (2min) |

**空轮询日志优化**：连续空轮询只在第 1 次和每 100 次时输出日志，避免日志洪泛。

### 4.4 心跳与续租

工作分配后，CLI 定期发送心跳以维持租约：

```javascript
POST /v1/environments/{envId}/work/{workId}/heartbeat
// 响应
{
  lease_extended: true,    // 租约是否续期
  state: "active"          // 工作当前状态
}
```

心跳间隔由 `non_exclusive_heartbeat_interval_ms` 配置控制，默认值为 0（禁用，依赖轮询保活）。

### 4.5 会话归档

会话完成或被中断时，CLI 调用归档接口：

```javascript
POST /v1/sessions/{sessionId}/archive
// 409 = 已归档，视为成功
```

归档操作在会话子进程退出后触发，确保所有会话数据已持久化。

### 4.6 权限事件发送

当用户在网页端确认权限请求时，通过事件接口传回 CLI：

```javascript
POST /v1/sessions/{sessionId}/events
{
  events: [{ type: "permission_response", /* ... */ }]
}
```

### 4.7 会话重连

支持断线后的会话恢复：

```javascript
POST /v1/environments/{envId}/bridge/reconnect
{ session_id: "sess-xxx" }
```

重连场景包括：网络瞬断、CLI 进程重启、令牌刷新导致的连接重置。

### 4.8 错误处理与 BridgeFatalError

`bridgeApi.ts` 定义了分层的错误处理策略：

| HTTP 状态码 | 行为 | 说明 |
|------------|------|------|
| 200/204 | 正常返回 | - |
| 401 | 触发令牌刷新后重试 | 最多重试 1 次 |
| 403 | 抛出 `BridgeFatalError` | 检查 `session_expired` 子类型 |
| 404 | 抛出 `BridgeFatalError` | Remote Control 不可用 |
| 410 | 抛出 `BridgeFatalError` | 会话已过期 |
| 5xx | 不校验（`validateStatus: s < 500`） | 由调用者处理 |

`BridgeFatalError` 携带 HTTP 状态码和可选的错误类型标识，调用者据此决定是重试、降级还是终止：

```javascript
class BridgeFatalError extends Error {
  constructor(message, status, errorType) { /* ... */ }
}

// 403 + session_expired 的特殊处理
if (bS6(errorType)) {
  message = "Remote Control session has expired. Please restart with " +
            "`claude remote-control` or /remote-control.";
}
```


## 5. 会话管理

### 5.1 会话创建流程

当 `pollForWork()` 返回工作时，Bridge 创建一个新的会话子进程：

```
pollForWork() 返回 work
        │
        ▼
acknowledgeWork()    ──► 确认接收工作
        │
        ▼
解析 work.data
├── type: "create_session"  ──► 创建新会话
└── type: "reconnect"       ──► 恢复已有会话
        │
        ▼
spawn() 子进程
├── 命令: process.execPath（Node.js/Bun）
├── 参数: --print --sdk-url ${sdkUrl} --session-id ${sessionId}
│         --input-format stream-json --output-format stream-json
│         --replay-user-messages
├── 环境变量:
│   ├── CLAUDE_CODE_SESSION_ACCESS_TOKEN = accessToken
│   ├── CLAUDE_CODE_ENVIRONMENT_KIND = "bridge"
│   ├── CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2 = "1"
│   └── CLAUDE_CODE_FORCE_SANDBOX = "1"（如果启用沙箱）
└── stdio: ['pipe', 'pipe', 'pipe']
```

### 5.2 会话运行器（Session Runner）

`sessionRunner.ts` 中的 `C_7()` 工厂函数返回一个 `spawn()` 方法，该方法创建并管理会话子进程。每个会话子进程是一个完整的 Claude Code CLI 实例，通过 stdin/stdout 与主进程通信。

**子进程生命周期**：

```
spawn()
  │
  ├── stdout readline ──► 逐行解析 JSON
  │     ├── 解析 tool_use ──► 更新 sessionActivity
  │     ├── 解析 text ──► 更新 sessionActivity
  │     ├── 解析 control_request ──► 触发 onPermissionRequest 回调
  │     ├── 解析 user 消息 ──► 触发 onFirstUserMessage 回调
  │     └── 写入 transcript log（如果启用）
  │
  ├── stderr readline ──► 缓存最近 10 行错误信息
  │
  └── exit/error 事件 ──► 解析退出状态
        ├── SIGTERM/SIGINT ──► "interrupted"
        ├── exit code 0    ──► "completed"
        └── 其他            ──► "failed"
```

**返回的会话句柄**：

```typescript
interface SessionHandle {
  sessionId: string;
  done: Promise<"completed" | "failed" | "interrupted">;
  activities: SessionActivity[];        // 最近 10 条活动
  currentActivity: SessionActivity;     // 最新活动
  accessToken: string;
  lastStderr: string[];                 // 最近 10 行 stderr

  kill(): void;           // 发送 SIGTERM
  forceKill(): void;      // 发送 SIGKILL
  writeStdin(data): void; // 写入 stdin
  updateAccessToken(token): void; // 运行时令牌更新
}
```

**令牌热更新**：当 JWT 令牌刷新时，通过 stdin 发送 `update_environment_variables` 消息，无需重启子进程：

```javascript
writeStdin(JSON.stringify({
  type: "update_environment_variables",
  variables: { CLAUDE_CODE_SESSION_ACCESS_TOKEN: newToken }
}) + "\n");
```

### 5.3 会话活动追踪

`sessionActivity.ts` 中的 `uCY()` 函数从子进程 stdout 解析活动事件：

| 消息类型 | 解析内容 | 活动类型 |
|----------|----------|----------|
| `assistant.tool_use` | 工具名 + 输入参数摘要 | `tool_start` |
| `assistant.text` | 文本前 80 字符 | `text` |
| `result.success` | "Session completed" | `result` |
| `result.error` | 错误信息 | `error` |

工具名映射表（增强可读性）：

```javascript
const toolDisplayNames = {
  Read: "Reading", Write: "Writing", Edit: "Editing",
  Bash: "Running", Glob: "Searching", Grep: "Searching",
  WebFetch: "Fetching", WebSearch: "Searching",
  Task: "Running task", LSP: "LSP",
  // ...
};
```

### 5.4 多会话与容量控制

Bridge 支持同时管理多个远程会话，通过 `max_sessions`（容量）参数控制：

```
Bridge 环境（capacity=3）
├── 会话 1：活跃 ── "修复登录Bug" ── Running Bash
├── 会话 2：活跃 ── "重构API" ── Editing src/api.ts
├── 会话 3：空闲
│
├── 轮询间隔：2,000ms（部分满）
└── UI 显示：Capacity: 2/3
```

多会话功能需要账户级别的特性开关（`IFK()` 检查），未获准的账户在尝试启动多会话时报错：

```
Error: Multi-session Remote Control is not enabled for your account yet.
```

### 5.5 Spawn 模式与 Worktree

新会话可以在三种模式下创建：

| 模式 | 说明 | 要求 |
|------|------|------|
| `single-session` | 单次会话，完成后退出 | 默认模式 |
| `same-dir` | 在当前目录创建新会话 | 多会话权限 |
| `worktree` | 在 Git worktree 中创建隔离会话 | Git 仓库 + 多会话权限 |

Worktree 模式的优势：每个会话在独立的 Git worktree 中工作，避免文件冲突。如果目录不是 Git 仓库，自动降级到 `same-dir` 模式：

```
Warning: Saved spawn mode is worktree but this directory is not a git repository.
Falling back to same-dir.
```


## 6. REPL Bridge

### 6.1 REPL Bridge 入口

REPL Bridge 是 Bridge 子系统在交互式 CLI 模式（非 `remote-control` 命令）中的集成点。它允许用户在普通 CLI 会话中通过 `/remote-control` 斜杠命令开启远程连接。

相关源文件链路：

```
initReplBridge.ts ──► replBridge.ts ──► replBridgeTransport.ts
                                            │
useReplBridge.ts (React Hook)               │
                                            ▼
                                    replBridgeHandle.ts
```

### 6.2 传输层实现

`replBridgeTransport.ts` 实现了 REPL Bridge 的传输层抽象。与 `remote-control` 命令的子进程模式不同，REPL Bridge 直接在当前进程内运行，通过消息事件桥接 REPL 循环和远程连接。

传输层的核心职责：
- 从远程 Bridge 接收用户消息，注入到 REPL 输入流
- 从 REPL 输出流捕获响应，转发到远程 Bridge
- 管理连接状态（connecting → connected → idle → reconnecting）

### 6.3 双向消息转发

```
网页端用户输入
      │
      ▼
Bridge 服务端
      │ (HTTP 事件推送)
      ▼
REPL Bridge Transport
      │
      ▼
本地 REPL 循环
      │
      ▼
Claude API 调用
      │
      ▼
工具执行 / 文本回复
      │
      ▼
REPL Bridge Transport
      │ (HTTP 事件回传)
      ▼
Bridge 服务端
      │
      ▼
网页端展示结果
```

`isBridge` 标志在会话写入（`write()`）时用于触发额外的调试日志输出：

```javascript
// 来自 cli.js 第 16410 行
if (this.isBridge) {
  if (event.type === "control_request" || this.isDebug) {
    log(serialize(event) + "\n");
  }
}
```

### 6.4 断线重连策略

REPL Bridge 的重连逻辑在 `replBridgeTransport.ts` 中实现，包含多层恢复机制：

```
传输层断开（WebSocket close 事件）
      │
      ▼
检查 transport reconnect budget
      │
      ├── 有预算 ──► 传输层重连
      │
      └── 无预算 ──► 尝试环境级重连
                          │
                          ├── 成功 ──► 恢复连接
                          │
                          └── 失败 + 信号未中止 ──► 报告连接丢失
```

断线时 UI 切换到 `reconnecting` 状态，显示重连动画。如果最终无法恢复，切换到 `failed` 状态。


## 7. 权限回调系统

### 7.1 远程权限请求流程

当远程会话中的 Claude 需要执行需要权限的工具时（如写入文件、运行命令），权限请求通过 Bridge 传播到网页端供用户确认：

```
CLI 子进程：Claude 需要执行 Bash("rm -rf node_modules")
      │
      ▼
stdout 输出 control_request JSON
      │
      ▼
sessionRunner 解析 control_request
      │
      ▼
onPermissionRequest 回调触发
      │
      ▼
bridgePermissionCallbacks.ts 处理
      │
      ▼
sendPermissionResponseEvent() ──► POST /v1/sessions/{id}/events
      │
      ▼
网页端显示权限确认对话框
      │
      ▼
用户确认/拒绝
      │
      ▼
事件回传 ──► CLI 子进程继续/中止执行
```

### 7.2 control_request 协议

`control_request` 是权限回调的核心消息类型：

```javascript
{
  type: "control_request",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    tool_input: { command: "npm install" },
    // ... 其他上下文
  }
}
```

子进程通过 stdout 输出 `control_request`，主进程解析后触发 `onPermissionRequest` 回调。

### 7.3 权限结果回传

权限结果通过 `sendPermissionResponseEvent()` API 调用回传到会话：

```javascript
POST /v1/sessions/{sessionId}/events
{
  events: [{
    type: "permission_response",
    // 包含 allow/deny 决策及原因
  }]
}
```


## 8. Bridge UI 层

### 8.1 连接状态渲染

`bridgeUI.ts` 实现了 Bridge 的终端 UI，使用 ANSI 转义序列进行就地渲染（覆盖已有行）：

**状态机**：

```
idle ──► connecting ──► connected ──► titled
  ▲                         │           │
  │                         ▼           ▼
  └──── failed ◄── reconnecting ◄──────┘
```

| 状态 | 颜色 | 图标 | 说明 |
|------|------|------|------|
| `connecting` | 黄色 | 旋转动画 | 正在连接 |
| `idle` | 绿色 | `HA8`（静态图标） | 等待会话 |
| `connected` | 青色 | `HA8` | 会话活跃 |
| `titled` | 青色 | `HA8` | 会话已命名 |
| `reconnecting` | 黄色 | 旋转动画 | 断线重连中 |
| `failed` | 红色 | - | 连接失败 |

**连接动画**：150ms 间隔的旋转器（spinner），使用 `Pp6` 字符数组。

### 8.2 QR Code 生成

Bridge UI 可以生成 QR Code 方便移动端扫描连接：

```javascript
const qrOptions = {
  type: "utf8",
  errorCorrectionLevel: "L",    // 低纠错（更紧凑）
  small: true                   // 紧凑模式
};
```

QR Code 通过空格键切换显示/隐藏。异步生成，失败时静默降级（记录错误日志但不阻塞 UI）。

### 8.3 会话列表展示

多会话模式下，UI 展示所有活跃会话的列表：

```
◉ Connected
    Capacity: 2/3 · New sessions will be created in an isolated worktree
    修复登录Bug    https://claude.ai/code/xxx ── Running Bash
    重构API       https://claude.ai/code/yyy ── Editing src/api.ts
```

每个会话显示：
- 标题（截断到 35 字符）
- URL（可点击的深链接）
- 当前活动（最近的 `tool_start` 或 `text` 活动摘要，截断到 40 字符）


## 9. 调试与故障注入

### 9.1 调试日志标签体系

Bridge 子系统使用分层日志标签，便于过滤和追踪：

| 标签 | 来源 | 内容 |
|------|------|------|
| `[bridge:api]` | `bridgeApi.ts` | REST API 请求/响应 |
| `[bridge:session]` | `sessionRunner.ts` | 子进程生命周期 |
| `[bridge:ws]` | `sessionRunner.ts` | 子进程 stdin/stdout 消息 |
| `[bridge:activity]` | `sessionActivity.ts` | 会话活动事件 |
| `[bridge:ui]` | `bridgeUI.ts` | UI 渲染调试 |
| `[bridge:repl]` | `replBridge*.ts` | REPL Bridge 通信 |
| `[bridge:poll]` | `remoteBridgeCore.ts` | 轮询循环状态 |
| `[bridge:token]` | `jwtUtils.ts` | JWT 令牌刷新 |
| `[upstreamproxy]` | 上行代理 | 代理连接与转发 |

每条日志均附带 `sessionId`、操作类型和关键参数，便于多会话场景下的问题定位。

### 9.2 Bridge Debug 命令

CLI 内置了 `/_bridge-debug` 隐藏命令，提供实时的 Bridge 状态查询和故障注入能力：

```
Usage: _bridge-debug <subcommand>

  close <code>              fire a transport close with numeric code
  poll <status> [type]      next poll throws BridgeFatalError(status, type)
  poll transient            next poll throws a transient (axios rejection)
  reconnect-session fail    next POST /bridge/reconnect fails
  heartbeat <status>        next heartbeat throws BridgeFatalError(status)
  status                    print bridge state
```

该命令仅在 Bridge 连接处于活跃状态且 `USER_TYPE=ant` 时可用。

### 9.3 故障注入接口

故障注入通过 `bridgeDebug.ts` 注册的句柄实现：

```javascript
// 触发传输层关闭
handle.fireClose(code);

// 注入下次轮询失败
handle.injectFault({
  method: "pollForWork",
  kind: "transient",  // 或 "fatal"
  status: 503,
  count: 1            // 影响次数
});

// 唤醒轮询循环（立即触发下一次轮询）
handle.wakePollLoop();
```

这套故障注入机制在开发和测试中非常有价值，可以模拟各种网络故障场景而无需实际断网。


## 10. 配置参数体系

Bridge 配置通过全局配置文件和环境变量两个层面控制：

**环境变量**：

| 变量 | 说明 |
|------|------|
| `CLAUDE_CODE_REMOTE` | 标识当前运行在远程 Bridge 环境中 |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | 远程会话 ID |
| `CLAUDE_CODE_SESSION_ACCESS_TOKEN` | 会话访问令牌 |
| `CLAUDE_CODE_ENVIRONMENT_KIND` | 环境类型（设为 `"bridge"`） |
| `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2` | 使用 v2 会话入口 |
| `CLAUDE_CODE_USE_CCR_V2` | 使用 CCR v2 |
| `CLAUDE_CODE_WORKER_EPOCH` | Worker 纪元编号 |
| `CLAUDE_CODE_FORCE_SANDBOX` | 强制沙箱模式 |
| `CCR_UPSTREAM_PROXY_ENABLED` | 启用上行代理 |

**全局配置项**：

| 配置键 | 说明 |
|--------|------|
| `remoteDialogSeen` | 用户已看过 Remote Control 确认对话框 |
| `remoteControlSpawnMode` | 多会话创建模式（`same-dir` / `worktree`） |

**轮询配置**（通过 feature flag `tengu_bridge_poll_interval_config` 下发）：

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

配置值通过 Zod schema 验证，确保所有数值在合理范围内（如轮询间隔最小 100ms、心跳间隔最小 0ms 或禁用）。


## 11. 演进思维实验

为什么 Bridge 的当前设计是合理的？让我们通过三级演进来理解：

### Level 1：纯 CLI（无远程）

```
用户 ──► 终端 ──► Claude Code CLI ──► Anthropic API
                       │
                  本地工具执行
```

**局限**：
- 只能在启动 CLI 的设备上操作
- 外出时无法继续会话
- 无法多人协作审查

### Level 2：简单 HTTP API 暴露

```
用户 ──► 浏览器 ──► CLI 暴露的 HTTP API ──► 本地工具执行
```

**问题**：
- CLI 需要暴露端口到公网——严重安全风险
- 穿透 NAT/防火墙困难
- 无法利用 Anthropic 现有基础设施
- 单向控制，无法实现权限确认等双向交互

### Level 3（当前方案）：服务端中继 + 轮询驱动

```
用户 ──► claude.ai ──► Anthropic 中继 ◄── CLI 主动轮询
                            │
                  双向消息传递 + 权限回调
```

**优势**：
- **零端口暴露**：CLI 仅发起出站请求，无需监听任何端口
- **防火墙友好**：纯 HTTPS 出站，可穿透绝大多数企业网络
- **安全认证**：复用 Anthropic 账户体系（OAuth + JWT + 可信设备）
- **权限双向确认**：用户可在网页端审查并确认工具执行权限
- **多会话支持**：一个 CLI 实例可同时服务多个远程会话
- **断线恢复**：轮询机制天然支持重连，无需维护长连接状态
- **多设备接入**：任何设备的浏览器或 Claude 应用都可连接
- **渐进式降级**：Bridge 完全是可选的，CLI 本身不依赖任何远程功能


## 12. 架构评估

### 优点

1. **安全设计扎实**：三层认证（OAuth + JWT + 可信设备）+ 输入参数严格校验 + 沙箱模式 + 工作区信任检查，形成纵深防御
2. **子进程隔离**：每个远程会话运行在独立的子进程中，通过 stdio 通信，进程崩溃不影响主 Bridge
3. **令牌热更新**：通过 stdin 消息更新令牌，无需重启子进程，零停机
4. **轮询间隔动态调整**：根据容量状态自动调整轮询频率，空闲时降到 10 分钟一次，避免浪费
5. **故障注入能力**：内置的调试命令支持模拟各种故障场景，大幅提升可测试性
6. **源文件组织清晰**：31 个文件按职责划分，命名规范统一，便于维护

### 设计张力

1. **轮询延迟 vs 实时性**：2 秒轮询间隔意味着最坏情况下用户操作需等待 2 秒才被 CLI 感知。对于交互密集场景可能感到迟滞。但考虑到实际使用中 Claude 的思考和回复时间远超 2 秒，这个延迟在实践中可以接受。

2. **子进程模型的开销**：每个远程会话启动一个完整的 Node.js/Bun 进程，内存开销较大。但这换来了进程级隔离和简化的状态管理——单进程多会话模型虽然节省内存，但状态共享和错误隔离会显著增加复杂度。

3. **轮询配置远程下发**：轮询间隔通过 feature flag（`tengu_bridge_poll_interval_config`）从服务端下发，这意味着 Anthropic 可以远程调整所有客户端的轮询行为。这提供了运维灵活性，但也引入了对服务端配置可用性的隐式依赖（配置不可用时回退到硬编码默认值）。

4. **上行代理的必要性判断**：上行代理仅在 `CLAUDE_CODE_REMOTE` + `CCR_UPSTREAM_PROXY_ENABLED` 同时设置时启用，存在明确的降级路径。但代理本身引入了 CA 证书管理、WebSocket 长连接维护等额外复杂度，只在企业受限网络环境中才有价值。

### 关键指标参考

| 指标 | 值 |
|------|-----|
| 源文件数 | 31 |
| REST API 端点数 | 13 |
| 环境变量控制项 | 8 |
| 默认轮询间隔（未满） | 2s |
| 默认轮询间隔（已满） | 10min |
| JWT 刷新缓冲时间 | 5min |
| 子进程活动缓冲大小 | 10 条 |
| WebSocket 帧分片大小 | 512KB |
| WebSocket 心跳间隔 | 30s |
| 令牌刷新失败最大重试 | 3 次 |


> **下一篇**：阶段 5-B 将选择另一个核心模块（工具系统或权限引擎）进行同等深度的解剖。
