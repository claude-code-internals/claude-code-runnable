<p align="right"><a href="../en/06_native_modules.md">English</a></p>

# 阶段 6: 原生模块与性能优化分析

> 本章替代传统 Codebook 中的 "CUDA/GPU 分析" 阶段。Claude Code 是一个 Node.js CLI 工具而非 GPU 计算框架，其性能优化策略体现在原生二进制调用、Native Addon 绑定、C 语言图像处理库以及多层级运行时缓存架构上。本章从二进制文件级别到运行时调度进行逐层剖析。


## 1. Vendored 原生二进制: Ripgrep

### 1.1 定位与用途

Ripgrep 是 Claude Code **Grep 工具** 的底层引擎，也是整个代码搜索子系统的核心。每当用户或 AI 代理执行代码搜索时，最终都会通过 `child_process` 调用 vendored 的 ripgrep 二进制文件。

在 Grep 工具的描述中可以清楚看到这一定位:

```
A powerful search tool built on ripgrep
- ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command.
  The Grep tool has been optimized for correct permissions and access.
```

### 1.2 预编译矩阵

| 平台 | 架构 | 文件名 | 大小 | 路径 |
|------|------|--------|------|------|
| macOS | ARM64 | `rg` | 3.9 MB | `vendor/ripgrep/arm64-darwin/rg` |
| macOS | x64 | `rg` | 4.0 MB | `vendor/ripgrep/x64-darwin/rg` |
| Linux | ARM64 | `rg` | 4.4 MB | `vendor/ripgrep/arm64-linux/rg` |
| Linux | x64 | `rg` | 5.4 MB | `vendor/ripgrep/x64-linux/rg` |
| Windows | ARM64 | `rg.exe` | 3.8 MB | `vendor/ripgrep/arm64-win32/rg.exe` |
| Windows | x64 | `rg.exe` | 4.3 MB | `vendor/ripgrep/x64-win32/rg.exe` |

许可证: **Unlicense + MIT 双许可** (见 `vendor/ripgrep/COPYING`)。

### 1.3 三模式路径解析

Claude Code 通过 `gG8()` 函数（对应源文件 `src/utils/ripgrep.ts`）实现三级路径解析策略:

```
getRipgrepCommand() -> { mode, command, args, argv0? }
```

**模式 1: System (系统安装)**
```javascript
// 如果环境变量 USE_SYSTEM_RIPGREP 启用
let { cmd } = wA8("rg", []);
if (cmd !== "rg") return { mode: "system", command: "rg", args: [] };
```
优先使用用户系统上已安装的 `rg`，适用于用户有自定义 ripgrep 配置的场景。

**模式 2: Embedded (内嵌到 Bun 运行时)**
```javascript
// 当通过 Bun 单可执行文件方式运行时
if (jj()) return {
  mode: "embedded",
  command: process.execPath,
  args: ["--no-config"],
  argv0: "rg"
};
```
在嵌入模式下，ripgrep 作为 Bun 可执行文件的一部分被调用，通过 `argv0` 欺骗使 Bun 以 `rg` 身份执行。`--no-config` 确保不加载用户的 `.ripgreprc`。

**模式 3: Builtin (内置 vendor 二进制)**
```javascript
let K = path.resolve(baseDir, "vendor", "ripgrep");
return {
  mode: "builtin",
  command: process.platform === "win32"
    ? path.resolve(K, `${process.arch}-win32`, "rg.exe")
    : path.resolve(K, `${process.arch}-${process.platform}`, "rg"),
  args: []
};
```
根据 `process.arch` 和 `process.platform` 自动选择对应平台的预编译二进制。

### 1.4 进程调用机制

Ripgrep 的调用通过函数 `e44()` 实现，核心逻辑:

```javascript
function e44(query, searchPath, abortSignal, callback, singleThreaded = false) {
  let { rgPath, rgArgs, argv0 } = xA6();      // 解析路径配置
  let threadArgs = singleThreaded ? ["-j", "1"] : [];   // 单线程降级
  let args = [...rgArgs, ...threadArgs, ...query, searchPath];

  // 超时配置: WSL 环境 60s, 其他 20s, 可通过环境变量覆盖
  let defaultTimeout = isWSL() ? 60000 : 20000;
  let envTimeout = parseInt(process.env.CLAUDE_CODE_GLOB_TIMEOUT_SECONDS || "", 10) || 0;
  let timeout = envTimeout > 0 ? envTimeout * 1000 : defaultTimeout;

  if (argv0) {
    // Bun.spawn 模式: 使用 argv0 伪装
    let child = spawn(rgPath, args, { argv0, signal, windowsHide: true });
    // ... stdout/stderr 收集，maxBuffer 限制 20MB
  } else {
    // execFile 模式: 标准 child_process
    execFile(rgPath, args, { maxBuffer: 20000000, signal, timeout, ... }, callback);
  }
}
```

关键设计决策:
- **maxBuffer 限制**: `Zn6 = 20000000` (20MB)，防止巨型搜索结果撑爆内存
- **超时分级**: WSL 环境给予 3 倍超时 (60s vs 20s)，因为 WSL 文件系统性能较差
- **可配置超时**: 通过 `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS` 环境变量允许用户覆盖

### 1.5 EAGAIN 自动降级

