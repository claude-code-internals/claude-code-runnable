<p align="right"><a href="../en/05_module_mcp.md">English</a></p>

# 阶段 5-E：MCP 协议集成深度解剖

> 本章对 Claude Code 中 MCP（Model Context Protocol，模型上下文协议）的完整集成架构进行深度逆向分析。MCP 是 Anthropic 定义的开放标准，旨在为 LLM 提供统一的外部工具与资源访问协议。在 Claude Code 中，MCP 子系统覆盖超过 30 个源文件的功能区域，涉及服务器发现、连接管理、传输层抽象、工具注册、资源系统、安全模型和插件生态。所有分析基于 `cli.js`（16667 行）源码逆向验证，辅以 `sdk-tools.d.ts` 公开类型交叉确认。


## 目录

1. [接口契约](#1-接口契约)
   - 1.1 [MCP 协议概述](#11-mcp-协议概述)
   - 1.2 [核心接口清单](#12-核心接口清单)
   - 1.3 [MCP 工具命名规范](#13-mcp-工具命名规范)
   - 1.4 [三大 MCP 内建工具](#14-三大-mcp-内建工具)
   - 1.5 [MCP Client 状态模型](#15-mcp-client-状态模型)
2. [实现机制](#2-实现机制)
   - 2.1 [MCP 服务器发现](#21-mcp-服务器发现)
   - 2.2 [连接管理 -- MCPConnectionManager 生命周期](#22-连接管理----mcpconnectionmanager-生命周期)
   - 2.3 [传输层抽象](#23-传输层抽象)
   - 2.4 [工具注册 -- MCP 工具到 Claude Code 工具的映射](#24-工具注册----mcp-工具到-claude-code-工具的映射)
   - 2.5 [资源系统 -- Resources 读取和列举](#25-资源系统----resources-读取和列举)
   - 2.6 [安全模型](#26-安全模型)
   - 2.7 [官方注册表与插件生态](#27-官方注册表与插件生态)
   - 2.8 [环境变量扩展](#28-环境变量扩展)
   - 2.9 [MCPB (MCP Bundle) 格式](#29-mcpb-mcp-bundle-格式)
   - 2.10 [Channel 通道系统](#210-channel-通道系统)
3. [演进思维实验](#3-演进思维实验)
4. [验证策略](#4-验证策略)


## 1. 接口契约

### 1.1 MCP 协议概述

MCP（Model Context Protocol）是 Anthropic 主导定义的开放标准协议，核心目标是建立 LLM 与外部服务之间的标准化通信接口。在 Claude Code 中，MCP 承担着"工具扩展总线"的角色——所有第三方工具、外部资源和自定义服务均通过 MCP 协议接入。

MCP 协议的三大核心原语（Primitive）：

| 原语 | 方向 | 说明 |
|------|------|------|
| **Tools** | 服务器 -> 客户端暴露 | 服务器向客户端暴露可调用的函数，带有 JSON Schema 输入参数定义 |
| **Resources** | 服务器 -> 客户端暴露 | 服务器向客户端暴露可读取的数据资源（文件、数据库条目等） |
| **Prompts** | 服务器 -> 客户端暴露 | 服务器向客户端暴露预定义的提示模板（Claude Code 当前主要消费 Tools 和 Resources） |

在 Claude Code 的实现中，MCP 客户端嵌入在 CLI 进程内部，在会话初始化阶段自动发现并连接配置的 MCP 服务器，将远程工具映射为本地 Claude 可调用的工具。

### 1.2 核心接口清单

从 `cli.js` 中提取的 MCP 子系统核心接口：

| 接口/类名 | 角色 | 关键职责 |
|-----------|------|---------|
| `MCPConnectionManager` | 连接管理器 | 管理所有 MCP 服务器的生命周期、连接/断开/重连 |
| `MCP Client` | 协议客户端 | 基于 `@modelcontextprotocol/sdk` 实现的标准 MCP 客户端 |
| `ListMcpResourcesTool` | 内建工具 | 列举所有已连接 MCP 服务器的可用资源 |
| `ReadMcpResourceTool` | 内建工具 | 按 URI 读取指定 MCP 服务器的资源内容 |
| MCP 代理工具 | 动态工具 | 每个远程 MCP 工具在本地注册为 `mcp__<serverName>__<toolName>` 格式的工具 |
| `SSETransport` (bJ6) | 传输层 | SSE（Server-Sent Events）+ HTTP POST 双向传输 |
| `StdioClientTransport` | 传输层 | 基于子进程 stdin/stdout 的本地传输 |
| `StreamableHTTPClientTransport` | 传输层 | 基于 HTTP 的可流式传输（新一代协议） |
| `fX7` (SdkControlTransport) | 传输层 | SDK 内部进程间桥接传输 |

### 1.3 MCP 工具命名规范

MCP 工具在 Claude Code 中使用严格的双下划线命名约定：

```
mcp__<serverName>__<toolName>
```

示例：
- `mcp__claude-in-chrome__tabs_context_mcp` -- Chrome 浏览器扩展提供的标签页上下文工具
- `mcp__playwright__screenshot` -- Playwright 浏览器自动化提供的截图工具
- `mcp__weather__get_forecast` -- 自定义天气服务器提供的天气查询工具

工具名解析函数 `nT()` 从完整工具名中提取 `serverName` 和 `toolName`：

```javascript
// cli.js 中的工具名解析逻辑（已简化）
function nT(toolName) {
  if (!toolName.startsWith("mcp__")) return null;
  const parts = toolName.split("__");
  // parts[0] = "mcp", parts[1] = serverName, parts[2..] = toolName
  if (parts.length < 3) return null;
  return {
    serverName: parts[1],
    toolName: parts.slice(2).join("__")
  };
}
```

此命名规范在权限系统中起关键作用：`alwaysAllowRules` 和 `alwaysDenyRules` 可以通过 `mcp__<serverName>__*` 模式匹配某个服务器的所有工具。

### 1.4 三大 MCP 内建工具

#### 1.4.1 MCP 代理工具（动态生成）

每个 MCP 服务器暴露的工具在 Claude Code 中被动态注册为独立工具。这些工具：
- 使用 `shouldDefer: true` 标记为延迟加载（ToolSearch 机制）
- 输入/输出 Schema 直接从 MCP 服务器的 `tools/list` 响应中获取
- 调用时通过对应 MCP 客户端的 `tools/call` 方法转发请求

#### 1.4.2 ListMcpResourcesTool

```javascript
// 工具名常量
var no6 = "ListMcpResourcesTool";

// 描述文本
`Lists available resources from configured MCP servers.
Each resource object includes a 'server' field indicating which server it's from.

Usage examples:
- List all resources from all servers: listMcpResources`
```

`ListMcpResourcesTool` 的关键属性：
- `name`: `"ListMcpResourcesTool"` （常量 `no6`）
- `isConcurrencySafe`: `true` -- 可并发安全调用
- `isReadOnly`: `true` -- 只读操作，不修改状态
- `shouldDefer`: `true` -- 延迟加载，通过 ToolSearch 发现
- 输入 Schema 可选 `server` 字段，不指定则列举所有服务器的资源
- 调用时遍历所有已连接且支持 `resources` 能力的 MCP 客户端

#### 1.4.3 ReadMcpResourceTool

```javascript
// 工具名（源码中）
name: "ReadMcpResourceTool"

// 输入 Schema
L.object({
  server: L.string().describe("The MCP server name"),
  uri: L.string().describe("The resource URI to read")
})

// 输出 Schema
L.object({
  contents: L.array(L.object({
    uri: L.string().describe("Resource URI"),
    mimeType: L.string().optional().describe("MIME type of the content"),
    text: L.string().optional().describe("Text content of the resource"),
    blobSavedTo: L.string().optional()
      .describe("Path where binary blob content was saved")
  }))
})
```

`ReadMcpResourceTool` 的实现细节：
- **必须指定** `server` 和 `uri` 两个参数
- 先从 `mcpClients` 中查找对应服务器，验证连接状态和 `resources` 能力
- 通过 `_N6()` 获取底层 MCP 客户端实例
- 发送标准 MCP `resources/read` 请求
- 对二进制 blob 内容自动保存到临时文件（`ZN6()` 函数），返回文件路径
- `maxResultSizeChars` 限制为 100,000 字符

```javascript
// 二进制资源处理（简化）
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

### 1.5 MCP Client 状态模型

每个 MCP 客户端在 `mcpClients` 数组中维护一个状态对象：

```
┌─────────────────────────────────────────────────┐
│                 MCP Client 状态                  │
├─────────────────────────────────────────────────┤
│ name: string           -- 服务器名称             │
│ type: ConnectionState  -- 连接状态               │
│   "connected"          -- 已连接，可用            │
│   "connecting"         -- 连接中                 │
│   "error"              -- 连接失败               │
│   "not_connected"      -- 未连接                 │
│ capabilities?: {       -- 服务器能力声明          │
│   tools?: boolean      -- 是否支持工具            │
│   resources?: boolean  -- 是否支持资源            │
│   prompts?: boolean    -- 是否支持提示模板        │
│ }                                               │
│ tools?: ToolDef[]      -- 已发现的工具列表        │
│ error?: string         -- 错误信息               │
└─────────────────────────────────────────────────┘
```

调用任何 MCP 工具前，系统会验证：
1. 服务器是否存在于 `mcpClients` 中
2. 服务器 `type` 是否为 `"connected"`
3. 服务器是否声明了对应能力（`tools` 或 `resources`）


## 2. 实现机制

### 2.1 MCP 服务器发现

Claude Code 从多个层级发现 MCP 服务器配置，优先级从高到低：

#### 2.1.1 配置层级

```
┌─────────────────────────────────────────────────────┐
│                   配置层级（优先级递减）                │
├─────────────────────────────────────────────────────┤
│ 1. CLI 参数 (flagSettings)                           │
│    --mcp-servers 或 SDK 的 mcpServers 选项            │
│                                                     │
│ 2. 项目级 .mcp.json                                  │
│    <project-root>/.mcp.json                          │
│    自动发现，团队共享                                  │
│                                                     │
│ 3. 用户级配置                                         │
│    ~/.claude/settings.json 中的 mcpServers 字段       │
│    用户全局生效                                       │
│                                                     │
│ 4. 项目级配置（settings.local.json）                   │
│    .claude/settings.local.json 中的 mcpServers 字段   │
│    项目特定，不提交 git                                │
│                                                     │
│ 5. 企业管理策略 (policySettings)                       │
│    管理员下发的 mcpServers 配置                        │
│                                                     │
│ 6. 插件内建 MCP 服务器                                 │
│    内建插件（如 claude-in-chrome）自带的 mcpServers     │
└─────────────────────────────────────────────────────┘
```

#### 2.1.2 .mcp.json 配置格式

`.mcp.json` 是项目级 MCP 服务器声明文件，存放在项目根目录，支持 Git 管理和团队共享：

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

配置加载函数 `SH("project")` 从项目目录读取 `.mcp.json`，解析 `servers` 字段并与其他层级的配置合并。

#### 2.1.3 用户级配置

通过 `~/.claude/settings.json` 的 `mcpServers` 字段配置，或使用 `/mcp` 斜杠命令交互式管理：

```json
// ~/.claude/settings.json
{
  "mcpServers": {
    "my-global-server": {
      "command": "my-mcp-server",
      "args": ["--port", "3000"]
    }
  }
}
```

#### 2.1.4 服务器发现合并策略

```
项目 .mcp.json  ──┐
用户 settings    ──┤
项目 local       ──┼──→  合并去重  ──→  MCPConnectionManager
CLI 参数         ──┤       ↓
插件 mcpServers  ──┤    重复检测 → "mcp-server-suppressed-duplicate" 错误
企业策略         ──┘
```

合并时，若多个层级声明了相同 `command` 或 `url` 的服务器，后者会被标记为 `mcp-server-suppressed-duplicate` 并跳过：

```javascript
// 错误类型定义（从 $M 函数提取）
case "mcp-server-suppressed-duplicate": {
  let K = q.duplicateOf.startsWith("plugin:")
    ? `server provided by plugin "${q.duplicateOf.split(":")[1] ?? "?"}"`
    : `already-configured "${q.duplicateOf}"`;
  return `MCP server "${q.serverName}" skipped — same command/URL as ${K}`;
}
```

### 2.2 连接管理 -- MCPConnectionManager 生命周期

MCPConnectionManager 负责所有 MCP 连接的全生命周期管理：

```
┌─────────────────────────────────────────────────────────────┐
│                  MCPConnectionManager 生命周期               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  初始化阶段                                                  │
│  ┌──────────────────────────────────────────────┐            │
│  │ 1. 读取所有层级的 MCP 服务器配置                │            │
│  │ 2. 合并去重（检测 duplicate）                  │            │
│  │ 3. 环境变量扩展（${VAR} 替换）                 │            │
│  │ 4. 为每个服务器创建传输层实例                   │            │
│  │ 5. 并发发起所有连接                            │            │
│  └──────────────────────────────────────────────┘            │
│                       ↓                                     │
│  连接阶段                                                    │
│  ┌──────────────────────────────────────────────┐            │
│  │ 对每个服务器：                                 │            │
│  │   创建 MCP Client → 选择传输 → connect()       │            │
│  │   → initialize() → tools/list → 注册工具       │            │
│  │   → resources 能力检测                         │            │
│  └──────────────────────────────────────────────┘            │
│                       ↓                                     │
│  运行阶段                                                    │
│  ┌──────────────────────────────────────────────┐            │
│  │ - 工具调用 → 通过 mcpClients 路由到对应服务器    │            │
│  │ - 状态监控 → 检测断连并尝试重连                  │            │
│  │ - 动态管理 → /mcp 命令添加/删除服务器            │            │
│  └──────────────────────────────────────────────┘            │
│                       ↓                                     │
│  清理阶段                                                    │
│  ┌──────────────────────────────────────────────┐            │
│  │ - 会话结束时逐个断开连接                        │            │
│  │ - 关闭子进程传输（stdio 模式）                  │            │
│  │ - 释放网络资源（SSE/HTTP 模式）                 │            │
│  └──────────────────────────────────────────────┘            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### 多服务器并发连接

MCPConnectionManager 使用 `Promise.all` 风格的并发策略同时连接所有已配置的服务器。任何单个服务器的连接失败不会阻塞其他服务器：

```
Server A (stdio)   ──→ connect ──→ ✓ connected
Server B (sse)     ──→ connect ──→ ✓ connected     } 并行
Server C (http)    ──→ connect ──→ ✗ error          } 互不阻塞
Server D (stdio)   ──→ connect ──→ ✓ connected
```

### 2.3 传输层抽象

MCP 协议定义了多种传输机制，Claude Code 实现了完整的传输层抽象：

#### 2.3.1 stdio 传输（StdioClientTransport）

最常用的本地传输方式。Claude Code 启动一个子进程，通过 stdin/stdout 进行 JSON-RPC 消息交换：

```
┌──────────────┐    stdin (JSON-RPC)     ┌──────────────┐
│              │ ──────────────────────→ │              │
│  Claude Code │                         │  MCP Server  │
│   (Client)   │ ←────────────────────── │  (子进程)    │
│              │    stdout (JSON-RPC)    │              │
└──────────────┘                         └──────────────┘
```

配置示例：
```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem"],
  "env": { "HOME": "/Users/user" },
  "cwd": "/workspace"
}
```

关键实现特征：
- 子进程生命周期与 MCP 客户端绑定
- `stderr` 输出被捕获用于调试日志
- 支持 `env` 和 `cwd` 配置传递给子进程
- 子进程异常退出触发自动重连机制

#### 2.3.2 SSE 传输（bJ6 / SSETransport）

用于远程 MCP 服务器的连接。使用 Server-Sent Events 进行服务器到客户端的消息流，HTTP POST 用于客户端到服务器的请求：

```
┌──────────────┐     GET /sse (EventStream)   ┌──────────────┐
│              │ ←─────────────────────────── │              │
│  Claude Code │                              │  MCP Server  │
│   (Client)   │ ──────────────────────────→  │   (远程)     │
│              │     POST /message (JSON)     │              │
└──────────────┘                              └──────────────┘
```

`bJ6`（`SSETransport`）类的核心属性和行为：

```javascript
class bJ6 {  // SSETransport
  url;                    // SSE 连接的 URL
  state = "idle";         // "idle" | "reconnecting" | "connected" | "closed"
  sessionId;              // 会话标识
  lastSequenceNum = 0;    // 最后接收的序列号（用于断点续传）
  reconnectAttempts = 0;  // 重连尝试次数
  reconnectTimer = null;  // 重连定时器
  livenessTimer = null;   // 活跃度检测定时器
  postUrl;                // POST 请求的 URL

  async connect() { /* ... */ }
  // 支持 from_sequence_num 断点续传
  // 使用 Last-Event-ID 头
  // HTTP 状态码分类：永久性错误 vs 可重试错误
}
```

关键特性：
- **断点续传**：通过 `lastSequenceNum` 和 `Last-Event-ID` 实现消息不丢失
- **自动重连**：使用指数退避策略，区分永久性错误（立即放弃）和暂时性错误（重试）
- **会话恢复**：通过 `sessionId` 跟踪会话状态
- **认证头刷新**：支持 `refreshHeaders` 和 `getAuthHeaders` 回调动态更新认证令牌

#### 2.3.3 StreamableHTTP 传输

新一代 HTTP 传输协议，取代 SSE 传输，使用单一 HTTP 端点进行双向通信：

```
┌──────────────┐   POST /mcp (Request)    ┌──────────────┐
│              │ ──────────────────────→  │              │
│  Claude Code │                          │  MCP Server  │
│   (Client)   │ ←────────────────────── │   (远程)     │
│              │   Streaming Response    │              │
└──────────────┘                          └──────────────┘
```

配置通过 `url` 字段（而非 `command`）触发远程传输选择。

#### 2.3.4 SdkControlTransport（fX7）

SDK 内部使用的进程间通信传输。当 Claude Code 作为 Agent SDK 的后端运行时，MCP 服务器可以通过 SDK 的控制通道桥接，而非独立的子进程或网络连接：

```
┌───────────────┐    SDK Control    ┌───────────────┐
│  Agent SDK    │ ←──────────────→  │  Claude Code  │
│  (Host App)   │    Channel       │  (Worker)     │
└───────┬───────┘                   └───────┬───────┘
        │                                   │
        │  in-process                       │  MCP Client
        ↓                                   ↓
┌───────────────┐              ┌───────────────┐
│  MCP Server   │              │  工具注册      │
│  (in-process) │              │  & 路由        │
└───────────────┘              └───────────────┘
```

`fX7` 类通过 socket 连接实现与桥接服务器的通信，支持：
- 安全验证（`validateSocketSecurity`）
- 超时检测（5000ms 连接超时）
- 自动重连（最多 10 次，指数退避）
- 请求/响应匹配和通知处理

#### 2.3.5 传输层选择逻辑

```
配置项解析
    ↓
┌───────────────────────────────────┐
│ 有 "command" 字段？               │
│   → YES → StdioClientTransport   │
│   → NO  ↓                        │
│ 有 "url" 字段？                   │
│   → YES → 检测 URL 协议           │
│     → sse:// → SSETransport      │
│     → http(s):// →               │
│       StreamableHTTPTransport    │
│   → NO  ↓                        │
│ SDK 内部调用？                     │
│   → YES → SdkControlTransport   │
└───────────────────────────────────┘
```

### 2.4 工具注册 -- MCP 工具到 Claude Code 工具的映射

#### 2.4.1 注册流程

MCP 服务器连接成功后，Claude Code 通过 `tools/list` 方法获取服务器暴露的所有工具，然后将每个工具映射为一个 Claude Code 内部工具：

```
MCP Server "weather"
├── tools/list 响应:
│   ├── { name: "get_forecast", inputSchema: {...} }
│   └── { name: "get_current", inputSchema: {...} }
│
↓ 映射为 Claude Code 工具
│
├── mcp__weather__get_forecast
│   ├── shouldDefer: true
│   ├── inputSchema: (从服务器获取)
│   └── call → MCP tools/call 转发
└── mcp__weather__get_current
    ├── shouldDefer: true
    ├── inputSchema: (从服务器获取)
    └── call → MCP tools/call 转发
```

#### 2.4.2 延迟加载机制

MCP 工具默认使用 `shouldDefer: true`，这意味着它们不会在初始工具列表中展示，而是通过 ToolSearch 机制按需加载。这个设计的原因：

1. **Token 经济**：一个 MCP 服务器可能暴露数十个工具，全部注入 system prompt 会消耗大量上下文窗口
2. **动态发现**：Claude 模型在需要特定能力时，通过 ToolSearch 语义匹配找到合适的 MCP 工具
3. **加载延迟**：某些 MCP 服务器连接较慢，延迟加载避免阻塞主流程

```
Claude 模型决策
    ↓
"需要查询天气"
    ↓
ToolSearch("weather forecast")
    ↓
匹配到 mcp__weather__get_forecast
    ↓
加载完整 Schema → 注入工具列表 → 调用
```

#### 2.4.3 权限集成

MCP 工具与 Claude Code 的权限系统深度集成：

```javascript
// 自动模式允许列表中的 MCP 相关工具
var N$Y = new Set([
  // ... 其他工具
  no6,                    // ListMcpResourcesTool
  "ReadMcpResourceTool",  // ReadMcpResourceTool
  // ...
]);
```

权限规则支持 MCP 工具的模式匹配：

| 规则格式 | 含义 |
|---------|------|
| `mcp__weather__get_forecast` | 精确匹配单个工具 |
| `mcp__weather__*` | 匹配 weather 服务器的所有工具 |
| `mcp__*` | 匹配所有 MCP 工具 |

遥测数据中，MCP 工具名被统一上报为 `"mcp"`：

```javascript
// cli.js 遥测处理
if (typeof A.toolName === "string" && A.toolName.startsWith("mcp__"))
  A.toolName = "mcp";
```

### 2.5 资源系统 -- Resources 读取和列举

MCP Resources 提供了从外部服务器获取结构化数据的标准化方式。

#### 2.5.1 资源发现流程

```
ListMcpResourcesTool 调用
    ↓
遍历所有 mcpClients
    ↓
过滤 type === "connected" && capabilities?.resources
    ↓
对每个服务器调用 resources/list
    ↓
合并结果，每个资源附加 server 字段
    ↓
返回资源列表 [{ server, uri, name, mimeType, ... }]
```

#### 2.5.2 资源读取流程

```
ReadMcpResourceTool({ server: "myserver", uri: "file:///path" })
    ↓
查找 mcpClients 中 name === "myserver"
    ↓
验证: 存在? → type === "connected"? → capabilities?.resources?
    ↓
调用 resources/read { uri }
    ↓
处理响应:
├── text content → 直接返回 { uri, mimeType, text }
├── blob content → Buffer.from(base64) → 保存到临时文件
│   → 返回 { uri, mimeType, blobSavedTo, text: description }
└── 其他 → { uri, mimeType }
```

#### 2.5.3 mcpContextUris

在项目配置中（`hc6` 默认配置对象），`mcpContextUris` 字段允许配置自动加载的 MCP 资源 URI 列表。这些资源会在会话初始化时自动读取，作为上下文注入到 Claude 的对话中：

```javascript
// 项目默认配置
var hc6 = {
  allowedTools: [],
  mcpContextUris: [],     // 自动加载的 MCP 资源 URI
  mcpServers: {},         // 项目级 MCP 服务器配置
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  // ...
};
```

### 2.6 安全模型

#### 2.6.1 权限层级

MCP 工具的权限遵循 Claude Code 的统一权限框架：

```
┌─────────────────────────────────────────────────┐
│                MCP 安全模型                      │
├─────────────────────────────────────────────────┤
│                                                 │
│  层级 1: 服务器准入                              │
│  ├── 企业策略 (policySettings) 可限制            │
│  │   允许的 MCP 服务器                           │
│  ├── .mcp.json 的信任对话框                      │
│  │   (hasTrustDialogAccepted)                   │
│  └── enabledMcpjsonServers /                    │
│      disabledMcpjsonServers 白名单              │
│                                                 │
│  层级 2: 工具级权限                              │
│  ├── alwaysAllowRules:                          │
│  │   mcp__<server>__<tool> 允许                  │
│  ├── alwaysDenyRules:                           │
│  │   mcp__<server>__* 拒绝                       │
│  └── alwaysAskRules:                            │
│      mcp__<server>__<tool> 每次询问              │
│                                                 │
│  层级 3: Hook 审计                               │
│  ├── PermissionRequest Hook                     │
│  │   可拦截 MCP 工具调用                         │
│  └── 支持动态权限更新                            │
│                                                 │
│  层级 4: 传输层安全                              │
│  ├── stdio: 子进程隔离                           │
│  ├── SSE/HTTP: TLS 加密                         │
│  ├── OAuth 认证（远程服务器）                     │
│  └── Header 注入（Bearer Token 等）              │
│                                                 │
└─────────────────────────────────────────────────┘
```

#### 2.6.2 OAuth 认证流程

远程 MCP 服务器支持 OAuth 2.0 认证。Claude Code 在 `getAuthHeaders` 回调中动态获取和刷新 OAuth token：

```
初始连接
    ↓
服务器要求认证 (401/403)
    ↓
触发 OAuth 流程
    ↓
┌──────────────────────────────┐
│ 1. 发现 OAuth metadata       │
│ 2. 构造 authorization URL    │
│ 3. 打开浏览器完成授权          │
│ 4. 接收 callback code         │
│ 5. 交换 access token          │
│ 6. 存储 refresh token         │
└──────────────────────────────┘
    ↓
使用 token 重新连接
    ↓
token 过期 → refreshHeaders 回调 → 自动刷新
```

`SSETransport` 中的认证头注入逻辑：

```javascript
// SSE 连接时的认证头处理
let authHeaders = this.getAuthHeaders();
let headers = {
  ...this.headers,
  ...authHeaders,
  "Accept": "text/event-stream",
  "anthropic-version": "2023-06-01",
  "User-Agent": userAgent()
};
// 如果有 Cookie 认证，移除 Authorization 头避免冲突
if (authHeaders.Cookie) delete headers.Authorization;
```

#### 2.6.3 .mcp.json 信任模型

项目级 `.mcp.json` 文件的安全处理：

```
发现 .mcp.json
    ↓
检查 hasTrustDialogAccepted
    ↓
├── 已接受 → 加载服务器配置
├── 未接受 → 显示信任对话框
│   ├── 用户接受 → 记录到 settings，加载配置
│   └── 用户拒绝 → 跳过 .mcp.json 中的服务器
└── enabledMcpjsonServers → 选择性启用
    disabledMcpjsonServers → 选择性禁用
```

### 2.7 官方注册表与插件生态

#### 2.7.1 官方插件注册表

Claude Code 维护一个官方插件注册表（`claude-plugins-official`），托管在 GitHub `anthropics/claude-plugins-official` 仓库。插件可以提供 MCP 服务器作为其能力之一：

```javascript
// 官方注册表标识
var C2 = "claude-plugins-official";

// 内建插件通过 Vh1 (Map) 注册
var Vh1 = new Map();
var Tn6 = "builtin";

// 内建插件数据结构
{
  name: string,
  description: string,
  version: string,
  defaultEnabled: boolean,
  mcpServers: Object,     // 插件提供的 MCP 服务器
  skills: Array,           // 插件提供的技能
  hooks: Object,           // 插件的 Hook 配置
  isAvailable: Function,   // 可用性检测
}
```

#### 2.7.2 插件与 MCP 服务器的关系

每个插件可以声明自己的 `mcpServers`，这些服务器在插件启用时自动注册到 MCPConnectionManager：

```
Plugin "claude-in-chrome" (builtin)
├── enabled: true
├── mcpServers: {
│   "claude-in-chrome": {
│     // Chrome 浏览器扩展桥接的 MCP 服务器
│     // 提供 tabs_context_mcp, screenshot, javascript_tool 等工具
│   }
│ }
└── 提供工具:
    ├── mcp__claude-in-chrome__tabs_context_mcp
    ├── mcp__claude-in-chrome__screenshot
    ├── mcp__claude-in-chrome__javascript_tool
    ├── mcp__claude-in-chrome__read_console_messages
    └── mcp__claude-in-chrome__gif_creator
```

#### 2.7.3 Marketplace 与依赖管理

插件注册表支持 marketplace（市场）概念，每个插件的完整标识为 `<name>@<marketplace>`：

```javascript
function Z4(pluginId) {
  if (pluginId.includes("@")) {
    let parts = pluginId.split("@");
    return { name: parts[0], marketplace: parts[1] };
  }
  return { name: pluginId };
}
```

插件间依赖通过 `DK4` 函数进行依赖解析和环检测：
- 依赖闭包计算
- 循环依赖检测
- 跨 marketplace 依赖校验
- 依赖缺失时自动降级（demoted）

#### 2.7.4 竞品工具检测

Claude Code 内置了对常见代码搜索和 AI 编码工具的检测机制，当检测到这些工具作为 MCP 服务器运行时，会提供特定的集成建议：

```javascript
var UB1 = {
  src: "sourcegraph", cody: "cody", aider: "aider",
  tabby: "tabby", tabnine: "tabnine", augment: "augment",
  pieces: "pieces", qodo: "qodo", aide: "aide",
  hound: "hound", seagoat: "seagoat", bloop: "bloop",
  gitloop: "gitloop", q: "amazon-q", gemini: "gemini"
};
```

### 2.8 环境变量扩展

MCP 服务器配置中支持 `${VARIABLE_NAME}` 语法进行环境变量替换。这在不同环境间共享 `.mcp.json` 时至关重要。

#### 2.8.1 扩展语法

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

扩展规则：
- `${VAR}` -- 替换为环境变量 `VAR` 的值
- 未定义的环境变量保持原样（不替换）
- 仅在 `env` 字段和特定配置字段中执行扩展
- 支持在 `args` 数组元素中进行替换

#### 2.8.2 安全考量

环境变量扩展在加载配置时执行，而非写入配置时。这意味着：
- `.mcp.json` 中可以安全地包含 `${SECRET}` 占位符并提交到 Git
- 实际的密钥值仅在运行时从环境中读取
- 不同开发者可以使用各自的环境变量值

### 2.9 MCPB (MCP Bundle) 格式

MCPB（MCP Bundle）是 Claude Code 支持的打包格式，用于分发包含 MCP 服务器的插件。

#### 2.9.1 MCPB 生命周期

```
下载 MCPB 文件
    ↓
解压和校验
├── mcpb-download-failed → 下载失败错误
├── mcpb-extract-failed → 解压失败错误
└── mcpb-invalid-manifest → 清单校验失败
    ↓
读取清单文件
    ↓
注册 MCP 服务器
    ↓
正常 MCP 连接流程
```

#### 2.9.2 错误处理

MCPB 相关的错误类型在 `$M` 错误格式化函数中定义：

```javascript
case "mcpb-download-failed":
  return `Failed to download MCPB from ${q.url}: ${q.reason}`;
case "mcpb-extract-failed":
  return `Failed to extract MCPB ${q.mcpbPath}: ${q.reason}`;
case "mcpb-invalid-manifest":
  return `MCPB manifest invalid at ${q.mcpbPath}: ${q.validationError}`;
```

### 2.10 Channel 通道系统

Channel（通道）是 MCP 协议的扩展能力，允许 MCP 服务器与 Claude Code 进行更深层次的集成——不仅仅是工具调用，还包括权限请求和双向通知。

#### 2.10.1 Channel 能力声明

MCP 服务器通过 `experimental["claude/channel"]` 能力声明通道支持：

```javascript
function R78(serverName, capabilities, installedFrom) {
  if (!capabilities?.experimental?.["claude/channel"])
    return { action: "skip", kind: "capability",
      reason: "server did not declare claude/channel capability" };
  // ...
}
```

#### 2.10.2 Channel 准入控制

Channel 的准入经过多层检查：

```
服务器声明 claude/channel 能力
    ↓
功能可用性检查 (QH6())
    ↓
认证检查 (需要 claude.ai 登录)
    ↓
组织策略检查
├── team/enterprise → channelsEnabled 策略
└── 个人用户 → 直接通过
    ↓
会话白名单检查 (--channels 参数)
    ↓
插件来源校验
├── 内联 marketplace → 匹配检查
├── 开发模式 → --dangerously-load-development-channels
└── 官方白名单 → allowedChannelPlugins
    ↓
注册通道
```

#### 2.10.3 Channel 权限通知

Channel 使用特殊的通知方法进行权限协商：

```javascript
var L47 = "notifications/claude/channel/permission";
var QNK = "notifications/claude/channel/permission_request";
```


## 3. 演进思维实验

如果从零构建 Claude Code 的外部工具集成系统，工程决策会如何逐步演进？

### Level 1：硬编码工具阶段

**场景**：CLI 需要与外部服务交互（如查询天气、访问数据库）。

**朴素方案**：

```javascript
// 直接在 CLI 中硬编码每个外部工具
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

// 主程序中注册
const tools = [new WeatherTool(), new DatabaseTool()];
```

**问题**：
- 每增加一个工具需要修改并发布 CLI
- 用户无法添加自定义工具
- 工具与 CLI 强耦合
- 无法适应用户多样化的工作环境

### Level 2：自定义插件阶段

**场景**：用户需要根据自己的工作环境添加工具。

**进化方案**：

```javascript
// 支持用户通过配置文件注册自定义工具
// config.json:
{
  "customTools": [{
    "name": "my-api",
    "endpoint": "http://localhost:3000/tool",
    "schema": { /* 输入参数定义 */ }
  }]
}

// CLI 加载自定义工具
for (const toolConfig of config.customTools) {
  tools.push(new HttpTool(toolConfig));
}
```

**问题**：
- 自定义协议，每个工具需要适配
- 没有标准的能力发现机制
- 多个 AI 工具（Claude Code、Cursor、Windsurf 等）各自定义接口
- 工具提供商需要为每个 AI 平台做适配

### Level 3：标准化 MCP 协议

**场景**：需要一个通用的、可互操作的工具集成协议。

**最终方案**（Claude Code 的实际实现）：

```
开放标准 MCP 协议
    ↓
标准化三大原语: Tools / Resources / Prompts
    ↓
多传输层: stdio / SSE / StreamableHTTP
    ↓
标准能力协商: initialize → capabilities
    ↓
统一的配置格式: .mcp.json
    ↓
生态系统: 官方注册表 + Marketplace
```

**Level 3 解决了什么**：

| 方面 | Level 1 | Level 2 | Level 3 |
|------|---------|---------|---------|
| 添加新工具 | 修改 CLI 代码 | 修改配置 + 适配器 | 写标准 MCP Server |
| 跨平台兼容 | 不支持 | 不支持 | 任何 MCP 客户端可用 |
| 能力发现 | 硬编码 | 手动配置 Schema | 自动 tools/list |
| 传输灵活性 | 固定 | HTTP only | stdio/SSE/HTTP |
| 安全模型 | 无 | 基础认证 | OAuth + 权限层级 |
| 资源访问 | 不支持 | 不支持 | resources 原语 |
| 生态系统 | 无 | 无 | 官方注册表 + Marketplace |

### 设计洞察

MCP 协议的设计遵循了几个关键的工程原则：

1. **协议先行**：先定义清晰的协议规范，再实现具体功能。这使得 Claude Code 的 MCP 实现可以与任何兼容的 MCP 服务器交互。

2. **传输无关**：协议层与传输层解耦。同一个 MCP 服务器既可以通过 stdio 本地运行，也可以通过 SSE 远程部署，客户端代码无需修改。

3. **渐进式发现**：`shouldDefer: true` + ToolSearch 实现了工具的按需加载，避免了大量 MCP 工具淹没模型的上下文窗口。

4. **配置即声明**：`.mcp.json` 文件是纯声明式的，描述"需要哪些服务器"而非"如何实现"。环境变量扩展使同一份配置适用于不同环境。

5. **安全多层防御**：从服务器准入、工具权限、Hook 审计到传输加密，安全策略分布在多个独立层级，每层独立生效。


## 4. 验证策略

### 4.1 源码验证点

| 验证项 | 搜索关键词 | 预期发现 |
|--------|-----------|---------|
| ListMcpResourcesTool 定义 | `no6="ListMcpResourcesTool"` | 工具名常量、描述文本、call 实现 |
| ReadMcpResourceTool 定义 | `name:"ReadMcpResourceTool"` | Zod Schema、blob 处理逻辑 |
| MCP 工具命名规范 | `mcp__` | 双下划线分隔的 serverName__toolName 格式 |
| SSE 传输层 | `class bJ6` | SSETransport 完整实现，断点续传、重连逻辑 |
| 服务器发现合并 | `mcp-server-suppressed-duplicate` | 重复服务器检测和错误报告 |
| 权限集成 | `alwaysAllowRules`, `mcp__*` | MCP 工具权限规则的模式匹配 |
| MCPB 错误处理 | `mcpb-download-failed` | MCPB Bundle 生命周期错误类型 |
| Channel 通道 | `claude/channel`, `R78` | Channel 能力检测和准入控制 |
| 遥测匿名化 | `toolName.startsWith("mcp__")` | MCP 工具名上报为 `"mcp"` |
| .mcp.json 加载 | `SH("project")` | 项目级配置读取 |

### 4.2 运行时验证

```bash
# 验证 MCP 工具注册
# 在 Claude Code 会话中执行：
# /mcp
# 预期：显示所有已连接的 MCP 服务器及其状态

# 验证 .mcp.json 自动发现
# 在包含 .mcp.json 的项目目录中启动 Claude Code
# 预期：自动连接 .mcp.json 中声明的服务器

# 验证工具延迟加载
# 使用 ToolSearch 搜索 MCP 工具名
# 预期：ToolSearch 能发现并加载延迟注册的 MCP 工具

# 验证环境变量扩展
# 在 .mcp.json 中使用 ${VAR} 语法
# 预期：运行时替换为实际环境变量值
```

### 4.3 交叉验证

| SDK 类型声明 (`sdk-tools.d.ts`) | `cli.js` 实现 | 一致性 |
|-------------------------------|--------------|--------|
| `mcpServers` 选项 | `hc6.mcpServers` 默认配置 | 类型和默认值一致 |
| MCP Server URL 定义 | SSE/StreamableHTTP 传输 | 支持 `url` 字段的远程服务器 |
| `mcp_servers` (Python SDK) | `mcpServers` (TS SDK) | 蛇形/驼峰命名适配 |

### 4.4 架构验证清单

- [ ] 确认 MCP 服务器发现的六个配置层级及其优先级
- [ ] 确认 `mcp__<serverName>__<toolName>` 命名约定在权限系统中的匹配逻辑
- [ ] 确认 SSETransport (`bJ6`) 的断点续传机制（`lastSequenceNum` + `Last-Event-ID`）
- [ ] 确认 ReadMcpResourceTool 的 blob 二进制内容处理路径
- [ ] 确认 MCPB Bundle 的三种错误类型覆盖了完整的生命周期
- [ ] 确认 Channel 通道的五层准入控制流程
- [ ] 确认环境变量扩展仅在运行时执行，不修改配置文件本身
- [ ] 确认 MCP 工具遥测上报时工具名被匿名化为 `"mcp"`
- [ ] 确认插件系统中 `mcpServers` 字段与 MCPConnectionManager 的集成路径
- [ ] 确认竞品工具检测列表（`UB1` 和 `iwz`）的完整性


> **引用来源**：所有代码片段和架构分析均来自 `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js`（v2.1.88，构建时间 2026-03-30T21:59:52Z）的逆向分析。混淆后的变量名（如 `bJ6`、`no6`、`hc6`、`$M`、`R78` 等）为 build 产物的实际标识符。
