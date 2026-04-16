<p align="right"><a href="../cn/05_module_context.md">中文</a></p>

# Phase 5: Deep Dive into Context and Memory Management

> This chapter dissects Claude Code's context construction, conversation compaction, session memory, and multi-layer cache system. Context and memory management are the key reason Claude Code can sustain long-running conversations: the subsystem spans more than 40 source files and exists to preserve the highest possible information density inside a limited context window. All analysis is cross-validated between source-map-derived file structure and the actual runtime logic in `cli.js`.


## Contents

1. Interface Contracts and Source-File Matrix
   - 1.1 Module Overview
   - 1.2 Core Source Files
   - 1.3 Supporting Source Files
2. Context Construction System
   - 2.1 System Context Construction in `context.ts`
   - 2.2 `CLAUDE.md` Loading Hierarchy in `claudemd.ts`
   - 2.3 Team Memory Synchronization
   - 2.4 Context Analysis and Visualization
3. Three-Tier Context Compaction Strategy
   - 3.1 Auto Compact
   - 3.2 Session Memory Compact
   - 3.3 Micro Compact
   - 3.4 Manual / Partial Compaction
   - 3.5 Post-Compaction Cleanup and State Reset
4. Session Memory System
   - 4.1 Session Memory Service
   - 4.2 Memory Template Structure
   - 4.3 Memory Token-Budget Management
   - 4.4 Auto Memory and Auto Dream
5. Prompt Cache System
   - 5.1 Anthropic API Caching
   - 5.2 Cache-Break Detection in `promptCacheBreakDetection.ts`
   - 5.3 Tool Search and Deferred Loading
6. Conversation History Management
   - 6.1 History Serialization and Storage
   - 6.2 Session Continuation
7. Multi-Layer Application Caches
8. Evolution Thought Experiment
9. Verification Matrix


## 1. Interface Contracts and Source-File Matrix

### 1.1 Module Overview

At a high level, the subsystem looks like this:

```text
API request / response
        ↓
 prompt cache control
 context builder
 deferred tool search
        ↓
context window
├── system prompt
├── memory files
└── messages
        ↓
auto compact / session-memory compact / micro compact
```

This is the logic that lets Claude Code balance three competing constraints at once:

- preserve important context
- stay within the model's token window
- minimize API cost and repeated work

### 1.2 Core Source Files

The core of the subsystem is spread across the following files:

| Source File | Estimated Size | Responsibility |
|---|---|---|
| `src/context.ts` | ~190 lines | Top-level system-context construction with memoization |
| `src/utils/context.ts` | ~120 lines | Low-level context helpers |
| `src/utils/claudemd.ts` | ~250 lines | Multi-layer `CLAUDE.md` loading and parsing |
| `src/services/compact/compact.ts` | ~450 lines | Main compaction engine, centered on `LE6()` |
| `src/services/compact/autoCompact.ts` | ~180 lines | Auto-compact trigger logic and threshold calculation |
| `src/services/compact/sessionMemoryCompact.ts` | ~250 lines | Local compaction path based on session memory |
| `src/services/compact/microCompact.ts` | ~150 lines | Time-based cleanup of old tool results |
| `src/services/compact/apiMicrocompact.ts` | ~100 lines | API-level micro-compaction support |
| `src/services/compact/prompt.ts` | ~200 lines | Prompt templates used during compaction |
| `src/services/compact/grouping.ts` | ~100 lines | Message grouping logic |
| `src/services/compact/postCompactCleanup.ts` | ~80 lines | Cache invalidation and state reset after compaction |
| `src/services/SessionMemory/sessionMemory.ts` | ~300 lines | Session-memory core service |
| `src/services/SessionMemory/sessionMemoryUtils.ts` | ~150 lines | Session-memory helpers |
| `src/services/SessionMemory/prompts.ts` | ~200 lines | Prompt templates for memory updates |
| `src/services/api/promptCacheBreakDetection.ts` | ~120 lines | Prompt-cache break detection |
| `src/history.ts` | ~350 lines | History serialization and persistence |
| `src/assistant/sessionHistory.ts` | ~100 lines | Session restoration |

