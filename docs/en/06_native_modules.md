<p align="right"><a href="../cn/06_native_modules.md">中文</a></p>

# Phase 6: Native Modules and Performance Optimization

> This chapter replaces the traditional "CUDA / GPU Analysis" phase used in other codebooks. Claude Code is a Node.js CLI, not a GPU computing framework, so its performance story is built around vendored native binaries, native Node addons, a C-based image-processing stack, and a multi-layer runtime cache architecture. The analysis moves from binary layout and native bindings up through bundling and runtime scheduling.


## 1. Vendored Native Binary: Ripgrep

### 1.1 Role and Purpose

Ripgrep is the engine behind Claude Code's **Grep** tool and therefore the foundation of the code-search subsystem. Whenever the user or an AI agent performs a code search, Claude Code ultimately shells out to a vendored `rg` binary.

The Grep prompt in the product makes this explicit:

```text
A powerful search tool built on ripgrep
- ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command.
  The Grep tool has been optimized for correct permissions and access.
```

### 1.2 Prebuilt Matrix

| Platform | Arch | File | Size | Path |
|------|------|--------|------|------|
| macOS | ARM64 | `rg` | 3.9 MB | `vendor/ripgrep/arm64-darwin/rg` |
| macOS | x64 | `rg` | 4.0 MB | `vendor/ripgrep/x64-darwin/rg` |
| Linux | ARM64 | `rg` | 4.4 MB | `vendor/ripgrep/arm64-linux/rg` |
| Linux | x64 | `rg` | 5.4 MB | `vendor/ripgrep/x64-linux/rg` |
| Windows | ARM64 | `rg.exe` | 3.8 MB | `vendor/ripgrep/arm64-win32/rg.exe` |
| Windows | x64 | `rg.exe` | 4.3 MB | `vendor/ripgrep/x64-win32/rg.exe` |

License: **Unlicense + MIT** dual license, as documented in `vendor/ripgrep/COPYING`.

### 1.3 Three-Mode Path Resolution

Claude Code resolves ripgrep through `gG8()` (`src/utils/ripgrep.ts`) using a three-level strategy:

```text
getRipgrepCommand() -> { mode, command, args, argv0? }
```

**Mode 1: system**

If `USE_SYSTEM_RIPGREP` is enabled, Claude Code prefers a system-installed `rg`. This is useful when the user wants custom `ripgrep` behavior or configuration.

**Mode 2: embedded**

When Claude Code runs as a Bun single-executable bundle, ripgrep can be invoked through `process.execPath` with `argv0: "rg"` and `--no-config`, so Bun behaves as if it were `rg` without reading the user's `.ripgreprc`.

**Mode 3: builtin**

If neither of the above applies, Claude Code selects a vendored prebuilt binary based on `process.arch` and `process.platform`.

### 1.4 Process Invocation

Ripgrep is launched through `e44()`:

```javascript
function e44(query, searchPath, abortSignal, callback, singleThreaded = false) {
  let { rgPath, rgArgs, argv0 } = xA6();
  let threadArgs = singleThreaded ? ["-j", "1"] : [];
  let args = [...rgArgs, ...threadArgs, ...query, searchPath];
}
```

Important runtime decisions:

- `maxBuffer`: `Zn6 = 20000000` (20 MB)
- default timeout: 20 seconds
- WSL timeout: 60 seconds
- user override: `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS`
- `argv0` is used when Bun must impersonate `rg`

### 1.5 Automatic EAGAIN Fallback

On Linux under resource pressure, ripgrep can fail with `os error 11` / `EAGAIN`. Claude Code detects that condition and retries with `-j 1`:

```javascript
if (!singleThreaded && isEAGAIN(stderr)) {
  telemetry("tengu_ripgrep_eagain_retry", {});
  e44(query, path, signal, callback, true);
  return;
}
```

This is a production-oriented self-healing tactic: trade throughput for reliability under load.

### 1.6 One-Time Availability Check

On first use, Claude Code probes ripgrep availability and caches the result:

```javascript
let ripgrepStatus = null;

async function testRipgrep() {
  if (ripgrepStatus !== null) return;
  let config = getRipgrepCommand();
  let result = await exec(config.command, [...config.args, "--version"], { timeout: 5000 });
  let working = result.code === 0 && result.stdout.startsWith("ripgrep ");
  ripgrepStatus = { working, lastTested: Date.now(), config };
}
```

