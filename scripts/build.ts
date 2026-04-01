import { plugin } from 'bun'
import { createBunBundlePlugin } from '../config/features'

// Register bun:bundle polyfill for the build
plugin(createBunBundlePlugin())

const result = await Bun.build({
  entrypoints: ['./src/entrypoints/cli.tsx'],
  outdir: './dist',
  target: 'bun',
  sourcemap: 'linked',
  define: {
    'MACRO.VERSION': JSON.stringify('2.1.88-local'),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'MACRO.PACKAGE_URL': JSON.stringify('claude-code-runnable'),
    'MACRO.NATIVE_PACKAGE_URL': JSON.stringify('claude-code-runnable'),
    'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify('file an issue at https://github.com/anthropics/claude-code/issues'),
    'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  },
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
  console.error('Build failed:')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

console.log('Build succeeded → dist/')
