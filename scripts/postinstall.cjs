#!/usr/bin/env node
/**
 * Postinstall script — downloads ripgrep binary after npm install.
 * Non-fatal: exits 0 on failure.
 */

const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } =
  require('fs')
const { spawnSync } = require('child_process')
const { setDefaultResultOrder } = require('node:dns')
const path = require('path')
const os = require('os')

try { setDefaultResultOrder('ipv4first') } catch { /* ignore */ }

const RG_VERSION = '15.0.1'
const DEFAULT_RELEASE_BASE = `https://github.com/microsoft/ripgrep-prebuilt/releases/download/v${RG_VERSION}`
const MIRROR_RELEASE_BASE = `https://ghproxy.net/https://github.com/microsoft/ripgrep-prebuilt/releases/download/v${RG_VERSION}`
const RELEASE_BASE = (process.env.RIPGREP_DOWNLOAD_BASE ?? DEFAULT_RELEASE_BASE).replace(/\/$/, '')

// Always relative to package root (where this script lives)
const binaryDir = path.join(__dirname, 'vendor', 'ripgrep')

function getPlatformMapping() {
  const arch = process.arch
  const platform = process.platform
  if (platform === 'darwin') {
    if (arch === 'arm64') return { target: 'aarch64-apple-darwin', ext: 'tar.gz' }
    if (arch === 'x64') return { target: 'x86_64-apple-darwin', ext: 'tar.gz' }
    throw new Error(`Unsupported macOS arch: ${arch}`)
  }
  if (platform === 'win32') {
    if (arch === 'x64') return { target: 'x86_64-pc-windows-msvc', ext: 'zip' }
    if (arch === 'arm64') return { target: 'aarch64-pc-windows-msvc', ext: 'zip' }
    throw new Error(`Unsupported Windows arch: ${arch}`)
  }
  if (platform === 'linux') {
    const isMusl = detectMusl()
    if (arch === 'x64') return { target: 'x86_64-unknown-linux-musl', ext: 'tar.gz' }
    if (arch === 'arm64') {
      return isMusl
        ? { target: 'aarch64-unknown-linux-musl', ext: 'tar.gz' }
        : { target: 'aarch64-unknown-linux-gnu', ext: 'tar.gz' }
    }
    throw new Error(`Unsupported Linux arch: ${arch}`)
  }
  throw new Error(`Unsupported platform: ${platform}`)
}

function detectMusl() {
  const muslArch = process.arch === 'x64' ? 'x86_64' : 'aarch64'
  try { statSync(`/lib/libc.musl-${muslArch}.so.1`); return true } catch { return false }
}

function getBinaryPath() {
  const subdir = `${process.arch}-${process.platform}`
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg'
  return path.join(binaryDir, subdir, binary)
}

function proxyEnvSet() {
  const v = (s) => (s ?? '').trim()
  return !!(v(process.env.HTTPS_PROXY) || v(process.env.HTTP_PROXY) || v(process.env.ALL_PROXY) || v(process.env.https_proxy) || v(process.env.http_proxy))
}

