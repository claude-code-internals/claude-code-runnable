# Build & Publish System Design

**Date**: 2026-04-16
**Status**: Approved
**Package name**: `open-claude-code`
**CLI commands**: `occ`, `occ-bun`, `open-claude-code`
**Scope**: Phase 1 — Core npm publish (CLI + ripgrep, native addons excluded)

## Release Scope & Provenance

**IMPORTANT**: This design targets **internal/private npm registry** distribution, NOT public npm.

**Context**: This codebase is reconstructed from leaked Anthropic Claude Code source. Original copyright belongs to Anthropic. The project is for learning and research purposes.

**Publishing strategy**:
- **Phase 1 (this spec)**: Internal npm registry or tarball distribution within authorized teams
- **Future consideration**: Public release would require:
  - Complete code audit and cleanup
  - Proper licensing negotiation or clean-room reimplementation
  - Removal of Anthropic-proprietary components
  - New repository under appropriate license

**Metadata in this spec**: The `release-manifest.ts` uses placeholder values (`MIT`, `your-org`) that MUST be replaced with actual internal registry info before publishing.

## Goal

Add build, packaging, and npm publish capability to the claude-code-runnable project. Phase 1 delivers a publishable core CLI package with ripgrep auto-download. Native addons (audio-capture, image-processor, etc.) are excluded from this phase and will fall back to pure-JS alternatives where available.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Publish target | Internal/private npm registry | Codebase provenance requires controlled distribution |
| Runtime compat | Bun + Node.js dual entry | Most users only have Node.js installed |
| Release automation | Manual (`npm publish`) | Sufficient for current scale, CI can be added later |
| Feature flag source | `scripts/build/release-features.ts` (new) | Separate from dev config, explicit release profile |
| ripgrep handling | postinstall auto-download | Best UX, non-fatal on failure |
| Native addons | Excluded from Phase 1 | No `.node` binaries available, fallback to pure-JS |
| Build architecture | Modular pipeline (`scripts/build/`) | Each step independent, testable, maintainable |
| Package structure | Staging directory (`.release/npm/`) | Clean package root, no path confusion |
| Provider SDKs | peerDependencies | npm warns if missing, user installs only needed providers |
| Telemetry exporters | Not in manifest | User installs manually if needed, documented separately |

## Architecture

### Node.js Support Matrix

| Component | Bun | Node.js | Notes |
|-----------|-----|---------|-------|
| Core CLI | ✅ Full | ✅ Full | Main REPL, tools, MCP |
| ripgrep | ✅ Full | ✅ Full | Auto-downloaded via postinstall |
| Image processing | ⚠️ Fallback | ⚠️ Fallback | Both use `sharp` (native only in standalone binary) |
| Audio capture | ❌ Not included | ❌ Not included | Phase 2 |
| URL handler | ❌ Not included | ❌ Not included | Phase 2 |
| Modifiers | ❌ Not included | ❌ Not included | Phase 2 |

**Legend**: ✅ Full support, ⚠️ Degraded/fallback, ❌ Not included in Phase 1

**Note**: Native image processing requires `isInBundledMode()` (standalone binary). npm package uses `sharp` for both Bun and Node.js.

### Build Pipeline

```
bun run build  →  scripts/build/index.ts
                    │
                    ├─ 1. clean dist/ and .release/
                    ├─ 2. bundle()          ← Bun.build() + release-features.ts
                    ├─ 3. patchNodeCompat() ← import.meta.require → createRequire
                    ├─ 4. stagePackage()    ← assemble .release/npm/ directory
                    └─ 5. genEntrypoints()  ← cli-bun.js + cli-node.js in .release/npm/
```

**Key change**: Build produces `.release/npm/` as a complete, self-contained package directory ready for `npm publish`.

### Publish Flow

```
npm version 2.1.89  →  bun run build  →  smoke test  →  npm publish ./.release/npm  →  git push --tags
```

## File Changes

### New Files

