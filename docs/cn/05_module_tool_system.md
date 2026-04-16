<p align="right"><a href="../en/05_module_tool_system.md">English</a></p>

# 阶段 5：工具系统深度解剖

> 工具系统是 Claude Code 最核心的模块——它定义了 AI 与宿主环境交互的全部能力边界。从文件读写到命令执行、从代码搜索到子代理 fork、从 MCP 动态发现到定时调度，工具系统横跨约 **184 个源文件**，构成了 Claude Code 的"手"和"脚"。本章从接口契约到实现细节，逐工具深入解剖。所有分析均经由 `cli.js`（16,667 行打包产物）中的运行时代码交叉验证。


## 目录

1. [接口契约 (The Contract)](#1-接口契约-the-contract)
   - 1.1 [工具核心类型定义](#11-工具核心类型定义)
   - 1.2 [工具完整清单](#12-工具完整清单)
   - 1.3 [文件操作工具组](#13-文件操作工具组)
   - 1.4 [代码搜索工具组](#14-代码搜索工具组)
   - 1.5 [命令执行工具组](#15-命令执行工具组)
   - 1.6 [Agent 系统工具组](#16-agent-系统工具组)
   - 1.7 [任务管理工具组](#17-任务管理工具组)
   - 1.8 [计划模式工具组](#18-计划模式工具组)
   - 1.9 [Git 隔离工具组](#19-git-隔离工具组)
   - 1.10 [网络工具组](#110-网络工具组)
   - 1.11 [MCP 工具组](#111-mcp-工具组)
   - 1.12 [交互工具组](#112-交互工具组)
   - 1.13 [配置工具组](#113-配置工具组)
   - 1.14 [定时工具组](#114-定时工具组)
   - 1.15 [远程工具组](#115-远程工具组)
2. [实现机制 (The Mechanics)](#2-实现机制-the-mechanics)
   - 2.1 [工具注册流程](#21-工具注册流程)
   - 2.2 [工具执行管道](#22-工具执行管道)
   - 2.3 [工具输入验证](#23-工具输入验证)
   - 2.4 [流式工具执行](#24-流式工具执行)
   - 2.5 [钩子系统](#25-钩子系统)
   - 2.6 [结果格式化](#26-结果格式化)
   - 2.7 [BashTool 核心实现](#27-bashtool-核心实现)
   - 2.8 [FileReadTool 核心实现](#28-filereadtool-核心实现)
   - 2.9 [GrepTool 核心实现](#29-greptool-核心实现)
   - 2.10 [AgentTool 核心实现](#210-agenttool-核心实现)
3. [演进思维实验](#3-演进思维实验)
4. [验证](#4-验证)


## 1. 接口契约 (The Contract)

### 1.1 工具核心类型定义

每个工具都通过 `sq()` 工厂函数创建，该函数将工具定义对象与默认实现合并。从 `cli.js` 中反向推导出的工具接口契约如下：

```typescript
// 工具基础接口（由 sq() 工厂函数强制约束）
interface ToolDefinition {
  // === 标识 ===
  name: string;                    // 工具唯一标识，如 "Bash", "Read", "Grep"
  searchHint?: string;             // 用于 ToolSearch 延迟加载的搜索提示
  aliases?: string[];              // 工具别名

  // === 描述 ===
  description(): Promise<string>;  // 工具简短描述（供 API tool_use 使用）
  prompt(): Promise<string>;       // 详细使用提示（注入到系统提示词中）

  // === Schema ===
  inputSchema: ZodSchema;          // Zod 定义的输入参数 schema
  outputSchema?: ZodSchema;        // Zod 定义的输出 schema

  // === 生命周期方法 ===
  isEnabled(): boolean;            // 是否在当前环境下可用
  shouldDefer?: boolean;           // 是否延迟加载（仅在需要时才发送 schema）
  isConcurrencySafe(input): boolean;  // 是否可安全并发执行
  isReadOnly(input): boolean;      // 是否为只读操作
  isDestructive(input): boolean;   // 是否为破坏性操作

  // === 权限 ===
  checkPermissions(input, context): Promise<PermissionResult>;

  // === 执行 ===
  call(input, context): Promise<ToolResult>;          // 实际执行逻辑
  validateInput?(input): Promise<ValidationResult>;   // 输入验证

  // === 结果映射 ===
  mapToolResultToToolResultBlockParam(data, toolUseId): ToolResultBlock;
  toAutoClassifierInput(input): string;  // 用于自动权限分类

  // === 渲染 ===
  userFacingName(input?): string;           // UI 显示名称
  renderToolUseMessage(input): ReactNode;   // 工具调用消息渲染
  renderToolResultMessage(data): ReactNode; // 工具结果消息渲染
}
```

关键的设计观察：

- **延迟 Schema**：通过 `B6(() => L.strictObject({...}))` 模式实现惰性求值。Schema 只在首次访问时构建，避免启动时全量解析的开销。变量名 `B6` 对应源码中的 `lazy` / `lazyOnce` 语义。
- **工厂合并**：`sq()` 将用户定义与 `KJ_`（默认工具实现）合并，提供 `isEnabled: () => true`、`isConcurrencySafe: () => false`、`isReadOnly: () => false`、`isDestructive: () => false` 等默认值。
- **环境感知**：`isEnabled()` 依据当前平台（`Z1()` 返回 `"macos"` / `"linux"` / `"windows"` / `"wsl"`）和功能开关决定工具可用性。

### 1.2 工具完整清单

从 `cli.js` 中提取的工具名称常量映射：

| 变量名 | 工具名 | 功能分类 |
|---------|--------|----------|
| `Cq` | `"Read"` | 文件操作 |
| `X4` | `"Edit"` | 文件操作 |
| `tK` | `"Write"` | 文件操作 |
| `nW` | `"NotebookEdit"` | 文件操作 |
| `i9` | `"Glob"` | 代码搜索 |
| `n3` | `"Grep"` | 代码搜索 |
| `_q` | `"Bash"` | 命令执行 |
| — | `"PowerShell"` | 命令执行 |
| `v4` | `"Agent"` | Agent 系统 |
| `wD` | `"SendMessage"` | Agent 系统 |
| `TN` | `"TaskCreate"` | 任务管理 |
| `Gq6` | `"TaskGet"` | 任务管理 |
| `Tq6` | `"TaskList"` | 任务管理 |
| — | `"TaskUpdate"` | 任务管理 |
| — | `"TaskStop"` | 任务管理 |
| — | `"TaskOutput"` | 任务管理 |
| — | `"EnterPlanMode"` | 计划模式 |
| `TL` | `"ExitPlanMode"` | 计划模式 |
| — | `"EnterWorktree"` | Git 隔离 |
| — | `"ExitWorktree"` | Git 隔离 |
| `Sj` | `"WebFetch"` | 网络 |
| `$N` | `"WebSearch"` | 网络 |
| — | `"MCPTool"` | MCP |
| — | `"ListMcpResources"` | MCP |
| — | `"ReadMcpResource"` | MCP |
| — | `"AskUserQuestion"` | 交互 |
| — | `"Skill"` | 交互 |
| — | `"ToolSearch"` | 交互 |
| — | `"Config"` | 配置 |
| — | `"TodoWrite"` | 配置 |
| `xL` | `"CronCreate"` | 定时 |
| `Vq6` | `"CronDelete"` | 定时 |
| `Ro6` | `"CronList"` | 定时 |
| `_H6` | `"RemoteTrigger"` | 远程 |
| — | `"Brief"` | 远程 |

工具启用条件由环境变量、功能开关和平台检测共同决定。核心工具（Read、Write、Edit、Bash、Glob、Grep）始终启用；Task 系列工具由 `IH()` 控制；Cron 系列由 `vN()` 控制；RemoteTrigger 需要功能开关 `tengu_surreal_dali` 和 OAuth 会话。

### 1.3 文件操作工具组

#### 1.3.1 Read（文件读取）

**工具名**：`"Read"`（内部变量 `Cq`）

**描述**：从本地文件系统读取文件内容。支持文本、图片、PDF、Jupyter Notebook 等多种格式。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `file_path` | `string` | 是 | 绝对路径 |
| `offset` | `number` | 否 | 起始行号（从 0 开始） |
| `limit` | `number` | 否 | 读取行数，默认 `mc6 = 2000` |
| `pages` | `string` | 否 | PDF 页码范围，如 `"1-5"` |

**输出格式**：
- 文本文件：`cat -n` 格式，行号从 1 开始
- 图片：经 Sharp 缩放后以 base64 嵌入
- PDF：通过 `PN1()` 解析页码范围，支持 `"3"`, `"1-5"`, `"10-"` 语法
- Notebook (`.ipynb`)：渲染所有单元格及其输出

**关键行为**：
- 文件未变化检测：通过 `_T6` 常量返回 `"File unchanged since last read..."` 提示复用已有内容
- 最大读取限制：默认 2000 行（`mc6`）
- PDF 格式判断：`KT6()` 通过扩展名检测，支持 `.pdf` 扩展名
- 图片检测：`uc6()` 检查当前模型是否支持视觉（排除 `claude-3-haiku`）

**权限特性**：
- `isReadOnly()` 返回 `true`
- `isConcurrencySafe()` 返回 `true`
- `checkPermissions` 默认 `"allow"`

#### 1.3.2 Edit（文件编辑）

**工具名**：`"Edit"`（内部变量 `X4`）

**描述**：对已有文件执行精确的字符串替换操作。只发送差异部分，比完整重写更高效。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `file_path` | `string` | 是 | 绝对路径 |
| `old_string` | `string` | 是 | 要替换的原始文本 |
| `new_string` | `string` | 是 | 替换后的文本（必须与 `old_string` 不同） |
| `replace_all` | `boolean` | 否 | 是否替换所有匹配项，默认 `false` |

**关键行为**：
- 唯一性验证：`old_string` 必须在文件中唯一匹配（除非使用 `replace_all`）
- 前置读取检查：如果文件未通过 Read 工具先行读取，操作将失败
- 意外修改检测：通过 `df8` 常量 `"File has been unexpectedly modified..."` 报错
- 路径保护：`Uf8 = "/.claude/**"` 和 `Qf8 = "~/.claude/**"` 默认受保护

**权限特性**：
- `isReadOnly()` 返回 `false`
- `isDestructive()` 返回 `false`
- 需要 ask 权限或 `acceptEdits` 模式

#### 1.3.3 Write（文件写入）

**工具名**：`"Write"`（内部变量 `tK`）

**描述**：创建新文件或完整覆写已有文件。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `file_path` | `string` | 是 | 绝对路径 |
| `content` | `string` | 是 | 文件全部内容 |

**关键行为**：
- 覆写保护：覆写已有文件时，要求先通过 Read 读取
- 前置检查函数 `NJ_()` 生成的提示信息明确要求先读取
- 新文件创建无需前置读取

**权限特性**：
- `isReadOnly()` 返回 `false`
- 需要 ask 权限或 `acceptEdits` 模式
- 检查目标路径是否在允许的写入目录范围内

#### 1.3.4 NotebookEdit（Jupyter 单元格编辑）

**工具名**：`"NotebookEdit"`（内部变量 `nW`）

**描述**：编辑 Jupyter Notebook 的特定单元格。支持插入、替换和删除操作。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `notebook_path` | `string` | 是 | Notebook 文件的绝对路径 |
| `command` | `"insert" \| "replace" \| "delete"` | 是 | 操作类型 |
| `cell_number` | `number` | 是 | 目标单元格编号（从 0 开始） |
| `cell_type` | `"code" \| "markdown"` | 否 | 新单元格类型（insert/replace 时使用） |
| `new_source` | `string` | 否 | 新单元格内容 |

**关键行为**：
- 精确操作：每次只修改一个单元格，避免全量重写 Notebook 结构
- JSON 格式化：操作结果通过 `Zh7()` 函数进行 JSON 数组插入或编辑
- 保留元数据：不影响 Notebook 的 kernel 信息和其他元数据

### 1.4 代码搜索工具组

#### 1.4.1 Glob（文件模式匹配）

**工具名**：`"Glob"`（内部变量 `i9`）

**描述**：快速文件模式匹配工具，可在任意规模代码库中使用。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `pattern` | `string` | 是 | glob 模式，如 `"**/*.js"`, `"src/**/*.ts"` |
| `path` | `string` | 否 | 搜索目录，默认为当前工作目录 |

**输出格式**：匹配的文件路径列表，按修改时间排序。

**关键行为**：
- 排除列表 `QS_`：自动排除 `.git` 目录，但保留 `.claude/commands` 和 `.claude/agents`（由 `oG8()` 实现）
- 大小写处理：`Ih1()` 将模式转为小写进行匹配
- 特殊字符检测：`GG()` 检测 `*`, `?`, `[`, `]` 通配符
- 路径规范化：`oV()` 处理 `~`, `./`, `../` 和符号链接解析

**权限特性**：
- `isReadOnly()` 返回 `true`
- `isConcurrencySafe()` 返回 `true`

#### 1.4.2 Grep（正则搜索）

**工具名**：`"Grep"`（内部变量 `n3`）

**描述**：基于 vendored ripgrep 二进制的强大搜索工具，支持完整正则语法。

**输入参数**（共 15 个）：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `pattern` | `string` | 是 | 正则表达式搜索模式 |
| `path` | `string` | 否 | 搜索路径，默认当前目录 |
| `glob` | `string` | 否 | 文件过滤 glob 模式，如 `"*.js"` |
| `type` | `string` | 否 | 文件类型过滤，如 `"js"`, `"py"`, `"rust"` |
| `output_mode` | `"content" \| "files_with_matches" \| "count"` | 否 | 输出模式，默认 `"files_with_matches"` |
| `-A` | `number` | 否 | 匹配后显示的行数 |
| `-B` | `number` | 否 | 匹配前显示的行数 |
| `-C` / `context` | `number` | 否 | 上下文行数 |
| `-n` | `boolean` | 否 | 显示行号，默认 `true` |
| `-i` | `boolean` | 否 | 忽略大小写 |
| `multiline` | `boolean` | 否 | 跨行匹配模式 |
| `head_limit` | `number` | 否 | 结果数量限制，默认 250 |
| `offset` | `number` | 否 | 跳过前 N 条结果 |

**三种输出模式**：

1. **`files_with_matches`**（默认）：仅返回匹配文件路径列表，格式为 `"Found N file(s)"`
2. **`content`**：返回匹配行的具体内容，支持上下文行、行号
3. **`count`**：返回匹配计数，格式为 `"Found N total occurrences across M files."`

**关键行为**：
- 分页信息：通过 `ps1()` 函数生成分页提示 `"Showing results with pagination = ..."`
- 结果限制：`head_limit` 默认 250 防止过大输出
- 空结果处理：当匹配为 0 时返回 `"No files found"` 或 `"No matches found"`

**权限特性**：
- `isReadOnly()` 返回 `true`
- `isConcurrencySafe()` 返回 `true`

### 1.5 命令执行工具组

#### 1.5.1 Bash（Shell 命令执行）

**工具名**：`"Bash"`（内部变量 `_q`）

**描述**：在 Shell 中执行命令，支持沙箱隔离、超时控制和后台执行。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `command` | `string` | 是 | 要执行的 Shell 命令 |
| `description` | `string` | 否 | 命令用途说明 |
| `timeout` | `number` | 否 | 超时毫秒数，最大 600000（10 分钟） |
| `run_in_background` | `boolean` | 否 | 是否后台执行 |
| `dangerouslyDisableSandbox` | `boolean` | 否 | 禁用沙箱模式 |

**输出格式**：
- 正常输出：stdout 内容
- 错误处理：`"exit code N"` 前缀 + stderr 内容
- 大输出截断：超过阈值时截断并提示 `"Output too large (XMB). Full output saved to: ..."`
- 后台执行：返回 `"Background process started..."` 提示信息

**权限特性**：
- `isReadOnly()` 和 `isDestructive()` 依据命令内容分析
- 通过 `toAutoClassifierInput()` 提取命令语义供自动模式使用
- 权限行为格式 `"Bash(command_prefix:*)"` 支持通配符匹配

#### 1.5.2 PowerShell（Windows 命令执行）

**工具名**：`"PowerShell"`

**描述**：Windows 平台的命令执行工具，行为与 BashTool 类似但使用 PowerShell 引擎。

**启用条件**：仅在 `Z1() === "windows"` 时可用。

### 1.6 Agent 系统工具组

#### 1.6.1 Agent（子代理）

**工具名**：`"Agent"`（内部变量 `v4`）

**描述**：启动一个子 Agent 进程来处理复杂任务。子代理继承父代理的上下文但拥有独立的消息循环。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `prompt` | `string` | 是 | 子代理的任务提示 |
| `subagent_type` | `string` | 否 | 子代理类型（决定工具集和系统提示） |

**子代理类型**（从 `cli.js` 中提取的内建类型）：

| 类型 | 工具集 | 用途 |
|------|--------|------|
| `"general-purpose"` | 全部工具 | 通用任务 |
| `"Plan"` | 只读（无 Write/Edit/Bash） | 架构规划 |
| `"Explore"` | 只读（Read/Glob/Grep） | 代码探索 |
| `"statusline-setup"` | Read/Edit | 状态栏配置 |
| 自定义代理 | 由 `.claude/agents/` 定义 | 项目特定 |

**输出格式**：
- 正常完成：子代理返回的内容块列表
- 带 worktree：额外包含 `worktreeBranch` 信息
- 空输出：`"(Subagent completed but returned no output.)"`
- 继续对话：`"use SendMessage with to: 'agentId' to continue this agent"`

**关键行为**：
- 子代理禁用工具集通过 `disallowedTools` 配置
- Plan 代理明确禁用 `[v4, TL, X4, tK, nW]`，即 Agent、ExitPlanMode、Edit、Write、NotebookEdit
- 子代理可指定独立的 `model`、`color`、`memory`、`isolation` 等属性
- 插件代理通过 `Ui6` 惰性加载，扫描 `.claude/agents/` 目录下的 Markdown 文件

**权限特性**：
- `isConcurrencySafe()` 返回 `false`（子代理可能修改文件）
- 子代理继承父代理的权限上下文

#### 1.6.2 SendMessage（代理间消息）

**工具名**：`"SendMessage"`（内部变量 `wD`）

**描述**：向已存在的子代理发送消息，用于继续中断的代理会话。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `to` | `string` | 是 | 目标代理 ID |
| `content` | `string` | 是 | 消息内容 |

### 1.7 任务管理工具组

任务管理系统提供结构化的任务跟踪能力。所有 Task 工具通过 `IH()` 函数控制启用/禁用。

#### 1.7.1 TaskCreate（创建任务）

**工具名**：`"TaskCreate"`（内部变量 `TN`）

**描述**：创建新任务到任务列表中。当任务复杂度达到 3 步以上时应主动使用。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `subject` | `string` | 是 | 任务简短标题，祈使语气 |
| `description` | `string` | 是 | 任务详细描述 |
| `activeForm` | `string` | 否 | 进行时态标题（如 `"Running tests"`），用于 spinner 显示 |
| `metadata` | `Record<string, unknown>` | 否 | 任意元数据 |

**输出格式**：`"Task #ID created successfully: SUBJECT"`

**关键行为**：
- 新任务默认状态为 `"pending"`
- 创建后自动展开任务视图 `expandedView: "tasks"`
- 任务数据通过 `$67()` 持久化到 `~/.claude/tasks/` 目录
- 支持阻塞错误检测：`Y67(blockingError)` 处理
- 创建失败时自动清理：`vC8(cG(), id)` 回滚

**权限特性**：
- `isConcurrencySafe()` 返回 `true`
- `shouldDefer` 为 `true`

#### 1.7.2 TaskGet（获取任务）

**工具名**：`"TaskGet"`（内部变量 `Gq6`）

**描述**：通过 ID 获取任务的完整详情。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `taskId` | `string` | 是 | 任务 ID |

**输出格式**：
```
Task #ID: SUBJECT
Status: STATUS
Description: DESCRIPTION
Blocked by: #X, #Y
Blocks: #Z
```

**权限特性**：`isReadOnly()` 返回 `true`

#### 1.7.3 TaskList（列出任务）

**工具名**：`"TaskList"`（内部变量 `Tq6`）

**描述**：列出所有任务的摘要信息。

**输入参数**：空对象 `{}`

**输出格式**：
```
#1 [completed] Fix auth bug
#2 [in_progress] Implement search (agent-1) [blocked by #3]
#3 [pending] Setup database
```

**关键行为**：
- 过滤内部任务：`filter(t => !t.metadata?._internal)`
- 自动过滤已完成的阻塞关系：已完成的 `blockedBy` 任务不再显示
- 返回 `owner` 字段用于 Swarm 模式下的任务分配

**权限特性**：`isReadOnly()` 返回 `true`

#### 1.7.4 TaskUpdate（更新任务）

**工具名**：`"TaskUpdate"`

**描述**：更新任务的状态、描述或依赖关系。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `taskId` | `string` | 是 | 任务 ID |
| `status` | `"pending" \| "in_progress" \| "completed" \| "deleted"` | 否 | 新状态 |
| `subject` | `string` | 否 | 更新标题 |
| `description` | `string` | 否 | 更新描述 |
| `owner` | `string` | 否 | 指派代理 ID |
| `blocks` | `string[]` | 否 | 阻塞的任务 ID 列表 |
| `blockedBy` | `string[]` | 否 | 被阻塞的任务 ID 列表 |

**关键行为**：
- `deleted` 状态为永久删除
- 关闭 3+ 任务后无验证步骤时触发验证提醒：`"NOTE: You just closed out 3+ tasks and none of them was a verification step..."`
- 验证代理类型标识为 `vA8`

#### 1.7.5 TaskStop / TaskOutput

**TaskStop**：停止一个正在运行的任务。
**TaskOutput**：获取任务的运行输出。

两者的输出嵌套在 `<output>` / `<error>` XML 标签中：
```
<output>Task output content</output>
<error>Error message if any</error>
```

### 1.8 计划模式工具组

#### 1.8.1 EnterPlanMode

**描述**：进入计划模式。在此模式下 Claude 只能读取和分析代码，不能执行任何修改操作。

**关键提示词**：
```
REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write,
edit, or modify any files. You do NOT have access to file editing tools.
```

#### 1.8.2 ExitPlanMode

**工具名**：`"ExitPlanMode"`（内部变量 `TL`，用户显示名 `kX = "ExitPlanMode"`）

**描述**：退出计划模式，恢复完整工具集。

**输出格式**：
- 用户批准：`"User has approved the plan..."`
- 附带反馈：`"User has approved exiting plan mode. You can now proceed."`

### 1.9 Git 隔离工具组

#### 1.9.1 EnterWorktree

**描述**：在 git worktree 中创建隔离的工作环境，允许子代理在独立分支上工作而不影响主分支。

**启用条件**：`bR6()` 始终返回 `true`（worktree 模式默认启用）。

#### 1.9.2 ExitWorktree

**描述**：退出 worktree 隔离环境，回到主工作目录。

### 1.10 网络工具组

#### 1.10.1 WebFetch（URL 内容获取）

**工具名**：`"WebFetch"`（内部变量 `Sj`）

**描述**：获取 URL 内容并通过 AI 模型处理。自带 15 分钟缓存。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `url` | `string` | 是 | 完整 URL |
| `prompt` | `string` | 是 | 描述要从页面提取的信息 |

**关键行为**：
- HTTP 自动升级为 HTTPS
- HTML 转 Markdown 后处理
- 使用 "small, fast model" 进行内容摘要
- 重定向检测：跨域重定向时返回重定向 URL 让模型重新请求
- GitHub URL 优先使用 `gh` CLI（`"For GitHub URLs, prefer using the gh CLI via Bash instead"`）
- 15 分钟自清洁缓存 `"Includes a self-cleaning 15-minute cache"`

**权限特性**：
- `isReadOnly()` 返回 `true`
- 受网络限制策略影响

#### 1.10.2 WebSearch（网络搜索）

**工具名**：`"WebSearch"`（内部变量 `$N`）

**描述**：执行网络搜索并返回结果。

**关键行为**：
- 域名过滤：支持 include/block 特定网站
- 仅限美国地区：`"Web search is only available in the US"`
- 时间意识：通过 `B24()` 获取当前月份年份，强制在搜索中使用正确年份
- 必须包含来源：`"After answering the user's question, you MUST include a 'Sources:' section"`
- 日期辅助函数：`Qi6()` 返回 `"YYYY-MM-DD"` 格式，`Jk8` 对其惰性缓存

### 1.11 MCP 工具组

#### 1.11.1 MCPTool（MCP 工具调用）

**描述**：调用通过 MCP (Model Context Protocol) 协议注册的外部工具。MCP 工具以 `mcp__serverName__toolName` 格式命名。

**动态特性**：
- MCP 服务器可通过 `settings.json` 的 `mcpServers` 字段静态配置
- 也可在运行时通过 `scope: "dynamic"` 动态注册（如 Chrome In Claude 集成）
- 工具 schema 通过 MCP 协议的 `tools/list` 请求获取 `inputSchema`

#### 1.11.2 ListMcpResources

**描述**：列出 MCP 服务器提供的可用资源列表。

#### 1.11.3 ReadMcpResource

**描述**：读取指定 MCP 资源的内容。

### 1.12 交互工具组

#### 1.12.1 AskUserQuestion

**描述**：向用户提出问题并等待回答。支持 1-4 个选项的多选式问题。

#### 1.12.2 Skill（技能执行）

**描述**：在主对话中执行已注册的技能（Skill）。技能通过 `.claude/commands/` 目录中的 Markdown 文件或内建技能注册。

**已知内建技能清单**（从 `cli.js` 系统提示词中提取）：
- `commit` — 创建规范化的 git commit
- `simplify` — 审查变更代码的复用性和质量
- `loop` — 按间隔循环执行提示
- `schedule` — 管理定时远程代理
- `claude-api` — 使用 Claude API 构建应用
- `codebook` — 深度代码剖析
- `review-pr` — PR 深度解析
- 以及其他用户和插件定义的技能

#### 1.12.3 ToolSearch（延迟工具搜索）

**描述**：获取延迟加载工具的完整 schema 定义。延迟工具在启动时仅注册名称，完整参数 schema 需要通过此工具按需获取。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `query` | `string` | 是 | 搜索查询，如 `"select:Read,Edit"` 或关键词 |
| `max_results` | `number` | 否 | 最大返回数，默认 5 |

**查询语法**：
- `"select:Read,Edit,Grep"` — 按名称精确获取
- `"notebook jupyter"` — 关键词搜索
- `"+slack send"` — 名称中必须包含 "slack"，按其余词排序

### 1.13 配置工具组

#### 1.13.1 Config（设置管理）

**工具名**：在 `cli.js` 中通过 `xfw` 注册

**描述**：获取或设置 Claude Code 的配置值。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `setting` | `string` | 是 | 设置键名，如 `"theme"`, `"model"` |
| `value` | `string \| boolean \| number` | 否 | 新值，省略则获取当前值 |

**输出格式**：
- 获取：`"theme = \"dark\""`
- 设置：`"Set theme to \"dark\""`
- 错误：`"Error: Unknown setting: \"foo\""`

**支持的设置键**（部分）：
```
apiKeyHelper, installMethod, autoUpdates, theme, verbose,
preferredNotifChannel, editorMode, autoCompactEnabled,
showTurnDuration, diffTool, todoFeatureEnabled, messageIdleNotifThresholdMs,
autoConnectIde, fileCheckpointingEnabled, terminalProgressBarEnabled,
respectGitignore, voiceEnabled, remoteControlAtStartup, ...
```

**关键行为**：
- 来源区分：`CJK()` 区分 `"global"` 和项目级设置
- 嵌套键支持：通过 `.` 分隔，如 `"permissions.defaultMode"`
- 布尔值转换：自动将 `"true"` / `"false"` 字符串转为布尔值
- 枚举验证：`hm8()` 返回可选值列表
- 写入验证：`validateOnWrite` 异步验证
- 特殊处理：`voiceEnabled` 设置需要检查麦克风权限、录音能力、AI流可用性

**权限特性**：
- 获取操作：`isReadOnly()` 返回 `true`
- 设置操作：需要 ask 权限，显示 `"Set SETTING to VALUE"` 确认

#### 1.13.2 TodoWrite（任务列表文件）

**描述**：直接写入结构化的任务列表。与 Task 系列工具不同，TodoWrite 操作的是文件级别的 TODO 列表。

### 1.14 定时工具组

#### 1.14.1 CronCreate（创建定时任务）

**工具名**：`"CronCreate"`（内部变量 `xL`）

**描述**：创建基于 cron 表达式的定时或一次性任务。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `cron` | `string` | 是 | 5 字段 cron 表达式（本地时间），`"M H DoM Mon DoW"` |
| `prompt` | `string` | 是 | 每次触发时要执行的提示 |
| `recurring` | `boolean` | 否 | 循环执行（默认 `true`）。`false` 表示一次性 |
| `durable` | `boolean` | 否 | 持久化到磁盘（默认 `false`，仅内存中） |

**关键行为**：
- 最大任务数限制：`$MK = 50`
- Cron 验证：`Eo6()` 验证表达式语法
- 下次触发检查：`xV6()` 验证表达式在一年内是否有匹配
- 持久化路径：`.claude/scheduled_tasks.json`
- 自动过期：`kq6` 天后自动过期
- Teammate 限制：持久化 cron 不支持 teammate 模式（`"durable crons are not supported for teammates"`）

**输出格式**：
- 循环：`"Scheduled recurring job ID (SCHEDULE). SESSION-ONLY. Auto-expires after N days."`
- 一次性：`"Scheduled one-shot task ID (SCHEDULE). It will fire once then auto-delete."`

#### 1.14.2 CronDelete（删除定时任务）

**工具名**：`"CronDelete"`（内部变量 `Vq6`）

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | CronCreate 返回的任务 ID |

**关键行为**：
- 所有权验证：teammate 模式下只能删除自己创建的任务
- 验证错误：`"Cannot delete cron job 'ID': owned by another agent"`

#### 1.14.3 CronList（列出定时任务）

**工具名**：`"CronList"`（内部变量 `Ro6`）

**输入参数**：空对象 `{}`

**输出格式**：
```
job-1 — every 5 minutes (recurring) [session-only]: Check deploy status
job-2 — Feb 28 at 2:30pm (one-shot): Send reminder
```

**关键行为**：
- Teammate 过滤：只显示当前代理创建的任务
- 人类可读调度：`bV6()` 将 cron 表达式转为自然语言

### 1.15 远程工具组

#### 1.15.1 RemoteTrigger（远程触发器管理）

**工具名**：`"RemoteTrigger"`（内部变量 `_H6`）

**描述**：通过 claude.ai CCR (Claude Code Remote) API 管理定时远程代理触发器。OAuth 令牌由进程内自动处理，不暴露到 Shell。

**输入参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `action` | `"list" \| "get" \| "create" \| "update" \| "run"` | 是 | API 操作 |
| `trigger_id` | `string` | 否 | 触发器 ID（get/update/run 必需） |
| `body` | `Record<string, unknown>` | 否 | JSON 请求体（create/update 必需） |

**API 端点映射**：
```
list   → GET  /v1/code/triggers
get    → GET  /v1/code/triggers/{trigger_id}
create → POST /v1/code/triggers
update → POST /v1/code/triggers/{trigger_id}
run    → POST /v1/code/triggers/{trigger_id}/run
```

**关键行为**：
- API 版本：`"anthropic-beta": "ccr-triggers-2026-01-30"`
- 认证要求：`Kq().accessToken` 必须有效
- 组织 UUID：通过 `mW()` 解析
- 超时：20 秒
- 启用条件：功能开关 `tengu_surreal_dali` + OAuth 会话 `OO("allow_remote_sessions")`

**输出格式**：`"HTTP STATUS\nJSON_BODY"`

#### 1.15.2 Brief（简洁模式）

**描述**：启用/禁用简洁输出模式，影响 Claude 的回复长度和详细程度。


## 2. 实现机制 (The Mechanics)

### 2.1 工具注册流程

工具系统的注册分三个阶段：

**阶段一：静态注册（启动时）**

核心工具在模块初始化时通过 `sq()` 工厂函数创建并注册到全局工具集中。从 `cli.js` 中观察到的注册模式：

```javascript
// 阶段性惰性初始化（y() 模式）
var IY = y(() => { cf8() });           // Read 工具依赖初始化
var E2 = y(() => { IY() });            // Write 工具依赖初始化
var qM = y(() => { Z$() });            // Grep 工具依赖初始化

// 工具名称常量定义
var Cq = "Read";
var tK = "Write";
var X4 = "Edit";
var _q = "Bash";
var i9 = "Glob";
var n3 = "Grep";
var v4 = "Agent";
```

`y()` 是一个一次性惰性求值函数——传入的闭包只在首次调用时执行，之后直接返回缓存结果。这确保了依赖链的正确初始化顺序，同时避免不必要的计算。

**工具集排除机制**：

不同代理类型通过 `disallowedTools` 数组裁剪可用工具：

```javascript
// Plan 代理的禁用工具列表
Mk8 = {
  agentType: "Plan",
  disallowedTools: [v4, TL, X4, tK, nW],  // Agent, ExitPlanMode, Edit, Write, NotebookEdit
  tools: cF.tools,
  model: "inherit",
  omitClaudeMd: true,
  getSystemPrompt: () => UQ_()
};

// REPL 模式的完整工具集
Noq = new Set([Cq, tK, X4, i9, n3, _q, nW, v4]);
// 即 Read, Write, Edit, Glob, Grep, Bash, NotebookEdit, Agent
```

**阶段二：MCP 动态注册**

MCP 工具在 MCP 服务器连接建立后动态注册。以 Chrome In Claude 为例：

```javascript
function i37() {
  // Chrome 扩展的 MCP 工具列表
  let K = pc.map((Y) => `mcp__claude-in-chrome__${Y.name}`);
  
  return {
    mcpConfig: {
      [yN]: {
        type: "stdio",
        command: process.execPath,
        args: ["--claude-in-chrome-mcp"],
        scope: "dynamic"   // 动态注册标记
      }
    },
    allowedTools: K,
    systemPrompt: j17()
  };
}
```

MCP 工具的 `inputSchema` 通过 MCP 协议的 `tools/list` 响应获取，格式为标准 JSON Schema。Chrome 扩展注册了 `javascript_tool`、`tabs_context_mcp` 等浏览器交互工具。

**阶段三：延迟加载（Deferred Tools）**

标记 `shouldDefer: true` 的工具在启动时仅注册名称和搜索提示，完整 schema 通过 ToolSearch 工具按需获取。这是对 token 预算的优化——避免将不常用工具的完整 schema 注入到系统提示词中。

从系统提醒消息中可以看到延迟工具列表：
```
The following deferred tools are now available via ToolSearch:
CronCreate, CronDelete, CronList, EnterWorktree, ExitWorktree,
NotebookEdit, RemoteTrigger, TaskCreate, TaskGet, TaskList,
TaskUpdate, WebFetch, WebSearch
```

### 2.2 工具执行管道

从 `cli.js` 中反向推导出的工具执行管道包含 5 个核心步骤：

```
API 响应流 → 提取 tool_use 块 → 并行执行 → 收集结果 → 拼接 tool_result
```

**步骤 1：tool_use 块提取**

来自 Anthropic API 的 assistant 消息中的 `content` 数组被扫描，提取所有 `type === "tool_use"` 的块：

```javascript
// 从 cli.js 中提取的工具调用提取逻辑
let _ = K.content.filter((Y) => Y.type === "tool_use");
if (_.length === 0) return null;
```

**步骤 2：工具查找与输入解析**

每个 `tool_use` 块通过 `name` 字段从工具注册表中查找对应工具：

```javascript
let $ = q.tools.find((A) => 
  ("name" in A ? A.name : A.mcp_server_name) === Y.name
);

// 如果工具有 parse 方法，先解析输入
if ("parse" in $ && $.parse) A = $.parse(A);
```

MCP 工具通过 `mcp_server_name` 字段匹配，内建工具通过 `name` 字段匹配。

**步骤 3：权限检查 + 钩子执行**

在实际调用 `call()` 之前，执行权限检查和 PreToolUse 钩子。

**步骤 4：工具执行**

```javascript
let O = await $.run(A);
return { type: "tool_result", tool_use_id: Y.id, content: O };
```

**步骤 5：错误处理**

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

自定义错误类 `nX6` 允许工具返回结构化的错误内容（而非简单字符串）。

### 2.3 工具输入验证

工具输入验证通过 Zod schema 和可选的 `validateInput()` 方法进行两层验证。

**第一层：Zod Schema 验证**

所有工具的 `inputSchema` 使用 Zod 定义，通过 `B6()` 惰性构建：

```javascript
// CronCreate 工具的输入 schema 示例
MqY = B6(() => L.strictObject({
  cron: L.string().describe('Standard 5-field cron expression in local time'),
  prompt: L.string().describe('The prompt to enqueue at each fire time.'),
  recurring: BX(L.boolean().optional()).describe('true = fire on every cron match...'),
  durable: BX(L.boolean().optional()).describe('true = persist to .claude/scheduled_tasks.json...')
}));
```

`L.strictObject()` 确保不接受未定义的额外字段。`BX()` 是一个包装函数，为可选布尔值添加额外的序列化/反序列化逻辑。

**第二层：自定义验证**

部分工具实现了 `validateInput()` 方法进行业务逻辑验证：

```javascript
// CronCreate 的验证逻辑
async validateInput(q) {
  if (!Eo6(q.cron))                           // cron 语法验证
    return { result: false, message: `Invalid cron expression '${q.cron}'...`, errorCode: 1 };
  if (xV6(q.cron, Date.now()) === null)       // 未来一年内是否有匹配
    return { result: false, message: `...does not match any calendar date...`, errorCode: 2 };
  if ((await uV6()).length >= $MK)             // 最大任务数检查
    return { result: false, message: `Too many scheduled jobs (max ${$MK})...`, errorCode: 3 };
  if (q.durable && VP())                       // teammate 限制
    return { result: false, message: "durable crons are not supported for teammates", errorCode: 4 };
  return { result: true };
}
```

验证结果使用 `errorCode` 进行精确错误分类。

### 2.4 流式工具执行

工具执行支持并发和中止控制。核心机制：

**并发执行**

多个 `tool_use` 块通过 `Promise.all` 并行执行：

```javascript
return {
  role: "user",
  content: await Promise.all(_.map(async (Y) => {
    // ... 查找工具、检查权限、执行
  }))
};
```

但并非所有工具都安全并发。`isConcurrencySafe()` 返回 `false` 的工具（如 Agent、Bash）在并发执行时需要额外的协调机制。

**中止控制**

每个工具执行上下文通过 `abortController` 提供中止能力：

```javascript
signal: K.abortController?.signal  // 传入的 AbortSignal
```

当用户按下 Ctrl+C 或会话超时时，AbortController 被触发，中断进行中的工具调用。

**超时控制**

Bash 工具通过 `timeout` 参数控制最大执行时间（默认 120,000 毫秒，最大 600,000 毫秒）。RemoteTrigger 使用 20 秒超时。网络工具使用自定义超时配置。

**后台执行**

Bash 工具的 `run_in_background: true` 模式启动后台进程，立即返回并在完成时通知。这通过 Node.js 的 `child_process.spawn` 配合 `detached: true` 选项实现。

### 2.5 钩子系统

钩子系统允许用户在工具执行前后注入自定义逻辑。两种钩子类型：

**PreToolUse 钩子**

在工具的 `call()` 方法执行之前触发。可以：
- 阻止工具执行
- 修改工具输入
- 记录审计日志

**PostToolUse 钩子**

在工具执行完成后触发。可以：
- 处理工具输出
- 触发副作用
- 生成进度消息

**钩子配置格式**（在 `settings.json` 中）：

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

**匹配器语法**：
- 工具名精确匹配：`"Bash"`, `"Write"`, `"Edit"`
- 正则匹配：`"Write|Edit"`
- 通配符匹配：`"*"` 匹配所有工具

**钩子执行**：
- 输入通过 stdin 以 JSON 格式传递
- 钩子可以通过 stdout 返回修改后的输入或阻止指令
- 钩子进度消息通过 `hook_progress` 数据类型过滤：`v16(q)` 函数过滤 `data?.type !== "hook_progress"` 的消息

**工具名匹配辅助函数**：

```javascript
function g_(q, K) {
  return q.name === K || (q.aliases?.includes(K) ?? false);
}

function L5(q, K) {
  return q.find((_) => g_(_, K));
}
```

### 2.6 结果格式化

工具执行结果通过 `mapToolResultToToolResultBlockParam()` 方法转换为 API 可接受的 `tool_result` 格式：

```javascript
// 标准格式
{
  tool_use_id: K,
  type: "tool_result",
  content: "result text"
}

// 错误格式
{
  tool_use_id: K,
  type: "tool_result",
  content: "Error: message",
  is_error: true
}

// 多块格式（Agent 工具返回）
{
  tool_use_id: K,
  type: "tool_result",
  content: [
    { type: "text", text: "result text" },
    { type: "text", text: "agentId: ..." }
  ]
}
```

**结果截断**：

大输出通过 `MI1` 阈值截断，持久化完整输出到本地文件：
```
Output too large (XMB). Full output saved to: /path/to/saved/output
Preview (first 2KB): ...
```

**内容格式化特殊处理**：

- Grep 结果长行替换为 `"[Omitted long matching line]"`
- Task 工具结果包含 `"Showing results with pagination"` 提示
- Agent 工具结果包含 `agentId` 供后续 SendMessage 使用

### 2.7 BashTool 核心实现

BashTool 是整个工具系统中最复杂的单一工具，涉及命令解析、安全检查、沙箱隔离、后台执行和输出捕获。

#### 2.7.1 命令解析与安全检查

命令经过 `YC_()` 提取用于沙箱日志的标签后，进入安全检查流程。

**排除目录列表**：

```javascript
function oG8() {
  return [...QS_.filter((q) => q !== ".git"), ".claude/commands", ".claude/agents"];
}
```

默认排除 `.git` 目录的搜索，同时保留 `.claude/commands` 和 `.claude/agents` 以允许技能文件被发现。

**安全路径列表** `yn6()`：

```javascript
function yn6() {
  let q = xh1();  // homedir
  return [
    "/dev/stdout", "/dev/stderr", "/dev/null", "/dev/tty",
    "/dev/dtracehelper", "/dev/autofs_nowait",
    "/tmp/claude", "/private/tmp/claude",
    Lv.join(q, ".npm/_logs"),
    Lv.join(q, ".claude/debug")
  ];
}
```

**路径验证** `rG8()`：

检查文件路径是否在允许范围内，处理 macOS 的 `/private/tmp` 和 `/private/var` 符号链接：

```javascript
function rG8(q, K) {
  let _ = Lv.normalize(q), z = Lv.normalize(K);
  if (z === _) return false;
  // 处理 /tmp/ → /private/tmp/ 映射
  if (_.startsWith("/tmp/") && z === "/private" + _) return false;
  if (_.startsWith("/var/") && z === "/private" + _) return false;
  // 检查根目录和单级目录的危险性
  if (z === "/") return true;
  if (z.split("/").filter(Boolean).length <= 1) return true;
  // 检查父子关系
  if (_.startsWith(z + "/")) return true;
  return false;
}
```

#### 2.7.2 沙箱机制

BashTool 通过操作系统级沙箱隔离命令执行环境。

**macOS 沙箱（sandbox-exec + Seatbelt）**

macOS 使用 Apple 的 `sandbox-exec` 命令和 Seatbelt 配置文件实现隔离：

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
  
  // 生成 Seatbelt 配置
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
  
  // 构建 sandbox-exec 命令
  let v = O54.default.quote([
    "env", ...G,
    "sandbox-exec", "-p", f,   // -p 直接传入配置字符串
    T, "-c", K                  // Shell + 命令
  ]);
  
  return v;
}
```

沙箱环境变量注入：

```javascript
function aG8(z, Y) {
  let envVars = [
    "SANDBOX_RUNTIME=1",
    `TMPDIR=${process.env.CLAUDE_TMPDIR || "/tmp/claude"}`
  ];
  // 网络代理配置...
  return envVars;
}
```

**Linux 沙箱（Bubblewrap / bwrap）**

Linux 平台使用 Bubblewrap（`bwrap`）实现容器级隔离：

- 依赖检测：`bwrap` 命令必须已安装
- 辅助工具：`socat` 用于 Unix domain socket 代理
- 安全增强：可选的 seccomp BPF 过滤器（`@anthropic-ai/sandbox-runtime`）
- 降级模式：如果 seccomp 不可用，警告但不阻止执行

**沙箱配置 UI**：

```javascript
// 三种沙箱模式
options = [
  { label: "Sandbox BashTool, with auto-allow", value: "auto-allow" },
  { label: "Sandbox BashTool, with regular permissions", value: "regular" },
  { label: "No Sandbox", value: "disabled" }
];

// Override 选项
overrideOptions = [
  { label: "Allow unsandboxed fallback", value: "open" },
  { label: "Strict sandbox mode", value: "closed" }
];
```

**沙箱违规日志**：

macOS 的 `J54()` 函数监听 sandbox 日志流，捕获违规事件：

```javascript
let A = _C_("log", [
  "stream",
  "--predicate", `(eventMessage ENDSWITH "${w54}")`,
  "--style", "compact"
]);
```

#### 2.7.3 后台执行与超时控制

后台执行通过 Node.js 的 `child_process.spawn` 实现：

```javascript
// execa 封装
function m_(q, K, _) {
  let z = KL7(q, K, _);          // 解析参数
  let A = rq1.spawn(z.file, z.args, z.options);
  
  // 取消支持
  A.kill = WE7.bind(null, A.kill.bind(A));
  A.cancel = DE7.bind(null, A, H);
  
  // 超时检测
  // timedOut 标记用于区分超时和正常退出
}
```

进程树杀死（`foq` 模块）：

```javascript
// 跨平台进程树杀死
switch (process.platform) {
  case "win32":
    exec("taskkill /pid " + q + " /T /F", _);
    break;
  case "darwin":
    // 使用 pgrep -P pid 递归查找子进程
    MN1(q, z, Y, ($) => Moq("pgrep", ["-P", $]), callback);
    break;
  default:
    // 使用 ps -o pid --no-headers --ppid pid
    MN1(q, z, Y, ($) => Moq("ps", ["-o", "pid", "--no-headers", "--ppid", $]), callback);
    break;
}
```

#### 2.7.4 stdout/stderr 捕获

输出通过 execa 的 `all` 流合并 stdout 和 stderr。对大输出的处理：

- 截断阈值：超过 `MI1` 字节时触发
- 持久化存储：完整输出保存到 `~/.claude/projects/.../tool-results/` 目录
- 预览提供：显示前 2KB 内容

### 2.8 FileReadTool 核心实现

#### 2.8.1 多格式支持

FileReadTool 通过文件扩展名检测和内容分析支持多种格式：

**文本文件**：
- 使用 `cat -n` 格式输出，带行号
- 支持 `offset` 和 `limit` 参数的分段读取
- 默认读取上限 `mc6 = 2000` 行

**图片文件**：
- 通过 `uc6()` 检查模型视觉能力（排除 `claude-3-haiku`）
- 使用 Sharp 库进行缩放处理
- 以 base64 编码嵌入到 `tool_result` 中
- 支持 PNG、JPG 等常见格式

**PDF 文件**：
- 扩展名检测：`KT6()` 通过 `VJ_` 集合（`new Set(["pdf"])`）判断
- 页码解析：`PN1()` 函数解析多种格式：
  - `"3"` → 单页
  - `"1-5"` → 页码范围
  - `"10-"` → 从第 10 页到末尾
  - 验证：起始页 >= 1，结束页 >= 起始页

```javascript
function PN1(q) {
  let K = q.trim();
  if (!K) return null;
  if (K.endsWith("-")) {                  // "10-" 格式
    let $ = parseInt(K.slice(0, -1), 10);
    if (isNaN($) || $ < 1) return null;
    return { firstPage: $, lastPage: Infinity };
  }
  let _ = K.indexOf("-");
  if (_ === -1) {                         // "3" 格式
    let $ = parseInt(K, 10);
    if (isNaN($) || $ < 1) return null;
    return { firstPage: $, lastPage: $ };
  }
  let z = parseInt(K.slice(0, _), 10);    // "1-5" 格式
  let Y = parseInt(K.slice(_ + 1), 10);
  if (isNaN(z) || isNaN(Y) || z < 1 || Y < 1 || Y < z) return null;
  return { firstPage: z, lastPage: Y };
}
```

**Jupyter Notebook (`.ipynb`)**：
- 解析 JSON 格式的 notebook 结构
- 渲染所有单元格及其输出
- 支持代码、Markdown 和可视化输出

#### 2.8.2 分段读取

大文件通过 `offset` 和 `limit` 参数实现分段读取，避免一次性加载过大文件到内存：

- `offset`：起始行号（从 0 开始）
- `limit`：最大读取行数（默认 2000）
- 文件内容 token 数超过 10,000 时自动提示使用分段参数

#### 2.8.3 文件读取缓存

Read 工具实现了文件变化检测缓存：

```javascript
var _T6 = "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.";
```

当文件自上次读取以来未发生变化时，返回此提示信息而非重复读取文件内容，节省上下文 token。

#### 2.8.4 大文件处理

二进制文件和超大文件的处理策略：

```javascript
var Mp6 = 104857600;  // 100MB 最大读取限制

async function YA8(q) {
  let { size: K } = await iR5(q);
  if (K <= Mp6) return LB(await nR5(q));
  // 大文件只读取最后 100MB
  let z = Buffer.allocUnsafe(Mp6);
  let $ = K - Mp6;
  // ... 从文件末尾读取
}
```

JSON/JSONL 文件有专门的解析路径 `LB()` 和 `Ph7`（带 50 项 LRU 缓存的 JSON 解析器）。

### 2.9 GrepTool 核心实现

#### 2.9.1 Vendored ripgrep 调用

GrepTool 不使用系统安装的 `rg` 命令，而是调用项目 `vendor/` 目录下的预编译 ripgrep 二进制：

```javascript
// 依赖检测
function FVY(q) {
  return q.includes("ripgrep");  // 检测 ripgrep 是否可用
}
```

ripgrep 作为子进程调用，通过 `spawn` 启动并收集 stdout/stderr。

**错误处理**：

```javascript
// 退出码处理
if (H === 1) return [];  // 无匹配（正常）
throw Error(`ripgrep failed with exit code ${H}: ${j}`);
```

ripgrep 退出码 1 表示无匹配（不是错误），退出码 2+ 表示真正的错误。

#### 2.9.2 15 个搜索参数

GrepTool 的参数映射到 ripgrep 的命令行选项：

| Grep 参数 | ripgrep 标志 | 说明 |
|-----------|-------------|------|
| `pattern` | 位置参数 | 正则表达式 |
| `path` | 位置参数 | 搜索路径 |
| `glob` | `--glob` | 文件过滤 |
| `type` | `--type` | 文件类型 |
| `output_mode` | `-l` / `-c` / 默认 | 输出模式 |
| `-A` | `-A` | 后文行数 |
| `-B` | `-B` | 前文行数 |
| `-C` / `context` | `-C` | 上下文行数 |
| `-n` | `-n` | 行号 |
| `-i` | `-i` | 忽略大小写 |
| `multiline` | `-U --multiline-dotall` | 跨行匹配 |
| `head_limit` | 后处理截断 | 结果限制 |
| `offset` | 后处理偏移 | 分页偏移 |

#### 2.9.3 三种输出模式

**`files_with_matches` 模式**（默认）：

仅返回匹配文件的路径列表。在 ripgrep 中使用 `-l` 标志。结果格式：

```
Found 5 file(s)
path/to/file1.ts
path/to/file2.js
...
```

**`content` 模式**：

返回匹配行的具体内容，支持上下文行和行号。支持 `-A`/`-B`/`-C` 上下文参数和 `-n` 行号。

长行自动截断，替换为 `"[Omitted long matching line]"` 以避免过大输出。

**`count` 模式**：

返回匹配统计。格式：

```
Found N total occurrences across M files.
```

#### 2.9.4 结果限制与分页

```javascript
// 分页提示生成
function ps1(A, O) {
  // 生成 "Showing results with pagination = limit: N, offset: M" 格式
  // 帮助模型理解当前结果在完整结果集中的位置
}
```

默认 `head_limit` 为 250，防止单次搜索返回过多结果消耗 token 预算。`offset` 参数支持从指定位置开始返回结果。

### 2.10 AgentTool 核心实现

#### 2.10.1 子进程 fork 与生命周期

Agent 工具启动子代理作为独立的消息循环。子代理的生命周期：

1. **创建**：分配唯一 `agentId`，设置 `AbortController`
2. **初始化**：继承父代理的上下文（工作目录、权限等），但使用独立的消息历史
3. **执行**：运行独立的消息循环，直到任务完成或被中止
4. **返回**：将输出内容块返回给父代理

**子代理结果处理**：

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

**远程启动**：

Agent 也支持远程启动模式（CCR），返回格式不同：

```javascript
if (_.status === "remote_launched") {
  return {
    tool_use_id: K,
    type: "tool_result",
    content: [{ type: "text", text: "Remote agent launched in CCR." }]
  };
}
```

#### 2.10.2 系统提示词继承与定制

子代理的系统提示词通过 `getSystemPrompt()` 方法生成。不同类型的子代理有不同的系统提示词策略：

- **Plan 代理**：`UQ_()` 生成只读探索提示，明确禁止文件修改
- **Explore 代理**：`BQ_()` 生成文件搜索专家提示
- **通用代理**：继承父代理的系统提示词
- **插件代理**：使用 Markdown 文件中定义的内容，通过 `dF()` 进行路径变量替换

路径变量替换机制：

```javascript
function dF(q, K) {
  let _ = (Y) => process.platform === "win32" ? Y.replace(/\\/g, "/") : Y;
  let z = q.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => _(K.path));
  if (K.source) {
    let Y = K.source;
    z = z.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, () => _(ei(Y)));
  }
  return z;
}
```

#### 2.10.3 工具集裁剪

每种子代理类型通过 `tools` 和 `disallowedTools` 控制可用工具集：

```javascript
// Plan 代理：禁止所有修改类工具
disallowedTools: [v4, TL, X4, tK, nW]
// = [Agent, ExitPlanMode, Edit, Write, NotebookEdit]

// Explore 代理示例
tools: ["Read", "Glob", "Grep"]

// Statusline Setup 代理
tools: ["Read", "Edit"]
```

插件代理从 Markdown frontmatter 读取工具列表：

```javascript
let W = Y76(j.tools);     // 解析 tools 字段
let g = j.disallowedTools !== void 0 ? Y76(j.disallowedTools) : void 0;
```

当启用记忆功能 (`memory`) 时，自动为代理添加 Write、Edit、Read 工具以支持记忆文件操作：

```javascript
if (l3() && S && W !== void 0) {
  let F = new Set(W);
  for (let U of [tK, X4, Cq])  // Write, Edit, Read
    if (!F.has(U)) W = [...W, U];
}
```

#### 2.10.4 Agent 颜色系统

子代理在 UI 中通过颜色标识进行区分：

```javascript
var GJ = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"];

var vX = {
  red: "red_FOR_SUBAGENTS_ONLY",
  blue: "blue_FOR_SUBAGENTS_ONLY",
  // ... 后缀 _FOR_SUBAGENTS_ONLY 防止与主代理颜色混淆
};

function wr(q) {
  if (q === "general-purpose") return;
  let _ = w38().get(q);
  if (_ && GJ.includes(_)) return vX[_];
  return;
}
```


## 3. 演进思维实验

### Level 1 → Level 2：从单一工具到工具编排

**Level 1（当前状态）**：每个工具是独立的函数调用。模型通过多轮对话串联工具调用来完成复杂任务。工具之间没有内建的数据传递管道——模型必须手动从上一次 `tool_result` 中提取信息并传入下一次 `tool_use`。

**Level 2 推演**：引入工具编排层（Tool Orchestration Layer）。

设想一个 `ToolPipeline` 原语：

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

这将允许模型在单次 `tool_use` 中表达多步操作链，减少对话轮次。例如：`Grep → Read → Edit` 可以合并为一次"搜索并替换"操作。

**收益**：减少 API 调用轮次 40-60%；降低上下文窗口消耗；减少中间结果序列化开销。

**风险**：增加权限审计复杂度——管道中的每一步都需要独立的权限检查。需要引入"事务性回滚"机制以应对管道中间步骤失败的情况。

### Level 2 → Level 3：从 CLI 工具到运行时平台

**Level 2（假设已实现）**：工具编排层使复杂操作链成为原子操作。但工具仍然是"请求-响应"模式，每次调用都是无状态的。

**Level 3 推演**：将工具系统升级为有状态运行时。

核心变革：

1. **工具会话（Tool Session）**：Bash 工具维持持久化的 Shell 会话而非每次都 spawn 新进程。这解决了当前"shell state does not persist between commands"的限制。

2. **文件监视器（File Watcher）**：Read/Edit/Write 工具与 inotify/FSEvents 集成，主动推送文件变化通知而非被动轮询。当 `_T6`（"File unchanged"）检测变为事件驱动时，可以实现真正的实时编辑。

3. **工具能力协商（Capability Negotiation）**：MCP 工具不再只是被动发现，而是主动声明能力并参与编排。运行时根据工具能力图自动选择最优执行路径。

4. **跨代理工具共享**：当前 Agent 工具 fork 子进程时，子代理获得独立的工具实例。Level 3 中，工具实例可以在代理间共享（如共享的文件锁管理器），通过分布式锁协议确保并发安全。

**架构影响**：

```
Level 1: Tool = function(input) → output
Level 2: Tool = Pipeline(steps) → output
Level 3: Tool = Runtime.session(capabilities) → stream<events>
```

这一演进路径将 Claude Code 从"AI 驱动的 CLI 工具"转变为"AI 原生的开发运行时"——工具不再是被动的函数调用目标，而是构成一个自适应的执行环境。

**关键挑战**：

- 状态管理复杂度爆炸：有状态工具需要序列化/恢复能力
- 安全边界模糊：共享工具实例需要细粒度的访问控制
- 调试难度增加：事件驱动模式下的因果关系追踪


## 4. 验证

### 4.1 工具名称验证

以下工具名称常量已在 `cli.js` 中直接验证：

| 变量 | 值 | 验证行号 |
|------|-----|---------|
| `Cq` | `"Read"` | 行 533（`var Cq="Read"`） |
| `tK` | `"Write"` | 行 540（`var tK="Write"`） |
| `X4` | `"Edit"` | 行 520（`var X4="Edit"`） |
| `_q` | `"Bash"` | 行 510（`var _q="Bash"`） |
| `i9` | `"Glob"` | 行 540（`var i9="Glob"`） |
| `n3` | `"Grep"` | 行 520（`var n3="Grep"`） |
| `nW` | `"NotebookEdit"` | 行 540（`var nW="NotebookEdit"`） |
| `Sj` | `"WebFetch"` | 行 795（`var Sj="WebFetch"`） |
| `$N` | `"WebSearch"` | 行 915 附近 |
| `TL` | `"ExitPlanMode"` | 行 1021（`var TL="ExitPlanMode"`） |
| `wD` | `"SendMessage"` | 代码搜索确认 |
| `_H6` | `"RemoteTrigger"` | 行 3615（`var _H6="RemoteTrigger"`） |

### 4.2 工具接口验证

`sq()` 工厂函数的默认实现 `KJ_` 已验证包含以下默认方法：

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

### 4.3 沙箱验证

macOS 沙箱命令生成已验证核心结构：

```
env SANDBOX_RUNTIME=1 TMPDIR=/tmp/claude sandbox-exec -p <profile> bash -c <command>
```

Linux 依赖检测信息已验证：
- ripgrep：`"ripgrep (rg): found/not found"`
- bubblewrap：`"bubblewrap (bwrap): installed/not installed"`
- socat：`"socat: installed/not installed"`
- seccomp：`"seccomp filter: installed/not installed"`

### 4.4 版本验证

```
VERSION: "2.1.88"
BUILD_TIME: "2026-03-30T21:59:52Z"
```

### 4.5 工具计数交叉验证

从代码中提取的工具名称常量和工具定义数量：

- 核心内建工具：约 30 个（含 Task/Cron/Remote 系列）
- MCP 动态工具：数量不定（取决于配置的 MCP 服务器）
- 插件代理工具：数量不定（取决于 `.claude/agents/` 目录）
- Chrome 浏览器工具：`pc` 数组中定义的 MCP 工具集

工具启用的判断函数已验证：
- Task 系列：`IH()` 控制
- Cron 系列：`vN()` 控制
- RemoteTrigger：`g8("tengu_surreal_dali", false) && OO("allow_remote_sessions")` 双重检查
- WebSearch：地区限制 + 功能开关
- Worktree：`bR6()` 始终返回 `true`

### 4.6 关键数据结构验证

**Cron 限制**：`$MK = 50`（最大定时任务数）

**文件读取限制**：`mc6 = 2000`（默认最大行数），`Mp6 = 104857600`（100MB 大文件阈值）

**JSON 解析缓存**：`Ph7` 使用 50 项 LRU 缓存，解析阈值 `rR5 = 8192` 字节。

**Grep 默认限制**：`head_limit` 默认 250 条结果。


> **源文件路径**：`/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js`（16,667 行打包产物）
> **工具系统覆盖范围**：约 184 个源文件（通过 Source Map 反向推导）
> **分析版本**：v2.1.88，构建时间 2026-03-30T21:59:52Z
