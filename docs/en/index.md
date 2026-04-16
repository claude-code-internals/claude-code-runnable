<p align="right"><a href="../cn/index.md">中文</a></p>

# Claude Code Codebook

> **@anthropic-ai/claude-code** -- A deep engineering analysis of Anthropic's official terminal-based AI coding assistant

This Codebook provides a systematic architectural and source-level analysis of the Claude Code CLI project, covering the full technical stack from project overview to core algorithms, and from the tool system to the permissions engine. Every chapter is grounded in reverse-engineering from the source maps of 4,756 files and cross-checked against the 16,667-line bundled artifact.


## Chapters

| No. | File | Chapter Title | Summary |
|------|------|---------|----------|
| 1 | [01_foundation](01_foundation.md) | Project Foundation | Project identity, technology choices, deep directory analysis, dependency knowledge graph, and quick-start guidance |
| 2 | [02_architecture](02_architecture.md) | Overall Architecture | Layered architecture design, entry-point routing strategy, React/Ink rendering pipeline, message-flow model, and state-management system |
| 3 | [03_workflow](03_workflow.md) | Workflow | Main user-interaction loop, conversation lifecycle, streaming response handling, tool invocation chain, and context compaction triggers |
| 4 | [04_core_mechanisms](04_core_mechanisms.md) | Core Data Structures and Algorithms | Message formats and serialization, token counting and cost tracking, conversation-history storage, and configuration-merge algorithms |
| 5 | [05_module_tool_system](05_module_tool_system.md) | Tool System | Base `Tool` design, taxonomy of 184 tool files, tool registration/discovery/execution pipelines, and input validation with output normalization |
| 6 | [05_module_permission](05_module_permission.md) | Permission System | Permission-engine architecture, rule-matching algorithms, user authorization dialogs, sandbox isolation strategy, and security-tier model |
| 7 | [05_module_agent](05_module_agent.md) | Agent Subprocess System | Sub-agent creation and lifecycle, task-dispatch strategy, asynchronous agent management, and result aggregation |
| 8 | [05_module_mcp](05_module_mcp.md) | MCP Integration | Model Context Protocol client/server implementation, tool bridging, resource access, and socket connection pooling |
| 9 | [05_module_bridge](05_module_bridge.md) | Bridge Communication Layer | Communication protocol with the web version of Claude, Bridge client architecture, message serialization, and connection-state management |
| 10 | [05_module_context](05_module_context.md) | Context and Memory Management | Context-window strategy, Compact compression algorithms, Memory persistence, and project onboarding-state detection |
| 11 | [06_native_modules](06_native_modules.md) | Native Modules and Performance Optimization | Native binary distribution in `vendor/`, Sharp image-processing pipelines, ripgrep integration, audio-capture modules, and cross-platform adaptation |
| 12 | [07_evaluation](07_evaluation.md) | Architectural Evaluation | Assessment of architectural strengths and weaknesses, design-decision retrospectives, scalability analysis, comparisons with similar tools, and improvement recommendations |


## Suggested Reading Paths

- **Get oriented quickly**: Start with [01_foundation](01_foundation.md) to understand the project's position and overall technical shape.
- **Understand how it runs**: Read 02 -> 03 -> 04 in order, moving from architecture to workflow to core algorithms.
- **Dive into specific subsystems**: The 05-series chapters can be read independently based on your interests.
- **Take an architecture-review perspective**: Jump straight to [07_evaluation](07_evaluation.md) for a top-down assessment.

## Project Snapshot

| Property | Value |
|------|-----|
| Package name | `@anthropic-ai/claude-code` |
| Version | 2.1.88 |
| Runtime | Node.js >= 18.0.0 (ES Module) |
| Bundled artifact | Single-file `cli.js` (about 13 MB, 16,667 lines) |
| Total source files | 4,756 including dependencies, with 1,902 application-source files |
| License | Proprietary to Anthropic PBC |