#### `scripts/build/index.ts` — Build orchestrator

Imports and calls each build step in sequence. Logs progress and timing for each step. Exits with error code on failure.

```ts
import { bundle } from './bundle'
import { patchNodeCompat } from './node-compat'
import { stagePackage } from './stage-package'
import { generateEntrypoints } from './gen-entrypoints'
import { rmSync } from 'fs'

const start = Date.now()

// Step 1: Clean
rmSync('dist', { recursive: true, force: true })
rmSync('.release', { recursive: true, force: true })

// Step 2-5: Build pipeline
await bundle()              // → dist/cli.js + chunks
await patchNodeCompat()     // → patch dist/*.js
await stagePackage()        // → .release/npm/ with package.json, postinstall.cjs
await generateEntrypoints() // → .release/npm/cli-bun.js + cli-node.js

console.log(`Build completed in ${Date.now() - start}ms`)
console.log(`Package ready at .release/npm/`)
```

#### `scripts/build/bundle.ts` — Core bundling

Calls `Bun.build()` with:
- `entrypoints: ['src/entrypoints/cli.tsx']`
- `outdir: 'dist'`
- `target: 'bun'`
- `splitting: true` (code splitting for smaller chunks)
- `define: getMacroDefines()` from `scripts/defines.ts`
- `external`: same list as current `scripts/build.ts` — bedrock-sdk, foundry-sdk, vertex-sdk, azure/identity, aws-sdk/client-bedrock, aws-sdk/client-sts, all @opentelemetry/exporter-* packages, sharp, turndown

**Feature flags**: Uses `RELEASE_FEATURES` from `scripts/build/release-features.ts`. The build script creates a temporary plugin that replaces `feature('X')` calls with `true` for enabled features, `false` for others. This is similar to `config/features.ts` but uses the release profile instead of dev config.

Build logs print the final feature list for verification.

#### `scripts/build/release-features.ts` — Release feature profile (new)

```ts
// Explicit feature set for npm releases
export const RELEASE_FEATURES = [
  'KAIROS_CHANNELS',
  // Add more stable features here as they mature
]
```

This is separate from `config/features.ts` (which remains for local dev experiments).

#### `scripts/build/release-manifest.ts` — Release package manifest (new)

Explicit definition of runtime dependencies and metadata for the published package. This avoids the fragility of filtering from root `package.json`.

