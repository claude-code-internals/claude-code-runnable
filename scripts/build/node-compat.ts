import { readdirSync, readFileSync, writeFileSync } from 'fs'

const OLD = 'var __require = import.meta.require;'
const NEW = `var __require = typeof import.meta.require === "function"
  ? import.meta.require
  : (await import("module")).createRequire(import.meta.url);`

export function patchNodeCompat() {
  const files = readdirSync('dist').filter(f => f.endsWith('.js'))
  let patched = 0
  for (const file of files) {
    const p = `dist/${file}`
    const src = readFileSync(p, 'utf8')
    if (src.includes(OLD)) {
      writeFileSync(p, src.replaceAll(OLD, NEW))
      patched++
    }
  }
  console.log(`[node-compat] Patched ${patched}/${files.length} files`)
}
