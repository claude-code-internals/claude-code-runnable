import { writeFileSync, chmodSync } from 'fs'

export function generateEntrypoints() {
  writeFileSync(
    '.release/npm/cli-bun.js',
    '#!/usr/bin/env bun\nimport "./cli.js"\n'
  )
  writeFileSync(
    '.release/npm/cli-node.js',
    '#!/usr/bin/env node\nimport "./cli.js"\n'
  )
  // chmod 755 (no-op on Windows, safe to call)
  try {
    chmodSync('.release/npm/cli-bun.js', 0o755)
    chmodSync('.release/npm/cli-node.js', 0o755)
  } catch { /* Windows */ }
  console.log('[gen-entrypoints] cli-bun.js + cli-node.js written')
}
