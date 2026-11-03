import { createInterface } from 'readline'
import { z } from 'zod/v4'
import { setFlagSettingsPath } from '../../bootstrap/state.js'
import { enableConfigs } from '../../utils/config.js'
import { eagerParseCliFlag } from '../../utils/cliArgs.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { expandEnvVars, filterMcpServersByPolicy } from './config.js'
import {
  getMcpOAuthCredentialState,
  performMCPOAuthFlow,
  revokeServerTokens,
} from './auth.js'
import { McpHTTPServerConfigSchema, McpSSEServerConfigSchema } from './types.js'

const Initialization = z.strictObject({
  name: z.string().min(1),
  server: z.union([
    McpHTTPServerConfigSchema().strict(),
    McpSSEServerConfigSchema().strict(),
  ]),
  action: z.enum(['start', 'status', 'logout']),
})

// Internal MCP management transport only: no session, transcript, model or tool connection.
export async function runMcpOAuthControl(args: string[]): Promise<void> {
  const settings = eagerParseCliFlag('--settings', args)
  if (settings) setFlagSettingsPath(settings)
  resetSettingsCache()
  enableConfigs()
  const controller = new AbortController()
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('close', () => {
    controller.abort()
  })
  const respond = (response: Record<string, unknown>) => {
    // Do not use slowOperations JSON wrappers on this private handoff.
    process.stdout.write(JSON.stringify(response) + '\n')
  }
  try {
    const iterator = lines[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done || first.value.length > 64 * 1024)
      throw new Error('Invalid MCP OAuth initialization')
    const { name, server, action } = Initialization.parse(
      JSON.parse(first.value),
    )
    const { expanded, missingVars } = expandEnvVars(server)
    if (expanded.type !== 'http' && expanded.type !== 'sse')
      throw new Error('Invalid MCP OAuth transport')
    if (
      missingVars.length ||
      expanded.oauth?.xaa ||
      !filterMcpServersByPolicy({ [name]: expanded }).allowed[name]
    ) {
      throw new Error('MCP OAuth configuration unavailable')
    }
    let failed = false
    if (action === 'start') {
      try {
        await performMCPOAuthFlow(
          name,
          expanded,
          authorizationUrl => {
            respond({ state: 'authorizing', authorizationUrl })
          },
          controller.signal,
          { skipBrowserOpen: true },
        )
      } catch {
        failed = !controller.signal.aborted
      }
    } else if (action === 'logout') {
      const timeout = setTimeout(() => {
        controller.abort()
      }, 10_000)
      try {
        await revokeServerTokens(name, expanded, { signal: controller.signal })
      } finally {
        clearTimeout(timeout)
      }
    }
    const credentials = getMcpOAuthCredentialState(name, expanded)
    respond({
      state:
        credentials === 'authorized'
          ? credentials
          : failed
            ? 'failed'
            : credentials,
    })
  } catch {
    respond({ state: 'unavailable' })
    process.exitCode = 1
  } finally {
    lines.close()
  }
}