function tryPowerShellDownload(url, dest) {
  const u = url.replace(/'/g, "''")
  const d = dest.replace(/'/g, "''")
  const cmd = `Invoke-WebRequest -Uri '${u}' -OutFile '${d}' -UseBasicParsing`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { stdio: 'pipe', windowsHide: true })
  return result.status === 0 && existsSync(dest) && statSync(dest).size > 0
}

function tryCurlDownload(url, dest) {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const result = spawnSync(curl, ['-fsSL', '-L', '--fail', '-o', dest, url], { stdio: 'pipe', windowsHide: true })
  return result.status === 0 && existsSync(dest) && statSync(dest).size > 0
}

async function fetchRelease(url) {
  if (proxyEnvSet()) {
    const undici = require('undici')
    return await undici.fetch(url, { redirect: 'follow', dispatcher: new undici.EnvHttpProxyAgent() })
  }
  return await fetch(url, { redirect: 'follow' })
}

async function downloadUrlToBuffer(url) {
  const response = await fetchRelease(url)
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`)
  return Buffer.from(await response.arrayBuffer())
}

async function downloadUrlToBufferWithFallback(url) {
  let firstError
  try { return await downloadUrlToBuffer(url) } catch (e) { firstError = e }
  const tmpRoot = path.join(os.tmpdir(), `ripgrep-dl-${process.pid}-${Date.now()}`)
  const tmpFile = path.join(tmpRoot, 'archive')
  mkdirSync(tmpRoot, { recursive: true })
  try {
    if (process.platform === 'win32' && tryPowerShellDownload(url, tmpFile)) return readFileSync(tmpFile)
    if (tryCurlDownload(url, tmpFile)) return readFileSync(tmpFile)
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
  throw firstError
}

function findZipEntryKey(files, want) {
  return Object.keys(files).find((k) => {
    const norm = k.replace(/\\/g, '/')
    return norm === want || norm.endsWith(`/${want}`)
  })
}

async function extractZip(buffer, binaryPath, extractedBinary) {
  const dir = path.dirname(binaryPath)
  let fflateError
  try {
    const { unzipSync } = require('fflate')
    const unzipped = unzipSync(new Uint8Array(buffer))
    const key = findZipEntryKey(unzipped, extractedBinary)
    if (!key) throw new Error(`Binary ${extractedBinary} not found in zip`)
    writeFileSync(binaryPath, Buffer.from(unzipped[key]))
    return
  } catch (e) { fflateError = e }
  const tmpDir = path.join(dir, '.tmp-download')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  try {
    const archivePath = path.join(tmpDir, 'archive.zip')
    writeFileSync(archivePath, buffer)
    let extracted = false
    if (process.platform === 'win32') {
      const psCmd = `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { stdio: 'pipe', windowsHide: true })
      if (r.status === 0) extracted = true
    }
    if (!extracted) {
      const r = spawnSync('unzip', ['-o', archivePath, '-d', tmpDir], { stdio: 'pipe' })
      if (r.status !== 0) {
        const unzipErr = r.stderr?.toString().trim() || 'command not found'
        throw new Error(`zip extraction failed (fflate: ${fflateError instanceof Error ? fflateError.message : String(fflateError)}; unzip: ${unzipErr})`)
      }
    }
    const srcBinary = path.join(tmpDir, extractedBinary)
    if (!existsSync(srcBinary)) throw new Error(`Binary not found at expected path: ${srcBinary}`)
    renameSync(srcBinary, binaryPath)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function extractTarGz(buffer, binaryPath, extractedBinary, assetName) {
  const dir = path.dirname(binaryPath)
  const tmpDir = path.join(dir, '.tmp-download')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  try {
    const archivePath = path.join(tmpDir, assetName)
    writeFileSync(archivePath, buffer)
    const result = spawnSync('tar', ['xzf', archivePath, '-C', tmpDir], { stdio: 'pipe' })
    if (result.status !== 0) throw new Error(`tar extract failed: ${result.stderr?.toString()}`)
    const srcBinary = path.join(tmpDir, extractedBinary)
    if (!existsSync(srcBinary)) throw new Error(`Binary not found at expected path: ${srcBinary}`)
    renameSync(srcBinary, binaryPath)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function main() {
  const { target, ext } = getPlatformMapping()
  const assetName = `ripgrep-v${RG_VERSION}-${target}.${ext}`
  const binaryPath = getBinaryPath()
  const binDir = path.dirname(binaryPath)

  const force = process.argv.includes('--force')
  if (!force && existsSync(binaryPath) && statSync(binaryPath).size > 0) {
    console.log(`[ripgrep] Binary already exists at ${binaryPath}, skipping.`)
    return
  }

  console.log(`[ripgrep] Downloading v${RG_VERSION} for ${target}...`)
  const extractedBinary = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const mirrors = [RELEASE_BASE]
  if (RELEASE_BASE === DEFAULT_RELEASE_BASE.replace(/\/$/, '')) mirrors.push(MIRROR_RELEASE_BASE.replace(/\/$/, ''))

  let buffer, lastError
  for (const base of mirrors) {
    const url = `${base}/${assetName}`
    try {
      console.log(`[ripgrep] Trying ${url}`)
      buffer = await downloadUrlToBufferWithFallback(url)
      break
    } catch (e) {
      console.warn(`[ripgrep] Download from ${base} failed: ${e instanceof Error ? e.message : e}`)
      lastError = e
    }
  }
  if (!buffer) throw lastError

  console.log(`[ripgrep] Downloaded ${Math.round(buffer.length / 1024)} KB`)
  mkdirSync(binDir, { recursive: true })

  if (ext === 'tar.gz') {
    await extractTarGz(buffer, binaryPath, extractedBinary, assetName)
  } else {
    await extractZip(buffer, binaryPath, extractedBinary)
  }

  if (process.platform !== 'win32') chmodSync(binaryPath, 0o755)
  console.log(`[ripgrep] Installed to ${binaryPath}`)
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error)
  console.error(`[postinstall] ripgrep download failed (non-fatal): ${msg}`)
  console.error(`[postinstall] You can install ripgrep manually: https://github.com/BurntSushi/ripgrep#installation`)
  process.exit(0)
})
