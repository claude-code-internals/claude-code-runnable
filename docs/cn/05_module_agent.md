<p align="right"><a href="../en/05_module_agent.md">English</a></p>

# 阶段 5-A：Agent 子进程系统深度解剖

> 本章对 Claude Code 的 Agent 子进程并发执行框架进行全面解构。Agent 系统是 Claude Code 中最复杂的子系统之一，它使 CLI 从"单轮对话工具"演进为"多进程协调执行框架"，支持任务分解、并行执行、进程隔离与代理间通信。所有分析基于 `cli.js`（16667 行）源码逆向验证，辅以 `sdk-tools.d.ts` 公开类型交叉确认。


## 目录

1. [接口契约](#1-接口契约)
   - 1.1 [AgentInput -- 输入参数规范](#11-agentinput----输入参数规范)
   - 1.2 [AgentOutput -- 输出类型规范](#12-agentoutput----输出类型规范)
   - 1.3 [Zod Schema 定义](#13-zod-schema-定义)
2. [实现机制](#2-实现机制)
   - 2.1 [Agent 执行核心 -- Qm8 工具定义](#21-agent-执行核心----qm8-工具定义)
   - 2.2 [内置 Agent 类型](#22-内置-agent-类型)
   - 2.3 [Agent 执行模式](#23-agent-执行模式)
   - 2.4 [Fork 机制 -- 上下文继承分叉](#24-fork-机制----上下文继承分叉)
   - 2.5 [Agent 间通信 -- SendMessage](#25-agent-间通信----sendmessage)
   - 2.6 [Worktree 隔离](#26-worktree-隔离)
   - 2.7 [Agent 生命周期管理](#27-agent-生命周期管理)
   - 2.8 [团队协作 Swarm 模式](#28-团队协作-swarm-模式)
   - 2.9 [Hook 集成](#29-hook-集成)
   - 2.10 [自动后台化与输入阻塞检测](#210-自动后台化与输入阻塞检测)
3. [演进思维实验](#3-演进思维实验)
4. [验证策略](#4-验证策略)


## 1. 接口契约

Agent 子进程系统是 Claude Code 的并发执行框架。它将"一个 Claude 进程执行所有事"扩展为"多个 Agent 进程协调执行复杂任务"，每个 Agent 拥有独立的上下文窗口、工具集和生命周期。

### 1.1 AgentInput -- 输入参数规范

Agent 工具通过 Zod Schema 严格校验输入。以下是从 `cli.js` 中提取的完整参数表：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `description` | `string` | 是 | 3-5 词任务摘要，用于 UI 展示和后台通知 |
| `prompt` | `string` | 是 | 完整任务说明，子 Agent 收到的指令正文 |
| `subagent_type` | `string` | 否 | 专门代理类型标识符。省略时行为取决于 fork 支持：支持 fork 则创建自身分叉，不支持则默认使用 `general-purpose` |
| `model` | `enum("sonnet","opus","haiku")` | 否 | 模型覆盖。优先级高于 Agent 定义中的 frontmatter `model` 字段，低于权限模式限制 |
| `run_in_background` | `boolean` | 否 | 异步执行开关。设为 `true` 时 Agent 在后台运行，父进程无需等待 |
| `name` | `string` | 否 | Agent 命名。设置后可通过 SendMessage 的 `to` 字段按名寻址 |
| `team_name` | `string` | 否 | 团队上下文名称。省略时使用当前会话的团队上下文 |
| `mode` | `enum("acceptEdits","bypassPermissions","default","dontAsk","plan")` | 否 | 权限模式覆盖，如 `plan` 要求批准执行计划 |
| `isolation` | `enum("worktree")` | 否 | 隔离模式。设为 `"worktree"` 创建临时 Git worktree |
| `cwd` | `string` | 否 | 工作目录覆盖。绝对路径，与 `isolation: "worktree"` 互斥 |

**条件约束**（源码验证）：
- 当运行在 teammate 上下文中时，`name`、`team_name`、`mode` 参数不可用——同伴不能生成其他同伴
- 当运行在 in-process teammate 上下文中时，`run_in_background` 不可用
- `cwd` 与 `isolation: "worktree"` 互斥，不能同时指定

### 1.2 AgentOutput -- 输出类型规范

输出是一个 Zod 联合类型（`z.union`），包含两种互斥状态：

**状态 1：`completed`（同步完成）**

```
{
  status: "completed",
  prompt: string,              // 原始提示词
  content: ContentBlock[],     // Agent 生成的内容块
  totalToolUseCount: number,   // 工具调用总次数
  totalDurationMs: number,     // 执行总时长（毫秒）
  totalTokens: number,         // 令牌消耗总量
  agentId: string,             // Agent 唯一标识
  agentType: string,           // Agent 类型标识
  worktreePath?: string,       // Worktree 路径（如有变更）
  worktreeBranch?: string      // Worktree 分支名
}
```

**状态 2：`async_launched`（异步启动）**

```
{
  status: "async_launched",
  agentId: string,             // Agent 唯一 ID
  description: string,         // 任务摘要
  prompt: string,              // 原始提示词
  outputFile: string,          // 输出文件路径（供查询进度）
  canReadOutputFile?: boolean  // 调用方是否有 Read/Bash 工具可查进度
}
```

**状态 3：`teammate_spawned`（团队成员生成，Swarm 模式专属）**

```
{
  status: "teammate_spawned",
  teammate_id: string,
  name: string,
  team_name: string
}
```

### 1.3 Zod Schema 定义

源码中 Schema 通过延迟求值（`B6(() => ...)`）定义，避免循环依赖和启动开销：

```javascript
// 基础输入 Schema
T4Y = B6(() => L.object({
  description: L.string().describe("A short (3-5 word) description of the task"),
  prompt: L.string().describe("The task for the agent to perform"),
  subagent_type: L.string().optional(),
  model: L.enum(["sonnet","opus","haiku"]).optional(),
  run_in_background: L.boolean().optional()
}))

// 扩展输入 Schema（增加 team 相关字段）
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

// 最终对外 Schema（根据环境条件裁剪字段）
xr1 = B6(() => {
  let q = v4Y().omit({ cwd: true });
  return mR6 || Lb() ? q.omit({ run_in_background: true }) : q
})
```

Schema 的条件裁剪体现了**环境自适应**设计：当 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 环境变量启用或 fork 模式禁用时，`run_in_background` 参数从 Schema 中移除——Schema 本身就是该参数不可用的最佳文档。


## 2. 实现机制

### 2.1 Agent 执行核心 -- Qm8 工具定义

Agent 工具在 `cli.js` 中以混淆名 `Qm8` 注册，核心属性：

```javascript
Qm8 = sq({
  name: v4,                          // 工具名（"Agent"）
  searchHint: "delegate work to a subagent",
  aliases: [CB],                      // 别名
  maxResultSizeChars: 1e5,            // 结果最大 100K 字符
  isReadOnly() { return true },       // 元数据层面标记为只读
  isConcurrencySafe() { return true }, // 支持并发安全

  async call({prompt, subagent_type, description, model,
              run_in_background, name, team_name, mode,
              isolation, cwd}, toolUseContext, canUseTool, metadata, onProgress) {
    // ... 核心执行逻辑
  }
})
```

**关键设计决策**：`isReadOnly()` 返回 `true`——Agent 工具本身的调用被视为只读操作，因为读写行为发生在子 Agent 内部，由子 Agent 自身的权限系统控制。

### 2.2 内置 Agent 类型

从 `cli.js` 中提取的内置 Agent 类型：

| agentType | 来源 | 用途 | 能力限制 |
|-----------|------|------|----------|
| `general-purpose` | `built-in` | 通用代理（默认）。拥有完整工具集 | 全能力 |
| `Explore` | `built-in` | 探索/研究代理。仅搜索和读取 | 只读——无法编辑文件 |
| `Plan` | `built-in` | 规划代理。分析需求并生成执行计划 | 只读——无法编辑文件 |
| `statusline-setup` | `built-in` | HUD 状态栏配置专用 | 特定功能 |
| `magic-docs` | `built-in` | 文档生成代理（CLAUDE.md 生成流程） | 读写 |

**自定义 Agent 定义**：

用户可以在 `.claude/agents/` 目录中定义自定义 Agent（Markdown frontmatter 格式），这些 Agent 通过 `agentDefinitions.activeAgents` 数组与内置类型共同参与调度。自定义 Agent 源码中标记为 `source: "projectSettings" | "userSettings" | "localSettings" | "flagSettings" | "policySettings" | "plugin"`，区别于 `source: "built-in"`。

Agent 定义结构（从源码逆向推断）：

```
AgentDefinition {
  agentType: string           // 唯一类型标识
  whenToUse: string           // 使用场景描述
  source: string              // 来源标识
  model?: string              // 默认模型
  color?: string              // UI 颜色标识
  background?: boolean        // 是否默认后台运行
  isolation?: "worktree"      // 默认隔离模式
  permissionMode?: string     // 权限模式
  memory?: string             // 记忆范围
  requiredMcpServers?: string[]  // 依赖的 MCP 服务器
  tokens?: number             // 令牌预算
  allowedTools?: string[]     // 允许的工具白名单
  getSystemPrompt(): string   // 获取系统提示词
}
```

### 2.3 Agent 执行模式

Agent 工具支持三种执行路径，由 `call()` 方法中的条件分支决定：

#### 路径 A：Teammate 生成（Swarm 模式）

```
触发条件: team_name 存在 && name 存在 && nq() 返回 true（Swarm 功能可用）

流程:
1. 校验 teammate 不能嵌套生成
2. 调用 VXK() 创建 tmux 分面进程
3. 返回 { status: "teammate_spawned", teammate_id, name, team_name }
```

#### 路径 B：异步后台 Agent

```
触发条件: run_in_background === true || agent.background === true（且未禁用后台任务）

流程:
1. 生成唯一 agentId（随机 8 字符 ID）
2. 通过 Fm8() 注册任务到全局 tasks 状态
3. 启动 iN() 流式推理循环（与主进程相同的 ReAct 循环）
4. 立即返回 { status: "async_launched", agentId, outputFile }
5. 完成时通过 task-notification 系统通知父进程
```

#### 路径 C：同步前台 Agent

```
触发条件: 默认路径

流程:
1. 生成 agentId，注册任务
2. 启动 iN() 流式推理循环
3. 逐步消费 AsyncIterator 产出的消息
4. 等待完成后收集结果
5. 返回 { status: "completed", content, totalToolUseCount, ... }
```

**自动后台化机制**：同步 Agent 可能在执行过程中被自动转为后台。`G4Y()` 函数检查 `CLAUDE_AUTO_BACKGROUND_TASKS` 环境变量或 `tengu_auto_background_agents` 功能标志，返回自动后台化超时时长（默认 120000ms = 2 分钟）。通过 `EXK()` 注册任务时创建一个 `setTimeout`，到期后通过 `backgroundSignal` Promise 通知主循环将该 Agent 切换为后台：

```javascript
// 自动后台化逻辑
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

### 2.4 Fork 机制 -- 上下文继承分叉

当 `subagent_type` 省略且 fork 功能可用时，Agent 工具不会创建一个全新的子进程，而是 **fork（分叉）自身**——新的 Agent 继承父进程的完整对话上下文（system prompt + 消息历史），相当于创建了一个拥有相同记忆的克隆体。

**Fork 的关键特征**：

1. **上下文继承**：通过 `forkContextMessages` 传递父进程的 `H.messages`
2. **系统提示词复用**：直接使用父进程的 `renderedSystemPrompt` 或重新构建
3. **指令注入**：`UMK()` 函数在消息尾部注入 Fork 指令块 `<fork_directive>`

Fork 指令正文（从源码中完整提取）：

```
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

**Fork 的递归保护**：`FMK()` 检查消息历史中是否已存在 `<fork_directive>` 标记。如果当前进程本身就是一个 fork worker，再次尝试 fork 会抛出错误 `"Fork is not available inside a forked worker."`。

**Fork vs. 新 Agent 的选择指南**（来自源码中的系统提示词）：

> Fork yourself (omit `subagent_type`) when the intermediate tool output isn't worth keeping in your context. The criterion is qualitative -- "will I need this output again" -- not task size.
>
> - **Research**: fork open-ended questions. If research can be broken into independent questions, launch parallel forks in one message. A fork beats a fresh subagent for this -- it inherits context and shares your cache.

### 2.5 Agent 间通信 -- SendMessage

`SendMessage` 工具是 Agent 间通信的唯一通道。关键特性：

| 特性 | 说明 |
|------|------|
| **按名寻址** | `to: "<name>"` 通过名称发送消息给特定 teammate |
| **按 ID 寻址** | `to: "<agentId>"` 通过内部 ID 发送（也用于恢复已完成的 Agent） |
| **广播** | `to: "*"` 团队范围广播（建议谨慎使用） |
| **结构化消息** | 支持 `{type: "shutdown_request"}` 等特殊消息类型 |
| **自动投递** | 消息自动投递到目标 Agent 的收件箱，无需手动轮询 |

**消息队列机制**：

```javascript
// 发送消息到 Agent 的待处理队列
function Um8(taskId, message, setAppState) {
  A3(taskId, setAppState, (state) => ({
    ...state,
    pendingMessages: [...state.pendingMessages, message]
  }))
}

// 消费 Agent 的待处理消息
function QXK(taskId, getAppState, setAppState) {
  let state = getAppState().tasks[taskId];
  if (!EJ(state) || state.pendingMessages.length === 0) return [];
  let messages = state.pendingMessages;
  A3(taskId, setAppState, (s) => ({ ...s, pendingMessages: [] }));
  return messages;
}
```

Teammate 之间的消息在空闲通知中包含简要摘要，为 coordinator 提供可见性而不必查看全文。

### 2.6 Worktree 隔离

`isolation: "worktree"` 为 Agent 创建一个完全隔离的 Git 工作环境。

**创建流程**：

```
1. 生成 worktree 名称: `agent-${agentId.slice(0,8)}`
2. 调用 c88() 创建 worktree:
   - Git 仓库内: 在 .claude/worktrees/ 下创建新的 git worktree + 新分支
   - 非 Git 仓库: 委托 WorktreeCreate/WorktreeRemove hooks（VCS 无关隔离）
3. 如果是 fork 模式，注入 worktree 切换提示词 QMK()
4. Agent 在 worktree 目录中执行所有操作
```

**清理策略**（`M6()` 函数）：

```javascript
async function getWorktreeResult() {
  // hook-based worktree: 始终保留
  if (hookBased) return { worktreePath };

  // 检查是否有变更（与创建时的 HEAD commit 比较）
  if (headCommit && !(await hasChanges(worktreePath, headCommit))) {
    // 无变更: 清理 worktree + 删除分支 + 清除元数据
    await removeWorktree(worktreePath, worktreeBranch, gitRoot);
    return {};
  }

  // 有变更: 保留 worktree，返回路径和分支名
  return { worktreePath, worktreeBranch };
}
```

这种"无变更自动清理，有变更自动保留"的策略确保资源不泄露，同时变更不丢失。

**EnterWorktree / ExitWorktree 工具**：

这两个工具供用户（非 Agent）手动管理 worktree 会话：

- `EnterWorktree`：
  - 仅在用户明确说"worktree"时使用
  - 当前不能已在 worktree 中
  - 可选指定名称和分支
  - 切换会话工作目录到新 worktree

- `ExitWorktree`：
  - 仅操作当前会话通过 `EnterWorktree` 创建的 worktree
  - `action: "keep"` 保留 worktree 目录和分支
  - `action: "remove"` 删除 worktree（有未提交变更时需 `discard_changes: true` 确认）
  - 恢复会话工作目录到进入前的位置

### 2.7 Agent 生命周期管理

Agent 从创建到销毁经历完整的状态机转换：

```
                           ┌──────────────────────────────────┐
                           │                                  ▼
  call() ──> 参数校验 ──> Agent 定义查找 ──> MCP 依赖检查
                                                     │
                                                     ▼
                          ┌──────────────────> 模型选择 (BN6)
                          │                      │
                          │                      ▼
                          │              系统提示词构建
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
                          │    teammate_    iN() 流式循环  iN() 流式循环
                          │    spawned           │            │
                          │                      ▼            ▼
                          │               task-notification  NL8() 收集
                          │                      │            │
                          │                      ▼            ▼
                          └───────────────  worktree清理  worktree清理
                                                 │            │
                                                 ▼            ▼
                                            返回结果      返回结果
```

**任务状态管理**（`gP` 模块，即 `localAgentTasks`）：

核心状态类型为 `local_agent`，具备以下状态字段：

```
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

**清理与通知**：

- `aq6()`：终止运行中的 Agent（调用 `abortController.abort()`，更新状态为 `killed`）
- `hL8()`：标记 Agent 完成（更新状态为 `completed`，存储结果）
- `SL8()`：标记 Agent 失败（更新状态为 `failed`，记录错误信息）
- `iq6()`：触发完成通知（通过 `IO()` 发送 task-notification XML 格式消息）
- `dXK()`：批量终止所有运行中的 Agent（会话退出时使用）

**资源自动回收**：每个 Agent 注册时通过 `pq()` 注册清理回调（`unregisterCleanup`），确保进程退出时 Agent 被正确终止。完成的 Agent 设置 `evictAfter` 时间戳（`Date.now() + BN8`），过期后从全局状态中移除。

### 2.8 团队协作 Swarm 模式

Swarm 是 Agent 系统的最高级编排模式，需要 tmux 支持。

#### TeamCreate

创建团队并初始化任务列表：

```javascript
// 团队配置文件结构
{
  name: "team-name",
  description: "Working on feature X",
  createdAt: Date.now(),
  leadAgentId: "...",
  leadSessionId: "...",
  members: [{
    agentId: "...",
    name: "lead",           // 使用名称寻址
    agentType: "...",
    model: "...",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    cwd: "...",
    subscriptions: []
  }]
}
```

创建流程：
1. 检查当前会话未领导其他团队
2. 生成 team 配置文件到 `~/.claude/teams/{team-name}/config.json`
3. 创建对应的任务列表目录 `~/.claude/tasks/{team-name}/`
4. 将创建者注册为团队 leader
5. 更新 `AppState.teamContext`

#### TeamDelete

清理团队资源：
1. 检查团队是否仍有活跃成员（有则拒绝删除）
2. 删除 `~/.claude/teams/{team-name}/` 目录
3. 删除 `~/.claude/tasks/{team-name}/` 目录
4. 清除 `AppState.teamContext` 和 `inbox`

#### Teammate 工作流

标准化的 Swarm 工作流：

```
1. Leader 通过 TeamCreate 创建团队
2. Leader 通过 Agent 工具（带 team_name + name 参数）生成 Teammate
   └── 每个 Teammate 在独立的 tmux pane 中运行
3. Leader 通过 TaskCreate 创建任务
4. Leader 通过 TaskUpdate（设 owner）分配任务给 Teammate
5. Teammate 执行任务，通过 TaskUpdate 标记完成
6. Teammate 每轮结束后自动进入 idle 状态
   └── idle 通知自动发送给 Leader
7. Leader 通过 SendMessage 继续指导或分配新任务
8. 完成后，Leader 通过 SendMessage 发送 {type: "shutdown_request"}
9. 所有 Teammate 关闭后，Leader 调用 TeamDelete 清理
```

**Teammate 空闲状态管理**：

Teammate 每轮结束后自动进入 idle——这是正常行为而非错误。系统在提示词中反复强调：

> Idle teammates can receive messages. Sending a message to an idle teammate wakes them up.
> Do not treat idle as an error.

这避免了 Leader Agent 误将正常的 idle 状态视为异常并采取不必要的恢复措施。

**Agent 类型选择指南**（团队模式专用提示词）：

```
- Read-only agents (e.g., Explore, Plan) cannot edit or write files.
  Only assign them research, search, or planning tasks.
- Full-capability agents (e.g., general-purpose) have access to
  all tools including file editing, writing, and bash.
- Custom agents defined in .claude/agents/ may have their own
  tool restrictions.
```

### 2.9 Hook 集成

Agent 系统与 Hook 事件系统深度集成，提供以下钩子点：

| Hook 事件 | 触发时机 | 输入 | 退出码行为 |
|-----------|---------|------|-----------|
| `SubagentStart` | 子 Agent 启动时 | `{agent_id, agent_type}` | `0`: stdout 显示给子 Agent |
| `SubagentStop` | 子 Agent 完成前 | `{agent_id, agent_type, agent_transcript_path}` | `0`: 不显示; `2`: stderr 显示给子 Agent 并继续运行 |
| `TaskCreated` | 任务创建时 | `{task_id, task_subject, task_description, teammate_name, team_name}` | 标准处理 |

Hook 回调中的 `PreToolUse`、`PostToolUse`、`PostToolUseFailure` 事件包含 `agent_id` 和 `agent_type` 字段，允许 Hook 区分工具调用来自主进程还是子 Agent。

### 2.10 自动后台化与输入阻塞检测

**UI 延迟显示**：同步 Agent 运行超过 2000ms（`Z4Y = 2000`）后，在 UI 中显示进度指示器：

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

**输入阻塞检测**：`R67()` 函数监控 Agent 输出文件，检测命令是否卡在交互式输入等待。通过定期检查文件大小是否增长，如果停滞时间超过阈值，读取最后几行输出并使用正则表达式模式匹配（`a4Y` 数组包含常见交互提示模式），匹配成功则发送通知建议使用管道输入或非交互标志。

**资源追踪**：`dw6()` 创建的计数器结构追踪每个 Agent 的：
- `toolUseCount`：工具使用次数
- `latestInputTokens`：最新输入令牌数
- `cumulativeOutputTokens`：累计输出令牌数
- `recentActivities`：最近活动记录（保留最近 5 条，`c4Y = 5`）


## 3. 演进思维实验

本节通过逐层递进的方式理解当前设计的必然性。

### Level 1（朴素方案）：单线程顺序执行

```
用户请求 ──> 主进程解析 ──> 调用 API ──> 执行工具 ──> 返回结果
                              │
                              └── 所有操作串行，一个接一个
```

**局限性**：
- 长任务（如完整的测试运行）阻塞用户交互
- 无法并行处理独立子任务（如同时搜索多个目录）
- 上下文窗口迅速被中间工具输出填满
- 复杂任务无法分解为专门角色

### Level 2（瓶颈识别）：需要并发但方式未定

试图在主进程中引入简单的并发：

```
用户请求 ──> 主进程解析 ──> Promise.all([
                              API 调用 1,
                              API 调用 2,
                              API 调用 3
                            ]) ──> 合并结果
```

**新问题**：
- 所有并发操作共享同一上下文窗口——窗口被更快耗尽
- 权限和工具状态在并发操作间产生竞态
- 失败的操作可能污染全局状态
- 无法给不同操作分配不同的模型/工具集/权限
- 一个操作的文件修改可能与另一个操作冲突

### Level 3（当前方案）：进程级隔离 + 消息传递

```
用户请求 ──> 主进程（Coordinator）
                 ├──> Fork Worker A（继承上下文，研究任务）
                 ├──> Agent B（独立上下文，general-purpose 编码）
                 │       └── [worktree 隔离，独立分支]
                 ├──> Agent C（独立上下文，Explore 只读搜索）
                 └──> Teammate D（tmux pane，独立进程，通过 SendMessage 通信）
                          │
                          ├── 通过 TaskList 共享任务状态
                          ├── 通过 SendMessage 交换消息
                          └── 通过 Team Config 发现彼此
```

**当前方案的关键优势**：

| 设计决策 | 解决的问题 |
|---------|-----------|
| 进程级隔离（独立上下文窗口） | 中间输出不污染父进程上下文 |
| Fork 机制（继承上下文） | 研究任务可利用缓存，无需重新描述背景 |
| 新 Agent（独立上下文） | 零上下文启动，适合独立明确的任务 |
| Worktree 隔离 | 文件修改不与主分支冲突 |
| 异步 Agent + task-notification | 长任务不阻塞用户交互 |
| SendMessage 通信 | 代理间协调无需共享内存 |
| 内置专门类型（Explore/Plan） | 工具集约束防止误操作 |
| 自动后台化 | 平衡交互响应性与任务完成度 |
| 递归保护（fork 内禁 fork） | 防止无限递归 |

**架构层面的深层洞察**：

Agent 系统本质上是一个**用户态进程调度器**：
- `Qm8.call()` 是 `fork()` / `exec()` 系统调用的类比
- `Fm8()` / `EXK()` 是进程注册表
- `SendMessage` 是进程间通信（IPC）
- `TeamCreate` / `TeamDelete` 是进程组管理
- `AbortController` 是信号机制（SIGTERM/SIGKILL）
- `tasks` 全局状态是 `/proc` 文件系统的类比
- `evictAfter` 是僵尸进程回收


## 4. 验证策略

### 4.1 接口契约验证

Agent 系统的输入输出通过 Zod Schema 在运行时严格校验。这意味着：

- **类型安全**：任何不符合 Schema 的输入在调用前即被拒绝
- **条件字段**：Schema 的 `.omit()` 动态裁剪确保不可用参数在语法层面不存在
- **联合类型输出**：`z.union([completed, async_launched])` 强制调用方处理两种状态

### 4.2 权限系统集成

每个 Agent 的工具调用受独立的权限上下文控制：

```javascript
let c = {
  ...D.toolPermissionContext,
  mode: V.permissionMode ?? "acceptEdits"
};
let K6 = nQ(c, D.mcp.tools);  // 根据权限过滤可用工具
```

Agent 定义中的 `allowedAgentTypes` 进一步限制可以由特定权限模式下的 Agent 生成的子 Agent 类型。权限拒绝时抛出明确的错误：

```
Agent type 'X' has been denied by permission rule 'Agent(X)' from settings.
```

### 4.3 MCP 服务器依赖验证

Agent 定义可声明 `requiredMcpServers`，系统在启动 Agent 前验证这些 MCP 服务器已连接并提供工具：

```javascript
// 等待 pending 的 MCP 服务器连接（最多 30 秒）
let a = Date.now() + 30000;
while (Date.now() < a) {
  if (await R7(500), ... ) break;
}
// 验证所需的 MCP 服务器已就绪
if (!Wk8(V, w6)) {
  throw Error(`Agent '${V.agentType}' requires MCP servers matching: ...`);
}
```

### 4.4 递归与无限循环防护

多层保护机制防止 Agent 系统的递归失控：

1. **Fork 递归保护**：`FMK()` 检查消息中是否已有 `<fork_directive>` 标记
2. **Teammate 嵌套禁止**：teammate 上下文中检查 `$Y()` 并拒绝生成新 teammate
3. **验证代理强制**：连续完成 3+ 任务且无验证步骤时，系统注入提示要求生成验证 Agent（`vA8` 类型）
4. **AbortController 传播**：父进程中止时，通过 `bC()` 创建的子 AbortController 自动中止子 Agent

### 4.5 遥测与可观测性

Agent 系统通过 `d()` 函数（遥测事件发送器）发射结构化事件：

| 事件名 | 触发时机 | 包含数据 |
|--------|---------|---------|
| `tengu_agent_tool_selected` | Agent 创建时 | agent_type, model, source, is_fork, is_async |
| `tengu_agent_tool_terminated` | Agent 终止时 | agent_type, model, duration_ms, is_async, reason |
| `tengu_team_created` | 团队创建时 | team_name, teammate_count, lead_agent_type |
| `tengu_team_deleted` | 团队删除时 | team_name |
| `tengu_agent_memory_loaded` | Agent 记忆加载时 | scope, source |

### 4.6 状态一致性保证

任务状态通过 `A3()` 函数（原子状态更新器）修改，遵循"先检查后修改"模式防止竞态：

```javascript
// 典型模式：原子更新 + 状态谓词
A3(taskId, setAppState, (state) => {
  if (state.status !== "running") return state;  // 前置检查
  return { ...state, status: "completed", ... };  // 不可变更新
});
```

通知去重通过 `notified` 标志位实现——`iq6()` 中先通过 `A3()` 原子地检查并设置 `notified: true`，只有首次成功设置的调用方才执行后续通知逻辑。


## 附录 A：Agent 系统源码定位索引

以下是 `cli.js` 中 Agent 系统关键符号的行号索引（基于 16667 行版本）：

| 符号/模块 | 大致行号 | 说明 |
|-----------|---------|------|
| `Qm8`（Agent 工具定义） | ~3900-3970 | 主入口 `sq({...})` |
| `T4Y`（基础输入 Schema） | ~3806 | Zod 基础参数 |
| `v4Y`（扩展输入 Schema） | ~3806 | 增加 team/isolation 参数 |
| `xr1`（对外输入 Schema） | ~3806 | 环境条件裁剪 |
| `k4Y`（输出 Schema） | ~3806 | 联合类型 completed/async |
| `Fm8`（异步任务注册） | ~3968 | 创建 running 状态 |
| `EXK`（同步+自动后台化注册） | ~3968 | 带超时的注册 |
| `GMK`（TeamCreate 提示词） | ~3627 | 完整工作流文档 |
| `VMK`（TeamDelete 提示词） | ~3737 | 清理说明 |
| `gMK`（Fork 指令正文） | ~3755 | fork_directive 模板 |
| `FMK`（Fork 递归检测） | ~3755 | 检查消息历史 |
| `UMK`（Fork 消息构造） | ~3755 | 注入指令到消息尾部 |
| `LqY`（TeamCreate 工具） | ~3736 | sq({...}) 定义 |
| `hqY`（TeamDelete 工具） | ~3749 | sq({...}) 定义 |
| Hook 事件定义 | ~6530-6536 | SubagentStart/SubagentStop |
| `dw6`（计数器初始化） | ~3960-3975 | tokenCount/toolUseCount |
| `iq6`（完成通知） | ~3963-3972 | task-notification XML |


## 附录 B：术语表

| 术语 | 定义 |
|------|------|
| **Agent** | 拥有独立上下文窗口和工具集的子进程，执行特定任务并返回结果 |
| **Fork** | 继承父进程完整对话上下文的 Agent 分叉，省略 `subagent_type` 时触发 |
| **Teammate** | Swarm 模式下在独立 tmux pane 中运行的 Agent，通过 SendMessage 通信 |
| **Swarm** | 多 Agent 协调模式，包含 Leader + Teammates + TaskList |
| **Worktree** | Git 工作树隔离，Agent 在独立分支的独立目录副本中工作 |
| **Coordinator** | Swarm 模式中的 Leader Agent，负责任务分配和团队协调 |
| **task-notification** | Agent 完成/失败时通过 `IO()` 发送的 XML 格式通知消息 |
| **AgentDefinition** | Agent 类型的完整定义，包含类型标识、系统提示词、工具集和权限配置 |
| **ReAct 循环** | Agent 执行的核心循环——推理(Reason)、行动(Act)、观察(Observe)、重复 |