当 Linux 系统在高负载下返回 "os error 11" (EAGAIN / Resource temporarily unavailable) 时，Claude Code 自动以单线程模式重试:

```javascript
function isEAGAIN(stderr) {
  return stderr.includes("os error 11") ||
         stderr.includes("Resource temporarily unavailable");
}

// 在回调中检测并重试
if (!singleThreaded && isEAGAIN(stderr)) {
  log("rg EAGAIN error detected, retrying with single-threaded mode (-j 1)");
  telemetry("tengu_ripgrep_eagain_retry", {});
  e44(query, path, signal, callback, true);  // 递归调用，强制 -j 1
  return;
}
```

这是一个面向生产环境的自愈机制: 并行 ripgrep 在资源竞争激烈时可能触发 EAGAIN，降级到 `-j 1` 单线程可以牺牲搜索速度换取稳定性。

### 1.6 首次可用性检测

Ripgrep 在首次使用时执行可用性探测，结果缓存到 `BG8`:

```javascript
let ripgrepStatus = null;  // { working: boolean, lastTested: number, config }

async function testRipgrep() {
  if (ripgrepStatus !== null) return;
  let config = getRipgrepCommand();
  let result = await exec(config.command, [...config.args, "--version"], { timeout: 5000 });
  let working = result.code === 0 && result.stdout.startsWith("ripgrep ");
  ripgrepStatus = { working, lastTested: Date.now(), config };
  telemetry("tengu_ripgrep_availability", {
    working: working ? 1 : 0,
    using_system: config.mode === "system" ? 1 : 0
  });
}
```

### 1.7 Grep 工具参数到 rg 标志映射

Claude Code 的 Grep 工具将高级搜索参数映射为 ripgrep CLI 标志。以下是从源码中提取的完整参数映射:

| Grep 工具参数 | rg 标志 | 说明 |
|---------------|---------|------|
| `pattern` | 位置参数 / `-e` | 搜索模式（以 `-` 开头时用 `-e` 前缀） |
| `path` | 位置参数 | 搜索目录（默认工作目录） |
| `glob` | `--glob` | 文件名过滤（支持逗号分隔和 `{a,b}` 语法） |
| `type` | `--type` | 文件类型过滤（js, py, rust 等） |
| `output_mode: "files_with_matches"` | `-l` | 仅输出匹配文件路径 |
| `output_mode: "count"` | `-c` | 输出匹配计数 |
| `output_mode: "content"` | *(默认)* | 输出匹配行内容 |
| `-n` | `-n` | 显示行号（content 模式默认开启） |
| `-i` | `-i` | 大小写不敏感 |
| `-A` | `-A` | 匹配后显示 N 行 |
| `-B` | `-B` | 匹配前显示 N 行 |
| `-C` / `context` | `-C` | 匹配上下文 N 行 |
| `multiline` | `-U --multiline-dotall` | 多行匹配模式 |
| `head_limit` | *(后处理)* | 限制返回结果数 |
| `offset` | *(后处理)* | 跳过前 N 条结果 |

此外，自动添加的隐含标志:
- `--hidden`: 总是搜索隐藏文件
- `--max-columns 500`: 限制单行最大宽度，防止二进制文件污染结果
- 权限排除: 根据 `toolPermissionContext` 自动排除受限路径
- `.gitignore` 排除: 通过 `cj6()` 函数加载额外的 glob 排除规则

### 1.8 性能优势分析

**为什么用 ripgrep 而非 Node.js 原生搜索?**

| 维度 | Node.js `fs.readdir` + `RegExp` | Ripgrep |
|------|--------------------------------|---------|
| 搜索速度 | O(n) 逐文件读取 | SIMD 加速的字符串匹配 |
| 并行度 | 单线程 event loop | 多线程并行（可通过 `-j` 控制） |
| `.gitignore` | 需手动解析 | 内置支持，自动遵守 |
| 内存使用 | 需将文件全部加载到堆中 | 流式处理，内存占用极低 |
| 二进制文件 | 需额外判断 | 自动跳过二进制文件 |
| 典型加速比 | 基准线 | **10-100x 更快** |

Ripgrep 使用 Rust 编写，底层采用 Teddy SIMD 多模式匹配算法（在支持 AVX2 的 x64 平台上），能够在单次 CPU 指令中匹配多个字节。


## 2. Vendored 原生绑定: Audio Capture

### 2.1 定位与用途

`audio-capture` 是 Claude Code 语音输入模式的核心组件，负责从系统麦克风采集原始音频数据。它是一个 **Node.js Native Addon** (`.node` 文件)，通过 N-API 与 Node.js 运行时交互。

### 2.2 预编译矩阵

| 平台 | 架构 | 大小 | 路径 |
|------|------|------|------|
| macOS | ARM64 | 428 KB | `vendor/audio-capture/arm64-darwin/audio-capture.node` |
| macOS | x64 | 429 KB | `vendor/audio-capture/x64-darwin/audio-capture.node` |
| Linux | ARM64 | 448 KB | `vendor/audio-capture/arm64-linux/audio-capture.node` |
| Linux | x64 | 481 KB | `vendor/audio-capture/x64-linux/audio-capture.node` |
| Windows | ARM64 | 460 KB | `vendor/audio-capture/arm64-win32/audio-capture.node` |
| Windows | x64 | 498 KB | `vendor/audio-capture/x64-win32/audio-capture.node` |