### 1.3 Supporting Source Files

Supporting files cover caches, commands, UI, memory utilities, and team synchronization. Important examples include:

- `src/utils/cachePaths.ts`
- `src/utils/fileReadCache.ts`
- `src/utils/fileStateCache.ts`
- `src/utils/toolSchemaCache.ts`
- `src/utils/contextAnalysis.ts`
- `src/utils/analyzeContext.ts`
- `src/utils/contextSuggestions.ts`
- `src/utils/memoryFileDetection.ts`
- `src/utils/teamMemoryOps.ts`
- `src/commands/compact/compact.ts`
- `src/commands/context/context.tsx`
- `src/commands/memory/memory.tsx`
- `src/components/ContextVisualization.tsx`
- `src/components/CompactSummary.tsx`
- `src/components/MemoryUsageIndicator.tsx`
- `src/services/teamMemorySync/index.ts`
- `src/services/teamMemorySync/watcher.ts`
- `src/services/teamMemorySync/secretScanner.ts`
- `src/tools/AgentTool/agentMemory.ts`
- `src/tools/AgentTool/agentMemorySnapshot.ts`


## 2. Context Construction System

### 2.1 System Context Construction in `context.ts`

System context is the environment description attached to every API request. `src/context.ts` and `src/utils/context.ts` build it, and most of the heavyweight pieces are memoized so they are not recomputed on every turn.

Key functions:

| Function | Responsibility | Cache Strategy |
|---|---|---|
| `getGitStatus()` | Branch, workspace state, recent commits | memoized |
| `getUserContext()` | OS, shell, working directory, user environment | memoized |
| `getSystemContext()` | Runtime and platform details | memoized |
| `getSystemPromptInjection()` | Read global prompt injection | global state |
| `setSystemPromptInjection()` | Update global prompt injection | global state |

The resulting context bundle includes:

- identity string
- Git status
- working directory and additional directories
- user-config snapshot
- `CLAUDE.md` content
- Team Memory content
- permission summary

Claude Code also switches identity strings depending on whether it is running in the interactive CLI or in the Agent SDK:

```typescript
"You are Claude Code, Anthropic's official CLI for Claude."
"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
"You are a Claude agent, built on Anthropic's Claude Agent SDK."
```

### 2.2 `CLAUDE.md` Loading Hierarchy in `claudemd.ts`

`CLAUDE.md` is Claude Code's project-context and instruction file. The loader resolves and merges multiple layers.

Representative path logic:

```typescript
function l$6(type: string): string {
  switch (type) {
    case "User":     return join(homedir(), "CLAUDE.md");
    case "Local":    return join(projectRoot, "CLAUDE.local.md");
    case "Project":  return join(projectRoot, "CLAUDE.md");
    case "Managed":  return join(managedDir(), "CLAUDE.md");
    case "AutoMem":  return sessionMemoryPath();
  }
  return teamMemEntrypoint();
}
```

Observed merge order:

| Priority | Type | Example Path | Purpose |
|---|---|---|---|
| 1 | User | `~/.claude/CLAUDE.md` | Global personal defaults |
| 2 | Managed | managed config directory | Org / MDM rules |
| 3 | Project | `<project>/CLAUDE.md` | Shared project instructions |
| 4 | Local | `<project>/CLAUDE.local.md` | Local-only overrides |
| 5 | AutoMem | session-memory file | Automatically maintained memory |
| 6 | TeamMem | synced team memory | Shared team knowledge |

Additional behavior:

- subdirectory `CLAUDE.md` files are auto-loaded when Claude is working inside subtrees, which is especially useful in monorepos
- external includes require explicit user approval through a dedicated safety dialog
- rule directories such as `~/.claude/rules/` and `<project>/.claude/rules/` are also supported

