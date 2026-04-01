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

if (!('MACRO' in globalThis)) {
  const macro: MacroConfig = {
    VERSION: process.env.CLAUDE_CODE_LOCAL_VERSION ?? pkg.version,
    BUILD_TIME: process.env.CLAUDE_CODE_LOCAL_BUILD_TIME ?? new Date().toISOString(),
    PACKAGE_URL: process.env.CLAUDE_CODE_LOCAL_PACKAGE_URL ?? pkg.name,
    NATIVE_PACKAGE_URL: process.env.CLAUDE_CODE_LOCAL_PACKAGE_URL ?? pkg.name,
    VERSION_CHANGELOG: '',
    ISSUES_EXPLAINER: 'file an issue at https://github.com/anthropics/claude-code/issues',
    FEEDBACK_CHANNEL: 'github',
  }

  ;(globalThis as typeof globalThis & { MACRO: MacroConfig }).MACRO = macro
}

process.env.CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH ??= '1'

await import('./src/entrypoints/cli.tsx')
