import { getMacroDefines } from '../defines'
import { RELEASE_FEATURES } from './release-features'

export async function bundle() {
  console.log(`[bundle] Features: ${RELEASE_FEATURES.join(', ')}`)

  const featurePlugin: import('bun').BunPlugin = {
    name: 'release-features',
    setup(build) {
      build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
        const text = await Bun.file(args.path).text()
        // Replace feature('X') calls: enabled → true, disabled → false
        const patched = text.replace(/feature\(['"]([^'"]+)['"]\)/g, (_match, flag) =>
          RELEASE_FEATURES.includes(flag) ? 'true' : 'false'
        )
        return { contents: patched, loader: args.loader as import('bun').Loader }
      })
    },
  }

  const result = await Bun.build({
    entrypoints: ['./src/entrypoints/cli.tsx'],
    outdir: './dist',
    target: 'bun',
    splitting: true,
    define: getMacroDefines(),
    plugins: [featurePlugin],
    external: [
      '@anthropic-ai/bedrock-sdk',
      '@anthropic-ai/foundry-sdk',
      '@anthropic-ai/vertex-sdk',
      '@azure/identity',
      '@aws-sdk/client-bedrock',
      '@aws-sdk/client-sts',
      '@opentelemetry/exporter-logs-otlp-grpc',
      '@opentelemetry/exporter-logs-otlp-http',
      '@opentelemetry/exporter-logs-otlp-proto',
      '@opentelemetry/exporter-metrics-otlp-grpc',
      '@opentelemetry/exporter-metrics-otlp-http',
      '@opentelemetry/exporter-metrics-otlp-proto',
      '@opentelemetry/exporter-prometheus',
      '@opentelemetry/exporter-trace-otlp-grpc',
      '@opentelemetry/exporter-trace-otlp-http',
      '@opentelemetry/exporter-trace-otlp-proto',
      'sharp',
      'turndown',
    ],
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error('Bundle failed')
  }

  console.log(`[bundle] Done → dist/ (${result.outputs.length} files)`)
}