### 2.3 加载机制

源码 (`vendor/audio-capture-src/index.ts`) 实现了多路径探测加载:

```javascript
let cachedModule = null;

function loadAudioCapture() {
  if (cachedModule) return cachedModule;

  let platform = process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return null;

  // 路径 1: 环境变量覆盖
  if (process.env.AUDIO_CAPTURE_NODE_PATH) {
    try { return cachedModule = require(process.env.AUDIO_CAPTURE_NODE_PATH); } catch {}
  }

  // 路径 2: 平台探测
  let key = `${process.arch}-${platform}`;
  let candidates = [
    `./vendor/audio-capture/${key}/audio-capture.node`,
    `../audio-capture/${key}/audio-capture.node`
  ];

  for (let path of candidates) {
    try { return cachedModule = require(path); } catch {}
  }

  return null;
}
```

关键设计:
- **单例缓存**: `cachedModule` 确保 `.node` 文件只加载一次，避免重复 `dlopen`
- **静默失败**: 所有 `require` 调用都包裹在 `try/catch` 中，音频不可用时不会崩溃
- **三平台支持**: 仅在 `darwin`/`linux`/`win32` 上尝试加载，其他平台立即返回 `null`
- **环境变量覆盖**: `AUDIO_CAPTURE_NODE_PATH` 允许开发者指定自定义构建路径

### 2.4 N-API 接口

加载的 `.node` 模块暴露以下原生接口:

```typescript
interface AudioCapture {
  startRecording(sampleRate: number, channels: number): boolean;
  stopRecording(): void;
  isRecording(): boolean;
  // ... 其他音频控制方法
}
```

这些接口直接调用平台特定的音频 API:
- **macOS**: CoreAudio (AudioUnit / AVAudioEngine)
- **Linux**: PulseAudio / ALSA
- **Windows**: WASAPI (Windows Audio Session API)

### 2.5 异步加载优化

语音模块的初始化采用延迟加载模式:

```javascript
let audioPromise = null;

function loadAudioAsync() {
  return audioPromise ??= (async () => {
    let start = Date.now();
    let module = await import('./audio-capture-napi');
    let sharp = module.sharp || module.default;
    module.isNativeAudioAvailable();
    log(`[voice] audio-capture-napi loaded in ${Date.now() - start}ms`);
    return module;
  })();
}
```

使用 `??=` (Nullish Coalescing Assignment) 确保只触发一次加载，后续调用复用同一个 Promise。加载耗时通过日志追踪。


## 3. 可选原生依赖: Sharp (图像处理)

### 3.1 定位与用途