```ts
import rootPkg from '../../package.json'

export const RELEASE_MANIFEST = {
  // Core runtime dependencies (always required)
  dependencies: {
    '@anthropic-ai/sdk': rootPkg.dependencies['@anthropic-ai/sdk'],
    '@anthropic-ai/claude-agent-sdk': rootPkg.dependencies['@anthropic-ai/claude-agent-sdk'],
    '@anthropic-ai/mcpb': rootPkg.dependencies['@anthropic-ai/mcpb'],
    '@anthropic-ai/sandbox-runtime': rootPkg.dependencies['@anthropic-ai/sandbox-runtime'],
    '@commander-js/extra-typings': rootPkg.dependencies['@commander-js/extra-typings'],
    '@growthbook/growthbook': rootPkg.dependencies['@growthbook/growthbook'],
    '@modelcontextprotocol/sdk': rootPkg.dependencies['@modelcontextprotocol/sdk'],
    '@opentelemetry/api': rootPkg.dependencies['@opentelemetry/api'],
    '@opentelemetry/api-logs': rootPkg.dependencies['@opentelemetry/api-logs'],
    '@opentelemetry/core': rootPkg.dependencies['@opentelemetry/core'],
    '@opentelemetry/resources': rootPkg.dependencies['@opentelemetry/resources'],
    '@opentelemetry/sdk-logs': rootPkg.dependencies['@opentelemetry/sdk-logs'],
    '@opentelemetry/sdk-metrics': rootPkg.dependencies['@opentelemetry/sdk-metrics'],
    '@opentelemetry/sdk-trace-base': rootPkg.dependencies['@opentelemetry/sdk-trace-base'],
    '@opentelemetry/semantic-conventions': rootPkg.dependencies['@opentelemetry/semantic-conventions'],
    'ajv': rootPkg.dependencies['ajv'],
    'asciichart': rootPkg.dependencies['asciichart'],
    'auto-bind': rootPkg.dependencies['auto-bind'],
    'axios': rootPkg.dependencies['axios'],
    'bidi-js': rootPkg.dependencies['bidi-js'],
    'chalk': rootPkg.dependencies['chalk'],
    'chokidar': rootPkg.dependencies['chokidar'],
    'cli-boxes': rootPkg.dependencies['cli-boxes'],
    'code-excerpt': rootPkg.dependencies['code-excerpt'],
    'diff': rootPkg.dependencies['diff'],
    'emoji-regex': rootPkg.dependencies['emoji-regex'],
    'env-paths': rootPkg.dependencies['env-paths'],
    'execa': rootPkg.dependencies['execa'],
    'figures': rootPkg.dependencies['figures'],
    'fuse.js': rootPkg.dependencies['fuse.js'],
    'get-east-asian-width': rootPkg.dependencies['get-east-asian-width'],
    'google-auth-library': rootPkg.dependencies['google-auth-library'],
    'highlight.js': rootPkg.dependencies['highlight.js'],
    'https-proxy-agent': rootPkg.dependencies['https-proxy-agent'],
    'ignore': rootPkg.dependencies['ignore'],
    'indent-string': rootPkg.dependencies['indent-string'],
    'ink': rootPkg.dependencies['ink'],
    'jsonc-parser': rootPkg.dependencies['jsonc-parser'],
    'lodash-es': rootPkg.dependencies['lodash-es'],
    'lru-cache': rootPkg.dependencies['lru-cache'],
    'marked': rootPkg.dependencies['marked'],
    'p-map': rootPkg.dependencies['p-map'],
    'picomatch': rootPkg.dependencies['picomatch'],
    'proper-lockfile': rootPkg.dependencies['proper-lockfile'],
    'qrcode': rootPkg.dependencies['qrcode'],
    'react': rootPkg.dependencies['react'],
    'react-reconciler': rootPkg.dependencies['react-reconciler'],
    'semver': rootPkg.dependencies['semver'],
    'shell-quote': rootPkg.dependencies['shell-quote'],
    'signal-exit': rootPkg.dependencies['signal-exit'],
    'stack-utils': rootPkg.dependencies['stack-utils'],
    'strip-ansi': rootPkg.dependencies['strip-ansi'],
    'supports-hyperlinks': rootPkg.dependencies['supports-hyperlinks'],
    'tree-kill': rootPkg.dependencies['tree-kill'],
    'turndown': rootPkg.dependencies['turndown'],  // HTML to markdown, required (pure JS)
    'type-fest': rootPkg.dependencies['type-fest'],
    'undici': rootPkg.dependencies['undici'],
    'usehooks-ts': rootPkg.dependencies['usehooks-ts'],
    'vscode-jsonrpc': rootPkg.dependencies['vscode-jsonrpc'],
    'vscode-languageserver-protocol': rootPkg.dependencies['vscode-languageserver-protocol'],
    'vscode-languageserver-types': rootPkg.dependencies['vscode-languageserver-types'],
    'wrap-ansi': rootPkg.dependencies['wrap-ansi'],
    'ws': rootPkg.dependencies['ws'],
    'xss': rootPkg.dependencies['xss'],
    'yaml': rootPkg.dependencies['yaml'],
    'zod': rootPkg.dependencies['zod'],
  },

  // Optional dependencies (platform-dependent, may fail to install)
  optionalDependencies: {
    // Image processing fallback (native module, may fail on some platforms)
    'sharp': rootPkg.dependencies['sharp'] || '^0.34.5',
  },

  // Peer dependencies (user installs only what they need)
  // npm warns if missing but does NOT fail installation
  // Provider SDKs: install the one matching your API provider
  // Telemetry exporters: install if you enable OpenTelemetry
  peerDependencies: {
    '@anthropic-ai/bedrock-sdk': '*',
    '@anthropic-ai/foundry-sdk': '*',
    '@anthropic-ai/vertex-sdk': '*',
    '@azure/identity': '*',
    '@aws-sdk/client-bedrock': '*',
    '@aws-sdk/client-bedrock-runtime': '*',  // Required for Bedrock streaming
    '@aws-sdk/client-sts': '*',
    '@opentelemetry/exporter-trace-otlp-http': '*',
    '@opentelemetry/exporter-trace-otlp-grpc': '*',
    '@opentelemetry/exporter-trace-otlp-proto': '*',
    '@opentelemetry/exporter-logs-otlp-http': '*',
    '@opentelemetry/exporter-logs-otlp-grpc': '*',
    '@opentelemetry/exporter-logs-otlp-proto': '*',
    '@opentelemetry/exporter-metrics-otlp-http': '*',
    '@opentelemetry/exporter-metrics-otlp-grpc': '*',
    '@opentelemetry/exporter-metrics-otlp-proto': '*',
    '@opentelemetry/exporter-prometheus': '*',  // Required for Prometheus metrics
  },

  peerDependenciesMeta: {
    // All peer deps are optional — only install what you use
    '@anthropic-ai/bedrock-sdk': { optional: true },
    '@anthropic-ai/foundry-sdk': { optional: true },
    '@anthropic-ai/vertex-sdk': { optional: true },
    '@azure/identity': { optional: true },
    '@aws-sdk/client-bedrock': { optional: true },
    '@aws-sdk/client-bedrock-runtime': { optional: true },
    '@aws-sdk/client-sts': { optional: true },
    '@opentelemetry/exporter-trace-otlp-http': { optional: true },
    '@opentelemetry/exporter-trace-otlp-grpc': { optional: true },
    '@opentelemetry/exporter-trace-otlp-proto': { optional: true },
    '@opentelemetry/exporter-logs-otlp-http': { optional: true },
    '@opentelemetry/exporter-logs-otlp-grpc': { optional: true },
    '@opentelemetry/exporter-logs-otlp-proto': { optional: true },
    '@opentelemetry/exporter-metrics-otlp-http': { optional: true },
    '@opentelemetry/exporter-metrics-otlp-grpc': { optional: true },
    '@opentelemetry/exporter-metrics-otlp-proto': { optional: true },
    '@opentelemetry/exporter-prometheus': { optional: true },
  },

  // Package metadata (MUST be updated for actual internal registry)
  metadata: {
    name: '@internal/open-claude-code',  // Scoped name prevents accidental public publish
    description: 'Internal Claude Code CLI — for authorized internal use only',
    keywords: ['claude', 'anthropic', 'cli', 'ai', 'coding-assistant', 'repl'],
    license: 'PROPRIETARY',
    publishConfig: {
      registry: 'https://your-internal-npm-registry.com',  // MUST update before publishing
      access: 'restricted',
    },
    repository: {
      type: 'git',
      url: 'git+https://your-internal-git.com/your-org/open-claude-code.git',
    },
    homepage: 'https://your-internal-docs.com/open-claude-code',
    bugs: {
      url: 'https://your-internal-git.com/your-org/open-claude-code/issues',
    },
  },
}
```

