import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'

export function logTaskPipeline(api: OpenClawPluginApi, event: string, count: number): void {
  if (process.env.MATCHACLAW_TRACE !== '1') return
  api.logger?.debug?.(`[task-pipeline] plugin.${event} count=${count}`)
}
