import type { BunPlugin } from 'bun'

export const ENABLED_FEATURES = new Set([
  // Uncomment features to enable:
  // 'BUILTIN_EXPLORE_PLAN_AGENTS',
  // 'HISTORY_SNIP',
  // 'REACTIVE_COMPACT',
  // 'COMMIT_ATTRIBUTION',
  'KAIROS_CHANNELS',
  // 'KAIROS',
  // 'COORDINATOR_MODE',
  // 'VOICE_MODE',
  // 'BRIDGE_MODE',
  // 'PROACTIVE',
  // 'WEB_BROWSER_TOOL',
  // 'CHICAGO_MCP',
  // 'AGENT_TRIGGERS',
  // 'DAEMON',
])

export function createBunBundlePlugin(): BunPlugin {
  return {
    name: 'bun-bundle-feature-replace',
    setup(build) {
      // Bun's native bun:bundle feature() cannot be overridden by plugins.
      // Instead, do source-level text replacement: for each enabled feature,
      // replace `feature('NAME')` with `true`; for all other feature() calls,
      // replace with `false`. This runs before Bun's own compile-time eval.
      build.onLoad({ filter: /\.(ts|tsx)$/ }, async (args) => {
        let contents = await Bun.file(args.path).text()
        if (!contents.includes('feature(')) return undefined
        for (const feat of ENABLED_FEATURES) {
          contents = contents.replaceAll(`feature('${feat}')`, 'true')
        }
        // Remaining feature() calls → false
        contents = contents.replace(/feature\('[A-Z_]+'\)/g, 'false')
        return { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' }
      })
    },
  }
}
