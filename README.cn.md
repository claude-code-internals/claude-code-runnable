# Claude Code Runnable

<p align="right"><a href="./README.md">English</a> | <strong>中文</strong></p>

这是一个从 `@anthropic-ai/claude-code@2.1.88` npm 发布包（包含 `cli.js.map`）还原出来的、可构建且可运行的源代码项目。运行时使用 Bun。**不修改任何原始 `src/` 或 `vendor/` 文件。**

> 泄露出的源代码本身无法直接运行，因为缺少构建配置、类型桩、原生模块 shim 和资源文件。本仓库通过新增约 90 个文件补齐这些缺口，同时保持原始的 1,884 个源码文件不变。

![Claude Code 运行示意图](./docs/images/claude-code-runnable.png)

## 特性

- **零源码修改**：所有原始 `src/` 和 `vendor/` 文件都保持不变，所有修复都通过新增文件实现
- **完整构建系统**：`bun run build` 会生成 19.5MB 的单文件 bundle（`dist/cli.js`）
- **完整 Ink TUI**：完整的交互式终端界面可运行，行为与官方 Claude Code 一致
- **无头模式**：支持 `--print` / `--output-format`，可用于脚本和 CI
- **Feature flags**：通过 `bun:bundle` polyfill 提供编译期 flag，并集中在一个配置文件中开关
- **跨平台**：支持 macOS、Linux 和 Windows（Windows 需要 Git Bash）

## 快速开始

### 1. 安装 Bun