### 2.3 Team Memory Synchronization

Team Memory is a shared memory channel managed through a sync service.

Core files:

| File | Responsibility |
|---|---|
| `src/services/teamMemorySync/index.ts` | Sync entry point |
| `src/services/teamMemorySync/watcher.ts` | File watcher |
| `src/services/teamMemorySync/types.ts` | Type definitions |
| `src/services/teamMemorySync/secretScanner.ts` | Secret scanner |
| `src/services/teamMemorySync/teamMemSecretGuard.ts` | Safety guard |
| `src/utils/teamMemoryOps.ts` | Team-memory operations |

Injected format:

```xml
<team-memory-content source="shared">
  ...
</team-memory-content>
```

Before shared memory is written, secret scanning checks for accidental leakage of API keys, tokens, and similar sensitive content. Related telemetry includes `tengu_team_mem_sync_pull`, `tengu_team_mem_sync_push`, and `tengu_team_mem_entries_capped`.

### 2.4 Context Analysis and Visualization

Claude Code exposes context-budget analysis through `/context`.

The runtime tracks a structure like:

```typescript
interface ContextWindow {
  total_input_tokens: number;
  total_output_tokens: number;
  context_window_size: number;
  current_usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
  used_percentage: number | null;
  remaining_percentage: number | null;
}
```

The analyzer `Up8()` breaks token usage into categories such as:

- system prompt
- system tools
- MCP tools
- deferred tools
- custom agents
- memory files
- skills
- messages
- autocompact buffer
- free space

`ContextVisualization.tsx` renders those categories as a colored grid. Grid density adjusts with context-window size and terminal width.


## 3. Three-Tier Context Compaction Strategy

Claude Code uses three distinct compaction layers so that it does not always have to pay the cost of a full AI-generated summary.

### 3.1 Auto Compact

**Source file**: `src/services/compact/autoCompact.ts`

Auto compact triggers when token use approaches the effective context window.

Core threshold logic:

```typescript
const effectiveWindow = min(modelWindowSize, configuredWindow) - maxOutputTokens;
const autoCompactThreshold = effectiveWindow - 13_000;
```

Important constants:

| Constant | Value | Meaning |
|---|---|---|
| `o3Y` | 20,000 | Maximum output-token deduction |
| `U87` | 13,000 | Auto-compact buffer |
| `a3Y` | 20,000 | Warning threshold |
| `s3Y` | 20,000 | Error threshold |
| `Q87` | 3,000 | Manual compact buffer |
| `kDK` | 3 | Circuit-breaker threshold for repeated failures |

Enablement:

```text
autoCompact = !DISABLE_COMPACT
           && !DISABLE_AUTO_COMPACT
           && config.autoCompactEnabled
```

Observed full-compaction flow:

1. check whether compaction is needed
2. see whether session-memory compaction can be used instead
3. if not, run the full `LE6()` path
4. execute `pre_compact` hooks
5. build summary prompt
6. optionally use cache sharing
7. retry up to 3 times on "prompt too long"
8. restore critical attachments such as recent files, active tasks, plans, and skills

### 3.2 Session Memory Compact

This is the low-cost local path. Instead of calling the API to generate a fresh summary, Claude Code can replace earlier turns with the already-maintained session-memory file.

Enablement depends on session-memory features being active and the dedicated compact flags being enabled.

Key thresholds:

```typescript
const mp8 = {
  minTokens: 10_000,
  minTextBlockMessages: 5,
  maxTokens: 40_000
};
```

Core algorithm:

1. start from the previous summary boundary if it exists
2. scan backward and accumulate tokens
3. stop when either `maxTokens` is reached or both `minTokens` and minimum text-message count are satisfied
4. fix the cut boundary so it never splits a `tool_use` from its matching `tool_result`
5. keep recent messages
6. replace the old section with session-memory content

Compared with full compaction:

