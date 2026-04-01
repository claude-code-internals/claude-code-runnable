import type { BunPlugin } from 'bun'

export const ENABLED_FEATURES = new Set([
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
])

export function createBunBundlePlugin(): BunPlugin {
  const featuresJson = JSON.stringify([...ENABLED_FEATURES])
  return {
    name: 'bun-bundle-polyfill',
    setup(build) {
      build.onResolve({ filter: /^bun:bundle$/ }, () => ({
        path: 'bun-bundle-polyfill',
        namespace: 'bun-bundle-ns',
      }))
      build.onLoad({ filter: /.*/, namespace: 'bun-bundle-ns' }, () => ({
        contents: `
          const ENABLED_FEATURES = new Set(${featuresJson});
          export function feature(name) { return ENABLED_FEATURES.has(name); }
        `,
        loader: 'js',
      }))
    },
  }
}
