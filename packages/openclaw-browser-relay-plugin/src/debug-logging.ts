import type { PluginLogger } from './plugin-types.js'

export function isRelayDebugEnabled(): boolean {
  return process.env.MATCHACLAW_TRACE === '1'
}

export function relayDebugInfo(logger: PluginLogger, message: () => string): void {
  if (!isRelayDebugEnabled()) return
  logger.info?.(message())
}

export function relayDebugWarn(logger: PluginLogger, message: () => string): void {
  if (!isRelayDebugEnabled()) return
  logger.warn?.(message())
}
