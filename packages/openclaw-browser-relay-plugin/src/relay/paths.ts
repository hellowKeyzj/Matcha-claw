import os from 'node:os'
import path from 'node:path'
import { BROWSER_RELAY_PLUGIN_ID } from '../manifest.js'

export function resolveRelayStateDir(stateDir?: string): string {
  const explicitStateDir = stateDir?.trim()
  if (explicitStateDir) {
    return path.resolve(explicitStateDir)
  }
  const envStateDir = process.env.OPENCLAW_STATE_DIR?.trim()
  if (envStateDir) {
    return path.resolve(envStateDir)
  }
  return path.join(os.homedir(), '.openclaw')
}

export function resolveRelayPluginStatePath(fileName: string, stateDir?: string): string {
  return path.join(resolveRelayStateDir(stateDir), 'plugins', BROWSER_RELAY_PLUGIN_ID, fileName)
}
