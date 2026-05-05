import type { PluginLogger } from 'openclaw/plugin-sdk'

// Flip this on locally when you need relay/playwright trace logs again.
export const ENABLE_BROWSER_RELAY_DEBUG_LOGS = false

export function relayDebugInfo(logger: PluginLogger, message: string): void {
  if (!ENABLE_BROWSER_RELAY_DEBUG_LOGS) return
  logger.info?.(message)
}

export function relayDebugWarn(logger: PluginLogger, message: string): void {
  if (!ENABLE_BROWSER_RELAY_DEBUG_LOGS) return
  logger.warn?.(message)
}