| Dimension | Session Memory Compact | Full Compact (`LE6`) |
|---|---|---|
| API call | none | yes |
| summary source | existing session-memory file | newly generated |
| latency | very low | higher |
| cost | zero | consumes tokens |
| fallback | can escalate to full compaction | — |

### 3.3 Micro Compact

**Source files**: `microCompact.ts`, `timeBasedMCConfig.ts`

Micro compact does **not** summarize the whole conversation. It selectively clears old tool-result payloads.

Default configuration:

```typescript
const config = {
  enabled: false,
  gapThresholdMinutes: 60,
  keepRecent: 5
};
```

Trigger conditions:

1. feature enabled
2. running in the main thread rather than a child Agent
3. the last assistant message is older than the configured gap threshold

Cleanup behavior:

- target old Read / Edit-family / Bash / Glob / Grep / LS / WebFetch / WebSearch results
- keep the most recent 5
- replace older payloads with `"[Old tool result content cleared]"`
- clear related caches

Telemetry event: `tengu_time_based_microcompact`

### 3.4 Manual / Partial Compaction

Users can trigger compaction manually through `/compact`.

Supported forms:

```text
/compact
/compact [message]
```

Partial compaction supports two directions:

- `up_to`: compact everything before a target message
- `from`: compact everything after a target message

Partial compaction still uses Claude-generated summaries, but only across the selected slice rather than the whole transcript.

### 3.5 Post-Compaction Cleanup and State Reset

After compaction, `Hp()` in `postCompactCleanup.ts` clears stale caches and resets derived state so the next API request rebuilds context from fresh sources.

Observed cleanup items:

1. clear memoized context caches
2. clear compaction-related caches
3. clear `CLAUDE.md` load cache
4. reset context state
5. reset file state
6. reset Git state
7. clear micro-compact caches


## 4. Session Memory System

### 4.1 Session Memory Service

**Source files**: `sessionMemory.ts`, `sessionMemoryUtils.ts`

Session memory is the mechanism that preserves important knowledge across compaction cycles. It extracts key information from the conversation and persists it into a Markdown file.

Storage layout:

```text
~/.claude/projects/<project-hash>/session-memory/
├── config/
│   ├── template.md
│   └── prompt.md
└── <session-id>.md
```

Workflow:

```text
conversation progresses
→ compaction triggers
→ current session-memory file is read
→ Claude updates memory according to the template
→ Edit writes back the memory file
→ future compaction cycles inject memory instead of replaying older turns
```

### 4.2 Memory Template Structure

The runtime variable `MDK` defines a fixed Markdown structure with ten sections:

```markdown
# Session Title
# Current State
# Task specification
# Files and Functions
# Workflow
# Errors & Corrections
# Codebase and System Documentation
# Learnings
# Key results
# Worklog
```

The instructions attached to the update process are strict:

1. section headings must not be removed or renamed
2. italic guide text must remain intact
3. only the actual content under each section should change
4. content should stay dense and factual, with real file paths, commands, functions, and errors
5. `Current State` must always reflect the latest state of work

### 4.3 Memory Token-Budget Management

Key limits:

| Constant | Value | Meaning |
|---|---|---|
| `up8` | 2,000 | Maximum tokens per section |
| `JDK` | 12,000 | Maximum tokens for the whole memory file |

Enforcement behavior:

- if the whole file exceeds 12,000 tokens, Claude Code emits a critical warning and prioritizes sections such as `Current State` and `Errors & Corrections`
- if a single section exceeds 2,000 tokens, the system identifies the offending sections and asks for compaction
- hard truncation logic can cap sections at up to `up8 * 4 = 8,000` tokens when the model cannot safely rewrite the memory file in time

### 4.4 Auto Memory and Auto Dream

Relevant settings:

| Setting | Type | Meaning |
|---|---|---|
| `autoMemoryEnabled` | settings | Automatically update session memory |
| `autoDreamEnabled` | settings | Perform deeper background consolidation while idle |