Telemetry records whether ripgrep works and whether the system version is being used.

### 1.7 Mapping Grep Parameters to `rg`

Claude Code maps high-level Grep parameters into ripgrep flags:

| Grep Parameter | `rg` Flag | Meaning |
|---------------|---------|------|
| `pattern` | positional / `-e` | Search expression |
| `path` | positional | Search root |
| `glob` | `--glob` | Filename filter |
| `type` | `--type` | Language / file type |
| `output_mode: "files_with_matches"` | `-l` | File list only |
| `output_mode: "count"` | `-c` | Count matches |
| `output_mode: "content"` | default | Show matching lines |
| `-n` | `-n` | Show line numbers |
| `-i` | `-i` | Ignore case |
| `-A` | `-A` | Trailing context |
| `-B` | `-B` | Leading context |
| `-C` / `context` | `-C` | Symmetric context |
| `multiline` | `-U --multiline-dotall` | Multiline search |
| `head_limit` | post-processing | Cap result count |
| `offset` | post-processing | Pagination offset |

Claude Code also adds implicit flags such as `--hidden`, `--max-columns 500`, permission-based exclusions, and `.gitignore`-derived glob exclusions.

### 1.8 Performance Advantages

Why use ripgrep instead of a pure Node.js file walker plus regex engine?

| Dimension | Node.js `fs.readdir` + `RegExp` | Ripgrep |
|------|--------------------------------|---------|
| Search speed | O(n) file-by-file reads | SIMD-accelerated search engine |
| Parallelism | Single-threaded event loop | Multi-threaded search |
| `.gitignore` support | Manual | Built-in |
| Memory profile | Must load files into JS heap | Streaming and low-memory |
| Binary-file handling | Manual | Built-in |
| Typical speedup | baseline | **10x-100x faster** |

Ripgrep's Rust implementation and SIMD-heavy search pipeline are the right performance primitive for a CLI that spends significant time navigating codebases.


## 2. Vendored Native Binding: Audio Capture

### 2.1 Role and Purpose

`audio-capture` is the core of Claude Code's voice-input mode. It captures raw microphone audio and exposes it to Node.js through a native `.node` addon.

### 2.2 Prebuilt Matrix

| Platform | Arch | Size | Path |
|------|------|------|------|
| macOS | ARM64 | 428 KB | `vendor/audio-capture/arm64-darwin/audio-capture.node` |
| macOS | x64 | 429 KB | `vendor/audio-capture/x64-darwin/audio-capture.node` |
| Linux | ARM64 | 448 KB | `vendor/audio-capture/arm64-linux/audio-capture.node` |
| Linux | x64 | 481 KB | `vendor/audio-capture/x64-linux/audio-capture.node` |
| Windows | ARM64 | 460 KB | `vendor/audio-capture/arm64-win32/audio-capture.node` |
| Windows | x64 | 498 KB | `vendor/audio-capture/x64-win32/audio-capture.node` |

### 2.3 Loading Strategy

The loader probes multiple paths:

```javascript
let cachedModule = null;

function loadAudioCapture() {
  if (cachedModule) return cachedModule;

  if (process.env.AUDIO_CAPTURE_NODE_PATH) {
    try { return cachedModule = require(process.env.AUDIO_CAPTURE_NODE_PATH); } catch {}
  }

  let key = `${process.arch}-${platform}`;
  let candidates = [
    `./vendor/audio-capture/${key}/audio-capture.node`,
    `../audio-capture/${key}/audio-capture.node`
  ];
}
```

Key choices:

- singleton cache so the addon is only loaded once
- silent failure so unsupported environments do not crash the CLI
- support only for `darwin`, `linux`, and `win32`
- environment override through `AUDIO_CAPTURE_NODE_PATH`

### 2.4 N-API Interface

The native module exposes an API shaped roughly like:

```typescript
interface AudioCapture {
  startRecording(sampleRate: number, channels: number): boolean;
  stopRecording(): void;
  isRecording(): boolean;
}
```

Platform backends map to CoreAudio on macOS, PulseAudio / ALSA on Linux, and WASAPI on Windows.

### 2.5 Async Loading Optimization

Voice features load lazily through a promise cache:

