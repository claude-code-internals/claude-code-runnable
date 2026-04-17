import { writeFileSync, mkdirSync, cpSync, readdirSync } from 'fs'
import rootPkg from '../../package.json'
import { RELEASE_MANIFEST } from './release-manifest'

export function stagePackage() {
  mkdirSync('.release/npm/vendor/ripgrep', { recursive: true })

  // Copy bundled files
  cpSync('dist/cli.js', '.release/npm/cli.js')
  for (const chunk of readdirSync('dist').filter(f => f.startsWith('chunk-'))) {
    cpSync(`dist/${chunk}`, `.release/npm/${chunk}`)
  }

  // Copy postinstall script
  cpSync('scripts/postinstall.cjs', '.release/npm/postinstall.cjs')

  // Generate package.json
  const distPkg = {
    ...RELEASE_MANIFEST.metadata,
    version: rootPkg.version,
    bin: {
      'open-claude-code': './cli-node.js',
      'open-claude-code-bun': './cli-bun.js',
    },
    type: 'module',
    engines: { node: '>=18.0.0' },
    scripts: { postinstall: 'node ./postinstall.cjs' },
    dependencies: RELEASE_MANIFEST.dependencies,
    optionalDependencies: RELEASE_MANIFEST.optionalDependencies,
    peerDependencies: RELEASE_MANIFEST.peerDependencies,
    peerDependenciesMeta: RELEASE_MANIFEST.peerDependenciesMeta,
  }

  writeFileSync('.release/npm/package.json', JSON.stringify(distPkg, null, 2))
  console.log('[stage-package] .release/npm/ assembled')
}
