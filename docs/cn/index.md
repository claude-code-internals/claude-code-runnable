
# Claude Code Codebook

> **@anthropic-ai/claude-code** -- Anthropic 官方终端 AI 编程助手的深度工程剖析

本 Codebook 对 Claude Code CLI 项目进行系统性的架构拆解与源码级分析，涵盖从项目概览到核心算法、从工具系统到权限引擎的完整技术栈。每一章节均基于对 4756 个源文件的 Source Map 反向推导与 16667 行打包产物的交叉验证。


## 章节目录

| 序号 | 文件 | 章节标题 | 内容概要 |
|------|------|---------|----------|
| 1 | [01_foundation](01_foundation) | 项目概述 | 项目身份、技术栈选型、目录结构深度解剖、依赖知识图谱、快速上手指南 |
| 2 | [02_architecture](02_architecture) | 整体架构 | 分层架构设计、入口点分流策略、React/Ink 渲染管线、消息流转模型、状态管理体系 |
| 3 | [03_workflow](03_workflow) | 业务工作流 | 用户交互主循环、对话生命周期、流式响应处理、工具调用链、上下文压缩触发机制 |
| 4 | [04_core_mechanisms](04_core_mechanisms) | 核心数据结构与算法 | 消息格式与序列化、Token 计数与成本追踪、对话历史存储、配置层级合并算法 |
| 5 | [05_module_tool_system](05_module_tool_system) | 工具系统 | Tool 基类设计、184 个工具文件的分类体系、工具注册/发现/执行管道、输入校验与输出规范化 |
| 6 | [05_module_permission](05_module_permission) | 权限系统 | 权限引擎架构、规则匹配算法、用户授权对话框、沙箱隔离策略、安全分级模型 |
| 7 | [05_module_agent](05_module_agent) | Agent 子进程系统 | 子 Agent 创建与生命周期、任务分派策略、异步 Agent 管理、结果聚合机制 |
| 8 | [05_module_mcp](05_module_mcp) | MCP 协议集成 | Model Context Protocol 客户端/服务端实现、工具桥接、资源读取、Socket 连接池 |
| 9 | [05_module_bridge](05_module_bridge) | Bridge 通信层 | 与 Web 版 Claude 的通信协议、Bridge 客户端架构、消息序列化、连接状态管理 |
| 10 | [05_module_context](05_module_context) | 上下文与内存管理 | 上下文窗口策略、Compact 压缩算法、Memory 持久化、项目 Onboarding 状态检测 |
| 11 | [06_native_modules](06_native_modules) | 原生模块与性能优化 | vendor 原生二进制分发策略、Sharp 图像处理管线、ripgrep 搜索集成、音频采集模块、跨平台适配 |
| 12 | [07_evaluation](07_evaluation) | 架构师定论 | 架构优劣势评估、设计决策复盘、可扩展性分析、与同类工具对比、改进建议 |


## 阅读建议

- **快速了解项目**：先读 [01_foundation](01_foundation)，掌握项目定位与技术全貌
- **理解运行机制**：按 02 -> 03 -> 04 顺序，从架构到工作流再到核心算法
- **深入特定模块**：05 系列章节可独立阅读，按兴趣选择
- **架构评审视角**：直接跳到 [07_evaluation](07_evaluation) 获取全局评估

## 项目快照

| 属性 | 值 |
|------|-----|
| 包名 | `@anthropic-ai/claude-code` |
| 版本 | 2.1.88 |
| 运行时 | Node.js >= 18.0.0 (ES Module) |
| 打包产物 | 单文件 `cli.js`（约 13MB, 16667 行） |
| 源文件总数 | 4756 个（含依赖），其中应用代码 1902 个 |
| 许可证 | Anthropic PBC 专有 |
