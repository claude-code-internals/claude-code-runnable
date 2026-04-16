<p align="right"><a href="../en/04_core_mechanisms.md">English</a></p>

# 阶段 4：核心数据结构与算法

> 本章深入剖析 Claude Code 的关键状态容器、控制逻辑算法以及阶段 5 模块选择策略。所有分析均基于 Source Map 反向推导出的 1906 个应用源文件以及 `sdk-tools.d.ts` 公开类型定义交叉验证。


## 目录

1. [关键状态容器](#1-关键状态容器)
   - 1.1 [AppState — 全局应用状态存储](#11-appstate--全局应用状态存储)
   - 1.2 [Message / ContentBlock — 对话消息数据模型](#12-message--contentblock--对话消息数据模型)
   - 1.3 [Tool — 工具基类定义](#13-tool--工具基类定义)
   - 1.4 [Task — 任务管理](#14-task--任务管理)
   - 1.5 [PermissionRule / PermissionResult — 权限规则和决策结果](#15-permissionrule--permissionresult--权限规则和决策结果)
   - 1.6 [CostTracker — 成本追踪器](#16-costtracker--成本追踪器)
2. [控制逻辑算法图](#2-控制逻辑算法图)
   - 2.1 [对话调度（核心循环）](#21-对话调度核心循环)
   - 2.2 [工具调度](#22-工具调度)
   - 2.3 [权限控制算法](#23-权限控制算法)
   - 2.4 [上下文管理](#24-上下文管理)
   - 2.5 [通信架构](#25-通信架构)
3. [阶段 5 模块选择策略](#3-阶段-5-模块选择策略)


## 1. 关键状态容器

Claude Code 的运行时由六个核心状态容器驱动。它们各自承担不同职责，共同构成了从用户输入到 API 调用、从工具执行到权限判定的完整数据流。

### 1.1 AppState — 全局应用状态存储

**定位**：全局应用状态的唯一真相来源（Single Source of Truth），采用类 Redux 的集中式状态管理模式。

**源文件清单**：

| 文件 | 职责 |
|------|------|
| `src/state/AppState.tsx` | 状态类型定义与 React Context 提供者 |
| `src/state/AppStateStore.ts` | 状态存储实现，封装读写操作 |
| `src/state/store.ts` | 全局 Store 实例创建与初始化 |
| `src/state/selectors.ts` | 选择器模式——派生计算状态 |
| `src/state/onChangeAppState.ts` | 状态变化监听与副作用触发 |
| `src/state/teammateViewHelpers.ts` | Teammate 视图相关状态辅助函数 |

**管理的状态维度**：

```
AppState
├── 工具执行状态
│   ├── 当前执行中的工具列表
│   ├── 工具执行结果缓存
│   └── 流式执行进度
├── 权限决策缓存
│   ├── 已授权规则列表
│   ├── 已拒绝规则列表
│   └── 自动批准模式状态
├── UI 状态
│   ├── 模态框栈（权限对话框、设置面板等）
│   ├── 通知队列
│   ├── 当前焦点组件
│   └── 终端尺寸与布局
├── 会话信息
│   ├── 对话历史（消息数组）
│   ├── 会话 ID 与元数据
│   ├── 当前模型配置
│   └── API 连接状态
├── 任务管理
│   ├── 后台任务列表
│   ├── Agent 子进程状态
│   └── Swarm 协作状态
└── 配置快照
    ├── 用户设置
    ├── 项目设置
    └── 托管设置（MDM）
```

**选择器模式**（`selectors.ts`）：

选择器是从原始状态派生计算结果的纯函数。Claude Code 将频繁访问的派生数据封装为选择器，避免在每个消费方重复计算。典型模式如下：

```typescript
// 伪代码示例——从 Source Map 推导
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

**变化监听机制**（`onChangeAppState.ts`）：

当状态发生变更时，触发注册的副作用函数。这些副作用包括：
- 自动持久化会话到磁盘（`sessionStorage.ts`）
- 更新终端标题（`useTerminalTitle.ts`）
- 触发 Bridge 同步（将状态推送到 claude.ai 网页端）
- 刷新 MCP 连接状态
- 更新 StatusLine 显示

**与 React/Ink 的集成**：

AppState 通过 React Context 注入到 Ink 组件树中。组件通过 `useAppState()` Hook 获取状态，通过 `setAppState()` 触发更新。由于 Ink 基于 React Reconciler 实现终端 UI 渲染，状态变更会触发整个组件树的 diff-and-patch 过程。


### 1.2 Message / ContentBlock — 对话消息数据模型

**定位**：对话消息是 Claude Code 数据流的核心载体，承载用户输入、AI 响应、工具调用与工具结果的全部信息。

**源文件清单**：

| 文件 | 职责 |
|------|------|
| `src/utils/messages.ts` | 消息工具函数（构造、过滤、变换） |
| `src/utils/messages/mappers.ts` | 消息格式映射（内部 <-> API） |
| `src/utils/messages/systemInit.ts` | 系统消息初始化 |
| `src/utils/messagePredicates.ts` | 消息类型谓词函数 |
| `src/utils/contentArray.ts` | ContentBlock 数组操作 |
| `src/components/Message.tsx` | 消息渲染组件 |
| `src/components/MessageRow.tsx` | 消息行布局 |
| `src/components/Messages.tsx` | 消息列表容器 |

**消息类型体系**：

```
Message
├── UserMessage
│   ├── 用户文本输入（prompt）
│   ├── 工具执行结果（tool_result）
│   ├── 图片附件
│   ├── Bash 输入/输出
│   ├── 命令输出
│   ├── Agent 通知
│   ├── 资源更新
│   ├── 内存文件输入
│   └── 频道消息（Bridge）
└── AssistantMessage
    ├── 文本响应（text）
    ├── 思考过程（thinking / redacted_thinking）
    ├── 工具调用请求（tool_use）
    └── 服务端工具使用
```

**ContentBlock 类型枚举**：

ContentBlock 是消息内部的原子内容单元，Anthropic Messages API 定义了以下类型：

| 类型 | 说明 | 方向 |
|------|------|------|
| `text` | 纯文本内容 | 双向 |
| `tool_use` | 工具调用请求（含 tool name + input JSON） | Assistant -> System |
| `tool_result` | 工具执行结果（含 output + error） | System -> API |
| `image` | Base64 编码图片（支持 JPEG/PNG/GIF/WebP） | User -> API |
| `thinking` | 扩展思考（Extended Thinking）内容 | Assistant 内部 |
| `redacted_thinking` | 被遮蔽的思考内容 | Assistant 内部 |
| `server_tool_use` | 服务端工具使用（web_search 等） | API 内部 |

**消息规范化与清理**：

Claude Code 在消息进入 API 调用之前会进行多步规范化处理：
1. **消息合并**：将连续的同角色消息合并（API 要求严格交替的 user/assistant 序列）
2. **媒体项剥离**：当媒体项数量超过 API 限制（>100）时，调用 `stripExcessMediaItems` 移除最早的媒体项
3. **思考块清理**：根据配置决定是否保留/移除 thinking 块
4. **工具结果截断**：超长工具输出会被截断或持久化到磁盘，仅保留摘要
5. **系统消息注入**：在消息列表头部注入系统提示（system prompt），包含 CLAUDE.md、工具定义、权限规则等

**消息谓词函数**（`messagePredicates.ts`）：

提供类型安全的消息分类检查，例如：
- `isUserMessage(msg)` / `isAssistantMessage(msg)`
- `hasToolUse(msg)` / `hasToolResult(msg)`
- `isThinkingBlock(block)` / `isTextBlock(block)`

这些谓词在消息渲染、消息过滤、上下文压缩等场景中被广泛使用。


### 1.3 Tool — 工具基类定义

**定位**：Tool 是 Claude Code 最核心的抽象之一。每个工具封装了一种独立的能力（读文件、执行命令、搜索代码等），供 Claude 在对话过程中按需调用。

**源文件清单**：

| 文件 | 职责 |
|------|------|
| `src/Tool.ts` | Tool 基类/接口定义 |
| `src/tools.ts` | 工具注册表与工具发现 |
| `sdk-tools.d.ts` | 所有工具的输入/输出 TypeScript 类型定义 |
| `src/utils/toolPool.ts` | 工具池管理（延迟加载、按需激活） |
| `src/utils/toolSchemaCache.ts` | 工具 JSON Schema 缓存 |
| `src/utils/toolSearch.ts` | 工具搜索与模糊匹配 |
| `src/utils/embeddedTools.ts` | 嵌入式工具配置 |

**Tool 接口定义**（从 `sdk-tools.d.ts` 推导）：

```typescript
interface Tool {
  // 基础属性
  name: string;                    // 工具唯一标识符
  description: string;             // 工具描述（注入 system prompt）
  inputSchema: JSONSchema;         // 输入参数的 JSON Schema

  // 执行方法
  execute(input: ToolInput): Promise<ToolResult>;

  // 权限相关
  isReadOnly?(): boolean;          // 是否为只读工具（影响权限判定）
  needsPermission?(): boolean;     // 是否需要用户授权

  // UI 相关
  renderToolUse?(props): ReactNode;   // 工具调用中的 UI 渲染
  renderToolResult?(props): ReactNode; // 工具结果的 UI 渲染

  // 提示词相关
  prompt?(): string;               // 工具的详细使用说明
}
```

**完整工具清单**（从 Source Map 提取的 `src/tools/` 目录）：

| 工具分类 | 工具名称 | 源目录 | 说明 |
|----------|----------|--------|------|
| **文件系统** | FileRead | `FileReadTool/` | 读取文件内容（支持文本、图片、PDF、Notebook） |
| | FileEdit | `FileEditTool/` | 精确字符串替换式文件编辑 |
| | FileWrite | `FileWriteTool/` | 创建或完整覆写文件 |
| | Glob | `GlobTool/` | 文件模式匹配搜索 |
| | Grep | `GrepTool/` | 基于 ripgrep 的内容搜索 |
| | NotebookEdit | `NotebookEditTool/` | Jupyter Notebook 单元格编辑 |
| **命令执行** | Bash | `BashTool/` | 执行 Shell 命令（18 个子模块） |
| | PowerShell | `PowerShellTool/` | Windows PowerShell 命令执行 |
| **Agent 系统** | Agent | `AgentTool/` | 创建并运行子 Agent（20 个子模块） |
| | SendMessage | `SendMessageTool/` | 向指定 Agent 发送消息 |
| **任务管理** | TaskCreate | `TaskCreateTool/` | 创建跟踪任务 |
| | TaskGet | `TaskGetTool/` | 获取任务状态 |
| | TaskList | `TaskListTool/` | 列出所有任务 |
| | TaskUpdate | `TaskUpdateTool/` | 更新任务状态 |
| | TaskOutput | `TaskOutputTool/` | 获取后台任务输出 |
| | TaskStop | `TaskStopTool/` | 停止运行中的任务 |
| | TodoWrite | `TodoWriteTool/` | 写入待办事项列表 |
| **MCP 集成** | MCP | `MCPTool/` | 调用 MCP Server 提供的工具 |
| | ListMcpResources | `ListMcpResourcesTool/` | 列出 MCP 资源 |
| | ReadMcpResource | `ReadMcpResourceTool/` | 读取 MCP 资源内容 |
| | McpAuth | `McpAuthTool/` | MCP 认证流程 |
| **网络** | WebFetch | `WebFetchTool/` | 获取网页内容 |
| | WebSearch | `WebSearchTool/` | 网络搜索 |
| **对话控制** | AskUserQuestion | `AskUserQuestionTool/` | 向用户提出多选问题 |
| | EnterPlanMode | `EnterPlanModeTool/` | 进入计划模式 |
| | ExitPlanMode | `ExitPlanModeTool/` | 退出计划模式并提交计划 |
| **配置管理** | Config | `ConfigTool/` | 读写运行时配置 |
| **工作区** | EnterWorktree | `EnterWorktreeTool/` | 创建 Git Worktree 隔离环境 |
| | ExitWorktree | `ExitWorktreeTool/` | 退出并可选清理 Worktree |
| **技能** | Skill | `SkillTool/` | 调用已注册的技能 |
| **远程触发** | RemoteTrigger | `RemoteTriggerTool/` | 触发远程 Agent |
| **定时任务** | CronCreate | `ScheduleCronTool/` | 创建定时任务 |
| | CronDelete | `ScheduleCronTool/` | 删除定时任务 |
| | CronList | `ScheduleCronTool/` | 列出定时任务 |
| **工具搜索** | ToolSearch | `ToolSearchTool/` | 搜索可用工具定义 |
| **代码分析** | LSP | `LSPTool/` | Language Server Protocol 交互 |
| **摘要简报** | Brief | `BriefTool/` | 生成简报摘要 |
| **其他** | SyntheticOutput | `SyntheticOutputTool/` | 合成输出（内部工具） |
| | REPL | `REPLTool/` | 交互式求值（primitiveTools） |
| | TeamCreate | `TeamCreateTool/` | 创建团队 |
| | TeamDelete | `TeamDeleteTool/` | 删除团队 |

**工具注册表架构**：

```
工具注册表 (tools.ts)
├── 内置工具 (src/tools/*)
│   └── 30+ 工具类，每个包含：
│       ├── *Tool.ts      — 工具逻辑实现
│       ├── UI.tsx         — 终端 UI 渲染
│       ├── prompt.ts      — 注入 system prompt 的说明文本
│       └── constants.ts   — 工具名称等常量
├── MCP 动态工具 (src/tools/MCPTool/)
│   └── 运行时从 MCP Server 发现并注册
├── 插件工具 (src/plugins/)
│   └── 通过插件系统扩展的第三方工具
└── 延迟工具 (toolPool.ts)
    └── 按需加载，减少启动时间
```

**工具池与延迟加载**：

`toolPool.ts` 实现了工具的延迟加载策略。并非所有 30+ 工具都在启动时加载，部分低频工具（如 CronCreate、TeamCreate 等）仅在被实际调用时才完成初始化。ToolSearch 工具正是为此设计——它允许 Claude 在对话中先搜索可用工具的 Schema 定义，再决定是否调用。


### 1.4 Task — 任务管理

**定位**：Task 是 Claude Code 并发执行框架的基本单位。每个 Task 代表一个独立的执行上下文，可以是本地 Shell 命令、子 Agent 进程、远程 Agent 会话，甚至是 Dream（后台思考）。

**源文件清单**：

| 文件 | 职责 |
|------|------|
| `src/Task.ts` | 核心 Task 类型定义 |
| `src/tasks.ts` | 任务管理器（集合操作） |
| `src/tasks/types.ts` | 任务类型扩展定义 |
| `src/tasks/DreamTask/DreamTask.ts` | Dream 后台思考任务 |
| `src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx` | 进程内 Teammate 任务 |
| `src/tasks/LocalAgentTask/LocalAgentTask.tsx` | 本地 Agent 子进程任务 |
| `src/tasks/LocalMainSessionTask.ts` | 主会话任务 |
| `src/tasks/LocalShellTask/LocalShellTask.tsx` | 本地 Shell 命令任务 |
| `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx` | 远程 Agent 任务 |
| `src/tasks/stopTask.ts` | 任务停止逻辑 |
| `src/tasks/pillLabel.ts` | 任务状态标签渲染 |

**TaskType 枚举**：

```typescript
type TaskType =
  | 'local_bash'              // 本地 Bash/Shell 命令执行
  | 'local_agent'             // 本地 Agent 子进程
  | 'remote_agent'            // 远程 Agent（通过 API）
  | 'in_process_teammate'     // 进程内 Teammate（Swarm 协作）
  | 'local_workflow'          // 本地工作流
  | 'monitor_mcp'             // MCP Server 监控
  | 'dream';                  // Dream 后台思考
```

**TaskStatus 状态机**：

```
                    ┌──────────┐
                    │ pending  │  任务已创建，等待调度
                    └────┬─────┘
                         │ 调度执行
                         ▼
                    ┌──────────┐
                    │ running  │  任务执行中
                    └────┬─────┘
                    ╱    │    ╲
          正常完成 ╱     │     ╲ 异常终止
                 ╱       │       ╲
    ┌───────────┐  ┌─────┴────┐  ┌─────────┐
    │ completed │  │  failed  │  │  killed  │
    └───────────┘  └──────────┘  └─────────┘
    （终态）        （终态）        （终态）
```

```typescript
type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed';

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed';
}
```

**TaskContext 运行时上下文**：

每个 Task 持有一个 TaskContext，包含：

```typescript
interface TaskContext {
  abortController: AbortController;   // 取消信号控制器
  getAppState: () => AppState;        // 获取当前应用状态
  setAppState: (patch) => void;       // 更新应用状态
  taskId: string;                     // 唯一任务标识
  parentTaskId?: string;              // 父任务 ID（嵌套场景）
}
```

**任务执行的生命周期**：

```
创建 Task
    │
    ├── 注册到 AppState.tasks
    ├── 设置 AbortController
    └── 初始化 TaskOutput
         │
         ▼
    调度执行
    │
    ├── local_bash: spawn 子进程 + stdin/stdout pipe
    ├── local_agent: fork 子进程 + 消息传递
    ├── in_process_teammate: 同进程内创建新 Agent Loop
    ├── remote_agent: 通过 API 创建远程会话
    ├── dream: 后台调用 API 进行思考
    └── monitor_mcp: 建立 MCP 连接并监控
         │
         ▼
    状态更新 (running -> completed/failed/killed)
    │
    ├── 收集输出 (TaskOutput)
    ├── 持久化输出到磁盘 (diskOutput.ts)
    ├── 更新 AppState
    └── 清理资源 (AbortController.abort())
```

**Shell 任务的特殊处理**（`LocalShellTask/`）：

Shell 任务具有额外的安全保护机制：
- `guards.ts`：命令执行前的安全检查
- `killShellTasks.ts`：批量终止 Shell 任务的逻辑
- 超时控制（最大 600000ms / 10 分钟）
- 后台化支持（用户按 Ctrl+B 或自动后台化长时间运行的命令）


### 1.5 PermissionRule / PermissionResult — 权限规则和决策结果

**定位**：Claude Code 实现了一个精细的权限引擎，控制 Claude 可以执行哪些操作。权限系统是安全性的核心保障。

**源文件清单**：

| 文件 | 职责 |
|------|------|
| `src/utils/permissions/PermissionMode.ts` | 权限模式定义 |
| `src/utils/permissions/PermissionResult.ts` | 权限判定结果类型 |
| `src/utils/permissions/PermissionRule.ts` | 权限规则数据结构 |
| `src/utils/permissions/PermissionUpdate.ts` | 权限规则更新操作 |
| `src/utils/permissions/permissions.ts` | 权限引擎核心逻辑 |
| `src/utils/permissions/permissionsLoader.ts` | 权限配置加载 |
| `src/utils/permissions/permissionRuleParser.ts` | 规则解析器 |
| `src/utils/permissions/permissionExplainer.ts` | 权限决策解释生成 |
| `src/utils/permissions/pathValidation.ts` | 路径权限验证 |
| `src/utils/permissions/filesystem.ts` | 文件系统权限 |
| `src/utils/permissions/bashClassifier.ts` | Bash 命令安全分类器 |
| `src/utils/permissions/dangerousPatterns.ts` | 危险命令模式检测 |
| `src/utils/permissions/yoloClassifier.ts` | 自动批准模式安全分类 |
| `src/utils/permissions/classifierDecision.ts` | 分类器决策结构 |
| `src/utils/permissions/classifierShared.ts` | 分类器共享逻辑 |
| `src/utils/permissions/shellRuleMatching.ts` | Shell 规则匹配算法 |
| `src/utils/permissions/denialTracking.ts` | 拒绝决策追踪 |
| `src/utils/permissions/shadowedRuleDetection.ts` | 被遮蔽规则检测 |
| `src/utils/permissions/autoModeState.ts` | 自动模式状态 |
| `src/utils/permissions/getNextPermissionMode.ts` | 权限模式切换 |
| `src/utils/permissions/permissionSetup.ts` | 权限系统初始化 |
| `src/utils/permissions/bypassPermissionsKillswitch.ts` | 绕过权限的紧急开关 |
| `src/types/permissions.ts` | 权限类型导出 |

**五种权限模式**：

```typescript
type PermissionMode =
  | 'default'           // 默认模式：每次敏感操作都询问用户
  | 'plan'              // 计划模式：先生成计划，用户批准后执行
  | 'acceptEdits'       // 接受编辑模式：自动批准文件编辑，其他操作仍需询问
  | 'bypassPermissions' // 绕过模式：跳过所有权限检查（危险！）
  | 'dontAsk';          // 静默模式：不询问用户，拒绝所有需要权限的操作
```

**权限规则数据结构**：

```typescript
interface PermissionRule {
  tool: string;           // 目标工具名称（如 'Bash', 'FileEdit'）
  action: 'allow' | 'deny';  // 允许或拒绝
  pattern?: string;       // 匹配模式（正则或 glob）
  scope?: 'session' | 'project' | 'global';  // 规则作用域
  reason?: string;        // 规则原因说明
}
```

**权限决策结果**：

```typescript
interface PermissionResult {
  allowed: boolean;       // 是否允许执行
  reason: string;         // 决策原因（供用户理解）
  rule?: PermissionRule;  // 命中的具体规则
  needsUserApproval?: boolean;  // 是否需要弹出询问对话框
}
```

**规则匹配优先级**（从高到低）：

```
1. bypassPermissions 全局开关 → 全部允许
2. 会话级规则（本次会话中用户的明确授权/拒绝）
3. 项目级规则（.claude/settings.json 中的规则）
4. 全局级规则（~/.claude/settings.json 中的规则）
5. 托管设置规则（MDM 下发的企业策略）
6. 工具默认行为（只读工具默认允许，写入工具默认需要授权）
```


### 1.6 CostTracker — 成本追踪器

**定位**：实时追踪 API 调用的 Token 消耗和成本，为用户提供使用量可视化和成本控制能力。

**源文件清单**：

| 文件 | 职责 |
|------|------|
| `src/cost-tracker.ts` | 成本追踪器核心实现（约 324 行） |
| `src/costHook.ts` | React Hook 封装（组件中使用） |
| `src/utils/modelCost.ts` | 各模型的单价配置 |
| `src/utils/tokens.ts` | Token 计数与估算 |
| `src/services/tokenEstimation.ts` | Token 估算服务 |
| `src/commands/cost/cost.ts` | /cost 命令实现 |
| `src/commands/usage/usage.tsx` | /usage 命令实现 |
| `src/services/api/usage.ts` | API 使用量查询 |
| `src/services/claudeAiLimits.ts` | claude.ai 使用限制 |

**追踪维度**：

```typescript
interface CostTracker {
  // Token 计数
  getTotalInputTokens(): number;           // 输入 Token 总数
  getTotalOutputTokens(): number;          // 输出 Token 总数
  getCacheCreationInputTokens(): number;   // 缓存创建时的输入 Token
  getCacheReadInputTokens(): number;       // 缓存命中时读取的 Token

  // 成本计算
  getTotalCostUSD(): number;               // 总成本（美元）

  // 性能指标
  getTotalAPIDuration(): number;           // API 调用总耗时（毫秒）
  getTotalToolDuration(): number;          // 工具执行总耗时（毫秒）

  // 速率限制追踪
  getRateLimitStatus(): {
    five_hour: RateLimitInfo;              // 5 小时滚动窗口
    seven_day: RateLimitInfo;              // 7 天滚动窗口
    seven_day_opus: RateLimitInfo;         // 7 天 Opus 模型专用窗口
    extra_usage: RateLimitInfo;            // 额外使用量
  };
}
```

**缓存经济学**：

CostTracker 区分了四种 Token 类型以精确计算成本：

| Token 类型 | 成本系数 | 说明 |
|-----------|----------|------|
| 标准输入 Token | 1x | 未命中缓存的输入 |
| 缓存创建 Token | 1.25x | 首次写入缓存的成本 |
| 缓存读取 Token | 0.1x | 命中缓存的输入（大幅降低成本） |
| 输出 Token | 5x（相对输入） | AI 生成的输出 |

缓存策略直接影响成本——Claude Code 的 prompt cache break detection（`promptCacheBreakDetection.ts`）机制会监测缓存是否被破坏，并在 system prompt 级别维护缓存一致性。

**速率限制追踪**：

```
速率限制窗口
├── five_hour       — 5 小时内的使用量上限
├── seven_day       — 7 天内的总使用量上限
├── seven_day_opus  — 7 天内 Opus 模型专用上限
└── extra_usage     — 购买的额外使用量配额
```

当接近速率限制时，`useRateLimitWarningNotification.tsx` 会在终端底部显示警告通知，`rateLimitMessages.ts` 生成友好的限制说明文案。


## 2. 控制逻辑算法图

### 2.1 对话调度（核心循环）

Claude Code 的核心是一个 **Agent Loop**（代理循环），也被称为 **ReAct 循环**（Reasoning + Acting）。这个循环是整个应用的心脏。

**核心循环伪代码**：

```typescript
// 简化的 Agent Loop 核心逻辑
async function agentLoop(context: TaskContext) {
  while (!context.abortController.signal.aborted) {
    // 1. 收集用户输入
    const userInput = await waitForUserInput();

    // 2. 处理用户输入（命令、文本、附件）
    const processedInput = processUserInput(userInput);
    // processUserInput.ts -> processBashCommand.tsx
    //                     -> processSlashCommand.tsx
    //                     -> processTextPrompt.ts

    // 3. 构建消息列表（含完整历史上下文）
    const messages = buildMessageList(
      context.getAppState().conversationHistory,
      processedInput
    );

    // 4. 检查上下文窗口容量
    if (shouldAutoCompact(messages)) {
      messages = await autoCompact(messages);  // 自动压缩
    }

    // 5. API 调用循环（处理工具调用链）
    let continueLoop = true;
    while (continueLoop) {
      // 5a. 发送到 Claude API（流式）
      const stream = await claude.messages.create({
        model: currentModel,
        system: buildSystemPrompt(),  // 含 CLAUDE.md、工具定义等
        messages: messages,
        stream: true,
        tools: getAvailableTools(),
      });

      // 5b. 流式接收响应
      const response = await processStream(stream);

      // 5c. 检查响应内容
      if (response.hasToolUse()) {
        // 执行工具并将结果追加到消息列表
        const toolResults = await executeTools(response.toolUses);
        messages.push(assistantMessage(response));
        messages.push(userMessage(toolResults));
        continueLoop = true;  // 继续循环，让 Claude 看到工具结果
      } else {
        // 纯文本响应，展示给用户
        displayResponse(response);
        continueLoop = false;
      }
    }

    // 6. 等待下一次用户输入（回到步骤 1）
  }
}
```

**流式响应处理管线**：

```
API Server (Anthropic / AWS Bedrock / Google Vertex)
    │
    │ SSE (Server-Sent Events) 流
    │
    ▼
StreamProcessor (src/utils/stream.ts)
    │
    ├── message_start    → 初始化消息容器
    ├── content_block_start → 创建 ContentBlock
    ├── content_block_delta → 增量更新内容
    │   ├── text_delta     → 逐字显示文本
    │   ├── input_json_delta → 逐步构建工具输入 JSON
    │   └── thinking_delta → 更新思考内容
    ├── content_block_stop → 完成一个 ContentBlock
    │   └── 如果是 tool_use → 触发工具执行
    ├── message_delta → 更新消息级元数据
    │   ├── stop_reason: end_turn | tool_use | max_tokens
    │   └── usage 统计更新
    └── message_stop → 消息完成
         │
         ▼
    Ink UI 实时渲染 (React Reconciler)
```

**stop_reason 分支逻辑**：

| stop_reason | 含义 | 后续动作 |
|-------------|------|---------|
| `end_turn` | Claude 主动结束回复 | 退出内循环，等待用户输入 |
| `tool_use` | Claude 请求使用工具 | 执行工具，将结果反馈，继续循环 |
| `max_tokens` | 达到输出 Token 上限 | 可能触发续写或提示用户 |

**消息流转数据流图**：

```
用户终端输入
    │
    ▼
processUserInput()
    │
    ├── /command → processSlashCommand() → 本地执行
    ├── !bash   → processBashCommand()  → 直接执行 Shell
    └── text    → processTextPrompt()   → 进入 API 调用
         │
         ▼
    ┌─────────────────────────────────┐
    │        Message Pipeline         │
    │                                 │
    │  系统消息                        │
    │  ├── System Prompt              │
    │  │   ├── CLAUDE.md (项目记忆)    │
    │  │   ├── 工具定义列表             │
    │  │   ├── 权限规则摘要             │
    │  │   └── 输出风格指令             │
    │  │                              │
    │  对话历史                        │
    │  ├── User: 之前的输入             │
    │  ├── Assistant: 之前的回复        │
    │  ├── User: 工具结果              │
    │  └── ... (可能已被 compact)      │
    │  │                              │
    │  当前输入                        │
    │  └── User: 最新输入              │
    └────────────┬────────────────────┘
                 │
                 ▼
          Anthropic Messages API
                 │
                 ▼
          流式响应处理
                 │
          ┌──────┴──────┐
          │             │
       tool_use      text only
          │             │
          ▼             ▼
    工具执行管线     Ink UI 渲染
    (见 2.2)      (展示给用户)
          │
          ▼
    结果反馈到 API
    (继续内循环)
```


### 2.2 工具调度

**工具执行管道**（`src/services/tools/`）：

| 文件 | 职责 |
|------|------|
| `StreamingToolExecutor.ts` | 流式工具执行器——管理工具执行生命周期 |
| `toolExecution.ts` | 工具执行核心逻辑——输入验证、执行、输出格式化 |
| `toolHooks.ts` | 工具执行钩子——前置/后置处理 |
| `toolOrchestration.ts` | 工具编排逻辑——多工具并发与串行策略 |

**完整的工具调度流程**：

```
API 响应包含 tool_use ContentBlock
    │
    ▼
Step 1: 解析工具调用
    ├── 从 content_block 提取 tool name
    ├── 从 input_json_delta 流式构建输入参数
    └── content_block_stop 时获得完整输入
    │
    ▼
Step 2: 工具查找
    ├── 在内置工具注册表中查找
    ├── 若未找到，在 MCP 工具注册表中查找
    ├── 若未找到，在插件工具中查找
    └── 若仍未找到 → 返回工具不存在错误
    │
    ▼
Step 3: 输入验证
    ├── 校验输入是否符合工具的 inputSchema (JSON Schema)
    ├── 必填参数检查
    ├── 类型检查（string, number, boolean, array, object）
    └── 特定工具的自定义验证（如 FileEdit 的路径检查）
    │
    ▼
Step 4: 权限检查 (详见 2.3)
    ├── 查询权限规则匹配结果
    ├── 若规则允许 → 继续执行
    ├── 若规则拒绝 → 返回拒绝消息
    ├── 若需要用户确认 → 弹出权限对话框
    │   ├── 用户批准 → 记录规则，继续执行
    │   └── 用户拒绝 → 记录规则，返回拒绝消息
    └── 注意：只读工具（Glob, Grep, FileRead）通常直接放行
    │
    ▼
Step 5: 执行前钩子 (toolHooks.ts - pre hooks)
    ├── hooks 配置检查（settings.json 中的 hooks 配置）
    ├── 文件变更监听初始化 (fileChangedWatcher.ts)
    ├── Git 操作追踪启动 (gitOperationTracking.ts)
    └── 自定义 hooks 执行（用户配置的前置脚本）
    │
    ▼
Step 6: 工具执行 (toolExecution.ts)
    │
    ├── Bash 工具:
    │   ├── 沙箱模式检查 (shouldUseSandbox.ts)
    │   ├── spawn 子进程
    │   ├── stdin/stdout/stderr pipe 管理
    │   ├── 超时控制（默认 120s，最大 600s）
    │   ├── 输出截断（过长输出持久化到磁盘）
    │   └── 后台化支持（Ctrl+B 或自动后台化）
    │
    ├── 文件操作工具:
    │   ├── 路径规范化（绝对路径验证）
    │   ├── 文件读取缓存 (fileReadCache.ts)
    │   ├── 文件编辑的原子性保证
    │   ├── 文件历史快照 (fileHistory.ts)
    │   └── Git diff 生成
    │
    ├── Agent 工具:
    │   ├── 子 Agent 创建 (forkSubagent.ts / runAgent.ts)
    │   ├── 上下文隔离（独立的消息历史和状态）
    │   ├── 模型选择（可覆盖父 Agent 的模型）
    │   ├── 后台执行支持
    │   └── 结果聚合与摘要
    │
    └── MCP 工具:
        ├── MCP Client 调用 (services/mcp/client.ts)
        ├── 序列化/反序列化
        └── 超时与重试
    │
    ▼
Step 7: 执行后钩子 (toolHooks.ts - post hooks)
    ├── 文件变更检测与通知
    ├── Git 操作追踪完成
    ├── 分析事件上报 (analytics)
    └── 自定义 hooks 执行（用户配置的后置脚本）
    │
    ▼
Step 8: 结果格式化
    ├── 构造 tool_result ContentBlock
    ├── 输出截断处理（过大输出持久化并引用）
    ├── 结构化内容组装（如 FileRead 的行号、FileEdit 的 diff）
    ├── 错误信息格式化
    └── 将结果追加到消息列表，作为 User 消息发回 API
```

**StreamingToolExecutor 的流式特性**：

```typescript
// StreamingToolExecutor 的核心机制
class StreamingToolExecutor {
  // 在 API 流式输出 tool_use 的 input 参数时，
  // 就开始准备工具执行环境，而不是等到完整输入到达后才开始
  onInputJsonDelta(delta: string) {
    this.partialInput += delta;
    // 部分输入可以用于提前验证和 UI 渲染
    this.updateUI(this.partialInput);
  }

  onContentBlockStop() {
    // 输入完整后，立即开始执行
    const input = JSON.parse(this.partialInput);
    this.execute(input);
  }
}
```

**多工具并发编排**（`toolOrchestration.ts`）：

当 Claude 在一次响应中发出多个 tool_use 请求时，Claude Code 需要决定执行策略：

```
单次响应中的多个 tool_use
    │
    ├── 独立工具（如多个 FileRead）→ 并发执行
    │   └── Promise.all([tool1.execute(), tool2.execute(), ...])
    │
    ├── 依赖工具（如 FileRead -> FileEdit）→ 串行执行
    │   └── tool1.execute() -> tool2.execute() -> ...
    │
    └── 混合场景 → 分组执行
        └── 先并发执行独立组，再串行执行依赖组
```


### 2.3 权限控制算法

Claude Code 实现了三层权限控制体系，确保 AI 操作在用户可控的安全边界内。

**三层权限控制架构**：

```
┌─────────────────────────────────────────────┐
│           全局层 (Global Layer)              │
│                                             │
│  toolPermissionMode: 决定整体权限策略         │
│  ├── default      → 进入工具层判定           │
│  ├── plan         → 要求先生成计划            │
│  ├── acceptEdits  → 文件编辑自动批准          │
│  ├── bypassPermissions → 全部跳过            │
│  └── dontAsk      → 全部拒绝                │
└─────────────────┬───────────────────────────┘
                  │ (default 模式下)
                  ▼
┌─────────────────────────────────────────────┐
│           工具层 (Tool Layer)                │
│                                             │
│  每个工具的权限规则列表                        │
│  ├── PermissionRule[] 匹配                   │
│  │   ├── allow 规则命中 → 允许               │
│  │   ├── deny 规则命中  → 拒绝               │
│  │   └── 无规则命中     → 检查工具默认行为     │
│  │                                          │
│  └── 工具默认行为                             │
│      ├── 只读工具（FileRead, Glob, Grep）     │
│      │   → 默认允许                          │
│      ├── 写入工具（FileEdit, FileWrite）      │
│      │   → 默认需要用户确认                    │
│      └── 执行工具（Bash, Agent）              │
│          → 进入命令层判定                      │
└─────────────────┬───────────────────────────┘
                  │ (Bash 工具)
                  ▼
┌─────────────────────────────────────────────┐
│           命令层 (Command Layer)              │
│                                             │
│  Bash 命令特定的安全分析                       │
│  ├── dangerousPatterns 检测                   │
│  ├── bashClassifier 分类                      │
│  ├── yoloClassifier 自动模式评估               │
│  └── pathValidation 路径检查                   │
└─────────────────────────────────────────────┘
```

**Bash 命令安全分析详解**：

**dangerousPatterns（危险模式检测，`dangerousPatterns.ts`）**：

```
危险等级 1: 远程代码执行
├── curl ... | sh/bash       — 管道执行远程脚本
├── wget -O - ... | bash     — 下载并执行
├── eval $(curl ...)         — eval 远程内容
└── python -c "$(curl ...)"  — 通过脚本语言执行远程代码

危险等级 2: 数据销毁
├── rm -rf /                 — 删除根目录
├── rm -rf ~                 — 删除用户目录
├── mkfs.*                   — 格式化磁盘
├── dd if=/dev/zero of=...   — 覆写设备
└── > /dev/sda               — 覆写磁盘设备

危险等级 3: 系统级操作
├── sudo ...                 — 提权执行
├── chmod -R 777 /           — 全局权限变更
├── chown -R ...             — 全局所有权变更
└── iptables ...             — 防火墙规则修改

危险等级 4: 网络风险
├── nc -l ...                — 监听网络端口
├── ssh -R ...               — 反向隧道
└── scp/rsync 到外部地址      — 数据外泄风险
```

**bashClassifier（Bash 命令分类器，`bashClassifier.ts`）**：

```typescript
// 分类结果
type BashClassification =
  | 'readonly'    // 只读命令（ls, cat, grep, find 等）→ 通常自动批准
  | 'safe_write'  // 安全写入（git add, npm install 等）→ 可能自动批准
  | 'dangerous'   // 危险命令 → 绝不自动批准
  | 'unknown';    // 无法分类 → 需要用户确认
```

分类器的判定逻辑：

```
输入: Bash 命令字符串
    │
    ▼
Step 1: 命令解析 (bashParser.ts / treeSitterAnalysis.ts)
    ├── 提取主命令（考虑管道、重定向、子 shell）
    ├── 解析参数和标志
    └── 处理 heredoc、命令替换等
    │
    ▼
Step 2: 只读检测 (readOnlyValidation.ts)
    ├── 命令是否在只读白名单中
    │   └── ls, cat, head, tail, wc, file, which, type,
    │       echo (无重定向), date, whoami, pwd, env, ...
    ├── git 子命令分类
    │   ├── git status/log/diff/show → 只读
    │   ├── git add/commit/push → 写入
    │   └── git reset --hard → 危险
    └── 管道链中所有命令都是只读 → 整体只读
    │
    ▼
Step 3: sed 编辑验证 (sedEditParser.ts / sedValidation.ts)
    ├── 解析 sed 表达式
    ├── 检测是否为 in-place 编辑 (-i 标志)
    ├── 若是 in-place 编辑 → 按 FileEdit 处理权限
    └── 若仅输出到 stdout → 按只读处理
    │
    ▼
Step 4: 路径验证 (pathValidation.ts)
    ├── 提取命令中涉及的文件路径
    ├── 检查路径是否在允许的工作目录内
    ├── 检查是否试图访问系统关键目录
    └── 跨越工作目录边界 → 标记为需要额外审查
    │
    ▼
Step 5: 语义分析 (commandSemantics.ts)
    ├── 命令的预期副作用分析
    ├── 破坏性操作检测 (destructiveCommandWarning.ts)
    └── 模式验证 (modeValidation.ts)
```

**yoloClassifier（自动批准模式，`yoloClassifier.ts`）**：

当用户启用 `bypassPermissions` 模式时，yoloClassifier 提供最后一道安全防线。即使在绕过模式下，某些极端危险的操作仍然会被拦截：

```
yoloClassifier 安全分级
├── 绝对禁止（即使 bypass 模式也拦截）
│   ├── rm -rf /
│   ├── curl | sh（远程代码执行）
│   ├── dd if=/dev/zero of=/dev/sda
│   └── 其他数据销毁/系统破坏命令
├── 高危警告（bypass 模式下放行但警告）
│   ├── sudo 命令
│   ├── 大范围文件删除
│   └── 系统配置修改
└── 正常放行（bypass 模式下静默允许）
    └── 所有其他命令
```

**权限 UI 交互**：

当工具执行需要用户授权时，Claude Code 会显示权限对话框。每种工具类型都有专门的对话框组件（`src/components/permissions/`）：

```
权限 UI 组件体系 (34 个源文件)
├── PermissionDialog.tsx           — 通用对话框框架
├── PermissionRequest.tsx          — 权限请求基类
├── PermissionPrompt.tsx           — 权限提示渲染
├── PermissionExplanation.tsx      — 决策解释文本
├── PermissionRuleExplanation.tsx  — 规则解释文本
│
├── BashPermissionRequest/         — Bash 命令授权
│   ├── BashPermissionRequest.tsx
│   └── bashToolUseOptions.tsx     — 授权选项（允许/拒绝/允许此类命令）
│
├── FileEditPermissionRequest/     — 文件编辑授权
├── FileWritePermissionRequest/    — 文件写入授权
├── FilesystemPermissionRequest/   — 文件系统操作授权
├── NotebookEditPermissionRequest/ — Notebook 编辑授权
├── SedEditPermissionRequest/      — sed 编辑授权
├── PowerShellPermissionRequest/   — PowerShell 授权
├── WebFetchPermissionRequest/     — 网络请求授权
├── SandboxPermissionRequest.tsx   — 沙箱相关授权
├── SkillPermissionRequest/        — 技能执行授权
├── ComputerUseApproval/           — Computer Use 授权
│
├── 计划模式相关
│   ├── EnterPlanModePermissionRequest/
│   └── ExitPlanModePermissionRequest/
│
├── AskUserQuestionPermissionRequest/  — 多选问题授权
│   ├── PreviewBox.tsx
│   ├── PreviewQuestionView.tsx
│   ├── QuestionNavigationBar.tsx
│   └── QuestionView.tsx
│
├── 规则管理
│   ├── rules/AddPermissionRules.tsx
│   ├── rules/PermissionRuleDescription.tsx
│   ├── rules/PermissionRuleInput.tsx
│   ├── rules/PermissionRuleList.tsx
│   ├── rules/RecentDenialsTab.tsx
│   ├── rules/AddWorkspaceDirectory.tsx
│   └── rules/RemoveWorkspaceDirectory.tsx
│
└── Worker/Swarm 相关
    ├── WorkerBadge.tsx
    └── WorkerPendingPermission.tsx
```


### 2.4 上下文管理

Claude Code 的上下文管理是保证长对话效率和质量的关键。由于 LLM 的上下文窗口有限，需要在信息保留和空间效率之间取得平衡。

**上下文管理子系统**（`src/services/compact/`）：

| 文件 | 职责 |
|------|------|
| `compact.ts` | 主压缩逻辑——完整的对话历史压缩 |
| `autoCompact.ts` | 自动压缩触发器——监测上下文使用率并自动触发 |
| `microCompact.ts` | 微型压缩——轻量级的局部压缩 |
| `apiMicrocompact.ts` | 基于 API 的微型压缩 |
| `grouping.ts` | 消息分组——识别可压缩的消息组 |
| `prompt.ts` | 压缩提示词——指导 Claude 如何压缩对话 |
| `postCompactCleanup.ts` | 压缩后清理——移除冗余数据 |
| `sessionMemoryCompact.ts` | 会话内存压缩 |
| `compactWarningHook.ts` | 压缩警告钩子 |
| `compactWarningState.ts` | 压缩警告状态管理 |
| `timeBasedMCConfig.ts` | 基于时间的微型压缩配置 |

**三级压缩策略**：

```
上下文窗口使用率
    │
    0%                    70%              85%              95%        100%
    ├─────────────────────┼────────────────┼────────────────┼──────────┤
    │    正常区域          │  微型压缩区域   │  自动压缩区域   │  紧急压缩│
    │    (无操作)          │  (microCompact)│  (autoCompact) │  (强制)  │
    │                     │                │                │          │
    │                     │ 压缩不重要的    │ 压缩整个历史   │ 激进裁剪 │
    │                     │ 工具输出细节    │ 保留关键信息    │ 仅保留   │
    │                     │                │                │ 最近上下文│
```

**Compact 压缩算法详解**（`compact.ts`）：

```
压缩流程
    │
    ▼
Step 1: 消息分组 (grouping.ts)
    ├── 识别工具调用-结果对
    ├── 识别多轮对话主题段落
    └── 标记重要/不重要的消息组
    │
    ▼
Step 2: 重要性评分
    ├── 最近的消息 → 高分（recency bias）
    ├── 包含关键决策的消息 → 高分
    ├── 文件操作的消息 → 中分（保留文件路径和操作摘要）
    ├── 大量工具输出 → 低分（可安全压缩）
    └── 重复的读取操作 → 最低分（可直接移除）
    │
    ▼
Step 3: 压缩执行
    ├── 调用 Claude API 生成压缩摘要
    │   ├── 提供压缩提示词 (prompt.ts)
    │   ├── 要求保留：关键决策、文件路径、代码更改摘要
    │   └── 允许丢弃：冗长的工具输出、重复信息
    │
    ├── 替换原始消息为压缩摘要
    │   └── 插入 CompactBoundary 标记（UI 中显示为分隔线）
    │
    └── 清理 (postCompactCleanup.ts)
        ├── 移除孤立的 tool_result（对应的 tool_use 已被压缩）
        ├── 合并连续的 text blocks
        └── 更新消息 ID 映射
```

**autoCompact 触发条件**（`autoCompact.ts`）：

```typescript
// 自动压缩触发逻辑（伪代码）
function shouldAutoCompact(messages: Message[]): boolean {
  const totalTokens = estimateTokenCount(messages);
  const windowSize = getContextWindowSize(currentModel);
  const usageRatio = totalTokens / windowSize;

  // 超过 85% 上下文窗口使用率时触发
  if (usageRatio > 0.85) return true;

  // 或者消息数量超过阈值
  if (messages.length > MAX_MESSAGE_COUNT) return true;

  return false;
}
```

**microCompact 微型压缩**（`microCompact.ts`）：

微型压缩是一种轻量级策略，不调用 Claude API，而是通过规则对工具输出进行局部精简：

```
microCompact 规则
├── 大型文件读取输出 → 截断为前 N 行 + 摘要
├── Bash 命令输出 → 截断为前/后 N 行
├── Grep 搜索结果 → 限制匹配数量
├── Glob 结果 → 限制文件列表长度
├── 错误堆栈 → 只保留关键帧
└── 重复出现的工具调用 → 合并为计数摘要
```

**缓存优化**（`promptCacheBreakDetection.ts`）：

Anthropic API 支持 prompt caching——如果连续请求的 system prompt 和前缀消息相同，可以复用缓存的 KV 对，大幅降低延迟和成本。

```
缓存中断检测逻辑
    │
    ▼
比较当前请求与上一次请求的前缀
    │
    ├── system prompt 变化 → 缓存全部失效
    │   └── 触发原因：CLAUDE.md 更新、工具列表变化、权限规则变化
    │
    ├── 早期消息变化 → 部分缓存失效
    │   └── 触发原因：对话历史被压缩或修改
    │
    └── 仅追加新消息 → 缓存有效
        └── 最优路径：仅需计算新增部分的 Token
```

缓存作用域为 `system_prompt` 级别。Claude Code 刻意维护 system prompt 的稳定性，避免不必要的变更破坏缓存。

**媒体项限制管理**：

Anthropic Messages API 对单个请求中的媒体项（图片、PDF 等）有数量限制（>100 时会报错）。`stripExcessMediaItems` 函数负责：

```
当 messages 中的媒体项 > 100 时
    │
    ▼
按时间顺序从最早的消息开始
    ├── 将图片 ContentBlock 替换为文本描述
    │   └── "[Image was here: {description}]"
    ├── 将 PDF 替换为文本引用
    │   └── "[PDF was here: {filename}]"
    └── 保留最近的媒体项（直到数量 <= 100）
```

**CLAUDE.md 与项目记忆**：

CLAUDE.md 是 Claude Code 的项目记忆文件，存储项目特定的上下文和指令。它被注入到 system prompt 中，成为 Claude 理解当前项目的关键信息源。

```
CLAUDE.md 加载层级
├── ~/.claude/CLAUDE.md         — 全局记忆（所有项目通用）
├── {project}/.claude/CLAUDE.md — 项目级记忆
├── {project}/CLAUDE.md         — 项目根目录记忆
└── 子目录 CLAUDE.md            — 目录级记忆
    └── 加载规则：仅当 Claude 访问该目录时加载
```

相关源文件：
- `src/utils/claudemd.ts` — CLAUDE.md 加载与解析
- `src/utils/markdownConfigLoader.ts` — Markdown 配置加载器
- `src/services/SessionMemory/` — 会话内存服务（自动提取和保存记忆）
- `src/services/extractMemories/` — 记忆提取服务
- `src/memdir/` — 内存目录管理（6 个文件）
- `src/projectOnboardingState.ts` — 项目 Onboarding 状态检测


### 2.5 通信架构

Claude Code 维护着五种并行的通信通道，每种通道承担不同的数据传输职责。

**通信架构总览**：

```
                         Claude Code CLI 进程
                              │
          ┌───────────────────┼───────────────────────┐
          │                   │                        │
     ┌────┴────┐        ┌────┴─────┐            ┌────┴────┐
     │Anthropic│        │  Bridge  │            │   MCP   │
     │  API    │        │ (Web版)  │            │ Servers │
     └────┬────┘        └────┬─────┘            └────┬────┘
          │                   │                       │
     HTTP/HTTPS          WebSocket              stdio + SSE
     (streaming)          + SSE                  (进程间)
          │                   │                       │
          │             ┌────┴─────┐                  │
          │             │claude.ai │                  │
          │             │网页版     │                  │
          │             └──────────┘                  │
          │                                           │
          │         ┌──────────┐              ┌──────┴──────┐
          │         │Agent IPC │              │MCP Server 1 │
          │         │(子进程)   │              │MCP Server 2 │
          │         └────┬─────┘              │MCP Server N │
          │              │                    └─────────────┘
          │         fork/exec
          │         + 消息传递
          │              │
          │         ┌────┴─────┐
          │         │子 Agent  │
          │         │进程      │
          │         └──────────┘
          │
          │         ┌──────────┐
          │         │  Bash    │
          │         │ (Shell)  │
          │         └────┬─────┘
          │              │
          │         spawn + pipe
          │         stdin/stdout/stderr
          │              │
          │         ┌────┴─────┐
          │         │Shell 进程│
          │         └──────────┘
```

#### 通道 1：Anthropic API（HTTP/HTTPS Streaming）

**职责**：与 Claude 大语言模型通信，发送消息并流式接收响应。

**源文件**：

| 文件 | 职责 |
|------|------|
| `src/services/api/claude.ts` | Claude API 客户端封装 |
| `src/services/api/client.ts` | HTTP 客户端配置 |
| `src/services/api/bootstrap.ts` | API 客户端初始化 |
| `src/services/api/errors.ts` | API 错误处理 |
| `src/services/api/errorUtils.ts` | 错误工具函数 |
| `src/services/api/withRetry.ts` | 请求重试逻辑 |
| `src/services/api/logging.ts` | API 请求/响应日志 |
| `src/services/api/promptCacheBreakDetection.ts` | 缓存中断检测 |
| `src/services/api/dumpPrompts.ts` | 调试用——导出完整 prompt |
| `src/services/api/emptyUsage.ts` | 空使用量初始值 |
| `src/services/api/firstTokenDate.ts` | 首个 Token 的时间戳追踪 |

**通信流程**：

```
claude.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 16384,
  system: [systemPrompt],          // 含 CLAUDE.md、工具定义
  messages: conversationHistory,    // 完整对话历史
  tools: toolDefinitions,          // 可用工具列表
  stream: true,                    // 启用流式传输
  metadata: {
    user_id: hashedUserId,         // 匿名化用户标识
  },
  // 可选：extended thinking
  thinking: {
    type: "enabled",
    budget_tokens: thinkingBudget,
  },
})
```

**API 提供商适配**（`src/utils/model/providers.ts`）：

Claude Code 支持多个 API 提供商：
- Anthropic Direct（默认）
- AWS Bedrock（`src/utils/model/bedrock.ts`）
- Google Vertex AI
- 自定义代理（通过 `ANTHROPIC_BASE_URL` 环境变量）

#### 通道 2：Bridge（WebSocket + SSE）

**职责**：与 claude.ai 网页版双向通信，允许用户在网页端查看和操控终端中的 Claude Code 会话。

**源文件**（31 个文件）：

```
src/bridge/
├── bridgeApi.ts            — Bridge REST API 客户端
├── bridgeConfig.ts         — Bridge 配置管理
├── bridgeDebug.ts          — 调试工具
├── bridgeEnabled.ts        — Bridge 功能开关检测
├── bridgeMain.ts           — Bridge 主控制器
├── bridgeMessaging.ts      — 消息序列化/反序列化
├── bridgePermissionCallbacks.ts — 权限回调桥接
├── bridgePointer.ts        — 消息指针（同步位置）
├── bridgeStatusUtil.ts     — 连接状态工具
├── bridgeUI.ts             — Bridge UI 集成
├── capacityWake.ts         — 容量唤醒（服务端负载管理）
├── codeSessionApi.ts       — 代码会话 API
├── createSession.ts        — 创建 Bridge 会话
├── debugUtils.ts           — Bridge 调试工具
├── envLessBridgeConfig.ts  — 无环境变量的配置
├── flushGate.ts            — 消息刷新门控
├── inboundAttachments.ts   — 入站附件处理
├── inboundMessages.ts      — 入站消息处理
├── initReplBridge.ts       — REPL Bridge 初始化
├── jwtUtils.ts             — JWT 令牌处理
├── pollConfig.ts           — 轮询配置
├── pollConfigDefaults.ts   — 轮询默认值
├── remoteBridgeCore.ts     — 远程 Bridge 核心
├── replBridge.ts           — REPL Bridge 实现
├── replBridgeHandle.ts     — REPL Bridge 句柄
├── replBridgeTransport.ts  — REPL Bridge 传输层
├── sessionIdCompat.ts      — 会话 ID 兼容
├── sessionRunner.ts        — 会话运行器
├── trustedDevice.ts        — 可信设备管理
├── types.ts                — Bridge 类型定义
└── workSecret.ts           — 工作密钥管理
```

**Bridge 通信协议**：

```
Claude Code CLI                          claude.ai Web
     │                                        │
     │ 1. 创建会话 (POST /session)             │
     │ ──────────────────────────────────────> │
     │                                        │
     │ 2. 建立 WebSocket 连接                  │
     │ <======================================>│
     │                                        │
     │ 3. 推送对话状态 (消息流)                  │
     │ ──────────────── SSE ──────────────────>│
     │                                        │
     │ 4. 接收用户操作 (消息/审批)               │
     │ <──────────── WebSocket ───────────────│
     │                                        │
     │ 5. 权限回调 (bridgePermissionCallbacks) │
     │ <──────────────────────────────────────│
     │                                        │
     │ 6. 附件传输 (图片/文件)                  │
     │ <── inboundAttachments ────────────────│
```

#### 通道 3：MCP（Model Context Protocol）

**职责**：与外部 MCP Server 通信，扩展 Claude Code 的工具和资源能力。

**源文件**（22 个文件）：

```
src/services/mcp/
├── InProcessTransport.ts       — 进程内传输（嵌入式 MCP Server）
├── MCPConnectionManager.tsx    — MCP 连接管理器（React 组件）
├── SdkControlTransport.ts      — SDK 控制传输
├── auth.ts                     — MCP 认证
├── channelAllowlist.ts         — 通道白名单
├── channelNotification.ts      — 通道通知
├── channelPermissions.ts       — 通道权限
├── claudeai.ts                 — claude.ai MCP 集成
├── client.ts                   — MCP 客户端实现
├── config.ts                   — MCP 配置
├── elicitationHandler.ts       — 交互式信息采集处理
├── envExpansion.ts             — 环境变量展开
├── headersHelper.ts            — HTTP 头辅助
├── mcpStringUtils.ts           — 字符串工具
├── normalization.ts            — 配置规范化
├── oauthPort.ts                — OAuth 端口管理
├── officialRegistry.ts         — 官方 MCP 注册表
├── types.ts                    — MCP 类型定义
├── useManageMCPConnections.ts  — 连接管理 Hook
├── utils.ts                    — MCP 工具函数
├── vscodeSdkMcp.ts             — VS Code SDK MCP 集成
├── xaa.ts                      — XAA 集成
└── xaaIdpLogin.ts              — XAA IdP 登录
```

**MCP 通信协议**：

```
Claude Code                              MCP Server
     │                                        │
     │ 传输方式 1: stdio                       │
     │   spawn MCP Server 进程                 │
     │   stdin  ──────────────────────────>   │
     │   stdout <──────────────────────────   │
     │   stderr <──── (日志/错误) ────────    │
     │                                        │
     │ 传输方式 2: SSE (Server-Sent Events)   │
     │   HTTP GET /sse ──────────────────>    │
     │   <──── SSE event stream ─────────    │
     │   HTTP POST /message ─────────────>   │
     │                                        │
     │ 传输方式 3: 进程内 (InProcessTransport) │
     │   直接函数调用（无进程间开销）             │
     │                                        │
     │ 协议流程:                               │
     │ 1. initialize → capabilities 协商      │
     │ 2. tools/list → 获取可用工具列表         │
     │ 3. resources/list → 获取可用资源         │
     │ 4. tools/call → 调用工具                │
     │ 5. resources/read → 读取资源            │
```

#### 通道 4：Agent IPC（进程间通信）

**职责**：主 Agent 与子 Agent 之间的通信，支持任务分派和结果聚合。

**源文件**：

| 文件 | 职责 |
|------|------|
| `src/utils/forkedAgent.ts` | Fork 子 Agent 进程 |
| `src/tools/AgentTool/forkSubagent.ts` | 子 Agent 创建 |
| `src/tools/AgentTool/runAgent.ts` | Agent 执行管理 |
| `src/tools/shared/spawnMultiAgent.ts` | 多 Agent 并发创建 |
| `src/utils/swarm/` | Swarm 协作框架（20+ 文件） |

**Agent 通信模型**：

```
主 Agent (Leader)
    │
    ├── fork/exec 创建子 Agent 进程
    │   └── 传递: prompt, 工具权限, 模型选择, 工作目录
    │
    ├── 消息传递
    │   ├── Leader → Worker: 任务分派、上下文注入
    │   ├── Worker → Leader: 进度更新、结果返回
    │   └── Worker <-> Worker: SendMessage 工具互发消息
    │
    └── 生命周期管理
        ├── 监控 Worker 状态
        ├── 超时控制
        ├── 异常处理（Worker 崩溃恢复）
        └── 资源清理（AbortController）
```

**Swarm 协作框架**（`src/utils/swarm/`）：

Swarm 是 Claude Code 的多 Agent 协作框架，支持在多个终端窗口中并发运行 Agent：

```
src/utils/swarm/
├── constants.ts               — Swarm 常量
├── inProcessRunner.ts         — 进程内 Runner
├── leaderPermissionBridge.ts  — Leader 权限桥接
├── permissionSync.ts          — 权限同步
├── reconnection.ts            — 重连逻辑
├── spawnInProcess.ts          — 进程内创建
├── spawnUtils.ts              — 创建工具
├── teamHelpers.ts             — 团队辅助函数
├── teammateInit.ts            — Teammate 初始化
├── teammateLayoutManager.ts   — Teammate 布局管理
├── teammateModel.ts           — Teammate 模型配置
├── teammatePromptAddendum.ts  — Teammate 提示词补充
└── backends/                  — 终端后端适配
    ├── ITermBackend.ts        — iTerm2 窗格管理
    ├── InProcessBackend.ts    — 进程内后端
    ├── PaneBackendExecutor.ts — 窗格后端执行器
    ├── TmuxBackend.ts         — Tmux 窗格管理
    ├── detection.ts           — 终端类型检测
    ├── it2Setup.ts            — iTerm2 配置
    ├── registry.ts            — 后端注册表
    ├── teammateModeSnapshot.ts — 模式快照
    └── types.ts               — 后端类型定义
```

#### 通道 5：Bash/Shell（spawn + pipe）

**职责**：执行本地 Shell 命令，是 Claude Code 与操作系统交互的主要通道。

**源文件**：

| 文件 | 职责 |
|------|------|
| `src/utils/Shell.ts` | Shell 抽象类 |
| `src/utils/ShellCommand.ts` | Shell 命令封装 |
| `src/utils/shell/shellProvider.ts` | Shell 提供者接口 |
| `src/utils/shell/bashProvider.ts` | Bash 提供者实现 |
| `src/utils/shell/powershellProvider.ts` | PowerShell 提供者实现 |
| `src/utils/shell/resolveDefaultShell.ts` | 默认 Shell 检测 |
| `src/utils/shell/outputLimits.ts` | 输出限制管理 |
| `src/utils/shell/shellToolUtils.ts` | Shell 工具函数 |
| `src/utils/shell/prefix.ts` | Shell 前缀（环境初始化） |
| `src/utils/shell/readOnlyCommandValidation.ts` | 只读命令验证 |

**Shell 执行流程**：

```
BashTool.execute(command)
    │
    ▼
Shell 前缀注入 (prefix.ts)
    ├── 设置 PATH
    ├── 设置 HOME
    ├── 注入 Shell 配置
    └── 沙箱前缀（如果启用）
    │
    ▼
spawn(shell, ['-c', prefixedCommand])
    │
    ├── stdin  → pipe（支持交互式输入）
    ├── stdout → pipe（流式捕获输出）
    └── stderr → pipe（捕获错误）
    │
    ▼
输出处理
    ├── 流式转发到 UI（实时显示）
    ├── 输出大小监控
    │   ├── 超过限制 → 截断 + 持久化到磁盘
    │   └── 持久化路径写入 tool_result
    ├── 超时监控（默认 120s）
    │   ├── 超时 → 发送 SIGTERM
    │   └── 仍未停止 → 发送 SIGKILL
    └── 退出码处理
        ├── 0 → 成功
        ├── 非零 → 附带 returnCodeInterpretation
        └── 信号终止 → 标记为 interrupted
```


## 3. 阶段 5 模块选择策略

基于前述的核心机制分析，我们选定以下 6 个模块进行阶段 5 的深度解剖。选择标准为：**架构复杂度高、源文件数量多、与核心数据流紧密耦合、代表了独特的工程设计决策**。

### 模块 1：工具系统 (Tool System)

**选择理由**：工具系统是 Claude Code 最大的代码子系统，包含 30+ 个工具类、184+ 个工具相关源文件。它定义了 AI 与外部世界交互的所有能力边界。

**深度解剖方向**：
- Tool 基类的完整接口契约
- 工具注册表的发现与加载机制
- 工具池延迟加载策略
- StreamingToolExecutor 的流式执行管道
- 工具编排（并发 vs 串行）的决策算法
- BashTool 的 18 个子模块安全体系
- AgentTool 的 20 个子模块递归执行框架
- 工具输入 JSON Schema 验证流程
- 工具输出截断与持久化策略

**核心源文件数量**：约 120+ 个（`src/tools/` + `src/services/tools/` + 相关工具类）

### 模块 2：权限系统 (Permission System)

**选择理由**：权限系统是 Claude Code 的安全核心，横跨 22 个专用源文件和 34 个 UI 组件文件。它实现了从全局策略到单条命令的多层安全模型。

**深度解剖方向**：
- 五种 PermissionMode 的切换状态机
- 权限规则匹配算法（优先级、作用域、模式匹配）
- bashClassifier 的 Bash 命令 AST 解析
- dangerousPatterns 的模式库维护策略
- yoloClassifier 的安全底线设计
- sedEditParser 的编辑操作检测
- 权限 UI 对话框的组件体系
- 被遮蔽规则检测（shadowedRuleDetection）
- 拒绝追踪与分析（denialTracking）
- 企业级托管设置（MDM）的权限覆写

**核心源文件数量**：约 56 个（`src/utils/permissions/` + `src/components/permissions/`）

### 模块 3：Agent 子进程系统

**选择理由**：Agent 系统实现了一个完整的多 Agent 并发执行框架，是 Claude Code 处理复杂任务的核心能力。它涉及进程管理、通信协议、状态同步等操作系统级别的工程挑战。

**深度解剖方向**：
- AgentTool 的 20 个子模块职责分解
- 子 Agent 创建策略（fork vs in-process vs remote）
- 内置 Agent 类型（generalPurpose, explore, plan, verification, claudeCodeGuide）
- Swarm 框架的终端后端适配（iTerm2, Tmux, InProcess）
- Leader-Worker 权限桥接机制
- Teammate 初始化与提示词注入
- 异步 Agent 管理与结果聚合
- Agent 上下文隔离策略
- Worktree 隔离模式

**核心源文件数量**：约 55 个（`src/tools/AgentTool/` + `src/utils/swarm/` + `src/tasks/`）

### 模块 4：MCP 协议集成

**选择理由**：MCP（Model Context Protocol）是 Claude Code 扩展能力的标准协议。它实现了完整的客户端，支持三种传输方式和多种认证机制。

**深度解剖方向**：
- MCP 客户端完整实现（client.ts）
- 三种传输层适配（stdio, SSE, InProcess）
- MCP 连接管理器的连接池策略
- 工具桥接——将 MCP 工具映射为 Claude Code 内置工具
- 资源读取与缓存
- MCP Server 审批流程
- OAuth 认证集成
- Elicitation（交互式信息采集）处理
- 官方 MCP 注册表集成
- VS Code SDK MCP 集成

**核心源文件数量**：约 30 个（`src/services/mcp/` + `src/tools/MCPTool/` + `src/tools/ListMcpResourcesTool/` + `src/tools/ReadMcpResourceTool/`）

### 模块 5：Bridge 通信层

**选择理由**：Bridge 是 Claude Code 与 claude.ai 网页版之间的通信桥梁，实现了终端应用和 Web 应用之间的实时状态同步。这是一个独特的工程挑战——将命令行体验映射到网页 UI。

**深度解剖方向**：
- Bridge 架构设计与生命周期
- WebSocket + SSE 双通道设计
- 消息序列化与反序列化协议
- 权限回调桥接——在 Web 端处理权限请求
- 连接状态管理与重连策略
- 可信设备管理与 JWT 认证
- 入站消息与附件处理
- FlushGate 消息缓冲与批量发送
- 会话同步指针（bridgePointer）
- 远程 Bridge 核心（remoteBridgeCore）

**核心源文件数量**：约 31 个（`src/bridge/`）

### 模块 6：上下文与内存管理

**选择理由**：上下文管理直接决定了 Claude Code 在长对话场景下的质量和效率。它实现了一套精密的压缩、缓存和记忆持久化策略。

**深度解剖方向**：
- 三级压缩策略（compact / autoCompact / microCompact）
- 压缩算法的消息分组与重要性评分
- 压缩提示词工程（指导 Claude 如何压缩）
- Prompt Cache Break Detection 缓存优化
- CLAUDE.md 加载层级与合并逻辑
- SessionMemory 服务——自动提取和保存记忆
- Memory 目录结构（memdir）
- Token 估算与预算分配（tokenBudget）
- 项目 Onboarding 状态检测
- Dream 后台思考任务集成

**核心源文件数量**：约 25 个（`src/services/compact/` + `src/memdir/` + `src/services/SessionMemory/` + `src/services/extractMemories/`）


### 模块选择汇总

| 序号 | 模块名称 | 核心源文件数 | 关键入口文件 | 架构复杂度 |
|------|---------|------------|-------------|-----------|
| 1 | 工具系统 | ~120 | `src/tools.ts`, `src/Tool.ts` | ★★★★★ |
| 2 | 权限系统 | ~56 | `src/utils/permissions/permissions.ts` | ★★★★★ |
| 3 | Agent 子进程系统 | ~55 | `src/tools/AgentTool/AgentTool.tsx` | ★★★★☆ |
| 4 | MCP 协议集成 | ~30 | `src/services/mcp/client.ts` | ★★★★☆ |
| 5 | Bridge 通信层 | ~31 | `src/bridge/bridgeMain.ts` | ★★★★☆ |
| 6 | 上下文与内存管理 | ~25 | `src/services/compact/compact.ts` | ★★★★☆ |
| **合计** | | **~317** | | |

这 317 个源文件覆盖了 Claude Code 1906 个应用源文件的约 16.6%，但它们构成了系统最核心的逻辑路径。通过对这六个模块的深度解剖，可以完整理解 Claude Code 从用户输入到最终输出的全链路工作机制。
