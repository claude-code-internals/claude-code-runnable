import { plugin } from 'bun'
import { createBunBundlePlugin } from './config/features'

plugin(createBunBundlePlugin())