**Why this matters**:
- `turndown` in `dependencies` (pure JS, always required)
- `sharp` in `optionalDependencies` (native, may fail on some platforms)
- Provider SDKs and telemetry exporters in `peerDependencies` + `peerDependenciesMeta.optional: true` — npm warns if missing but does NOT install them by default
- `@aws-sdk/client-bedrock-runtime` and `@opentelemetry/exporter-prometheus` added (were missing)
- Scoped package name `@internal/open-claude-code` + `publishConfig.registry` prevents accidental public publish

#### `scripts/build/node-compat.ts` — Node.js compatibility patching

Scans all `.js` files in `dist/` and replaces:
```js
var __require = import.meta.require;
```
with:
```js
var __require = typeof import.meta.require === "function"
  ? import.meta.require
  : (await import("module")).createRequire(import.meta.url);
```

Reports number of patched files.

#### `scripts/build/stage-package.ts` — Assemble release package (new)

Creates `.release/npm/` directory with complete package structure:

```
.release/npm/
├── package.json          ← generated from release-manifest.ts
├── cli.js                ← from dist/cli.js
├── cli-bun.js            ← generated by gen-entrypoints
├── cli-node.js           ← generated by gen-entrypoints
├── chunk-*.js            ← from dist/chunk-*.js
├── postinstall.cjs       ← adapted from scripts/postinstall.cjs
└── vendor/               ← empty, ripgrep downloads here on install
    └── ripgrep/
```

