<p align="right"><a href="../en/05_module_context.md">English</a></p>

# 阶段 5：上下文与内存管理深度解剖

> 本章深度剖析 Claude Code 的上下文构建、对话压缩、会话内存和多层缓存系统。上下文与内存管理是 Claude Code 处理长对话的关键模块，横跨 40+ 个源文件，承担着"让 AI 在有限窗口内保持最大信息密度"的核心使命。所有分析均基于 Source Map 反向推导的源文件路径与 `cli.js` 运行时代码交叉验证。


## 目录

1. [接口契约与源文件矩阵](#1-接口契约与源文件矩阵)
   - 1.1 [模块全景图](#11-模块全景图)
   - 1.2 [核心源文件清单](#12-核心源文件清单)
   - 1.3 [辅助源文件清单](#13-辅助源文件清单)
2. [上下文构建系统](#2-上下文构建系统)
   - 2.1 [系统上下文构建 — context.ts](#21-系统上下文构建--contextts)
   - 2.2 [CLAUDE.md 加载层级 — claudemd.ts](#22-claudemd-加载层级--claudemdts)
   - 2.3 [Team Memory 同步](#23-team-memory-同步)
   - 2.4 [上下文分析与可视化](#24-上下文分析与可视化)
3. [三级上下文压缩策略](#3-三级上下文压缩策略)
   - 3.1 [Auto Compact — 自动压缩](#31-auto-compact--自动压缩)
   - 3.2 [Session Memory Compact — 会话内存压缩](#32-session-memory-compact--会话内存压缩)
   - 3.3 [Micro Compact — 微型压缩](#33-micro-compact--微型压缩)
   - 3.4 [手动 / 部分压缩](#34-手动--部分压缩)
   - 3.5 [压缩后清理与状态重置](#35-压缩后清理与状态重置)
4. [会话内存系统](#4-会话内存系统)
   - 4.1 [Session Memory 服务](#41-session-memory-服务)
   - 4.2 [内存模板结构](#42-内存模板结构)
   - 4.3 [内存令牌预算管理](#43-内存令牌预算管理)
   - 4.4 [Auto Memory 与 Auto Dream](#44-auto-memory-与-auto-dream)
5. [Prompt 缓存系统](#5-prompt-缓存系统)
   - 5.1 [Anthropic API 缓存机制](#51-anthropic-api-缓存机制)
   - 5.2 [缓存中断检测 — promptCacheBreakDetection.ts](#52-缓存中断检测--promptcachebreakdetectionts)
   - 5.3 [工具搜索与延迟加载](#53-工具搜索与延迟加载)
6. [对话历史管理](#6-对话历史管理)
   - 6.1 [历史序列化与存储 — history.ts](#61-历史序列化与存储--historyts)
   - 6.2 [会话继续 — sessionHistory.ts](#62-会话继续--sessionhistoryts)
7. [多层应用缓存](#7-多层应用缓存)
8. [演进思维实验](#8-演进思维实验)
9. [验证矩阵](#9-验证矩阵)


## 1. 接口契约与源文件矩阵

### 1.1 模块全景图

```
                         ┌─────────────────────────────────┐
                         │     API Request / Response      │
                         └──────────┬──────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
              ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
              │  Prompt    │  │  Context   │  │  Tool     │
              │  Cache     │  │  Builder   │  │  Search   │
              │  Control   │  │            │  │  Defer    │
              └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
                    │               │               │
                    └───────────────┤               │
                                    │               │
              ┌─────────────────────▼───────────────▼────┐
              │            Context Window                │
              │   (200K / 1M tokens)                     │
              │                                          │
              │  ┌──────────┐ ┌─────────┐ ┌──────────┐  │
              │  │ System   │ │ Memory  │ │ Messages │  │
              │  │ Prompt   │ │ Files   │ │          │  │
              │  └──────────┘ └─────────┘ └──────────┘  │
              └──────────┬───────────────────────────────┘
                         │
           ┌─────────────┼─────────────┐
           │             │             │
     ┌─────▼──────┐ ┌───▼────┐ ┌──────▼──────┐
     │ Auto       │ │ Session│ │ Micro       │
     │ Compact    │ │ Memory │ │ Compact     │
     │            │ │ Compact│ │             │
     └────────────┘ └────────┘ └─────────────┘
```

### 1.2 核心源文件清单

| 源文件（Source Map 路径） | 行数(估) | 职责 |
|---|---|---|
| `src/context.ts` | ~190 | 系统上下文构建入口，memoize 缓存 |
| `src/utils/context.ts` | ~120 | 底层上下文工具函数 |
| `src/utils/claudemd.ts` | ~250 | CLAUDE.md 多层级加载与解析 |
| `src/services/compact/compact.ts` | ~450 | 主压缩引擎——`LE6()` 函数实现 |
| `src/services/compact/autoCompact.ts` | ~180 | 自动压缩触发判定与阈值计算 |
| `src/services/compact/sessionMemoryCompact.ts` | ~250 | 基于会话内存的轻量压缩路径 |
| `src/services/compact/microCompact.ts` | ~150 | 时间间隔触发的工具结果微型清理 |
| `src/services/compact/apiMicrocompact.ts` | ~100 | API 级微压缩 |
| `src/services/compact/prompt.ts` | ~200 | 压缩提示词模板 |
| `src/services/compact/grouping.ts` | ~100 | 消息分组逻辑 |
| `src/services/compact/compactWarningState.ts` | ~60 | 压缩警告状态管理 |
| `src/services/compact/compactWarningHook.ts` | ~80 | 压缩警告 React Hook |
| `src/services/compact/timeBasedMCConfig.ts` | ~40 | 时间触发微压缩配置 |
| `src/services/compact/postCompactCleanup.ts` | ~80 | 压缩后清理逻辑 |
| `src/services/SessionMemory/sessionMemory.ts` | ~300 | 会话内存核心服务 |
| `src/services/SessionMemory/sessionMemoryUtils.ts` | ~150 | 会话内存工具函数 |
| `src/services/SessionMemory/prompts.ts` | ~200 | 会话内存更新提示词 |
| `src/services/api/promptCacheBreakDetection.ts` | ~120 | 缓存中断检测 |
| `src/history.ts` | ~350 | 对话历史序列化与存储 |
| `src/assistant/sessionHistory.ts` | ~100 | 会话历史恢复 |

### 1.3 辅助源文件清单

| 源文件 | 职责 |
|---|---|
| `src/utils/cachePaths.ts` | 缓存路径管理（统一所有缓存文件的存储位置） |
| `src/utils/fileReadCache.ts` | 文件读取缓存（LRU，避免重复读取） |
| `src/utils/fileStateCache.ts` | 文件状态缓存 |
| `src/utils/completionCache.ts` | 补全缓存 |
| `src/utils/toolSchemaCache.ts` | 工具 Schema 缓存 |
| `src/utils/statsCache.ts` | 统计数据缓存 |
| `src/utils/contextAnalysis.ts` | 上下文分析算法 |
| `src/utils/analyzeContext.ts` | 上下文分析入口 |
| `src/utils/contextSuggestions.ts` | 上下文优化建议 |
| `src/utils/memoryFileDetection.ts` | 内存文件自动检测 |
| `src/utils/memory/types.ts` | 内存类型定义 |
| `src/utils/memory/versions.ts` | 内存版本管理 |
| `src/utils/teamMemoryOps.ts` | 团队内存操作 |
| `src/utils/model/contextWindowUpgradeCheck.ts` | 上下文窗口升级检查 |
| `src/ink/line-width-cache.ts` | UI 行宽缓存 |
| `src/ink/node-cache.ts` | UI 节点缓存 |
| `src/commands/compact/compact.ts` | `/compact` 命令入口 |
| `src/commands/compact/index.ts` | 命令注册 |
| `src/commands/context/context.tsx` | `/context` 命令入口 |
| `src/commands/context/context-noninteractive.ts` | 非交互式上下文分析 |
| `src/commands/memory/memory.tsx` | `/memory` 命令入口 |
| `src/commands/memory/index.ts` | 命令注册 |
| `src/commands/clear/caches.ts` | 缓存清理命令 |
| `src/commands/break-cache/index.js` | 缓存中断命令 |
| `src/components/ContextVisualization.tsx` | 上下文可视化组件 |
| `src/components/ContextSuggestions.tsx` | 上下文建议组件 |
| `src/components/CompactSummary.tsx` | 压缩摘要显示组件 |
| `src/components/messages/CompactBoundaryMessage.tsx` | 压缩边界消息组件 |
| `src/components/messages/UserMemoryInputMessage.tsx` | 用户内存消息组件 |
| `src/components/memory/MemoryFileSelector.tsx` | 内存文件选择器 |
| `src/components/memory/MemoryUpdateNotification.tsx` | 内存更新通知 |
| `src/components/MemoryUsageIndicator.tsx` | 内存使用量指示器 |
| `src/hooks/useMemoryUsage.ts` | 内存使用量 Hook |
| `src/services/teamMemorySync/types.ts` | 团队内存类型 |
| `src/services/teamMemorySync/index.ts` | 团队内存同步入口 |
| `src/services/teamMemorySync/watcher.ts` | 团队内存变更监视 |
| `src/services/teamMemorySync/secretScanner.ts` | 团队内存密钥扫描 |
| `src/services/teamMemorySync/teamMemSecretGuard.ts` | 团队内存安全守卫 |
| `src/memdir/memoryTypes.ts` | 内存目录类型 |
| `src/memdir/memoryScan.ts` | 内存目录扫描 |
| `src/memdir/memoryAge.ts` | 内存老化策略 |
| `src/tools/AgentTool/agentMemory.ts` | Agent 内存 |
| `src/tools/AgentTool/agentMemorySnapshot.ts` | Agent 内存快照 |
| `src/utils/plugins/zipCache.ts` | 插件 ZIP 缓存 |
| `src/utils/plugins/zipCacheAdapters.ts` | ZIP 缓存适配器 |
| `src/utils/plugins/cacheUtils.ts` | 插件缓存工具 |
| `src/utils/queryContext.ts` | 查询上下文 |
| `src/utils/workloadContext.ts` | 工作负载上下文 |
| `src/utils/agentContext.ts` | Agent 上下文 |
| `src/utils/teammateContext.ts` | Teammate 上下文 |


## 2. 上下文构建系统

### 2.1 系统上下文构建 — context.ts

系统上下文是每次 API 请求附带的环境信息。`context.ts` 和 `src/utils/context.ts` 共同完成上下文构建，并通过 memoize 缓存避免重复计算。

**核心函数**：

| 函数 | 职责 | 缓存策略 |
|---|---|---|
| `getGitStatus()` | 获取 Git 分支、状态、最近提交信息 | memoize（单次会话内） |
| `getUserContext()` | 用户级上下文（OS、Shell、工作目录等） | memoize |
| `getSystemContext()` | 系统级上下文（平台、版本等） | memoize |
| `getSystemPromptInjection()` | 获取系统提示词注入内容 | 全局变量 |
| `setSystemPromptInjection()` | 设置系统提示词注入内容 | 全局变量 |

**上下文信息组成**（经 `cli.js` 验证）：

```
System Context
├── 身份声明
│   └── "You are Claude Code, Anthropic's official CLI for Claude."
├── Git 状态
│   ├── 当前分支名
│   ├── 工作树状态（修改/暂存文件）
│   └── 最近提交记录
├── 工作目录
│   ├── 绝对路径
│   └── 附加目录（/add-dir 添加的）
├── 用户配置快照
│   ├── OS / 平台 / Shell
│   └── 语言偏好
├── CLAUDE.md 内容（详见 2.2）
├── Team Memory 内容（详见 2.3）
└── 权限规则摘要
```

**身份声明变体**（`src/services/api/` 中的 `uf8()` 函数）：

```typescript
// 交互式模式（默认）
"You are Claude Code, Anthropic's official CLI for Claude."

// SDK 非交互模式 + 有 appendSystemPrompt
"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."

// SDK 非交互模式 + 无 appendSystemPrompt
"You are a Claude agent, built on Anthropic's Claude Agent SDK."
```

### 2.2 CLAUDE.md 加载层级 — claudemd.ts

CLAUDE.md 是项目级配置文件，为 Claude 提供项目上下文、自定义指令和编码规范。系统按层级加载并合并多个 CLAUDE.md 文件。

**加载路径函数 `l$6()`**（经 `cli.js` 验证）：

```typescript
function l$6(type: string): string {
  switch (type) {
    case "User":     return join(homedir(), "CLAUDE.md");        // ~/.claude/CLAUDE.md
    case "Local":    return join(projectRoot, "CLAUDE.local.md"); // 本地（不提交）
    case "Project":  return join(projectRoot, "CLAUDE.md");       // 项目根目录
    case "Managed":  return join(managedDir(), "CLAUDE.md");      // 托管配置目录
    case "AutoMem":  return sessionMemoryPath();                  // 自动内存文件
  }
  return teamMemEntrypoint();                                     // 团队内存
}
```

**加载优先级与合并规则**：

| 优先级 | 类型 | 路径示例 | 用途 |
|---|---|---|---|
| 1 | User | `~/.claude/CLAUDE.md` | 用户全局偏好（所有项目生效） |
| 2 | Managed | `~/.claude/.managed/CLAUDE.md` | 组织/MDM 托管的规则 |
| 3 | Project | `<project>/CLAUDE.md` | 项目级指令（提交到 Git） |
| 4 | Local | `<project>/CLAUDE.local.md` | 本地指令（不提交，在 .gitignore 中） |
| 5 | AutoMem | `~/.claude/projects/.../session-memory/...` | 自动内存（会话生成） |
| 6 | TeamMem | 通过 Team Memory Sync 获取 | 团队共享内存 |

**子目录 CLAUDE.md**：Claude 在工作于项目子目录时会自动加载该子目录中的 CLAUDE.md，实现模块级指令隔离（尤其适用于 Monorepo）。

**外部包含安全**：当 CLAUDE.md 通过 `@include` 或类似机制引用外部文件时，系统会弹出安全确认对话框（`ClaudeMdExternalIncludesDialog.tsx`），确保用户明确授权。相关配置项：
- `hasClaudeMdExternalIncludesApproved`: 是否已批准外部包含
- `hasClaudeMdExternalIncludesWarningShown`: 是否已显示警告

**Rules 目录**：除 CLAUDE.md 外，还支持 Rules 目录下的规则文件：
- `~/.claude/rules/` — 用户全局规则
- `<project>/.claude/rules/` — 项目级规则

### 2.3 Team Memory 同步

Team Memory 是跨团队共享的上下文信息，通过同步服务管理。

**源文件**：

| 文件 | 职责 |
|---|---|
| `src/services/teamMemorySync/index.ts` | 团队内存同步入口 |
| `src/services/teamMemorySync/watcher.ts` | 文件变更监视器 |
| `src/services/teamMemorySync/types.ts` | 类型定义 |
| `src/services/teamMemorySync/secretScanner.ts` | 密钥扫描器 |
| `src/services/teamMemorySync/teamMemSecretGuard.ts` | 安全守卫 |
| `src/utils/teamMemoryOps.ts` | 团队内存操作函数 |

**注入到系统提示词的格式**（`cli.js` 验证）：

```xml
<team-memory-content source="shared">
  ... 团队内存内容 ...
</team-memory-content>
```

**安全机制**：Team Memory 内容在写入前会经过 `secretScanner` 扫描，防止 API Key、Token 等敏感信息泄露。相关遥测事件：
- `tengu_team_mem_sync_pull` — 拉取团队内存
- `tengu_team_mem_sync_push` — 推送团队内存
- `tengu_team_mem_entries_capped` — 内存条目数达上限

### 2.4 上下文分析与可视化

Claude Code 提供了完善的上下文使用量分析功能，通过 `/context` 命令触发。

**上下文窗口元数据结构**（`cli.js` 第 1166-1178 行验证）：

```typescript
interface ContextWindow {
  total_input_tokens: number;       // 会话累计输入 token
  total_output_tokens: number;      // 会话累计输出 token
  context_window_size: number;      // 当前模型窗口大小（200000 或 1000000）
  current_usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
  used_percentage: number | null;      // 已使用百分比 (0-100)
  remaining_percentage: number | null; // 剩余百分比 (0-100)
}
```

**上下文分析函数 `Up8()`**（`src/utils/analyzeContext.ts`）：

该函数执行完整的 Token 预算分析，返回分类统计：

| 分析维度 | 内容 |
|---|---|
| System prompt | 系统提示词（含身份声明、规则等） |
| System tools | 内置工具定义的 Token 占用 |
| MCP tools | MCP 工具定义的 Token 占用 |
| MCP tools (deferred) | 延迟加载的 MCP 工具 |
| System tools (deferred) | 延迟加载的系统工具 |
| Custom agents | 自定义 Agent 定义 |
| Memory files | CLAUDE.md 等内存文件 |
| Skills | Skill 定义 |
| Messages | 对话消息 |
| Autocompact buffer | 自动压缩预留空间 |
| Free space | 剩余可用空间 |

**网格可视化**（`ContextVisualization.tsx`）：

分析结果以彩色网格形式展示在终端中，每个色块代表一个分类，直观显示 Token 预算分配。网格维度根据窗口大小动态调整：
- 1M 上下文窗口：20 x 10 格
- 200K 上下文窗口：最大 10 x 10 格
- 窄终端（<80 列）：5 x 5 格


## 3. 三级上下文压缩策略

当对话历史不断增长逼近上下文窗口极限时，Claude Code 采用三级自适应压缩策略来维持对话能力。

### 3.1 Auto Compact — 自动压缩

**源文件**：`src/services/compact/autoCompact.ts`

**触发判定函数 `t3Y()`**：

自动压缩的触发基于 Token 用量与上下文窗口的比例关系。核心阈值计算逻辑（`cli.js` 验证）：

```typescript
// 有效上下文窗口 = min(模型窗口, 配置窗口) - 最大输出 Token
// 最大输出 Token 上限为 20,000
const effectiveWindow = min(modelWindowSize, configuredWindow) - maxOutputTokens;

// 自动压缩阈值 = 有效窗口 - 13,000（预留缓冲区）
const autoCompactThreshold = effectiveWindow - 13_000;

// 当 inputTokens >= autoCompactThreshold 时触发自动压缩
```

**关键常量**（`cli.js` 验证）：

| 常量 | 值 | 含义 |
|---|---|---|
| `o3Y` (maxOutputTokens cap) | 20,000 | 输出 Token 从有效窗口中扣除的上限 |
| `U87` (autoCompactBuffer) | 13,000 | 自动压缩预留缓冲区 |
| `a3Y` (warningThreshold) | 20,000 | 上下文使用警告阈值 |
| `s3Y` (errorThreshold) | 20,000 | 上下文使用错误阈值 |
| `Q87` (manualCompactBuffer) | 3,000 | 手动压缩预留缓冲区 |
| `kDK` (maxConsecutiveFailures) | 3 | 连续失败熔断次数 |

**启用条件**（`hb()` 函数）：

```
autoCompact 启用 = !(DISABLE_COMPACT) && !(DISABLE_AUTO_COMPACT) && config.autoCompactEnabled
```

可通过 `claude config set autoCompactEnabled true/false` 控制。默认启用。

**压缩执行流程**（`hWK()` → `LE6()`）：

```
1. 检查是否需要压缩（Token 用量 >= 阈值）
2. 检查 session memory compact 是否可用
   ├── 是 → 走 Session Memory Compact 路径（3.2）
   └── 否 → 走完整压缩路径
3. 完整压缩路径（LE6）：
   a. 执行 pre_compact Hook
   b. 构造压缩请求消息
   c. 尝试 Cache Sharing（如果启用 tengu_compact_cache_prefix）
      ├── 命中 → 直接使用缓存的压缩结果
      └── 未中 → 调用 API 生成摘要
   d. 处理 Prompt Too Long 重试
      ├── 截断早期消息
      └── 最多重试 3 次（qDK = 3）
   e. 恢复压缩后附件
      ├── 最近读取的文件（最多 5 个，总 50,000 token 上限）
      ├── 活跃任务状态
      ├── Plan 文件引用
      ├── 已激活的 Skill 内容
      └── 工具 Schema
   f. 生成压缩边界标记（compact_boundary）
   g. 执行 post_compact Hook
   h. 重置上下文缓存
4. 返回压缩结果
```

**压缩提示词**（`N3Y` 变量，`src/services/compact/prompt.ts`）：

系统向 Claude 发送的压缩请求使用专用的系统提示词 `"You are a helpful AI assistant tasked with summarizing conversations."`，并附带详细的分析指令：

```
1. 按时间顺序分析消息
2. 识别用户的显式请求与意图
3. 记录 Claude 的处理方式
4. 提取关键技术决策
5. 保留未完成的任务状态
```

**压缩后注入的摘要格式**（`P18()` 函数）：

```
This session is being continued from a previous conversation that ran out of context.
The summary below covers the earlier portion of the conversation.

<summary>
[... AI 生成的对话摘要 ...]
</summary>

If you need specific details from before compaction (like exact code snippets,
error messages, or content you generated), read the full transcript at: [path]

Recent messages are preserved verbatim.
```

自动压缩时会在末尾追加：`Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`

**遥测事件**：

| 事件 | 含义 |
|---|---|
| `tengu_compact` | 完成一次完整压缩 |
| `tengu_compact_failed` | 压缩失败 |
| `tengu_compact_ptl_retry` | Prompt Too Long 导致的重试 |
| `tengu_compact_cache_sharing_success` | 缓存共享命中 |
| `tengu_compact_cache_sharing_fallback` | 缓存共享回退 |
| `tengu_compact_streaming_retry` | 流式传输重试 |

### 3.2 Session Memory Compact — 会话内存压缩

**源文件**：`src/services/compact/sessionMemoryCompact.ts`

当会话内存（Session Memory）可用时，系统优先使用轻量级的会话内存压缩路径，而非完整的 API 摘要压缩。这是一种"零 API 调用"的压缩策略。

**启用条件 `pp8()`**：

```
Session Memory Compact 启用 =
  (ENABLE_CLAUDE_CODE_SM_COMPACT 环境变量 || (tengu_session_memory 功能开关 && tengu_sm_compact 功能开关))
  && !DISABLE_CLAUDE_CODE_SM_COMPACT
```

**核心参数**（`cli.js` 验证）：

```typescript
const mp8 = {
  minTokens:            10_000,    // 最小累积 Token 数才触发
  minTextBlockMessages:      5,    // 最小文本消息数才触发
  maxTokens:            40_000     // 超过此值强制触发
};
```

**压缩算法 `i3Y()`**：

```
1. 从上次压缩的摘要 ID 开始（如果存在），否则从末尾开始
2. 向前扫描消息，累积 Token 计数
3. 当满足以下任一条件时停止：
   a. 累积 tokens >= maxTokens（40K）
   b. 累积 tokens >= minTokens（10K）且文本消息数 >= 5
4. 调用 B87() 修正切割边界——确保不在工具调用-结果对中间切断
5. 保留切割点之后的消息作为 messagesToKeep
6. 用会话内存文件内容替代被切割的消息
```

**工具调用边界修正 `B87()`**：

压缩切割点不能落在工具调用与其结果之间。修正算法会：
1. 扫描保留区中引用的 `tool_use_id`
2. 向前追溯找到对应的 `tool_use` 块
3. 将切割点前移到完整的工具调用-结果对之前

**与完整压缩的对比**：

| 维度 | Session Memory Compact | Full Compact (LE6) |
|---|---|---|
| API 调用 | 无 | 需要调用 Claude API |
| 摘要来源 | 会话内存文件（已有） | 实时生成 |
| 延迟 | 极低（本地文件读取） | 较高（API 往返） |
| 摘要质量 | 取决于会话内存更新频率 | 每次新鲜生成 |
| 成本 | 零 | 消耗 API Token |
| 回退 | 阈值超限时回退到完整压缩 | - |

### 3.3 Micro Compact — 微型压缩

**源文件**：`src/services/compact/microCompact.ts`、`src/services/compact/timeBasedMCConfig.ts`

微型压缩不同于全对话摘要——它针对的是单个工具调用结果的清理，而非整体对话。

**时间触发的微压缩机制** (`Hd_()` 函数，`cli.js` 验证)：

```typescript
// 配置（通过功能开关 tengu_slate_heron 控制）
const config = {
  enabled: false,              // 默认关闭
  gapThresholdMinutes: 60,     // 对话间隔超过 60 分钟触发
  keepRecent: 5                // 保留最近 5 个工具结果
};
```

**触发条件**：
1. 功能已启用
2. 当前在主线程（非子 Agent）
3. 最后一条 assistant 消息距今超过 `gapThresholdMinutes`（默认 60 分钟）

**清理逻辑**：

```
1. 识别所有特定类型的工具调用 ID：
   - Read 工具
   - 文件编辑工具（jr 集合）
   - Bash 工具
   - Glob 工具
   - Grep 工具
   - LS 工具
   - WebFetch 工具
   - WebSearch 工具
2. 保留最近 keepRecent 个工具调用的结果
3. 将其余工具结果替换为 "[Old tool result content cleared]"
4. 清除压缩相关缓存
```

**Token 估算**：每个被清理的工具结果通过 `Cj4()` 函数估算 Token 数（文本按字符估算，图片/文档固定按 2000 token 估算）。

**遥测事件**：`tengu_time_based_microcompact`，记录间隔时长、清理数量、保留数量和节省的 Token 数。

### 3.4 手动 / 部分压缩

**源文件**：`src/services/compact/compact.ts` 中的 `zDK()` 函数

用户可以通过 `/compact` 命令手动触发压缩，并且支持指定压缩范围：

```
/compact               → 压缩全部历史
/compact [message]     → 从指定消息开始压缩（up_to 或 from）
```

**部分压缩**支持两个方向：
- `up_to`：压缩指定消息之前的所有消息，保留之后的
- `from`：压缩指定消息之后的所有消息，保留之前的

部分压缩同样调用 Claude API 生成摘要，但只对选定范围内的消息进行摘要。压缩后的附件恢复逻辑与完整压缩相同，但会排除保留区已包含的文件引用。

### 3.5 压缩后清理与状态重置

**`Hp()` 函数**（`src/services/compact/postCompactCleanup.ts`）：

压缩完成后执行一系列状态重置操作：

```
1. 清除 context memoize 缓存（bO.cache.clear）
2. 清除 compact 相关的 memoize 缓存
3. 清除 claudemd 加载缓存（La）
4. 重置上下文状态
5. 重置文件状态
6. 重置 Git 状态
7. 清除 micro compact 缓存
```

这确保压缩后的下一次 API 请求使用最新的上下文信息，而非过期的缓存。


## 4. 会话内存系统

### 4.1 Session Memory 服务

**源文件**：`src/services/SessionMemory/sessionMemory.ts`、`src/services/SessionMemory/sessionMemoryUtils.ts`

会话内存是 Claude Code 跨压缩周期保持上下文连续性的核心机制。它将对话中的关键信息提取并持久化到一个 Markdown 文件中。

**存储路径**：

```
~/.claude/projects/<project-hash>/session-memory/
├── config/
│   ├── template.md        (用户自定义模板)
│   └── prompt.md          (用户自定义更新提示词)
└── <session-id>.md        (会话内存文件)
```

**工作流**：

```
对话进行中 → 压缩触发 → 读取当前会话内存文件
→ Claude 按照模板结构更新内存内容
→ 使用 Edit 工具写回内存文件
→ 下次压缩时内存内容作为摘要注入
```

### 4.2 内存模板结构

会话内存使用固定的 Markdown 模板结构（`MDK` 变量，`cli.js` 验证）：

```markdown
# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
```

**模板更新规则**（注入给 Claude 的指令）：
1. **绝对不能**修改或删除节标题（`#` 开头的行）
2. **绝对不能**修改或删除节描述（斜体 `_..._` 行）
3. 只更新每节的实际内容
4. 写入 **详细、信息密集** 的内容——包含文件路径、函数名、错误消息、精确命令等
5. 每节限制在 ~2,000 token（`up8` 常量）
6. 始终更新 "Current State" 以反映最近的工作

### 4.3 内存令牌预算管理

**核心限制常量**（`cli.js` 验证）：

| 常量 | 值 | 含义 |
|---|---|---|
| `up8` | 2,000 | 每节最大 token 数 |
| `JDK` | 12,000 | 整个会话内存文件最大 token 数 |

**超限处理 `F3Y()`**：

```
如果整体 tokens > JDK（12,000）:
  → CRITICAL 警告：必须精简整个文件
  → 优先保留 "Current State" 和 "Errors & Corrections"

如果任何一节 tokens > up8（2,000）:
  → 列出超限的节及其 token 数
  → 要求精简
```

**内容截断保护 `GDK()`**：

当会话内存文件内容过长且无法直接由 Claude 精简时（例如在 Session Memory Compact 路径中），系统会按节截断，每节最大允许 `up8 * 4 = 8,000` token。截断后追加提示 `"Some session memory sections were truncated for length."`。

### 4.4 Auto Memory 与 Auto Dream

**配置项**（`cli.js` 验证）：

| 设置 | 类型 | 描述 |
|---|---|---|
| `autoMemoryEnabled` | settings | 启用自动内存（对话结束时自动更新会话内存） |
| `autoDreamEnabled` | settings | 启用后台内存整合（在空闲时合并和精简内存） |

这两个功能通过 `src/services/SessionMemory/sessionMemory.ts` 协调。当 `autoMemoryEnabled` 开启时，系统会在每次压缩后自动触发会话内存更新，无需用户手动调用 `/memory` 命令。

`autoDreamEnabled` 启用后台的内存整合过程，在对话空闲期间执行更深度的内存精简和合并操作。


## 5. Prompt 缓存系统

### 5.1 Anthropic API 缓存机制

Claude Code 深度利用 Anthropic API 的 Prompt Caching 功能来优化性能和成本。

**缓存控制标记 `pU()`**：

在系统提示词、CLAUDE.md 内容等关键文本块上附加 `cache_control` 标记。`cli.js` 中随处可见这种模式：

```typescript
{
  type: "text",
  text: claudeMdContent,
  cache_control: pU({ querySource: "auto_mode" })
}
```

`pU()` 函数返回的缓存控制对象包含 `{ type: "ephemeral" }`，这利用了 Anthropic API 的 Ephemeral Cache 机制：
- **TTL**：由服务端控制（通常 1 小时）
- **命中条件**：前缀匹配——只要消息的前缀部分与缓存一致，后缀的变化不会破坏缓存
- **成本优势**：缓存命中时输入 Token 价格降低约 90%

**缓存效果追踪**（API 响应中的 usage 字段）：

```typescript
interface TokenUsage {
  input_tokens: number;                   // 非缓存输入 token
  output_tokens: number;                  // 输出 token
  cache_creation_input_tokens: number;    // 本次写入缓存的 token
  cache_read_input_tokens: number;        // 本次从缓存读取的 token
}
```

**压缩时的缓存共享**（`tengu_compact_cache_prefix` 功能开关）：

当启用时，压缩请求会尝试使用缓存共享模式（`hG()` 函数），通过 `forkLabel: "compact"` 标识压缩专用的对话分支。如果缓存命中，可以跳过完整的 API 调用直接获得压缩结果，大幅降低压缩成本。

### 5.2 缓存中断检测 — promptCacheBreakDetection.ts

**源文件**：`src/services/api/promptCacheBreakDetection.ts`

当系统提示词或 CLAUDE.md 内容发生变化时，之前缓存的前缀会失效。缓存中断检测机制会：

1. 检测上下文是否发生了可能破坏缓存的变更
2. 在 `/break-cache` 命令中提供手动中断功能
3. 维护缓存有效性状态映射（`zd_` Map，TTL 3,600,000ms = 1 小时）

**相关命令**：`/break-cache` — 手动中断当前的 Prompt 缓存，强制下次 API 调用重新建立缓存前缀。

### 5.3 工具搜索与延迟加载

**源文件**：`src/utils/toolSchemaCache.ts` 与工具搜索系统

Claude Code 的工具定义占用大量 Token 预算。为此，系统实现了工具的延迟加载（Deferred Tools）机制：

**延迟加载决策 `W18()`**：

```
1. 检查模型是否支持 tool_reference 块
   └── 不支持（如 Haiku 系列）→ 禁用延迟加载
2. 检查 ToolSearchTool 是否可用
   └── 不可用 → 禁用
3. 根据 ENABLE_TOOL_SEARCH 环境变量确定模式：
   - "true" → TST 模式（始终启用）
   - "auto" 或 "auto:N" → 自动模式（基于阈值判断）
   - "false" → 标准模式（禁用）
4. 自动模式阈值计算：
   - 阈值 = 有效窗口 * (autoPercent / 100)
   - 默认 autoPercent = 10
   - 字符级回退阈值 = Token 阈值 * 2.5
```

**延迟加载流程**：
- 初始请求只发送已使用过的工具定义和少量核心工具
- 当 Claude 需要使用新工具时，通过 `tool_reference` 块请求加载
- 系统动态注入请求的工具 Schema

**延迟工具增量 `a87()`**：

通过 `deferred_tools_delta` 附件类型追踪工具加载状态的变化，确保每次 API 请求只包含必要的工具定义变更。


## 6. 对话历史管理

### 6.1 历史序列化与存储 — history.ts

**源文件**：`src/history.ts`

对话历史以 JSONL（每行一个 JSON 对象）格式持久化存储。

**存储位置**：

```
~/.claude/projects/<project-hash>/sessions/
└── <session-id>.jsonl
```

**历史管理功能**：
- 实时追加写入——每条新消息立即写入文件
- 会话恢复——通过 `--continue` / `--resume` 标志恢复
- 历史搜索——`/history-search` 命令

### 6.2 会话继续 — sessionHistory.ts

**源文件**：`src/assistant/sessionHistory.ts`

会话继续功能允许用户在新的 CLI 实例中恢复之前的对话。

**恢复流程**：
1. 读取 JSONL 历史文件
2. 反序列化所有消息
3. 如果历史过长，考虑自动触发压缩
4. 恢复文件读取状态和工具权限状态
5. 继续对话

**与 `--continue` 的区别**：
- `claude --continue`：继续最近的会话
- `claude --resume <session-id>`：继续指定的会话


## 7. 多层应用缓存

Claude Code 在应用层维护多个独立的缓存系统，每个缓存服务于不同的性能优化目标：

| 缓存 | 源文件 | 策略 | 目的 |
|---|---|---|---|
| **设置缓存** | `src/utils/settings/settingsCache.ts` | 内存 + 磁盘 | 避免频繁读取配置文件 |
| **文件读取缓存** | `src/utils/fileReadCache.ts` | LRU | 避免重复读取同一文件 |
| **文件状态缓存** | `src/utils/fileStateCache.ts` | 内存 | 追踪文件状态变化 |
| **工具 Schema 缓存** | `src/utils/toolSchemaCache.ts` | WeakMap | 避免重复序列化工具定义 |
| **补全缓存** | `src/utils/completionCache.ts` | 内存 | 缓存 Tab 补全结果 |
| **统计缓存** | `src/utils/statsCache.ts` | 内存 | 缓存统计数据 |
| **行宽缓存** | `src/ink/line-width-cache.ts` | 内存 | UI 渲染行宽计算缓存 |
| **节点缓存** | `src/ink/node-cache.ts` | 内存 | UI 节点渲染缓存 |
| **缓存路径管理** | `src/utils/cachePaths.ts` | - | 统一管理所有缓存文件的磁盘路径 |
| **插件 ZIP 缓存** | `src/utils/plugins/zipCache.ts` | 磁盘 | 插件打包缓存 |
| **同步缓存** | `src/services/remoteManagedSettings/syncCache.ts` | 磁盘 | 远程管理设置同步缓存 |
| **同步缓存状态** | `src/services/remoteManagedSettings/syncCacheState.ts` | 内存 | 同步状态追踪 |
| **Context memoize** | `src/context.ts` | memoize | 上下文构建函数结果缓存 |
| **提示词缓存有效性** | `src/services/api/promptCacheBreakDetection.ts` | Map (TTL 1h) | API 缓存中断检测 |
| **Token 计数缓存** | （内联于 analyzeContext.ts） | memoize | 工具定义 Token 计数结果 |

**缓存清理**：`/clear caches` 命令（`src/commands/clear/caches.ts`）提供统一的缓存清理入口。压缩后的 `Hp()` 函数也会自动清理相关缓存以确保一致性。


## 8. 演进思维实验

### Level 1 — 朴素方案：完整对话发送

```
用户消息 1 + AI 回复 1 + 用户消息 2 + AI 回复 2 + ... + 用户消息 N
→ 全部发送给 API
```

**致命缺陷**：
- Token 用量线性增长，很快超出上下文窗口限制（200K/1M）
- 对于使用工具的对话，工具结果可能包含数千行代码，增长更快
- API 成本与对话长度成正比

### Level 2 — 简单截断 + 滑动窗口

```
保留最近 N 条消息，丢弃更早的消息
```

**瓶颈**：
- 丢失重要的项目上下文和早期决策
- AI 可能重复已被否定的方案
- 工具调用-结果对可能在中间被截断，导致上下文不一致
- 无法处理单条超大工具输出

### Level 3 — 当前方案：三级自适应压缩 + 多层缓存 + 持久化内存

```
微型压缩（Micro Compact）
  ↓ 清理过期的大型工具结果
会话内存压缩（Session Memory Compact）
  ↓ 零 API 调用，用已有的内存文件替代早期消息
完整压缩（Full Compact via LE6）
  ↓ 调用 Claude API 生成智能摘要
  ↓ 恢复关键附件（文件、计划、技能、任务）
  ↓ 利用 Prompt Cache 降低成本
会话内存持久化
  ↓ 跨压缩周期保持关键知识
工具延迟加载
  ↓ 只发送实际需要的工具定义
```

**为什么这是最优解**：

1. **分级响应**：不同严重程度的上下文压力，用不同成本的策略应对
2. **信息保真**：AI 生成的摘要比简单截断更能保留语义信息
3. **边界感知**：工具调用-结果对不会被截断
4. **零成本路径**：Session Memory Compact 不消耗 API Token
5. **成本优化**：Prompt Cache + Cache Sharing 可将压缩成本降低 90%+
6. **熔断保护**：连续 3 次压缩失败后停止尝试，避免无限循环
7. **跨会话延续**：会话内存文件使知识在多次压缩甚至新会话中延续


## 9. 验证矩阵

以下验证点均通过 `cli.js` 运行时代码和 Source Map 交叉确认：

| 验证项 | 方法 | 结果 |
|---|---|---|
| 上下文构建函数存在 | `cli.js` 搜索 `getSystemContext`, `getUserContext` 等 | 在第 119 行确认存在（混淆后名称） |
| CLAUDE.md 五级加载路径 | `l$6()` 函数逆向分析 | User / Local / Project / Managed / AutoMem 五级确认 |
| Team Memory XML 标签格式 | `cli.js` 第 1469-1471 行 | `<team-memory-content source="shared">` 格式确认 |
| 自动压缩缓冲区 13,000 token | `U87` 常量 | 值为 13000 确认 |
| 最大输出 Token 上限 20,000 | `o3Y` 常量 | 值为 20000 确认 |
| 压缩 Prompt Too Long 最大重试 3 次 | `qDK` 常量 | 值为 3 确认 |
| 压缩连续失败熔断次数 3 | `kDK` 常量 | 值为 3 确认 |
| 会话内存每节限制 2,000 token | `up8` 常量 | 值为 2000 确认 |
| 会话内存总限制 12,000 token | `JDK` 常量 | 值为 12000 确认 |
| Session Memory Compact 阈值 | `mp8` 对象 | minTokens=10000, minTextBlockMessages=5, maxTokens=40000 确认 |
| 微压缩默认间隔 60 分钟 | `Yd_` 配置 | gapThresholdMinutes=60 确认 |
| 微压缩保留最近 5 个结果 | `Yd_` 配置 | keepRecent=5 确认 |
| 缓存控制使用 ephemeral 类型 | `pU()` 函数调用模式 | `cache_control: pU(...)` 模式遍布 `cli.js` |
| 工具搜索默认阈值 10% | `i87` 常量 | 值为 10 确认 |
| 压缩后文件恢复最多 5 个 | `eWK` 常量 | 值为 5 确认 |
| 压缩后文件恢复总 Token 上限 | `E3Y` 常量 | 值为 50000 确认 |
| 上下文窗口元数据结构 | `cli.js` 第 1166-1178 行 | 完整结构体确认 |
| 会话内存 10 节模板 | `MDK` 变量 | Session Title / Current State / Task specification 等 10 节确认 |
| autoCompactEnabled 配置项 | 配置系统 `RR6` 对象 | source="global", type="boolean" 确认 |
| autoMemoryEnabled 配置项 | 配置系统 `RR6` 对象 | source="settings", type="boolean" 确认 |
| autoDreamEnabled 配置项 | 配置系统 `RR6` 对象 | source="settings", type="boolean" 确认 |
| 压缩后清理函数 `Hp()` | `cli.js` 搜索 | 清除 memoize、claudemd、git 状态等缓存确认 |
| 对话历史 JSONL 存储 | `cli.js` 搜索 `.jsonl` | JSONL 格式确认 |
| 工具延迟加载 `tool_reference` 块 | `Jp()` 函数 | 检测 `type === "tool_reference"` 确认 |
| 已发现工具持久化跨压缩 | `iQ()` 函数 | 从 `compact_boundary` 中恢复 `preCompactDiscoveredTools` 确认 |


> **总结**：Claude Code 的上下文与内存管理是一个精心设计的多层系统——从底层的文件缓存到中层的 Token 预算管理，再到顶层的 AI 驱动压缩，每一层都有明确的职责边界和成本考量。三级压缩策略的核心设计原则是"以最小的成本保留最大的信息量"，而会话内存系统则将这种信息保留能力从单次压缩周期延伸到了整个项目生命周期。