When `autoMemoryEnabled` is on, Claude Code updates memory automatically after compaction cycles. When `autoDreamEnabled` is on, the system can do more aggressive cleanup and consolidation while the conversation is idle.


## 5. Prompt Cache System

### 5.1 Anthropic API Caching

Claude Code makes heavy use of Anthropic's prompt caching.

Representative pattern:

```typescript
{
  type: "text",
  text: claudeMdContent,
  cache_control: pU({ querySource: "auto_mode" })
}
```

`pU()` returns an ephemeral cache-control object. The practical consequence is that large, stable prompt prefixes such as system instructions and `CLAUDE.md` content can be reused across turns instead of being billed repeatedly.

Tracked token counters:

```typescript
interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}
```

The compaction pipeline can also benefit from cache sharing when `tengu_compact_cache_prefix` is enabled.

### 5.2 Cache-Break Detection in `promptCacheBreakDetection.ts`

Changes to system prompt content or `CLAUDE.md` can invalidate previously cached prefixes. The cache-break detector:

1. identifies changes likely to invalidate the cache
2. supports manual invalidation through `/break-cache`
3. stores cache-validity state in a TTL-backed map (`zd_`, about one hour)

### 5.3 Tool Search and Deferred Loading

Tool definitions themselves consume a large amount of token budget, so Claude Code defers many of them.

The enablement decision `W18()` checks:

1. whether the model supports `tool_reference` blocks
2. whether ToolSearch is available
3. the `ENABLE_TOOL_SEARCH` environment variable
4. auto-threshold rules based on effective context-window size

Representative modes:

- `"true"`: always enable ToolSearch / deferred loading
- `"auto"` or `"auto:N"`: enable based on thresholds
- `"false"`: disable deferred loading

The system tracks deferred-tool changes incrementally through `deferred_tools_delta`, so each request only sends the schema changes that actually matter.


## 6. Conversation History Management

### 6.1 History Serialization and Storage

**Source file**: `src/history.ts`

Conversation history is stored in JSONL format:

```text
~/.claude/projects/<project-hash>/sessions/
└── <session-id>.jsonl
```

Capabilities:

- append each new message in real time
- restore prior sessions
- support history search

### 6.2 Session Continuation

**Source file**: `src/assistant/sessionHistory.ts`

Session continuation works by:

1. reading the JSONL file
2. deserializing the message list
3. compacting if needed
4. restoring file-read state and permission state
5. continuing the conversation

Behavioral distinction:

- `claude --continue`: resume the most recent session
- `claude --resume <session-id>`: resume a specific session


## 7. Multi-Layer Application Caches

Claude Code maintains many independent caches, each aimed at a different bottleneck:

| Cache | Source File | Strategy | Purpose |
|---|---|---|---|
| settings cache | `settingsCache.ts` | memory + disk | reduce config reads |
| file-read cache | `fileReadCache.ts` | LRU | avoid duplicate file reads |
| file-state cache | `fileStateCache.ts` | memory | track change state |
| tool-schema cache | `toolSchemaCache.ts` | `WeakMap` / runtime cache | avoid repeated schema serialization |
| completion cache | `completionCache.ts` | memory | cache tab completions |
| stats cache | `statsCache.ts` | memory | cache statistics |
| line-width cache | `line-width-cache.ts` | memory | terminal-render calculations |
| node cache | `node-cache.ts` | memory | UI-node rendering |
| cache-path registry | `cachePaths.ts` | path map | unify cache storage |
| plugin ZIP cache | `zipCache.ts` | disk | plugin archive reuse |
| sync cache | `syncCache.ts` | disk | remote managed-settings sync |
| context memoization | `context.ts` | memoize | avoid rebuilding context repeatedly |
| prompt-cache validity map | `promptCacheBreakDetection.ts` | TTL map | track cache invalidation |
| token-count memoization | `analyzeContext.ts` | memoize | reuse token analysis |