本项目使用 [Bun](https://bun.sh) 作为运行时。

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# macOS (Homebrew)
brew install bun

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

### 2. 安装依赖

```bash
bun install
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，并设置你的 ANTHROPIC_API_KEY
```

### 4. 运行

```bash
# 交互式 TUI 模式
bun run dev

# 无头模式（单条提示词）
bun run dev -- -p "hello" --output-format text

# 查看版本
bun run dev -- --version
# => 2.1.88-local (Claude Code)
```

### 5. 构建（可选）

```bash
bun run build
bun dist/cli.js --version
```

## 项目结构

```text
claude-code-runnable/
├── bootstrap-entry.ts      # 入口文件（设置 MACRO 全局变量 -> 导入 cli.tsx）
├── preload.ts              # Bun preload 插件（bun:bundle polyfill）
├── config/
│   └── features.ts         # Feature flag 与插件工厂的唯一配置源
├── bunfig.toml             # Bun 配置（加载 preload.ts）
├── package.json            # 依赖与脚本（dev/start/build）
├── tsconfig.json           # TypeScript 配置
├── .env.example            # 环境变量模板
├── scripts/
│   └── build.ts            # Bun build 脚本（externals + define + plugin）
├── src/                    # 还原后的原始 TS/TSX 源码（1,884 个文件）
│   ├── entrypoints/cli.tsx # 实际 CLI 入口
│   ├── stubs/              # bun-bundle.d.ts 类型声明
│   └── ...
├── vendor/                 # 4 个原生模块的 TS 绑定层
├── shims/                  # 7 个 stub 包（通过 file: 协议引用）
│   ├── @ant/claude-for-chrome-mcp/
│   ├── @ant/computer-use-mcp/
│   ├── @ant/computer-use-swift/
│   ├── @ant/computer-use-input/
│   ├── color-diff-napi/
│   ├── modifiers-napi/
│   └── url-handler-napi/
└── dist/                   # 构建产物（bun run build）
    └── cli.js              # 约 19.5MB 的单文件 bundle
```

## 相比原始源码的变化

所有变化都是**新增文件**，**不修改任何已有源码文件**。

### 根配置文件（9 个文件）

| 文件 | 作用 |
|------|------|
| `package.json` | 依赖与脚本（`dev`/`start`/`build`/`typecheck`） |
| `tsconfig.json` | 带 `bun:bundle` 路径别名的 TypeScript 配置 |
| `bunfig.toml` | Bun preload 配置 |
| `preload.ts` | 在运行时为 `bun:bundle` feature flag 提供 polyfill 的 Bun 插件 |
| `bootstrap-entry.ts` | 设置带环境变量覆盖的 `globalThis.MACRO`，然后导入 CLI |
| `config/features.ts` | Feature flag 集合与插件工厂的唯一配置源 |
| `scripts/build.ts` | 带 externals 列表与 MACRO define 的 Bun 构建脚本 |
| `.env.example` | 环境变量模板 |
| `src/stubs/bun-bundle.d.ts` | `bun:bundle` 的 TypeScript 类型声明 |

### Shim 包（7 个包，16 个文件）

这些本地 `file:` 协议包用于替代缺失的 Anthropic 内部模块和原生模块：

| 包 | 策略 |
|----|------|
| `@ant/claude-for-chrome-mcp` | 带工具目录的 MCP server stub |
| `@ant/computer-use-mcp` | 带完整类型系统与会话流程 shim（22 个工具） |
| `@ant/computer-use-swift` | 297 行 stub，在 macOS 上具备部分功能 |
| `@ant/computer-use-input` | 带平台判断的输入 API stub |
| `color-diff-napi` | 重新导出 `src/native-ts/` 中的 TypeScript 实现 |
| `modifiers-napi` | 重新导出 `vendor/` 中的 TS 绑定 |
| `url-handler-napi` | 重新导出 `vendor/` 中的 TS 绑定 |

### SDK 与类型桩（4 个文件）

| 文件 | 作用 |
|------|------|
| `src/entrypoints/sdk/coreTypes.generated.ts` | SDK 消息类型 |
| `src/entrypoints/sdk/runtimeTypes.ts` | SDK 运行时类型（15 个类型） |
| `src/entrypoints/sdk/settingsTypes.generated.ts` | SDK settings 类型 |
| `src/entrypoints/sdk/toolTypes.ts` | SDK 工具定义类型 |

### 工具桩（6 个文件）

| 文件 | 策略 |
|------|------|
| `src/tools/TungstenTool/TungstenTool.ts` | 禁用工具（`isEnabled=false`） |
| `src/tools/TungstenTool/TungstenLiveMonitor.tsx` | 返回 `null` 的 React 组件 |
| `src/tools/WorkflowTool/constants.ts` | 工具名常量 |
| `src/tools/REPLTool/REPLTool.ts` | `null` 导出（feature-gated） |
| `src/tools/SuggestBackgroundPRTool/` | `null` 导出（feature-gated） |
| `src/tools/VerifyPlanExecutionTool/` | `null` 导出（feature-gated） |

### Feature-gated 服务桩（7 个文件）

这些是编译期开关后面的 no-op 实现：

| 文件 | 对应开关 |
|------|----------|
| `src/services/compact/cachedMicrocompact.ts` | `CACHED_MICROCOMPACT` |
| `src/services/compact/snipCompact.ts` | `HISTORY_SNIP` |
| `src/services/compact/snipProjection.ts` | `HISTORY_SNIP` |
| `src/services/contextCollapse/index.ts` | `CONTEXT_COLLAPSE` |
| `src/services/contextCollapse/operations.ts` | `CONTEXT_COLLAPSE` |
| `src/services/contextCollapse/persist.ts` | `CONTEXT_COLLAPSE` |
| `src/localRecoveryCli.ts` | 独立恢复 CLI |

### 组件与命令桩（6 个文件）

| 文件 | 作用 |
|------|------|
| `src/components/agents/SnapshotUpdateDialog.tsx` | 返回 `null` 的 React 组件 |
| `src/assistant/AssistantSessionChooser.tsx` | 返回 `null` 的 React 组件 |
| `src/commands/assistant/assistant.ts` | 空 assistant 命令 |
| `src/commands/assistant/index.ts` | 重导出 barrel |
| `src/commands/agents-platform/index.ts` | 空命令数组 |
| `src/utils/protectedNamespace.ts` | 固定返回 false |

### 其他资源文件（7 个文件）

| 文件 | 作用 |
|------|------|
| `src/ink/devtools.ts` | 空模块（用于 fire-and-forget 导入） |
| `src/ink/global.d.ts` | 空环境声明 |
| `src/types/connectorText.ts` | Connector 文本块类型 |
| `src/utils/filePersistence/types.ts` | 文件持久化常量与接口 |
| `src/utils/ultraplan/prompt.txt` | 规划提示词资源 |
| `src/utils/permissions/yolo-classifier-prompts/` | 3 个分类器提示词文件 |

### Skill 文件（29 个文件）

| 目录 | 内容 |
|------|------|
| `src/skills/bundled/claude-api/` | 26 个文件：API 使用示例（Python、Go、Java 等） |
| `src/skills/bundled/verify/` | 3 个文件：验证 skill |

## 已知限制

- **原生模块**（audio-capture、image-processor）没有原始 Rust/C++ 源码；当前 shim 仅提供优雅降级
- **Feature-flag 功能**（VOICE_MODE、BRIDGE_MODE、COORDINATOR_MODE 等）默认关闭；开启后可能还需要补更多 stub
- **没有测试文件**：原始 bundle 不包含测试
- **Anthropic 内部功能**（`USER_TYPE === 'ant'`）目前是空 stub（例如 REPLTool、agents-platform 等）
- **Commander v12**：为了兼容多字符短选项 `-d2e`，从 v14 降级到了 v12

## 免责声明

本仓库基于 2026-03-31 从 Anthropic npm registry 泄露的 Claude Code 源代码。所有原始源码版权归 [Anthropic](https://www.anthropic.com) 所有。仅供学习与研究使用。