**package.json generation**:
```ts
import { writeFileSync, mkdirSync, cpSync, readdirSync } from 'fs'
import rootPkg from '../../package.json'
import { RELEASE_MANIFEST } from './release-manifest'

// Create staging directory
mkdirSync('.release/npm/vendor/ripgrep', { recursive: true })

// Copy bundled files
cpSync('dist/cli.js', '.release/npm/cli.js')
// Copy all chunk-*.js files
const chunks = readdirSync('dist').filter(f => f.startsWith('chunk-'))
for (const chunk of chunks) {
  cpSync(`dist/${chunk}`, `.release/npm/${chunk}`)
}

// Copy and adapt postinstall script (see below)
cpSync('scripts/postinstall.cjs', '.release/npm/postinstall.cjs')

// Generate package.json from release manifest
const distPkg = {
  ...RELEASE_MANIFEST.metadata,
  version: rootPkg.version,  // Version comes from root package.json
  bin: {
    occ: './cli-node.js',
    'occ-bun': './cli-bun.js',
    'open-claude-code': './cli-node.js',
  },
  engines: {
    node: '>=18.0.0',
  },
  scripts: {
    postinstall: 'node ./postinstall.cjs',
  },
  dependencies: RELEASE_MANIFEST.dependencies,
  optionalDependencies: RELEASE_MANIFEST.optionalDependencies,
}

writeFileSync('.release/npm/package.json', JSON.stringify(distPkg, null, 2))
```

**Why this matters**: `.release/npm/` is a complete, self-contained package. All paths are relative to this directory. `npm publish ./.release/npm` works directly.

#### `scripts/build/gen-entrypoints.ts` — Dual entry point generation

Generates two executable entry files in `.release/npm/`:

**`.release/npm/cli-bun.js`**:
```js
#!/usr/bin/env bun
import "./cli.js"
```

**`.release/npm/cli-node.js`**:
```js
#!/usr/bin/env node
// No Bun polyfill — let code naturally fall back to Node.js alternatives
import "./cli.js"
```

Sets chmod 755 on both files.

**Key change**: No `globalThis.Bun` polyfill. Defining a partial Bun object is unsafe — it can trick code into Bun-specific branches that fail under Node.js. Instead, code should check for specific Bun APIs (e.g., `typeof Bun?.semver?.order === 'function'`) and fall back gracefully when they don't exist.

#### `scripts/defines.ts` — MACRO constant management

```ts
import pkg from '../package.json'

export function getMacroDefines(): Record<string, string> {
  return {
    "MACRO.VERSION": JSON.stringify(pkg.version),
    "MACRO.BUILD_TIME": JSON.stringify(new Date().toISOString()),
    "MACRO.PACKAGE_URL": JSON.stringify('open-claude-code'),
    "MACRO.NATIVE_PACKAGE_URL": JSON.stringify('open-claude-code'),
    "MACRO.VERSION_CHANGELOG": JSON.stringify(""),
    "MACRO.ISSUES_EXPLAINER": JSON.stringify(
      "file an issue at https://github.com/anthropics/claude-code/issues"
    ),
    "MACRO.FEEDBACK_CHANNEL": JSON.stringify("github"),
  }
}
```

