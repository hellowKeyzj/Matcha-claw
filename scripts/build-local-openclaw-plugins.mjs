#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LOCAL_OPENCLAW_PLUGIN_BUILD_TARGETS,
  buildManagedOpenClawPlugins,
} from './lib/openclaw-local-plugin-builder.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const selectedPluginIds = process.argv.slice(2)

await buildManagedOpenClawPlugins({
  rootDir: ROOT,
  ...(selectedPluginIds.length > 0 ? { pluginIds: selectedPluginIds } : {}),
})

const builtPluginIds = selectedPluginIds.length > 0
  ? selectedPluginIds
  : LOCAL_OPENCLAW_PLUGIN_BUILD_TARGETS.map((target) => target.pluginId)

console.log(`Built local OpenClaw plugins: ${builtPluginIds.join(', ')}`)
