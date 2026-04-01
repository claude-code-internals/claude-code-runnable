# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is the Claude Code CLI source (v2.1.88) — an interactive terminal-based AI coding assistant. It is a TypeScript/React application that renders in the terminal using a custom Ink-based renderer. The runtime is **Bun** (uses `bun:bundle` for compile-time feature flags).

**No build/test/lint configuration exists in this repo.** This is a source dump extracted from a larger monorepo — there are no `package.json`, `tsconfig.json`, test files, or CI configs.

## Architecture

### Request Lifecycle

```
main.tsx → CLI setup & prefetch → launchRepl() → QueryEngine.ts → query.ts → API call → tool execution loop
```

1. **`src/main.tsx`** (4.7k lines): Entry point. Sets up Commander CLI, performs parallel prefetching (MDM settings, keychain, bootstrap data, MCP registry, GrowthBook), then launches the REPL.
2. **`src/QueryEngine.ts`** (1.3k lines): Main conversation loop. Orchestrates message flow, tool execution, permission checks, and streaming responses.
3. **`src/query.ts`** (1.7k lines): Core query execution — builds the request, calls the Anthropic API via `services/api/claude.ts`, handles streaming, and processes tool use blocks.
4. **`src/services/api/claude.ts`** (3.4k lines): Anthropic API client. Manages request construction, streaming, token counting, retry logic, and usage tracking.

### State Management

- **`src/state/AppStateStore.ts`** — Immutable state store definition (`DeepImmutable` enforced)
- **`src/state/AppState.tsx`** — React Context provider wrapping the store
- **`src/state/selectors.ts`** — Selector functions for derived state
- State follows an immutable pattern: always create new objects, never mutate

### Tool System (`src/tools/`)

45+ tools, each in its own directory with a main file exporting a `Tool` object. The `Tool` interface (`src/Tool.ts`, 800 lines) defines:
- `name`, `description`, `inputSchema` (JSON Schema)
- `isEnabled()` — runtime availability check
- `isReadOnly()` — whether the tool modifies state
- `needsPermissions()` — permission requirements
- `call()` — execution function receiving `ToolUseContext`

Tool assembly happens in `src/tools.ts` — combines built-in tools, MCP tools, and plugin tools into a single pool with preset filtering.

### Command System (`src/commands.ts`)

50+ slash commands, each imported from `src/commands/<name>/`. Commands implement a `Command` interface and are registered in a central registry. Some commands are gated by `USER_TYPE` (ant-only) or feature flags.

### Feature Flags — Compile-Time Dead Code Elimination

```typescript
import { feature } from 'bun:bundle'
if (feature('COORDINATOR_MODE')) { /* included only in coordinator builds */ }
```

Key flags: `COORDINATOR_MODE`, `KAIROS` (assistant mode), `VOICE_MODE`, `BRIDGE_MODE`, `PROACTIVE`, `AGENT_TRIGGERS`, `WEB_BROWSER_TOOL`, `WORKFLOW_SCRIPTS`, `TERMINAL_PANEL`.

Runtime flags use `process.env.USER_TYPE` (`'ant'` for internal, otherwise external).

### Rendering

Custom **Ink** terminal UI framework (`src/ink/`) with React components. The CLI entry (`src/entrypoints/cli.tsx`) is a React component tree rendered to the terminal. UI components live in `src/components/` with a design system in `src/components/design-system/`.

### Circular Dependency Avoidance

The codebase uses lazy `require()` calls to break import cycles, especially around `AppState.tsx`, `teammate.ts`, and coordinator modules:
```typescript
const getTeammateUtils = () => require('./utils/teammate.js') as typeof import('./utils/teammate.js')
```

## Key Directories

| Path | Purpose |
|------|---------|
| `src/tools/` | Tool implementations (AgentTool, BashTool, FileEditTool, etc.) |
| `src/commands/` | Slash command implementations |
| `src/services/api/` | Anthropic API client, bootstrap, file uploads, retry logic |
| `src/services/mcp/` | Model Context Protocol client, config, registry |
| `src/state/` | React state management (immutable store + context) |
| `src/entrypoints/` | CLI, MCP server, SDK entry points |
| `src/utils/` | Utilities (auth, git, model, permissions, settings, shell, etc.) |
| `src/hooks/` | React hooks for tool permissions, UI state |
| `src/plugins/` | Plugin system with bundled plugins |
| `src/skills/` | Skill system with bundled skills |
| `src/coordinator/` | Multi-agent coordinator mode |
| `src/bridge/` | Always-on bridge mode (WebSocket-based) |
| `src/tasks/` | Task management system for background work |
| `src/utils/swarm/` | Multi-agent swarm coordination |
| `vendor/` | Native NAPI modules (audio capture, image processing, URL handling) |

## Patterns

- **Immutable state**: `DeepImmutable` type enforced on `AppState`. Never mutate state objects.
- **Conditional loading**: Feature-gated code uses `feature()` from `bun:bundle` for compile-time elimination, and `process.env.USER_TYPE` for runtime gating.
- **Tool interface**: Every tool exports a `Tool` object conforming to `src/Tool.ts`. Tools declare their own permissions, schemas, and execution logic.
- **React for terminal**: All UI is React components rendered via the custom Ink framework in `src/ink/`.
- **Parallel prefetching**: `main.tsx` fires off MDM reads, keychain lookups, bootstrap fetches, and MCP registry loads in parallel before the REPL starts.

## Commit Message Convention

Format:
```
<type>(<scope>): <subject>

<optional body>
```

**Types**: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `style`

**Rules**:
- Subject line: imperative mood, lowercase, no period, max 72 characters
- Scope: optional, identifies the module affected (e.g., `tools`, `query`, `state`, `mcp`, `cli`)
- Body: wrap at 72 characters, explain *why* not *what*, separate from subject with a blank line
- Reference issues/PRs when relevant (e.g., `Closes #123`)

Examples:
```
feat(tools): add PowerShell tool for Windows support
fix(query): prevent duplicate tool calls on stream retry
refactor(state): extract selectors into dedicated module
docs: add CLAUDE.md with architecture overview
```