Version comes from `package.json` — single source of truth. No separate version constant to keep in sync.

#### `scripts/postinstall.cjs` — ripgrep binary download

Adapted from claude-code-best's postinstall script with **critical path fix**. CJS format (required for npm postinstall under Node.js).

**Key modification**: The original script uses `path.resolve(scriptDir, "..")` to find project root, which breaks when the script is moved to package root. The adapted version must use:

```js
const binaryDir = path.join(__dirname, 'vendor/ripgrep')
```

This ensures ripgrep is always downloaded to `<package-root>/vendor/ripgrep/`, regardless of where the script is located.

Features:
- Multi-platform: macOS (arm64/x64), Linux (x64/arm64, glibc/musl), Windows (x64/arm64)
- Idempotent: skips if binary already exists
- Non-fatal: exits 0 on failure, prints manual install instructions
- Mirror fallback: GitHub → ghproxy.net
- Proxy-aware: respects HTTPS_PROXY/HTTP_PROXY
- Multiple download strategies: fetch → curl → PowerShell (Windows)

**Install location**: `vendor/ripgrep/<arch>-<platform>/rg[.exe]` (relative to package root, i.e., `.release/npm/vendor/ripgrep/...`)

**Implementation note**: When copying from `scripts/postinstall.cjs` to `.release/npm/postinstall.cjs`, the `stage-package.ts` script must either:
1. Perform a text replacement to fix the path logic, OR
2. Maintain a separate `scripts/postinstall-release.cjs` with the correct paths

**Note**: This is the only postinstall step. Native addons (audio-capture, etc.) are not included in Phase 1.

#### `scripts/bump-version.ts` — Removed

Use `npm version` instead:
```bash
npm version 2.1.89 --no-git-tag-version
```

This updates `package.json` automatically. `scripts/defines.ts` reads from it at build time.

### Modified Files

#### `package.json`

**Root `package.json` stays as dev manifest.** Only change:
```diff
  "scripts": {
    "dev": "bun run ./bootstrap-entry.ts",
-   "build": "bun run ./scripts/build.ts",
+   "build": "bun run ./scripts/build/index.ts",
    "typecheck": "bun x tsc --noEmit"
  }
```

The published package uses `.release/npm/package.json` (generated by build from `release-manifest.ts`), not the root one.

#### `config/features.ts`

No structural changes needed. The existing `ENABLED_FEATURES` set and `createBunBundlePlugin()` function remain for dev mode. The build pipeline uses `release-features.ts` instead to avoid accidentally publishing experimental features.

#### `.gitignore`

Add:
```
dist/
.release/
```

#### `tsconfig.json`

Add `scripts/` to the include path for type checking:
```diff
- "include": ["src/**/*", "vendor/**/*", "shims/**/*"],
+ "include": ["src/**/*", "vendor/**/*", "shims/**/*", "scripts/**/*"],
```

### Deleted Files

| File | Reason |
|------|--------|
| `scripts/build.ts` | Replaced by `scripts/build/` directory |

### Unchanged Files

| File | Reason |
|------|--------|
| `bootstrap-entry.ts` | Dev mode entry, unaffected |
| `preload.ts` | Bun plugin loader for dev, unaffected |
| `config/features.ts` | Dev feature config, unaffected (build uses release-features.ts) |
| `bunfig.toml` | Dev preload config, unaffected |

### Generated Files (not in git)

| File | Purpose |
|------|---------|
| `dist/cli.js` | Bundled CLI (intermediate) |
| `dist/chunk-*.js` | Code-split chunks (intermediate) |
| `.release/npm/` | Complete package directory for publishing |

## Publishing Workflow

### Manual publish steps