```javascript
let audioPromise = null;

function loadAudioAsync() {
  return audioPromise ??= (async () => {
    let module = await import('./audio-capture-napi');
    module.isNativeAudioAvailable();
    return module;
  })();
}
```

The `??=` pattern ensures a single shared load path, and the runtime logs load latency.


## 3. Optional Native Dependency: Sharp (Image Processing)

### 3.1 Role and Purpose

[Sharp](https://sharp.pixelplumbing.com/) is Claude Code's image-processing engine. It resizes and recompresses images before they are sent to the model, and it builds on [libvips](https://www.libvips.org/).

### 3.2 Dependency Architecture

Claude Code declares multiple platform-specific `@img/sharp-*` packages under `optionalDependencies`. npm installs only the package for the current platform.

The dependency tree typically looks like:

```text
@img/sharp-<platform>
└── sharp-<platform>.node
    └── @img/sharp-libvips-<platform>
        └── libvips-cpp.8.17.3.<dylib/so/dll>
```

There are **9 platform variants** in the package metadata.

### 3.3 libvips Dependency Tree

The bundled `libvips` stack depends on around **28 C/C++ libraries**, including codecs and support libraries for JPEG, PNG, WebP, HEIF, AV1, TIFF, SVG, GIF, font rendering, color management, XML parsing, EXIF parsing, and SIMD acceleration.

This is effectively a complete native image-processing pipeline hidden behind a compact Node API.

### 3.4 Lazy Loading

Sharp is optional and loaded on demand:

```javascript
let sharpInstance = null;

async function loadSharp() {
  if (sharpInstance) return sharpInstance.default;

  if (isEmbedded()) {
    try {
      let module = await import('./native-image-processor');
      let sharp = module.sharp || module.default;
      return sharpInstance = { default: sharp }, sharp;
    } catch {}
  }
}
```

If Sharp is unavailable, Claude Code falls back to transmitting the original image rather than failing the entire workflow.

### 3.5 Four-Stage Image Compression Pipeline

Claude Code uses a progressive compression pipeline to reduce images to `maxBytes`, defaulting to `vL = 3932160` (3.75 MB):

1. **Progressive resize**: 100% → 75% → 50% → 25%, preserving the original format
2. **PNG quantization**: resize to 800x800, enable palette mode, restrict to 64 colors
3. **Moderate JPEG compression**: resize to 600x600, quality 50
4. **Extreme JPEG fallback**: resize to 400x400, quality 20

If the image still exceeds the limit after all four stages, the pipeline throws.

### 3.6 Image Constants

| Constant | Value | Meaning |
|------|-----|------|
| `Ek6` | 5,242,880 | Maximum source file size (5 MB) |
| `vL` | 3,932,160 | Default `maxBytes` target (3.75 MB) |
| `nF` | 2,000 | Maximum width in pixels |
| `iF` | 2,000 | Maximum height in pixels |
| `Lk6` | 20,971,520 | Large-file threshold (20 MB) |
| `_j4` | 100 | Media-item count limit |


## 4. Build and Bundling Strategy

### 4.1 Single-File Bundle Architecture

Claude Code uses **Bun** to bundle the project into one JavaScript artifact:

```text
Inputs:
  4,756 source files
  ├── src/**/*.ts
  ├── node_modules/** (inlined runtime deps)
  └── vendor/**-src/*.ts

Outputs:
  cli.js      13.0 MB
  cli.js.map  59.8 MB
```

### 4.2 Bundle Analysis

The bundle header shows:

```javascript
#!/usr/bin/env node
// (c) Anthropic PBC. All rights reserved.
// Version: 2.1.88
// Want to see the unminified source? We're hiring!
```

Notable packaging traits:

- ESM module system
- runtime engine: Node.js >= 18 or Bun
- no runtime `dependencies` at install time because JS dependencies are inlined
- platform-specific native pieces remain in `optionalDependencies`

### 4.3 Packaging Advantages

| Dimension | Traditional `node_modules` | Single-file bundle |
|------|---------------------|-----------|
| Install speed | hundreds of packages | one main package |
| Disk footprint | often hundreds of MB | 13 MB for `cli.js` |
| Startup I/O | many small-file loads | one large-file load |
| Determinism | depends on `node_modules` state | fixed bundle |
| Debugging | source directly readable | source maps required |

### 4.4 Native-Module Isolation

Native pieces that cannot be inlined remain separate:

```text
@anthropic-ai/claude-code/
├── cli.js
├── cli.js.map
├── vendor/
│   ├── ripgrep/{platform}/rg
│   └── audio-capture/{platform}/audio-capture.node
└── node_modules/@img/
    ├── sharp-<platform>/
    └── sharp-libvips-<platform>/
```

This separation exists because:

1. `.node` files are native shared libraries and cannot be packed into JS in the same way
2. `rg` is an external executable launched through `child_process`
3. `libvips` is dynamically loaded by Sharp's `.node` binding


## 5. Runtime Performance Optimization

### 5.1 Startup Performance: Millisecond-Level Profiling

Claude Code ships with a detailed startup profiler in `src/utils/startupProfiler.ts`.

Representative exported API:

```javascript
export {
  profileReport,
  profileCheckpoint,
  logStartupPerf,
  isDetailedProfilingEnabled,
  getStartupPerfLogPath
};
```

The profiler records marks, optionally captures `process.memoryUsage()`, and renders a full checkpoint report. Typical checkpoints include:

- `profiler_initialized`
- `cli_entry`
- `main_tsx_imports_loaded`
- `init_function_start`
- `init_configs_enabled`
- `init_network_configured`
- `init_function_end`
- `eagerLoadSettings_start`
- `eagerLoadSettings_end`
- `main_after_run`

Sampling is enabled for about **0.5%** of launches through `Math.random() < 0.005`, with telemetry measuring import time, init time, settings time, and total startup time.

### 5.2 Parallel Initialization

Claude Code aggressively parallelizes startup tasks:

```javascript
Promise.all([
  import('./event-logging'),
  import('./growth-book')
]).then(([eventModule, growthModule]) => {
  eventModule.initialize1PEventLogging();
});
```

Other optimizations include:

- dynamic `import()` for non-critical modules
- conditional loading for remote-only modules
- `Promise.all` for independent startup work

### 5.3 UI Rendering Performance: FPS Metrics

Claude Code tracks terminal rendering performance through `fpsMetrics.tsx` and `fpsTracker.ts`.

The metric collector uses **reservoir sampling**:

```javascript
const RESERVOIR_SIZE = 1024;
```

It maintains counters, histograms, and sampled distributions, then computes metrics such as P50, P95, and P99 percentiles from the reservoir. This avoids unbounded memory growth while preserving useful rendering statistics.

### 5.4 Cache Architecture

Claude Code uses multiple caches at different layers:

| Cache Module | Purpose | Strategy |
|----------|----------|------|
| `settingsCache` | settings files | in-memory plus file-change detection |
| `fileReadCache` | read results | LRU |
| `fileStateCache` | file metadata | in-memory |
| `toolSchemaCache` | JSON Schema | runtime cache |
| `completionCache` | completion results | LRU |
| `statsCache` | stats | persistent |
| `zipCache` | plugin ZIP extraction | disk cache |
| `line-width-cache` | terminal width calculations | in-memory |
| `node-cache` | Ink node render cache | virtual-DOM-level cache |
| `syncCache` | remote managed settings | timestamp cache |
| `lazySchema` | schema construction | lazy evaluation |
| `memoize` | general function memoization | key-based memoization |

The project's own memoization helper is used for operations such as rough file-count estimation and ripgrep availability checks.

### 5.5 API Interaction Performance

**Streaming responses**

Claude Code always requests `stream: true` from the Claude API, improving time-to-first-token and making cancellation cheaper.

**Prompt cache tracking**

The runtime tracks:

- `input_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`

Cached prompt reads can reduce cost by roughly **90%** on repeated system/context material.

**Automatic context compaction**

When conversation size exceeds `DEFAULT_CONTEXT_TOKEN_THRESHOLD = 100000`, Claude Code can summarize prior history and replace it with a compact summary generated by the model itself.

**Telemetry batching**

Telemetry is exported in batches through `TelemetryExporter`, using delay windows plus exponential backoff on failure.

### 5.6 Memory Optimization

Representative memory-control tactics:

- media items are capped at `MAX_MEDIA_ITEMS = 100`
- ripgrep stdout/stderr buffers are capped at 20 MB
- search output limits line width with `--max-columns 500`
- large tool outputs are truncated and previewed instead of always being fully inlined


## 6. Cross-Platform Compatibility Matrix

### 6.1 Full Platform-Support Table

| Component | macOS ARM64 | macOS x64 | Linux ARM64 | Linux x64 | Linux musl ARM64 | Linux musl x64 | Linux ARM | Windows ARM64 | Windows x64 |
|------|:-----------:|:---------:|:-----------:|:---------:|:----------------:|:--------------:|:---------:|:-------------:|:-----------:|
| `cli.js` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ripgrep | ✅ | ✅ | ✅ | ✅ | -- | -- | -- | ✅ | ✅ |
| audio-capture | ✅ | ✅ | ✅ | ✅ | -- | -- | -- | ✅ | ✅ |
| sharp | ✅ | ✅ opt | ✅ opt | ✅ opt | ✅ opt | ✅ opt | ✅ opt | ✅ opt | ✅ opt |
| libvips | ✅ | ✅ opt | ✅ opt | ✅ opt | ✅ opt | ✅ opt | -- | ✅ opt | ✅ opt |

`opt` means the component is installed through `optionalDependencies`. `--` indicates that no prebuilt binary is shipped and the corresponding feature degrades gracefully.

### 6.2 Platform-Specific Differences

| Feature | macOS | Linux | Windows | WSL |
|------|-------|-------|---------|-----|
| ripgrep timeout | 20s | 20s | 20s | 60s |
| ripgrep EAGAIN retry | no | yes | no | yes |
| audio backend | CoreAudio | PulseAudio / ALSA | WASAPI | unsupported |
| process kill path | SIGTERM → SIGKILL | SIGTERM → SIGKILL | `kill()` | SIGTERM → SIGKILL |
| ripgrep process option | `windowsHide: false` | — | `windowsHide: true` | — |
| sandbox path | — | seccomp + bubblewrap | — | — |
| mTLS support | ✅ | ✅ | ✅ | ✅ |
| upstream proxy | remote only | remote only | remote only | remote only |

### 6.3 Graceful Degradation

Each native component has its own fallback ladder:

```text
ripgrep unavailable
→ try system rg
→ try embedded rg
→ try vendored rg
→ if all fail, only Grep breaks

audio-capture unavailable
→ try AUDIO_CAPTURE_NODE_PATH
→ try vendored path
→ if all fail, voice mode is disabled

sharp unavailable
→ try embedded image processor
→ try installed npm sharp
→ if all fail, images pass through with less optimization
```

### 6.4 Environment Variables Quick Reference

| Variable | Purpose | Default |
|----------|------|--------|
| `USE_SYSTEM_RIPGREP` | Force use of system-installed `rg` | unset |
| `AUDIO_CAPTURE_NODE_PATH` | Override path to `audio-capture.node` | unset |
| `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS` | Ripgrep timeout in seconds | 20, or 60 on WSL |
| `CLAUDE_CODE_PROFILE_STARTUP` | Enable detailed startup profiling | unset |
| `CLAUDE_CODE_REMOTE` | Remote Bridge mode | unset |


## 7. Contrast with Traditional CUDA Analysis

This chapter replaces a CUDA-focused performance review because Claude Code's bottlenecks are not GPU kernels. Its optimization targets are different:

| Traditional CUDA Focus | Claude Code Equivalent |
|---------------------|---------------------|
| GPU kernel optimization | ripgrep SIMD search plus multithreading |
| VRAM management | 20 MB ripgrep buffers plus 3.75 MB image budget |
| kernel launch latency | `child_process.spawn` latency plus singleton caches |
| tensor memory layout | single-file bundling to reduce `node_modules` I/O |
| multi-GPU parallelism | `Promise.all` initialization and concurrent API activity |
| mixed precision | four-stage progressive image compression |
| model quantization | PNG palette quantization and JPEG quality tiers |
| distributed synchronization | prompt cache plus context compaction |
| profiling tools like Nsight | `profileCheckpoint`, 0.5% startup sampling, FPS metrics |
| compute-capability matrices | multi-platform compatibility matrix |

Claude Code is not performance-sensitive in the same way a GPU stack is. Its critical path is a mix of filesystem throughput, subprocess orchestration, image preprocessing, bundle startup cost, and token economics.