[Sharp](https://sharp.pixelplumbing.com/) 是 Claude Code 的图像处理引擎，用于在将图片发送给 AI 模型之前进行尺寸缩放和格式转换。它基于 C 语言编写的 [libvips](https://www.libvips.org/) 图像处理库，提供接近原生速度的图像操作。

### 3.2 依赖架构

```
@anthropic-ai/claude-code (package.json optionalDependencies)
 |
 +-- @img/sharp-darwin-arm64@0.34.5          # 平台特定 Native Addon
 |    +-- lib/sharp-darwin-arm64.node (256KB)  # N-API 绑定
 |    +-- @img/sharp-libvips-darwin-arm64@1.2.4  # libvips 动态库
 |         +-- lib/libvips-cpp.8.17.3.dylib (15MB)  # 核心图像处理库
 |
 +-- @img/sharp-darwin-x64@^0.34.2
 +-- @img/sharp-linux-arm@^0.34.2
 +-- @img/sharp-linux-arm64@^0.34.2
 +-- @img/sharp-linux-x64@^0.34.2
 +-- @img/sharp-linuxmusl-arm64@^0.34.2
 +-- @img/sharp-linuxmusl-x64@^0.34.2
 +-- @img/sharp-win32-arm64@^0.34.2
 +-- @img/sharp-win32-x64@^0.34.2
```

**9 个平台变体** 在 `optionalDependencies` 中声明，npm 会在安装时自动只安装当前平台的变体。

### 3.3 libvips 依赖树

从 `versions.json` 中提取的完整 C 库依赖链 (libvips 8.17.3):

| 类别 | 库名 | 版本 | 用途 |
|------|------|------|------|
| **核心** | vips | 8.17.3 | 图像处理框架 |
| **JPEG** | mozjpeg | 0826579 | Mozilla 优化的 JPEG 编解码器 |
| **PNG** | png | 1.6.50 | PNG 编解码器 |
| **PNG** | spng | 0.7.4 | 高性能 PNG 解码器 |
| **WebP** | webp | 1.6.0 | WebP 编解码器 |
| **HEIF** | heif | 1.20.2 | HEIF/HEIC 编解码器 |
| **AV1** | aom | 3.13.1 | AV1 编解码器（AVIF 支持） |
| **TIFF** | tiff | 4.7.1 | TIFF 编解码器 |
| **SVG** | rsvg | 2.61.2 | SVG 渲染器 |
| **GIF** | cgif | 0.5.0 | GIF 编码器 |
| **色彩** | lcms | 2.17 | 色彩管理系统 |
| **量化** | imagequant | 2.4.1 | 色彩量化（PNG 调色板优化） |
| **SIMD** | highway | 1.3.0 | 跨平台 SIMD 加速 |
| **文本** | pango | 1.57.0 | 文本渲染 |
| **字体** | freetype | 2.14.1 | 字体光栅化 |
| **字体** | harfbuzz | 12.1.0 | 文字塑形引擎 |
| **字体** | fontconfig | 2.17.1 | 字体配置 |
| **文本** | fribidi | 1.0.16 | Unicode 双向文本 |
| **2D** | cairo | 1.18.4 | 2D 图形库 |
| **2D** | pixman | 0.46.4 | 像素操作 |
| **基础** | glib | 2.86.1 | GLib 基础库 |
| **基础** | ffi | 3.5.2 | 外部函数接口 |
| **基础** | expat | 2.7.3 | XML 解析器 |
| **基础** | xml2 | 2.15.1 | XML 解析库 |
| **基础** | exif | 0.6.25 | EXIF 元数据读取 |
| **压缩** | zlib-ng | 2.2.5 | 高性能 zlib 替代 |
| **压缩** | archive | 3.8.2 | 归档格式支持 |
| **代理** | proxy-libintl | 0.5 | 国际化代理 |

总计 **28 个 C/C++ 库** 被静态编译进 `libvips-cpp.8.17.3.dylib` (15MB)，这是一个完整的图像处理工具链。

### 3.4 延迟加载策略

Sharp 作为可选依赖，采用 Promise 缓存的延迟加载:

```javascript
let sharpInstance = null;

async function loadSharp() {
  if (sharpInstance) return sharpInstance.default;

  // 路径 1: 嵌入模式
  if (isEmbedded()) {
    try {
      let module = await import('./native-image-processor');
      let sharp = module.sharp || module.default;
      return sharpInstance = { default: sharp }, sharp;
    } catch {
      console.warn("Native image processor not available in embedded mode");
    }
  }

  // 路径 2: npm 安装的 sharp
  // 通过 require("sharp") 加载，依赖 @img/sharp-{platform} 包
}
```

当 Sharp 不可用时（如安装失败），图像处理降级为原始传输，不会阻断主流程。

### 3.5 四级图像压缩管道

Claude Code 实现了渐进式图像压缩策略，目标是将图像大小降至 `maxBytes` (默认 `vL = 3932160` = 3.75MB) 以内:

```
原始图像 -> 检查是否已满足大小 -> [策略1] -> [策略2] -> [策略3] -> [策略4]
```

**策略 1: 渐进缩放** (`qa_`)
```javascript
let scales = [1, 0.75, 0.5, 0.25];
for (let scale of scales) {
  let width = Math.round((metadata.width || 2000) * scale);
  let height = Math.round((metadata.height || 2000) * scale);
  let resized = sharp(buffer)
    .resize(width, height, { fit: "inside", withoutEnlargement: true });
  resized = applyFormatCompression(resized, format);
  let output = await resized.toBuffer();
  if (output.length <= maxBytes) return output;
}
```
按 100% -> 75% -> 50% -> 25% 逐级缩小，保持原始格式。

**策略 2: PNG 强制量化** (`_a_`，仅 PNG 格式)
```javascript
sharp(buffer)
  .resize(800, 800, { fit: "inside", withoutEnlargement: true })
  .png({ compressionLevel: 9, palette: true, colors: 64 })
  .toBuffer();
```
将 PNG 转为 64 色调色板模式，极大压缩文件大小。

**策略 3: JPEG 中等压缩** (`za_`)
```javascript
sharp(buffer)
  .resize(600, 600, { fit: "inside", withoutEnlargement: true })
  .jpeg({ quality: 50 })
  .toBuffer();
```
转换为 JPEG 格式，质量 50%，尺寸限制 600x600。

**策略 4: JPEG 极限压缩** (`Ya_`)
```javascript
sharp(buffer)
  .resize(400, 400, { fit: "inside", withoutEnlargement: true })
  .jpeg({ quality: 20 })
  .toBuffer();
```
最终兜底: 400x400 尺寸，JPEG 质量 20%。如果仍然超限则抛出错误。

### 3.6 图像处理常量

从源码中提取的关键常量:

| 常量 | 值 | 说明 |
|------|-----|------|
| `Ek6` | 5,242,880 (5 MB) | 最大文件大小限制 |
| `vL` | 3,932,160 (3.75 MB) | 图像 maxBytes 默认值 |
| `nF` | 2,000 | 最大宽度 (px) |
| `iF` | 2,000 | 最大高度 (px) |
| `Lk6` | 20,971,520 (20 MB) | 大文件阈值 |
| `_j4` | 100 | 媒体项数量限制 |


## 4. 构建与打包策略

### 4.1 单文件打包架构

Claude Code 采用 **Bun** 作为构建工具，将整个项目打包为单一 JavaScript 文件:

```
构建输入:
  4,756 个源文件 (TypeScript/JavaScript/TSX)
    ├── src/**/*.ts          # 业务逻辑
    ├── node_modules/**      # 运行时依赖 (全部内联)
    └── vendor/**-src/*.ts   # vendor 模块源码

构建输出:
  cli.js      ─── 13.0 MB   # 单文件可执行包
  cli.js.map  ─── 59.8 MB   # Source Map (完整调试信息)
```

### 4.2 打包内容分析

`cli.js` 文件头部:

```javascript
#!/usr/bin/env node
// (c) Anthropic PBC. All rights reserved.
// Version: 2.1.88
// Want to see the unminified source? We're hiring!
// https://job-boards.greenhouse.io/anthropic/jobs/4816199008
```

打包特征:
- **模块系统**: ESM (`"type": "module"` in package.json)
- **运行时引擎**: Node.js >= 18.0.0 / Bun
- **依赖策略**: `dependencies: {}` ——运行时零依赖，所有模块内联到 `cli.js`
- **可选依赖**: 仅 `@img/sharp-*` 系列以 `optionalDependencies` 存在（因为包含平台特定 `.node` 文件无法内联）

### 4.3 打包优势

| 维度 | 传统 `node_modules` | 单文件打包 |
|------|---------------------|-----------|
| 安装速度 | 数百个包解析 + 下载 | 仅下载 1 个包 |
| 磁盘占用 | 数百 MB `node_modules` | 13 MB `cli.js` |
| 启动速度 | 大量 `require` 解析 | 单文件加载 |
| 文件系统压力 | 数千个小文件 I/O | 单文件 I/O |
| 版本一致性 | 受 `node_modules` 状态影响 | 确定性打包 |
| 调试能力 | 源码直接可读 | Source Map (60MB) 完整映射 |

### 4.4 原生模块隔离

无法内联的原生模块保持独立:

```
@anthropic-ai/claude-code/
  ├── cli.js                          # 所有 JS 代码
  ├── cli.js.map                      # 调试映射
  ├── vendor/
  │   ├── ripgrep/{platform}/rg       # 原生二进制
  │   └── audio-capture/{platform}/   # N-API Addon
  └── node_modules/
      └── @img/
          ├── sharp-darwin-arm64/      # Sharp N-API Addon
          │   └── lib/*.node
          └── sharp-libvips-darwin-arm64/  # libvips 动态库
              └── lib/*.dylib
```

这种分离策略的原因:
1. **`.node` 文件**: 是编译后的动态链接库 (`.so`/`.dylib`/`.dll`)，无法打包到 JS 中
2. **二进制可执行文件**: `rg` 是独立进程，通过 `child_process.spawn` 调用
3. **动态库**: `libvips-cpp.*.dylib` 在运行时被 `.node` 文件 `dlopen`


## 5. 运行时性能优化

### 5.1 启动性能: 毫秒级分析框架

Claude Code 内置了精密的启动性能分析框架 (`src/utils/startupProfiler.ts`)，追踪从进程启动到界面渲染的每一个阶段。

**分析框架实现**:

```javascript
// 导出接口
export {
  profileReport,       // 生成完整报告
  profileCheckpoint,   // 记录检查点
  logStartupPerf,      // 输出到日志
  isDetailedProfilingEnabled,  // 是否启用详细分析
  getStartupPerfLogPath        // 分析日志路径
};

// 检查点记录
function profileCheckpoint(name) {
  if (!profilingEnabled) return;
  performance.mark(name);
  if (detailedProfiling) memorySnapshots.push(process.memoryUsage());
}

// 报告生成
function generateReport() {
  let marks = performance.getEntriesByType("mark");
  let lines = ["=" .repeat(80), "STARTUP PROFILING REPORT", "=".repeat(80), ""];
  let lastTime = 0;
  for (let [i, mark] of marks.entries()) {
    lines.push(formatEntry(mark.startTime, mark.startTime - lastTime,
                           mark.name, memorySnapshots[i]));
    lastTime = mark.startTime;
  }
  lines.push(`Total startup time: ${formatMs(lastMark.startTime)}ms`);
  return lines.join("\n");
}
```

**启动阶段与检查点序列**:

```
profiler_initialized
  │
  ├── cli_entry                         # 入口点
  │     └── main_tsx_imports_loaded      # 模块导入完成
  │
  ├── init_function_start               # 初始化开始
  │     ├── init_configs_enabled        # 配置加载
  │     ├── init_safe_env_vars_applied  # 环境变量应用
  │     ├── init_after_graceful_shutdown # 优雅关闭注册
  │     ├── init_after_1p_event_logging # 事件日志初始化
  │     ├── init_after_oauth_populate   # OAuth 填充
  │     ├── init_after_jetbrains_detection  # IDE 检测
  │     ├── init_after_remote_settings_check  # 远程设置检查
  │     ├── init_network_configured     # 网络(mTLS/代理)配置
  │     └── init_function_end           # 初始化完成
  │
  ├── eagerLoadSettings_start           # 设置预加载
  │     └── eagerLoadSettings_end
  │
  └── main_after_run                    # 渲染就绪
```

**自动采样**: 通过 `Math.random() < 0.005` (0.5% 概率) 自动采样启动性能数据，发送遥测:

```javascript
let samplingEnabled = Math.random() < 0.005;
let profilingEnabled = detailedProfiling || samplingEnabled;

// 遥测数据结构
let metricsMap = {
  import_time:   ["cli_entry", "main_tsx_imports_loaded"],
  init_time:     ["init_function_start", "init_function_end"],
  settings_time: ["eagerLoadSettings_start", "eagerLoadSettings_end"],
  total_time:    ["cli_entry", "main_after_run"]
};
```

### 5.2 并行初始化

`init` 函数中大量使用并行初始化减少启动延迟:

```javascript
// 1P 事件日志与 GrowthBook 并行初始化
Promise.all([
  import('./event-logging'),
  import('./growth-book')
]).then(([eventModule, growthModule]) => {
  eventModule.initialize1PEventLogging();
  growthModule.onGrowthBookRefresh(() => {
    eventModule.reinitialize1PEventLoggingIfConfigChanged();
  });
});

// 远程代理环境的代理初始化
if (process.env.CLAUDE_CODE_REMOTE) {
  let { initUpstreamProxy, getUpstreamProxyEnv } = await import('./upstreamproxy');
  let { registerUpstreamProxyEnvFn } = await import('./sandbox');
  registerUpstreamProxyEnvFn(getUpstreamProxyEnv);
  await initUpstreamProxy();
}
```

关键优化:
- **动态 `import()`**: 非关键模块使用动态导入，不阻塞主初始化路径
- **条件加载**: 远程环境专有的代理模块仅在 `CLAUDE_CODE_REMOTE` 环境下加载
- **`Promise.all` 并行**: 无依赖关系的初始化任务并行执行

### 5.3 UI 渲染性能: FPS 度量追踪

Claude Code 实现了完整的 FPS (帧率) 度量框架 (`src/context/fpsMetrics.tsx` + `src/utils/fpsTracker.ts`)，用于监控终端 UI 渲染性能。

**FPS 度量 Provider**:

```tsx
// React Context 提供 FPS 度量
const FpsMetricsContext = createContext(undefined);

function FpsMetricsProvider({ getFpsMetrics, children }) {
  // 使用 React 的 useMemo 缓存，仅在 children 或 getFpsMetrics 变化时重渲染
  let cache = useMemoCache(3);
  let value;
  if (cache[0] !== children || cache[1] !== getFpsMetrics) {
    value = createElement(FpsMetricsContext.Provider, { value: getFpsMetrics }, children);
    cache[0] = children;
    cache[1] = getFpsMetrics;
    cache[2] = value;
  } else {
    value = cache[2];
  }
  return value;
}
```

**度量收集器**: 使用 **Reservoir Sampling** 算法进行统计采样:

```javascript
const RESERVOIR_SIZE = 1024;

function createMetricsCollector() {
  let counters = new Map();
  let histograms = new Map();
  let distributions = new Map();

  return {
    increment(name, value = 1) {
      counters.set(name, (counters.get(name) ?? 0) + value);
    },
    observe(name, value) {
      let hist = histograms.get(name);
      if (!hist) {
        hist = { reservoir: [], count: 0, sum: 0, min: value, max: value };
        histograms.set(name, hist);
      }
      hist.count++;
      hist.sum += value;
      if (value < hist.min) hist.min = value;
      if (value > hist.max) hist.max = value;
      // Reservoir Sampling: 保持固定大小样本的随机采样
      if (hist.reservoir.length < RESERVOIR_SIZE) {
        hist.reservoir.push(value);
      } else {
        let idx = Math.floor(Math.random() * hist.count);
        if (idx < RESERVOIR_SIZE) hist.reservoir[idx] = value;
      }
    }
  };
}
```

**百分位数计算**: 从 Reservoir 中计算 P50/P95/P99:

```javascript
function percentile(sortedArray, p) {
  let idx = (p / 100) * (sortedArray.length - 1);
  let lower = Math.floor(idx);
  let upper = Math.ceil(idx);
  if (lower === upper) return sortedArray[lower];
  return sortedArray[lower] + (sortedArray[upper] - sortedArray[lower]) * (idx - lower);
}
```

### 5.4 缓存层架构

Claude Code 实现了多层缓存体系，从源码中提取的缓存模块清单:

| 缓存模块 | 源文件 | 缓存目标 | 策略 |
|----------|--------|----------|------|
| `settingsCache` | `src/utils/settings/settingsCache.ts` | 用户/项目设置 | 内存缓存 + 文件变更检测 |
| `fileReadCache` | `src/utils/fileReadCache.ts` | 文件读取结果 | LRU 缓存 |
| `fileStateCache` | `src/utils/fileStateCache.ts` | 文件状态 (mtime/size) | 内存缓存 |
| `toolSchemaCache` | `src/utils/toolSchemaCache.ts` | 工具 JSON Schema | 运行时缓存 |
| `completionCache` | `src/utils/completionCache.ts` | 自动补全结果 | LRU 缓存 |
| `statsCache` | `src/utils/statsCache.ts` | 统计数据 | 持久化缓存 |
| `zipCache` | `src/utils/plugins/zipCache.ts` | 插件 ZIP 解压结果 | 磁盘缓存 |
| `line-width-cache` | `src/ink/line-width-cache.ts` | 终端行宽计算 | 内存缓存 |
| `node-cache` | `src/ink/node-cache.ts` | Ink 渲染节点 | 虚拟 DOM 缓存 |
| `cachePaths` | `src/utils/cachePaths.ts` | 缓存目录路径 | 静态常量 |
| `syncCache` | `src/services/remoteManagedSettings/syncCache.ts` | 远程设置同步 | 时间戳缓存 |
| `lazySchema` | `src/utils/lazySchema.ts` | 延迟 Schema 构建 | 惰性求值 |
| `memoize` | `src/utils/memoize.ts` | 通用函数记忆化 | 参数哈希 |

**通用 Memoize 工具** (`src/utils/memoize.ts`):

项目自有的 `_1` 函数（内部 memoize 工具）被广泛使用:

```javascript
// 使用示例 1: 文件计数估算
let estimateFileCount = memoize(
  async (dir, abortSignal, excludePatterns = []) => {
    let args = ["--files", "--hidden"];
    excludePatterns.forEach(p => args.push("--glob", `!${p}`));
    let count = await runRipgrepCount(args, dir, abortSignal);
    if (count === 0) return 0;
    let magnitude = Math.floor(Math.log10(count));
    let base = Math.pow(10, magnitude);
    return Math.round(count / base) * base;  // 量级估算，避免精确计数
  },
  (dir, signal, excludePatterns = []) => `${dir}|${excludePatterns.join(",")}`
);

// 使用示例 2: Ripgrep 可用性检测
let testRipgrepAvailability = memoize(async () => { ... });
```

第二个参数是 **缓存键生成函数**，将函数参数映射为字符串键。

### 5.5 API 交互性能

**5.5.1 流式响应**

Claude Code 始终以流式 (`stream: true`) 调用 Claude API:

```javascript
// 创建消息时强制启用流
return A4(stream, params, { ...params, stream: true }, "f");
// 通过 X-Stainless-Helper 头标识请求类型
{ headers: { "X-Stainless-Helper": "..." } }
```

流式响应的优势:
- 首 token 延迟降低 (TTFT: Time To First Token)
- 用户可以实时看到 AI 响应
- 取消请求时节省 API 成本

**5.5.2 Prompt 缓存**

Claude API 内置 prompt 缓存机制，Claude Code 追踪三个 token 计数维度:

```javascript
// 在 usage 统计中追踪
if (usage.cache_creation_input_tokens != null)
  accumulated.cache_creation_input_tokens = usage.cache_creation_input_tokens;
if (usage.cache_read_input_tokens != null)
  accumulated.cache_read_input_tokens = usage.cache_read_input_tokens;
```

- `input_tokens`: 常规输入 token
- `cache_creation_input_tokens`: 写入缓存的 token（首次对话轮次）
- `cache_read_input_tokens`: 从缓存读取的 token（后续轮次，**成本降低 90%**）

系统提示和工具定义在多轮对话中被缓存，避免重复计费。

**5.5.3 上下文压缩 (Compaction)**

当对话 token 数超过阈值时，自动触发上下文压缩:

```javascript
const DEFAULT_CONTEXT_TOKEN_THRESHOLD = 100000;  // 100K tokens

async function checkCompaction() {
  let control = params.compactionControl;
  if (!control || !control.enabled) return false;

  // 计算当前上下文总 token 数
  let totalTokens = usage.input_tokens
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
    + usage.output_tokens;

  let threshold = control.contextTokenThreshold ?? 100000;
  if (totalTokens < threshold) return false;

  // 使用 AI 生成对话摘要，替换历史消息
  let summary = await client.messages.create({
    model: control.model ?? params.model,
    messages: [...buildSummaryPrompt(params.messages)],
    max_tokens: params.max_tokens,
  }, {
    headers: { "x-stainless-helper": "compaction" }
  });

  // 用摘要替换整个历史
  params.messages = [{ role: "user", content: summary.content }];
  return true;
}
```

压缩策略是一个自动触发的上下文管理机制:
1. **监控阈值**: 持续追踪总 token 使用量
2. **触发压缩**: 超过 100K token 阈值时触发
3. **AI 摘要**: 用当前模型生成对话摘要
4. **上下文替换**: 用摘要替换全部历史消息

**5.5.4 遥测批处理**

遥测数据通过 `mV1` (TelemetryExporter) 批量发送:

```javascript
class TelemetryExporter {
  endpoint;
  maxBatchSize;
  batchDelayMs;
  baseBackoffDelayMs;
  maxBackoffDelayMs;
  maxAttempts;
  pendingExports = [];

  // 批量收集 -> 延迟发送 -> 指数退避重试
}
```

### 5.6 内存优化策略

**5.6.1 媒体项限制**

当对话中的媒体项（图片、文件等）超过 100 个时自动裁剪:

```javascript
const MAX_MEDIA_ITEMS = 100;  // _j4 = 100
```

**5.6.2 ripgrep 输出缓冲限制**

Ripgrep 输出被限制在 20MB:

```javascript
const RG_MAX_BUFFER = 20000000;  // Zn6 = 20MB
// stdout/stderr 均有独立限制，超出时截断
if (stdout.length > RG_MAX_BUFFER) {
  stdout = stdout.slice(0, RG_MAX_BUFFER);
  truncated = true;
}
```

**5.6.3 工具结果大小管理**

搜索结果通过 `--max-columns 500` 限制单行宽度，防止匹配到二进制文件的超长行。


## 6. 跨平台兼容性矩阵

### 6.1 完整平台支持表

| 组件 | macOS ARM64 | macOS x64 | Linux ARM64 | Linux x64 | Linux musl ARM64 | Linux musl x64 | Linux ARM | Windows ARM64 | Windows x64 |
|------|:-----------:|:---------:|:-----------:|:---------:|:----------------:|:--------------:|:---------:|:-------------:|:-----------:|
| **cli.js** (主程序) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **ripgrep** | ✅ 3.9MB | ✅ 4.0MB | ✅ 4.4MB | ✅ 5.4MB | -- | -- | -- | ✅ 3.8MB | ✅ 4.3MB |
| **audio-capture** | ✅ 428KB | ✅ 429KB | ✅ 448KB | ✅ 481KB | -- | -- | -- | ✅ 460KB | ✅ 498KB |
| **sharp** | ✅ 256KB | ✅ opt | ✅ opt | ✅ opt | ✅ opt | ✅ opt | ✅ opt | ✅ opt | ✅ opt |
| **libvips** | ✅ 15MB | ✅ opt | ✅ opt | ✅ opt | ✅ opt | ✅ opt | -- | ✅ opt | ✅ opt |

> "opt" = 可选依赖，通过 `optionalDependencies` 按平台安装。"--" = 无预编译二进制，功能降级。

### 6.2 平台特定行为差异

| 特性 | macOS | Linux | Windows | WSL |
|------|-------|-------|---------|-----|
| **ripgrep 超时** | 20s | 20s | 20s | 60s |
| **ripgrep EAGAIN 重试** | 不触发 | ✅ 单线程降级 | 不触发 | ✅ 单线程降级 |
| **音频后端** | CoreAudio | PulseAudio/ALSA | WASAPI | 不支持 |
| **进程终止信号** | SIGTERM -> SIGKILL | SIGTERM -> SIGKILL | kill() | SIGTERM -> SIGKILL |
| **ripgrep 进程选项** | `windowsHide: false` | -- | `windowsHide: true` | -- |
| **沙盒安全** | -- | seccomp BPF + bubblewrap | -- | -- |
| **mTLS 支持** | ✅ | ✅ | ✅ | ✅ |
| **上游代理** | 仅远程模式 | 仅远程模式 | 仅远程模式 | 仅远程模式 |

### 6.3 降级策略

Claude Code 为每个原生组件实现了优雅降级:

```
ripgrep 不可用:
  ├── 尝试系统 rg → 尝试内嵌 rg → 尝试 vendor rg
  └── 全部失败: Grep 工具返回错误，但不影响其他工具

audio-capture 不可用:
  ├── 尝试 AUDIO_CAPTURE_NODE_PATH → 尝试 vendor 路径
  └── 全部失败: 语音模式不可用，但 CLI 正常运行

sharp 不可用:
  ├── 尝试嵌入模式加载 → 尝试 npm 包加载
  └── 全部失败: 图像以原始大小传输（可能超出 API 限制）
```

### 6.4 环境变量速查

| 环境变量 | 用途 | 默认值 |
|----------|------|--------|
| `USE_SYSTEM_RIPGREP` | 强制使用系统安装的 rg | 未设置 |
| `AUDIO_CAPTURE_NODE_PATH` | 自定义 audio-capture.node 路径 | 未设置 |
| `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS` | ripgrep 超时 (秒) | 20 (WSL: 60) |
| `CLAUDE_CODE_PROFILE_STARTUP` | 启用详细启动分析 | 未设置 |
| `CLAUDE_CODE_REMOTE` | 远程代理模式 | 未设置 |


## 7. 与传统 CUDA 分析的对比

本章替代 CUDA 分析的原因在于 Claude Code 的性能瓶颈不在 GPU 计算，而在于:

| 传统 CUDA 项目关注点 | Claude Code 对应优化 |
|---------------------|---------------------|
| GPU Kernel 优化 | Ripgrep SIMD 字符串匹配 + 多线程并行 |
| 显存管理 | 20MB ripgrep 输出缓冲 + 3.75MB 图像压缩限制 |
| Kernel Launch 延迟 | `child_process.spawn` 进程启动延迟 + 单例缓存 |
| Tensor 内存布局 | 单文件打包消除 `node_modules` I/O |
| 多 GPU 并行 | `Promise.all` 并行初始化 + 并行 API 调用 |
| 混合精度训练 | 四级图像渐进压缩管道 (100% -> 75% -> 50% -> 25%) |
| 模型量化 | PNG 64 色调色板量化 + JPEG 质量梯度 (80% -> 50% -> 20%) |
| 分布式训练同步 | Prompt 缓存 (90% 成本降低) + 上下文压缩 |
| Profiling (Nsight) | `profileCheckpoint` + 0.5% 自动采样 + FPS 度量 |
| Compute Capability 矩阵 | 6 平台 x 3 组件跨平台兼容矩阵 |

Claude Code 的性能优化本质是 **I/O 密集型** 而非 **计算密集型** 的: 最大的延迟来源是文件系统搜索 (通过原生 ripgrep 解决)、网络 API 调用 (通过流式响应和缓存解决)、以及进程间通信 (通过单例和延迟加载解决)。这种优化策略与 GPU 计算框架的优化方向截然不同，但工程深度同样值得深入研究。