```bash
# 1. Update version
npm version 2.1.89 --no-git-tag-version

# 2. Build
bun run build

# 3. Smoke test (see Verification Checklist below)
bun .release/npm/cli-bun.js --version
node .release/npm/cli-node.js --version

# 4. Pack and inspect
npm pack ./.release/npm
tar -tzf open-claude-code-*.tgz | head -20

# 5. Publish
npm publish ./.release/npm

# 6. Tag and push
git add package.json
git commit -m "chore: bump version to 2.1.89"
git tag v2.1.89
git push origin main --tags
```

### What gets published

When you run `npm publish ./.release/npm`:
- npm reads `.release/npm/package.json` as the package manifest
- Only files in `.release/npm/` are included
- Result: clean package with no dev dependencies, source code, or build artifacts

## Verification Checklist

After implementation, verify with **smoke tests**:

### Build verification
- [ ] `bun run build` succeeds
- [ ] `.release/npm/` contains: `cli.js`, `package.json`, `cli-bun.js`, `cli-node.js`, `postinstall.cjs`, and chunk files
- [ ] `.release/npm/package.json` has no `file:` dependencies
- [ ] `.release/npm/package.json` has `turndown` in `dependencies` (not optionalDependencies)
- [ ] `.release/npm/package.json` has `sharp` in `optionalDependencies`
- [ ] `.release/npm/package.json` has provider SDKs and telemetry exporters in `peerDependencies`
- [ ] `.release/npm/package.json` has `publishConfig.registry` set to internal registry URL
- [ ] `.release/npm/vendor/ripgrep/` directory exists (empty before install)
- [ ] Build logs print final feature list from `release-features.ts`

### Runtime verification
- [ ] `bun .release/npm/cli-bun.js --version` prints correct version
- [ ] `node .release/npm/cli-node.js --version` prints correct version
- [ ] `node .release/npm/cli-node.js --help` shows help text

### Package verification
- [ ] `npm pack ./.release/npm` produces tarball
- [ ] Tarball contains only package contents (no source, docs, or sourcemaps)
- [ ] Extract tarball, verify structure matches `.release/npm/`
- [ ] `npm publish --dry-run ./.release/npm` succeeds

### Install smoke test
```bash
# In a temp directory
mkdir /tmp/test-occ && cd /tmp/test-occ

# Pack and install locally (not globally)
npm pack /path/to/project/.release/npm
npm install ./open-claude-code-*.tgz

# Test CLI
npx occ --version
npx occ --help

# Try a real command
cd /some/code/repo
npx occ "search for TODO comments"
```

### Runtime dependency verification (critical)
Test that dynamically imported dependencies work:

```bash
# In the test directory where package is installed
cd /tmp/test-occ

# Test core dependencies
node -e "require('sharp')" && echo "sharp OK"
node -e "require('turndown')" && echo "turndown OK"

# Test optional provider SDKs (if installed)
node -e "require('@anthropic-ai/bedrock-sdk')" && echo "bedrock-sdk OK" || echo "bedrock-sdk not installed (optional)"
node -e "require('@anthropic-ai/vertex-sdk')" && echo "vertex-sdk OK" || echo "vertex-sdk not installed (optional)"

# Test OpenTelemetry exporters (if installed)
node -e "require('@opentelemetry/exporter-trace-otlp-http')" && echo "otel OK" || echo "otel not installed (optional)"
```

### ripgrep verification
- [ ] After install, `<install-dir>/vendor/ripgrep/<platform>/rg` exists
- [ ] Manually test: `cd .release/npm && node ./postinstall.cjs` downloads ripgrep to `./vendor/ripgrep/`
- [ ] Verify ripgrep path is correct: `ls .release/npm/vendor/ripgrep/*/rg*`

## Future Enhancements (Phase 2)

- Native addons support (audio-capture, image-processor, modifiers, url-handler)
- CI/CD with GitHub Actions (tag-triggered publish)
- Automated changelog generation
- Platform-specific npm packages (like `@open-claude-code/darwin-arm64`)
