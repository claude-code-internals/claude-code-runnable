import { rmSync } from 'fs'
import { bundle } from './bundle'
import { patchNodeCompat } from './node-compat'
import { stagePackage } from './stage-package'
import { generateEntrypoints } from './gen-entrypoints'

const start = Date.now()

// Step 1: Clean
rmSync('dist', { recursive: true, force: true })
rmSync('.release', { recursive: true, force: true })

// Step 2-5: Build pipeline
await bundle()
patchNodeCompat()
stagePackage()
generateEntrypoints()

console.log(`Build completed in ${Date.now() - start}ms`)
console.log('Package ready at .release/npm/')
