
# 阶段 1: 项目概述 (Foundation)

本章对 `@anthropic-ai/claude-code` 进行全面的项目级解剖，从身份定位、技术选型到每一层目录的职责，再到完整的依赖知识图谱，为后续的架构分析和模块深潜建立坚实的认知基础。


## 1. 项目身份

### 1.1 基本信息

| 属性 | 值 |
|------|-----|
| 包名 | `@anthropic-ai/claude-code` |
| 版本 | 2.1.88 |
| 作者 | Anthropic &lt;support@anthropic.com&gt; |
| 仓库 | [github.com/anthropics/claude-code](https://github.com/anthropics/claude-code) |
| 主页 | [claude.com/product/claude-code](https://claude.com/product/claude-code) |
| 文档 | [code.claude.com/docs/en/overview](https://code.claude.com/docs/en/overview) |
| 许可证 | Anthropic PBC 专有 (非开源) |
| 入口命令 | `claude` (通过 `package.json` 的 `bin` 字段映射到 `cli.js`) |
| 模块系统 | ES Module (`"type": "module"`) |
| Node.js 要求 | >= 18.0.0 |
| 构建工具 | Bun (基于 `bun.lock` 文件推断) |
| Bug 报告 | GitHub Issues 或 CLI 内置 `/bug` 命令 |

### 1.2 项目定位与核心价值

Claude Code 是 Anthropic 公司推出的**官方命令行编程助手**，它将 Claude AI 的能力直接嵌入开发者的终端工作流中。与传统的 IDE 插件或 Web 聊天界面不同，Claude Code 选择了终端作为一等公民界面，体现了"在开发者最自然的工作环境中提供 AI 能力"的设计哲学。

其核心价值主张包括：

- **代码库理解**：通过 Grep、Glob、FileRead 等工具深度理解项目结构和代码语义
- **文件编辑**：FileEdit 和 FileWrite 工具直接在磁盘上修改代码，支持精确的字符串替换和全文件写入
- **命令执行**：Bash 工具在沙箱保护下执行任意 Shell 命令，支持超时控制和后台运行
- **Git 工作流**：原生理解 Git 操作，辅助创建提交、管理分支、创建 Pull Request
- **多模态输入**：支持文本、图像（通过 Sharp 处理）和语音（通过 audio-capture 原生模块）
- **可扩展性**：通过 MCP (Model Context Protocol) 协议集成外部工具和资源
- **多平台部署**：在终端、IDE 和 GitHub (@claude 标记) 中均可使用

### 1.3 技术栈速览

```
┌─────────────────────────────────────────────────┐
│                 用户交互层                        │
│     React + Ink (终端 UI 渲染)                    │
├─────────────────────────────────────────────────┤
│                 应用逻辑层                        │
│   TypeScript (1332 .ts + 552 .tsx + 18 .js)      │
│   总计 1902 个应用源文件                           │
├─────────────────────────────────────────────────┤
│                 AI 引擎层                         │
│   @anthropic-ai/sdk (Claude API 客户端)           │
│   @anthropic-ai/bedrock-sdk (AWS Bedrock)        │
│   @anthropic-ai/vertex-sdk (Google Vertex AI)    │
│   @anthropic-ai/foundry-sdk (Azure Foundry)      │
├─────────────────────────────────────────────────┤
│                 原生模块层                        │
│   ripgrep (搜索) │ Sharp (图像) │ audio (音频)    │
├─────────────────────────────────────────────────┤
│                 运行时                            │
│          Node.js >= 18.0.0 (ES Module)           │
└─────────────────────────────────────────────────┘
```


## 2. 深度目录解剖

### 2.1 分发结构 (npm 包)

以下是通过 `npm install -g @anthropic-ai/claude-code` 安装后的实际磁盘布局：

```
@anthropic-ai/claude-code/                  # 包根目录
│
├── cli.js                  # [13.0 MB, 16667 行] 打包后的主入口
│                           # 由 Bun 将全部 TypeScript 源码 + 依赖编译为单个 ESM 文件
│                           # 包含所有业务逻辑、UI 组件、工具实现、服务层代码
│
├── cli.js.map              # [57.0 MB] Source Map 文件
│                           # 映射到 4756 个原始源文件
│                           # 其中 1902 个为应用代码 (../src/), 其余为 node_modules 依赖
│
├── package.json            # 包配置：bin 映射、引擎要求、可选依赖声明
│                           # 注意 dependencies 为空 —— 所有依赖已打包进 cli.js
│                           # 仅 optionalDependencies 中声明 9 个 @img/sharp-* 平台绑定
│
├── bun.lock                # Bun 包管理器的锁文件，记录构建时的依赖解析结果
│
├── sdk-tools.d.ts          # [2719 行] TypeScript 类型定义文件
│                           # 由 json-schema-to-typescript 自动生成
│                           # 定义了所有工具的输入/输出类型 (Agent, Bash, FileEdit 等)
│                           # 供 SDK 集成者在 TypeScript 项目中获得类型提示
│
├── README.md               # 项目说明文档
├── LICENSE.md              # 许可证 (Anthropic PBC 专有)
│
├── node_modules/           # 仅含平台特定的原生绑定
│   └── @img/
│       ├── sharp-darwin-arm64/       # macOS ARM64 的 Sharp 原生绑定
│       └── sharp-libvips-darwin-arm64/  # libvips 图像处理库原生绑定
│       # 其他平台 (linux-x64, win32-x64 等) 按需安装
│
└── vendor/                 # 预编译的原生二进制工具
    ├── audio-capture/      # 跨平台音频采集模块
    │   ├── arm64-darwin/   # macOS ARM64 (Apple Silicon)
    │   ├── x64-darwin/     # macOS x86_64 (Intel Mac)
    │   ├── arm64-linux/    # Linux ARM64
    │   ├── x64-linux/      # Linux x86_64
    │   ├── arm64-win32/    # Windows ARM64
    │   └── x64-win32/      # Windows x86_64
    │
    └── ripgrep/            # ripgrep 搜索引擎二进制
        ├── arm64-darwin/   # macOS ARM64
        ├── x64-darwin/     # macOS x86_64
        ├── arm64-linux/    # Linux ARM64
        ├── x64-linux/      # Linux x86_64
        ├── arm64-win32/    # Windows ARM64
        ├── x64-win32/      # Windows x86_64
        └── COPYING         # ripgrep 许可证 (Unlicense/MIT)
```

**关键设计决策解读：**

1. **单文件打包策略**：将全部 TypeScript 源码和约 200 个 npm 依赖打包为一个 13MB 的 `cli.js`。这意味着 `package.json` 中 `dependencies` 为空对象 `{}`。优势是安装速度极快、无依赖冲突；代价是 Source Map 高达 57MB。

2. **原生模块外置**：Sharp 图像处理和 vendor 目录中的二进制工具无法被 JavaScript 打包器处理，因此作为 `optionalDependencies` 或预编译 vendor 文件分发。每个原生模块都提供 6 个平台变体（3 操作系统 x 2 架构）。

3. **平台感知安装**：`@img/sharp-*` 声明为 `optionalDependencies`，npm 会根据当前平台仅安装匹配的变体。例如在 macOS ARM64 上只安装 `sharp-darwin-arm64`。

### 2.2 原始源码结构 (通过 Source Map 推断)

通过解析 `cli.js.map` 中的 `sources` 数组，可以还原出构建前的完整源码目录树。总计 1902 个应用源文件（1332 个 `.ts` + 552 个 `.tsx` + 18 个 `.js`）。

```
src/
│
├── entrypoints/                    # [8 文件] 应用入口点
│   ├── cli.tsx                     # CLI 主入口，处理命令行参数解析和主循环启动
│   ├── init.ts                     # 初始化流程入口 (claude init)
│   ├── mcp.ts                      # MCP 服务端模式入口 (claude mcp serve)
│   ├── sdk/
│   │   ├── coreTypes.ts            # SDK 核心类型导出
│   │   ├── coreSchemas.ts          # SDK 核心 Schema 定义
│   │   └── controlSchemas.ts       # SDK 控制层 Schema
│   ├── sandboxTypes.ts             # 沙箱环境类型定义
│   └── agentSdkTypes.ts           # Agent SDK 类型导出
│
├── main.tsx                        # [约 4684 行] 主程序文件
│                                   # 包含核心对话循环、消息处理、流式渲染
│                                   # 是整个应用最核心的业务编排文件
│
├── Tool.ts                         # 工具基类，定义工具的注册、验证、执行接口
├── Task.ts                         # 任务管理基类，定义任务生命周期
├── commands.ts                     # 命令分发器，将用户 /command 路由到处理函数
├── tools.ts                        # 工具管理器，注册和检索所有可用工具
├── context.ts                      # 上下文管理，维护对话上下文和环境信息
├── history.ts                      # 对话历史管理，持久化存储和加载
├── cost-tracker.ts                 # 成本追踪器，计算 Token 用量和费用
│
├── components/                     # [389 文件] React/Ink UI 组件库
│   # 所有终端界面元素的实现
│   # 包含消息渲染、权限对话框、任务列表、进度条、Markdown 渲染等
│   # 使用 .tsx 文件，基于 React + Ink 的声明式 UI 范式
│
├── commands/                       # [207 文件] CLI 斜杠命令
│   # /help, /bug, /commit, /review-pr, /config 等用户可触发的命令
│   # 每个命令通常由一个独立文件实现
│   # 由 commands.ts 统一注册和分发
│
├── tools/                          # [184 文件] 工具实现
│   # 每个工具对应 AI 可调用的一个能力
│   # 已知工具: Agent, Bash, FileEdit, FileRead, FileWrite,
│   #           Glob, Grep, TaskOutput, TaskStop, McpInput,
│   #           ListMcpResources, ReadMcpResource, NotebookEdit,
│   #           TodoWrite, WebFetch, WebSearch, AskUserQuestion,
│   #           Config, EnterWorktree, ExitWorktree, ExitPlanMode
│   # 工具列表来源于 sdk-tools.d.ts 中的类型定义
│
├── services/                       # [130 文件] 业务服务层
│   ├── api/                        # API 客户端 (核心文件约 3420 行)
│   │                               # 封装与 Claude API 的通信，含流式处理
│   ├── mcp/                        # MCP 协议服务
│   │                               # Model Context Protocol 客户端与服务端实现
│   ├── compact/                    # 上下文压缩服务
│   │                               # 当对话历史超出窗口时执行智能压缩
│   └── tools/                      # 工具执行管道
│                                   # 工具调用的中间件链：验证 -> 权限 -> 执行 -> 结果
│
├── hooks/                          # [104 文件] React Hooks
│   # 封装各类副作用和状态逻辑
│   # 如 costHook.ts (成本追踪)、各种 UI 状态 hooks
│
├── utils/                          # [571 文件] 工具函数库 (项目最大目录)
│   ├── permissions/                # 权限引擎核心实现
│   │                               # 规则解析、匹配算法、安全策略
│   └── ...                         # 文件操作、字符串处理、平台检测等通用工具
│
├── bridge/                         # [31 文件] Bridge 通信层
│   # 与 Web 版 Claude 的双向通信
│   # 包含 bridgeClient.ts 等核心文件
│
├── ink/                            # [96 文件] Ink 终端 UI 扩展
│   # 对 Ink 框架的定制和扩展
│   # 自定义渲染器、布局组件、主题系统
│
├── state/                          # [18 文件] 状态管理
│   # 应用全局状态的定义和管理
│   # 可能采用 React Context 或自定义状态容器
│
├── skills/                         # [20 文件] 技能/插件系统
│   # 可扩展的技能模块（如 /commit, /review-pr 等）
│   # 提供声明式的能力注册机制
│
├── platform/                       # [40 文件] 平台适配层
│   # 处理不同操作系统和环境的差异
│   # 终端能力检测、路径规范化、原生模块加载
│
├── auth/                           # [28 文件] 认证模块
│   # OAuth/API Key 认证流程
│   # 多提供商支持 (Anthropic, AWS, Google, Azure)
│
├── trace/                          # [26 文件] 追踪/遥测
│   # OpenTelemetry 集成
│   # 性能指标采集和上报
│
├── configuration/                  # [11 文件] 配置管理
│   # 多层级配置合并 (全局 -> 项目 -> 会话)
│   # settings.json 解析
│
├── context/                        # [11 文件] 上下文模块
│   # 对话上下文的高级管理
│   # Memory 文件 (.claude/MEMORY.md) 读写
│
├── tasks/                          # [12 文件] 任务模块
│   # 异步任务管理和 TodoWrite 支持
│
├── detectors/                      # [17 文件] 检测器
│   # 环境检测、项目类型识别
│   # projectOnboardingState.ts 等
│
├── export/                         # [17 文件] 导出模块
│   # 对话历史导出功能
│
├── aggregator/                     # [14 文件] 聚合器
│   # 数据聚合和汇总逻辑
│
├── keybindings/                    # [14 文件] 快捷键系统
│   # 自定义键绑定支持
│   # ~/.claude/keybindings.json 管理
│
├── cli/                            # [19 文件] CLI 基础设施
│   # 命令行参数解析
│   # 子命令路由
│
├── migrations/                     # [11 文件] 数据迁移
│   # 配置格式和数据结构的版本迁移
│
├── metrics/                        # [9 文件] 指标系统
│   # 使用量统计和性能指标
│
├── vim/                            # [5 文件] Vim 模式
│   # 终端内 Vim 键绑定支持
│
├── voice/                          # 语音输入模块
│   # 与 vendor/audio-capture 配合
│   # 语音转文本输入支持
│
├── buddy/                          # [6 文件] Buddy 系统
│   # 可能是伴随进程或辅助 Agent 机制
│
├── coordinator/                    # 协调器
│   # 多任务/多 Agent 协调
│
├── remote/                         # [4 文件] 远程功能
│   # 远程 Agent 触发和管理
│
├── screens/                        # [3 文件] 屏幕/视图
│   # 顶层 UI 屏幕定义
│
├── query/                          # [4 文件] 查询引擎
│   # QueryEngine.ts - 非交互式查询模式
│
├── outputStyles/                   # 输出样式
│   # 不同输出格式的样式定义
│
├── assistant/                      # 助手模块
│   # 助手角色相关逻辑
│
└── native-ts/                      # [4 文件] 原生 TypeScript 模块
    # 与原生绑定的 TypeScript 接口层
    # imageResize.ts, pixelCompare.ts, deniedApps.ts 等
```

### 2.3 源文件规模统计

| 目录 | 文件数 | 占比 | 主要职责 |
|------|--------|------|---------|
| `utils/` | 571 | 30.0% | 通用工具函数、权限引擎、平台工具 |
| `components/` | 389 | 20.4% | React/Ink UI 组件 |
| `commands/` | 207 | 10.9% | 斜杠命令实现 |
| `tools/` | 184 | 9.7% | AI 可调用工具 |
| `services/` | 130 | 6.8% | 业务服务 (API、MCP、压缩) |
| `hooks/` | 104 | 5.5% | React Hooks |
| `ink/` | 96 | 5.0% | Ink 框架扩展 |
| `platform/` | 40 | 2.1% | 平台适配 |
| `bridge/` | 31 | 1.6% | Web Bridge 通信 |
| 其他 | 150 | 7.9% | auth, trace, state, skills 等 |
| **总计** | **1902** | **100%** | |


## 3. 依赖知识图谱

### 3.1 核心依赖 (打包进 cli.js)

Claude Code 将所有运行时依赖打包进单个 `cli.js` 文件。通过 Source Map 分析，共识别出约 200 个 npm 包。以下按功能领域分类：

#### AI / LLM 客户端

| 库 | 文件数 | 用途 | 关键使用场景 |
|----|--------|------|-------------|
| `@anthropic-ai/sdk` | 51 | Anthropic Claude API 官方客户端 | 核心对话引擎 -- 发送消息、接收流式响应、管理对话上下文。支持 Messages API 和工具调用协议 |
| `@anthropic-ai/bedrock-sdk` | 12 | AWS Bedrock 上的 Claude 访问 | 企业用户通过 AWS Bedrock 使用 Claude，提供 AWS 认证和区域路由 |
| `@anthropic-ai/vertex-sdk` | 6 | Google Cloud Vertex AI 上的 Claude | 通过 Google Cloud 平台访问 Claude 模型 |
| `@anthropic-ai/foundry-sdk` | 9 | Azure Foundry 上的 Claude | 通过 Azure 平台访问 Claude 模型 |
| `@anthropic-ai/sandbox-runtime` | 14 | 沙箱运行时 | 为 Bash 工具提供安全的沙箱执行环境 |

#### 协议与通信

| 库 | 文件数 | 用途 | 关键使用场景 |
|----|--------|------|-------------|
| `@modelcontextprotocol/sdk` | 21 | MCP 协议官方 SDK | 实现 MCP 客户端和服务端，桥接外部工具和资源到 Claude 的工具系统中 |
| `vscode-jsonrpc` | 16 | JSON-RPC 协议实现 | MCP 通信层的底层传输协议，支持请求-响应和通知模式 |
| `ws` | 14 | WebSocket 客户端 | Bridge 通信层 -- 与 Web 版 Claude 建立实时双向连接 |
| `undici` | 96 | HTTP 客户端 (Node.js 原生) | 高性能 HTTP 请求，API 调用底层传输 |
| `axios` | 56 | HTTP 客户端 | 额外的 HTTP 请求库，可能用于特定的第三方 API 调用 |

#### UI 渲染

| 库 | 文件数 | 用途 | 关键使用场景 |
|----|--------|------|-------------|
| React + Ink | (打包) | 终端 UI 渲染框架 | 所有用户界面元素 -- 消息展示、权限授权对话框、任务列表、进度指示器。Ink 将 React 的声明式组件模型带入终端环境 |
| `highlight.js` | 193 | 语法高亮引擎 | 在终端中对代码块进行语法着色，支持数十种编程语言 |
| `chalk` | 7 | 终端颜色工具 | ANSI 颜色码封装，用于文本着色 |
| `@alcalzone/ansi-tokenize` | 7 | ANSI 序列解析 | 解析和处理终端 ANSI 转义序列 |
| `@inquirer/core` | 20 | 交互式命令行提示 | 用户输入收集、确认对话框、选择菜单 |

#### 数据处理与验证

| 库 | 文件数 | 用途 | 关键使用场景 |
|----|--------|------|-------------|
| `zod` | 77 | TypeScript-first Schema 验证 | 工具输入参数验证、API 响应校验、配置文件格式验证 |
| `zod-to-json-schema` | 27 | Zod Schema 转 JSON Schema | 将 Zod 定义的工具参数 Schema 转换为 JSON Schema 格式供 Claude API 使用 |
| `ajv` | 61 | JSON Schema 验证器 | MCP 协议消息验证、配置文件校验 |
| `ajv-formats` | 3 | AJV 格式扩展 | 扩展 JSON Schema 验证支持 (email, uri 等格式) |
| `yaml` | 72 | YAML 解析器 | 解析 YAML 格式的配置文件和 front matter |
| `jsonc-parser` | 6 | JSON with Comments 解析 | 解析 `settings.json` 等允许注释的 JSON 文件 |

#### 云平台认证 (AWS / Azure / Google)

| 库 | 文件数 | 用途 | 关键使用场景 |
|----|--------|------|-------------|
| `@aws-sdk/credential-providers` | 17 | AWS 凭证提供者 | Bedrock 模式下获取 AWS IAM 凭证 |
| `@aws-sdk/client-bedrock` | 6 | AWS Bedrock 客户端 | Bedrock API 调用 |
| `@aws-sdk/client-bedrock-runtime` | 6 | Bedrock 运行时客户端 | 模型推理请求 |
| `@aws-sdk/client-sts` | 10 | AWS STS 客户端 | 临时凭证获取 (AssumeRole) |
| `@aws-sdk/client-cognito-identity` | 6 | Cognito 身份客户端 | 身份联合认证 |
| `@aws-sdk/client-sso` | 6 | AWS SSO 客户端 | SSO 登录流程 |
| `@aws-crypto/*` | 23 | AWS 加密工具 | SHA-256、CRC32 等加密和校验 |
| `@smithy/*` | ~150 | AWS SDK 基础设施 | AWS SDK v3 的底层工具集 (HTTP、序列化、中间件) |
| `@azure/identity` | 41 | Azure 身份认证 | Azure AD 认证 (Foundry 模式) |
| `@azure/msal-node` | 48 | Microsoft 认证库 | OAuth 2.0 / OIDC 认证流程 |
| `@azure/msal-common` | 60 | MSAL 公共库 | 认证流程的共享逻辑 |
| `@azure/core-rest-pipeline` | 29 | Azure REST 管道 | HTTP 请求管道和中间件 |
| `@azure/core-client` | 15 | Azure 客户端基础 | REST API 客户端封装 |

#### 文本与文件处理

| 库 | 文件数 | 用途 | 关键使用场景 |
|----|--------|------|-------------|
| `lodash-es` | 226 | 工具函数库 | 项目中文件数最多的依赖 -- 大量使用其集合操作、对象处理、字符串工具 |
| `diff` | 7 | 文本差异计算 | FileEdit 工具的 diff 生成和显示 |
| `shell-quote` | 3 | Shell 命令解析 | 安全地解析和转义 Shell 命令字符串 |
| `parse5` | 26 | HTML 解析器 | WebFetch 工具解析网页内容 |
| `@mixmark-io/domino` | 53 | DOM 实现 | 服务端 DOM 操作，配合 HTML 解析 |
| `xss` | 5 | XSS 过滤 | 清理不可信的 HTML 内容 |
| `cssfilter` | 5 | CSS 过滤 | 清理不可信的 CSS 样式 |
| `fs-extra` | 56 | 文件系统增强 | 递归复制、移动、确保目录存在等高级文件操作 |
| `graceful-fs` | 4 | 文件系统容错 | 处理 EMFILE 等文件描述符耗尽问题 |
| `proper-lockfile` | 4 | 文件锁 | 防止并发进程同时修改配置文件 |

#### 安全与加密

| 库 | 文件数 | 用途 | 关键使用场景 |
|----|--------|------|-------------|
| `node-forge` | 42 | 加密工具库 | TLS 证书处理、加密操作 |
| `jsonwebtoken` | 12 | JWT 令牌 | OAuth 认证中的 JWT 签名和验证 |
| `jws` | 5 | JSON Web Signature | JWT 底层签名实现 |

#### 可观测性 (OpenTelemetry)

| 库 | 文件数 | 用途 | 关键使用场景 |
|----|--------|------|-------------|
| `@opentelemetry/*` | ~80 | 分布式追踪框架 | 性能追踪、指标采集、日志关联。包含 TracerProvider、MeterProvider、LoggerProvider 完整栈 |
| `@grpc/grpc-js` | ~50 | gRPC 客户端 | OpenTelemetry 数据通过 gRPC 协议上报到 OTLP 收集器 |
| `protobufjs` | ~20 | Protocol Buffers | gRPC 消息的序列化和反序列化 |

#### 其他工具

| 库 | 文件数 | 用途 | 关键使用场景 |
|----|--------|------|-------------|
| `semver` | 110 | 语义版本解析 | 版本号比较、兼容性检查、升级提示 |
| `commander` | 7 | 命令行框架 | CLI 参数定义和解析 |
| `uuid` | 32 | UUID 生成 | 会话 ID、请求 ID、Agent ID 等唯一标识符 |
| `qrcode` | 34 | 二维码生成 | OAuth 认证流程中在终端显示登录二维码 |
| `picomatch` | 6 | Glob 匹配 | 文件路径模式匹配，Glob 工具底层 |
| `execa` | 9 | 进程执行 | Bash 工具底层的子进程管理 |
| `cross-spawn` | 6 | 跨平台进程创建 | 在 Windows/macOS/Linux 上统一的进程创建接口 |
| `signal-exit` | 4 | 退出信号处理 | 确保进程退出时的清理操作 |
| `detect-libc` | 4 | C 库检测 | 检测 glibc/musl 以加载正确的原生绑定 |
| `flora-colossus` | 4 | 依赖树分析 | 分析 Node.js 模块依赖树 |
| `@growthbook/growthbook` | 6 | 功能开关/A-B 测试 | 功能灰度发布和实验控制 |
| `plist` | 3 | Apple plist 解析 | macOS 平台特定的配置文件读取 |
| `json-bigint` | 3 | 大数 JSON | 处理超出 JavaScript 安全整数范围的 JSON 数值 |

### 3.2 原生/Vendor 依赖

这些依赖不通过 npm 打包，而是以预编译二进制形式分发：

| 组件 | 位置 | 用途 | 技术细节 |
|------|------|------|---------|
| ripgrep | `vendor/ripgrep/` | 超快的正则表达式搜索引擎 | Rust 编写，性能远超 `grep`。作为 Grep 工具的底层实现，在大型代码库中实现毫秒级搜索。提供 6 个平台二进制文件 |
| Sharp | `node_modules/@img/sharp-*` | 高性能图像处理 | 基于 libvips C 库。FileRead 工具处理图片时用于缩放、格式转换、元数据提取。支持 JPEG、PNG、WebP、AVIF 等格式 |
| audio-capture | `vendor/audio-capture/` | 系统音频采集 | 平台原生音频 API 绑定。为语音输入模式提供麦克风音频流采集能力。提供 6 个平台二进制文件 |

### 3.3 依赖规模概览

| 类别 | 包数量 (约) | 说明 |
|------|------------|------|
| AI/LLM 客户端 | 5 | Anthropic 官方 SDK 家族 |
| AWS SDK 及基础设施 | ~50 | 支持 Bedrock 部署模式 |
| Azure SDK | ~10 | 支持 Foundry 部署模式 |
| OpenTelemetry | ~15 | 完整的可观测性栈 |
| gRPC/Protobuf | ~10 | OTLP 上报传输层 |
| UI 渲染 | ~10 | React, Ink, 语法高亮, 颜色 |
| 数据验证 | ~5 | Zod, AJV |
| 文本/文件处理 | ~15 | lodash, diff, parse5, fs-extra 等 |
| 安全/加密 | ~5 | node-forge, JWT |
| 通用工具 | ~30 | semver, uuid, commander 等 |
| 原生/Vendor | 3 | ripgrep, Sharp, audio-capture |
| **总计** | **~200** | 全部打包进 13MB 的 cli.js |


## 4. SDK 工具类型体系

`sdk-tools.d.ts`（2719 行）定义了 Claude Code 对外暴露的完整工具类型接口。这份自动生成的文件是理解 Claude Code 工具系统"公共 API"的权威来源。

### 4.1 工具类型联合

```typescript
export type ToolInputSchemas =
  | AgentInput          // 创建子 Agent 执行子任务
  | BashInput           // 执行 Shell 命令
  | TaskOutputInput     // 异步任务输出
  | ExitPlanModeInput   // 退出计划模式
  | FileEditInput       // 精确编辑文件内容
  | FileReadInput       // 读取文件/图像
  | FileWriteInput      // 写入完整文件
  | GlobInput           // 文件模式匹配搜索
  | GrepInput           // 正则表达式内容搜索
  | TaskStopInput       // 停止异步任务
  | ListMcpResourcesInput  // 列出 MCP 资源
  | McpInput            // 调用 MCP 工具
  | NotebookEditInput   // 编辑 Jupyter Notebook
  | ReadMcpResourceInput   // 读取 MCP 资源
  | TodoWriteInput      // 写入待办事项
  | WebFetchInput       // 获取网页内容
  | WebSearchInput      // 网络搜索
  | AskUserQuestionInput   // 向用户提问
  | ConfigInput         // 读写配置
  | EnterWorktreeInput  // 进入 Git Worktree
  | ExitWorktreeInput;  // 退出 Git Worktree
```

### 4.2 工具功能分类

| 类别 | 工具 | 说明 |
|------|------|------|
| **代码搜索** | Glob, Grep | 文件名匹配 + 内容正则搜索 |
| **文件操作** | FileRead, FileEdit, FileWrite, NotebookEdit | 读取、精确编辑、全量写入、Notebook 编辑 |
| **命令执行** | Bash | 带沙箱保护的 Shell 命令执行 |
| **子任务** | Agent, TaskOutput, TaskStop | 创建子 Agent、获取异步结果、停止任务 |
| **Web 交互** | WebFetch, WebSearch | 获取网页内容和网络搜索 |
| **MCP 扩展** | McpInput, ListMcpResources, ReadMcpResource | MCP 工具调用和资源访问 |
| **用户交互** | AskUserQuestion | 需要用户输入时主动提问 |
| **工作区管理** | EnterWorktree, ExitWorktree | Git Worktree 切换 |
| **流程控制** | ExitPlanMode, Config, TodoWrite | 计划模式退出、配置管理、待办管理 |


## 5. 构建与分发策略

### 5.1 单文件打包 (Single-file Bundle)

Claude Code 采用了极致的单文件打包策略，由 Bun 打包器（而非 webpack 或 esbuild）将 1902 个应用源文件和约 200 个 npm 依赖编译为一个 `cli.js` 文件。

**打包特征：**

- **输出格式**：ES Module (符合 `package.json` 中的 `"type": "module"`)
- **文件大小**：约 13MB (13,047,043 字节)
- **行数**：16,667 行 (高度压缩/合并)
- **Source Map**：独立的 `cli.js.map` 文件 (约 57MB)，映射到 4756 个源文件
- **Tree-shaking**：Bun 在打包时会进行摇树优化，移除未使用的代码路径

**选择 Bun 作为打包器的原因推测：**

1. Bun 的打包速度远快于 webpack，适合频繁构建发布
2. Bun 对 TypeScript 和 JSX/TSX 有原生支持，无需额外的 Babel 配置
3. Bun 的 ES Module 输出质量较高
4. Anthropic 团队可能在开发阶段也使用 Bun 作为运行时

### 5.2 发布防护

`package.json` 中包含一个发布保护脚本：

```json
"scripts": {
  "prepare": "node -e \"if (!process.env.AUTHORIZED) { ... process.exit(1); }\""
}
```

这确保只有通过官方 CI/CD 流程（设置了 `AUTHORIZED` 环境变量）才能发布新版本，防止意外的手动发布。

### 5.3 版本号语义

版本 `2.1.88` 遵循语义版本规范：
- **2** (major)：表示第 2 代主要版本，可能存在与 1.x 不兼容的变更
- **1** (minor)：功能增量
- **88** (patch)：高频的补丁发布，反映活跃的迭代节奏


## 6. 运行时环境

### 6.1 Node.js 要求

`"engines": { "node": ">=18.0.0" }` 要求 Node.js 18 或更高版本。这一选择基于：

- **ES Module 原生支持**：Node.js 18 完全支持 ESM，与项目的 `"type": "module"` 配置一致
- **Fetch API**：Node.js 18 引入了全局 `fetch()`，减少对外部 HTTP 库的依赖
- **Web Streams API**：流式 API 响应处理依赖 Node.js 18 的 ReadableStream
- **LTS 支持**：Node.js 18 是 LTS 版本，企业环境广泛部署

### 6.2 平台支持矩阵

基于 vendor 目录和 Sharp 依赖的平台变体：

| 操作系统 | 架构 | ripgrep | audio-capture | Sharp |
|---------|------|---------|---------------|-------|
| macOS | ARM64 (Apple Silicon) | ✅ | ✅ | ✅ |
| macOS | x86_64 (Intel) | ✅ | ✅ | ✅ |
| Linux | ARM64 | ✅ | ✅ | ✅ |
| Linux | x86_64 | ✅ | ✅ | ✅ |
| Linux (musl) | ARM64 | - | - | ✅ |
| Linux (musl) | x86_64 | - | - | ✅ |
| Windows | ARM64 | ✅ | ✅ | ✅ |
| Windows | x86_64 | ✅ | ✅ | ✅ |

### 6.3 文件系统布局 (运行时)

Claude Code 在运行时会创建和使用以下用户数据目录：

```
~/.claude/                    # 全局配置目录
├── settings.json             # 全局设置（权限规则、功能开关）
├── keybindings.json          # 自定义快捷键
├── MEMORY.md                 # 全局 Memory 文件（跨项目持久化知识）
├── projects/                 # 按项目组织的数据
│   └── <project-hash>/
│       ├── MEMORY.md         # 项目级 Memory 文件
│       └── sessions/         # 对话会话历史
└── credentials/              # 认证凭据

<project>/.claude/            # 项目级配置
├── settings.json             # 项目级设置
└── MEMORY.md                 # 项目级 Memory（另一种路径约定）
```


## 7. 快速上手

### 7.1 安装

```bash
# 全局安装 (推荐)
npm install -g @anthropic-ai/claude-code

# 验证安装
claude --version
```

### 7.2 首次使用

```bash
# 进入你的项目目录
cd /path/to/your/project

# 启动 Claude Code
claude

# 首次启动会引导你完成认证
# 支持 Anthropic API Key、OAuth、AWS Bedrock、Google Vertex AI 等认证方式
```

### 7.3 常用命令

```bash
# 交互模式（默认）
claude

# 直接提问（非交互模式）
claude "解释这个项目的架构"

# 从管道输入
cat error.log | claude "分析这个错误日志"

# 恢复上次对话
claude --continue

# 以 MCP 服务端模式启动
claude mcp serve
```

### 7.4 交互模式下的斜杠命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/bug` | 报告 Bug |
| `/commit` | 创建 Git 提交 |
| `/review-pr` | 审查 Pull Request |
| `/config` | 管理配置 |
| `/clear` | 清空对话历史 |

### 7.5 作为 SDK 使用

Claude Code 也可以作为 Node.js SDK 在代码中调用：

```typescript
import { claude } from "@anthropic-ai/claude-code";

// sdk-tools.d.ts 提供了完整的 TypeScript 类型支持
// 包括所有工具的输入/输出类型定义
```


## 8. 本章小结

Claude Code 是一个架构精巧的大型 TypeScript 项目。以下是关键的技术特征总结：

1. **极致的分发优化**：1902 个源文件 + ~200 个依赖打包为单个 13MB 文件，实现零依赖安装
2. **React in Terminal**：大胆地将 React 组件模型引入终端 UI，使用 Ink 框架渲染 389 个 UI 组件
3. **多云架构**：原生支持 Anthropic 直连、AWS Bedrock、Google Vertex AI、Azure Foundry 四种部署模式
4. **协议驱动的扩展性**：通过 MCP (Model Context Protocol) 实现工具和资源的开放式扩展
5. **深度可观测性**：集成完整的 OpenTelemetry 栈（Trace + Metrics + Logs），通过 gRPC/OTLP 上报
6. **跨平台原生能力**：vendor 目录提供 6 个平台的 ripgrep 和 audio-capture 预编译二进制
7. **安全纵深防御**：权限引擎 + 沙箱运行时 + 文件锁 + XSS 过滤 + 密钥检测的多层安全体系
8. **功能实验框架**：集成 GrowthBook 实现功能开关和 A/B 测试，支持渐进式功能发布

后续章节将逐一深入这些技术特征的实现细节。
