# Build & Run Design Spec

## Goal

Make the restored Claude Code CLI source (v2.1.88) buildable and runnable locally with Bun, using the minimum necessary additions. No existing `src/` files are modified.

## Approach

**Method B (Standard)**: Combine best practices from four reference repos (claude-code-haha, claude-code-rev, claude-code, claude-code-best). Use `bootstrap-entry.ts` for MACRO injection, a Bun preload plugin for `bun:bundle` feature flags, top-level `shims/` for stub packages, and a build script for `bun build` output.

**Key constraints:**
- Zero modifications to existing `src/` or `vendor/` files
- All new files are additive (stubs for missing resources, shims for missing packages, config files)
- Feature flags default to all disabled, configurable via Set

---

## New Files to Create

### 1. Configuration Files (project root)

#### `package.json`

```json
{
  "name": "claude-code-runnable",
  "version": "999.0.0-local",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run ./bootstrap-entry.ts",
    "start": "bun run ./bootstrap-entry.ts",
    "build": "bun run ./scripts/build.ts",
    "typecheck": "bun x tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.80.0",
    "@anthropic-ai/claude-agent-sdk": "*",
    "@anthropic-ai/mcpb": "*",
    "@anthropic-ai/sandbox-runtime": "^0.0.44",
    "@aws-sdk/client-bedrock-runtime": "^3.1020.0",
    "@commander-js/extra-typings": "^14.0.0",
    "@growthbook/growthbook": "^1.6.5",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@opentelemetry/api": "*",
    "@opentelemetry/api-logs": "^0.214.0",
    "@opentelemetry/core": "^2.6.1",
    "@opentelemetry/resources": "^2.6.1",
    "@opentelemetry/sdk-logs": "^0.214.0",
    "@opentelemetry/sdk-metrics": "^2.6.1",
    "@opentelemetry/sdk-trace-base": "^2.6.1",
    "@opentelemetry/semantic-conventions": "^1.40.0",
    "ajv": "^8.18.0",
    "asciichart": "^1.5.25",
    "auto-bind": "^5.0.1",
    "axios": "^1.14.0",
    "bidi-js": "^1.0.3",
    "chalk": "^5.6.2",
    "chokidar": "^5.0.0",
    "cli-boxes": "^4.0.1",
    "code-excerpt": "^4.0.0",
    "diff": "^8.0.4",
    "emoji-regex": "^10.6.0",
    "env-paths": "^4.0.0",
    "execa": "^9.6.1",
    "figures": "^6.1.0",
    "fuse.js": "^7.1.0",
    "get-east-asian-width": "^1.5.0",
    "google-auth-library": "^10.6.2",
    "highlight.js": "^11.11.1",
    "https-proxy-agent": "^8.0.0",
    "ignore": "^7.0.5",
    "indent-string": "^5.0.0",
    "ink": "^6.8.0",
    "jsonc-parser": "^3.3.1",
    "lodash-es": "^4.17.23",
    "lru-cache": "^11.2.7",
    "marked": "^17.0.5",
    "p-map": "^7.0.4",
    "picomatch": "^4.0.4",
    "proper-lockfile": "^4.1.2",
    "qrcode": "^1.5.4",
    "react": "^19.2.4",
    "react-reconciler": "^0.33.0",
    "semver": "^7.7.4",
    "shell-quote": "^1.8.3",
    "signal-exit": "^4.1.0",
    "stack-utils": "^2.0.6",
    "strip-ansi": "^7.2.0",
    "supports-hyperlinks": "^4.4.0",
    "tree-kill": "^1.2.2",
    "type-fest": "^5.5.0",
    "undici": "^7.24.6",
    "usehooks-ts": "^3.1.1",
    "vscode-jsonrpc": "^8.2.1",
    "vscode-languageserver-protocol": "^3.17.5",
    "vscode-languageserver-types": "^3.17.5",
    "wrap-ansi": "^10.0.0",
    "ws": "^8.20.0",
    "xss": "^1.0.15",
    "yaml": "^2.8.3",
    "zod": "^4.3.6",
    "@ant/claude-for-chrome-mcp": "file:./shims/@ant/claude-for-chrome-mcp",
    "@ant/computer-use-mcp": "file:./shims/@ant/computer-use-mcp",
    "@ant/computer-use-swift": "file:./shims/@ant/computer-use-swift",
    "@ant/computer-use-input": "file:./shims/@ant/computer-use-input",
    "color-diff-napi": "file:./shims/color-diff-napi",
    "modifiers-napi": "file:./shims/modifiers-napi",
    "url-handler-napi": "file:./shims/url-handler-napi"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/diff": "^7.0.0",
    "@types/lodash-es": "^4.17.12",
    "@types/react": "^19.0.0",
    "@types/ws": "^8.5.0",
    "typescript": "^5.8.0"
  }
}
```

#### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowJs": true,
    "jsx": "react-jsx",
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "strict": false,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "src/*": ["./src/*"],
      "bun:bundle": ["./src/stubs/bun-bundle.d.ts"]
    },
    "types": ["bun-types"]
  },
  "include": ["src/**/*", "vendor/**/*", "shims/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Note: `bun:bundle` type declaration path is for IDE type-checking only. At runtime, the Bun preload plugin intercepts the import.

#### `bunfig.toml`

```toml
[run]
preload = ["./preload.ts"]
```

#### `preload.ts`

Bun plugin that intercepts `import { feature } from 'bun:bundle'` and returns a configurable `feature()` function.

```typescript
import { plugin } from 'bun'

plugin({
  name: 'bun-bundle-polyfill',
  setup(build) {
    build.onResolve({ filter: /^bun:bundle$/ }, () => ({
      path: 'bun-bundle-polyfill',
      namespace: 'bun-bundle-ns',
    }))
    build.onLoad({ filter: /.*/, namespace: 'bun-bundle-ns' }, () => ({
      contents: `
        const ENABLED_FEATURES = new Set([
          // Uncomment features to enable:
          // 'BUILTIN_EXPLORE_PLAN_AGENTS',
          // 'HISTORY_SNIP',
          // 'REACTIVE_COMPACT',
          // 'COMMIT_ATTRIBUTION',
          // 'KAIROS',
          // 'COORDINATOR_MODE',
          // 'VOICE_MODE',
          // 'BRIDGE_MODE',
          // 'PROACTIVE',
          // 'WEB_BROWSER_TOOL',
          // 'CHICAGO_MCP',
          // 'AGENT_TRIGGERS',
          // 'DAEMON',
        ]);
        export function feature(name) { return ENABLED_FEATURES.has(name); }
      `,
      loader: 'js',
    }))
  },
})
```

#### `bootstrap-entry.ts`

Runtime entry point that sets `globalThis.MACRO` then imports the real CLI.

```typescript
import pkg from './package.json'

type MacroConfig = {
  VERSION: string
  BUILD_TIME: string
  PACKAGE_URL: string
  NATIVE_PACKAGE_URL: string
  VERSION_CHANGELOG: string
  ISSUES_EXPLAINER: string
  FEEDBACK_CHANNEL: string
}

const macro: MacroConfig = {
  VERSION: pkg.version,
  BUILD_TIME: new Date().toISOString(),
  PACKAGE_URL: pkg.name,
  NATIVE_PACKAGE_URL: pkg.name,
  VERSION_CHANGELOG: '',
  ISSUES_EXPLAINER: 'file an issue at https://github.com/anthropics/claude-code/issues',
  FEEDBACK_CHANNEL: 'github',
}

;(globalThis as typeof globalThis & { MACRO: MacroConfig }).MACRO = macro

await import('./src/entrypoints/cli.tsx')
```

#### `.env.example`

```env
# Authentication (choose one)
ANTHROPIC_API_KEY=sk-ant-xxx
# ANTHROPIC_AUTH_TOKEN=your_bearer_token

# Custom API endpoint (optional)
# ANTHROPIC_BASE_URL=https://api.example.com/anthropic

# Model overrides (optional)
# ANTHROPIC_MODEL=claude-sonnet-4-20250514
# ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-20250514
# ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5-20251001
# ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-20250514

# Timeouts
API_TIMEOUT_MS=600000

# Disable telemetry and non-essential traffic
DISABLE_TELEMETRY=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH=1
```

#### `scripts/build.ts`

```typescript
const result = await Bun.build({
  entrypoints: ['./src/entrypoints/cli.tsx'],
  outdir: './dist',
  target: 'bun',
  sourcemap: 'linked',
  define: {
    'MACRO.VERSION': JSON.stringify('999.0.0-local'),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'MACRO.PACKAGE_URL': JSON.stringify('claude-code-runnable'),
    'MACRO.NATIVE_PACKAGE_URL': JSON.stringify('claude-code-runnable'),
    'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify('file an issue at https://github.com/anthropics/claude-code/issues'),
    'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  },
})

if (!result.success) {
  console.error('Build failed:')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

console.log('Build succeeded → dist/')
```

#### `src/stubs/bun-bundle.d.ts`

Type declaration for IDE support:
```typescript
declare module 'bun:bundle' {
  export function feature(name: string): boolean
}
```

---

### 2. Shim Packages (`shims/`)

Each shim is a minimal local npm package referenced via `file:` protocol in `package.json`. All content sourced from claude-code-rev's shims (most complete implementations).

| Package | Files | Purpose |
|---------|-------|---------|
| `@ant/claude-for-chrome-mcp` | package.json + index.ts | Chrome browser MCP stub |
| `@ant/computer-use-mcp` | package.json + index.ts + types.ts + sentinelApps.ts | Computer use MCP stub |
| `@ant/computer-use-swift` | package.json + index.ts | macOS Swift bridge stub |
| `@ant/computer-use-input` | package.json + index.ts | Computer input API stub |
| `color-diff-napi` | package.json + index.ts | Re-exports from `src/native-ts/color-diff/` |
| `modifiers-napi` | package.json + index.ts | Re-exports from `vendor/modifiers-napi-src/` |
| `url-handler-napi` | package.json + index.ts | Re-exports from `vendor/url-handler-src/` |

**Source:** Copy from `claude-code-rev/shims/` directory (full contents documented in exploration phase).

---

### 3. Missing Source Stubs (`src/`)

Files that exist in the original Anthropic codebase but were not captured in the source map extraction. These are additive only — no existing files are modified.

#### SDK Type Stubs (from claude-code-rev)

| File | Content |
|------|---------|
| `src/entrypoints/sdk/coreTypes.generated.ts` | Basic SDK message types + `Record<string, unknown>` stubs |
| `src/entrypoints/sdk/runtimeTypes.ts` | Runtime type definitions (sessions, queries, options) |
| `src/entrypoints/sdk/settingsTypes.generated.ts` | `export type Settings = Record<string, unknown>` |
| `src/entrypoints/sdk/toolTypes.ts` | `export type SDKToolDefinition = Record<string, unknown>` |

#### Tool Stubs (from claude-code-rev)

| File | Content |
|------|---------|
| `src/tools/TungstenTool/TungstenTool.ts` | Disabled tool using `buildTool()`, returns error message |
| `src/tools/TungstenTool/TungstenLiveMonitor.tsx` | React component returning `null` |
| `src/tools/WorkflowTool/constants.ts` | `export const WORKFLOW_TOOL_NAME = 'workflow'` |

#### Type Stubs (from claude-code-haha)

| File | Content |
|------|---------|
| `src/types/connectorText.ts` | `ConnectorTextBlock`, `ConnectorTextDelta` types + type guard |
| `src/utils/filePersistence/types.ts` | `PersistedFile`, `FailedPersistence` interfaces + constants |

#### Missing Resource Files

| File | Content | Source |
|------|---------|--------|
| `src/ink/global.d.ts` | Empty file (just prevents import error) | New |
| `src/localRecoveryCli.ts` | Minimal readline REPL fallback | claude-code-haha |
| `src/utils/ultraplan/prompt.txt` | Planning mode system prompt | claude-code-rev |

#### Skill .md Files (29 files, from claude-code-rev)

All 26 claude-api skill docs + 3 verify skill docs. These are imported as text strings via Bun's text loader. Missing files cause Bun to hang indefinitely.

- `src/skills/bundled/claude-api/SKILL.md` + 25 language-specific docs
- `src/skills/bundled/verify/SKILL.md` + 2 example docs

#### Classifier Prompt Files (3 files)

| File | Content |
|------|---------|
| `src/utils/permissions/yolo-classifier-prompts/auto_mode_system_prompt.txt` | Placeholder prompt text |
| `src/utils/permissions/yolo-classifier-prompts/permissions_anthropic.txt` | Placeholder |
| `src/utils/permissions/yolo-classifier-prompts/permissions_external.txt` | Placeholder |

These are loaded behind `feature('TRANSCRIPT_CLASSIFIER')` / `feature('BASH_CLASSIFIER')` flags, so they only need to exist when flags are off. Source content from claude-code-rev if available, otherwise create minimal placeholder text.

---

## Usage

### Install & Run

```bash
bun install
bun run dev                                        # Interactive TUI
bun run dev -- -p "hello" --output-format text     # Headless mode
```

### Build

```bash
bun run build          # Output: dist/cli.js
bun dist/cli.js        # Run built artifact
```

### Authentication

```bash
export ANTHROPIC_API_KEY=sk-ant-xxx
# Or copy .env.example to .env and fill in values
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | API authentication |
| `ANTHROPIC_BASE_URL` | Custom API endpoint |
| `ANTHROPIC_MODEL` | Override default model |
| `DISABLE_TELEMETRY=1` | Disable telemetry |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | Skip non-essential network |
| `CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH=1` | Skip remote settings/policy prefetch |

---

## What Is NOT Modified

- **No existing `src/` files changed** — all fixes are additive (new stub files)
- **No existing `vendor/` files changed**
- **No source code patches** — unlike claude-code-haha which modified 8 existing files
- The `global.d.ts` import issue is solved by creating the empty file, not deleting the import
- The `modifiers-napi` crash is solved by the shim package, not by adding try-catch

---

## File Count Summary

| Category | Count |
|----------|-------|
| Config files (root) | 6 (package.json, tsconfig.json, bunfig.toml, preload.ts, bootstrap-entry.ts, .env.example) |
| Build script | 1 |
| Type declaration | 1 (bun-bundle.d.ts) |
| Shim packages | ~18 files across 7 packages |
| Source stubs (src/) | ~44 files (SDK types, tools, resources, skills) |
| **Total new files** | **~70** |