Cache invalidation is exposed through `/clear caches`, and compaction also clears the caches that could make context reconstruction inconsistent.


## 8. Evolution Thought Experiment

### Level 1: Naive full-history resend

```text
send every user message and every assistant reply to the API on every turn
```

Fatal problems:

- token usage grows linearly
- tool-heavy conversations grow even faster
- cost scales directly with transcript length

### Level 2: Simple truncation and sliding window

```text
keep the last N messages, drop the rest
```

This is better, but still flawed:

- early design decisions disappear
- the model can retry already-rejected approaches
- tool-use / tool-result pairs can be cut in half
- one giant tool result can still blow up the window

### Level 3: Adaptive three-tier compaction plus memory and caches

Claude Code's actual design combines:

- micro compact for old tool results
- session-memory compact for local low-cost summarization
- full compact through `LE6()` when a fresh AI-generated summary is required
- persistent session-memory files across compaction cycles
- deferred tool loading so schema definitions only appear when needed

Why this is the right design:

1. **graded response**: different pressure levels trigger different-cost solutions
2. **semantic preservation**: summaries retain meaning better than raw truncation
3. **boundary awareness**: tool-use / tool-result pairs stay intact
4. **zero-cost local path**: session-memory compaction can avoid API usage entirely
5. **cost optimization**: prompt cache and cache sharing can reduce compaction cost dramatically
6. **failure protection**: repeated failures trip a circuit breaker after 3 attempts
7. **cross-cycle continuity**: session-memory files preserve knowledge beyond a single compaction pass


## 9. Verification Matrix

The following points were confirmed through `cli.js` and source-map cross-checking:

| Item | Method | Result |
|---|---|---|
| context construction functions | search for `getSystemContext`, `getUserContext`, etc. | confirmed |
| multi-layer `CLAUDE.md` loading | reverse analysis of `l$6()` | confirmed |
| Team Memory XML format | runtime string search | `<team-memory-content source="shared">` confirmed |
| auto-compact buffer | constant `U87` | 13,000 confirmed |
| max output-token deduction | constant `o3Y` | 20,000 confirmed |
| prompt-too-long retries | constant `qDK` | 3 confirmed |
| compaction failure circuit breaker | constant `kDK` | 3 confirmed |
| per-section session-memory limit | constant `up8` | 2,000 confirmed |
| total session-memory limit | constant `JDK` | 12,000 confirmed |
| session-memory compact thresholds | object `mp8` | `minTokens=10000`, `minTextBlockMessages=5`, `maxTokens=40000` confirmed |
| micro-compact gap | config `Yd_` | 60 minutes confirmed |
| micro-compact keep count | config `Yd_` | keep recent 5 confirmed |
| ephemeral prompt caching | `pU()` call pattern | confirmed throughout `cli.js` |
| deferred-tool-search threshold | constant `i87` | 10% confirmed |
| max restored files after compact | constant `eWK` | 5 confirmed |
| restored-file token budget | constant `E3Y` | 50,000 confirmed |
| context-window metadata shape | runtime structure check | confirmed |
| 10-section memory template | variable `MDK` | confirmed |
| `autoCompactEnabled` | config object `RR6` | confirmed |
| `autoMemoryEnabled` | config object `RR6` | confirmed |
| `autoDreamEnabled` | config object `RR6` | confirmed |
| post-compact cleanup function | search for `Hp()` | confirmed |
| JSONL session history | search for `.jsonl` usage | confirmed |
| deferred tool loading via `tool_reference` | `Jp()` logic | confirmed |
| discovered-tool persistence across compaction | `iQ()` logic | confirmed |


> **Summary**: Claude Code's context and memory subsystem is a carefully layered design. File caches, token budgeting, prompt caching, session memory, and AI-driven compaction all serve distinct roles. The guiding principle is consistent throughout: preserve the most information possible at the lowest possible cost, while keeping the model within a bounded context window.
