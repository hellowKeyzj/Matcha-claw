import {
  definePluginEntry,
  type OpenClawConfig,
  type OpenClawPluginApi,
  type PluginLogger,
} from 'openclaw/plugin-sdk/plugin-entry'
import type { BrowserActionContext, BrowserActionParams } from '../browser-action-contract.js'
import { BROWSER_RELAY_PLUGIN_DESCRIPTION, BROWSER_RELAY_PLUGIN_ID, BROWSER_RELAY_PLUGIN_NAME, DEFAULT_BROWSER_RELAY_PORT, type BrowserBackendMode } from '../manifest.js'
import { IabBrowserClient } from '../iab/client.js'
import type { BrowserRelayServer } from '../relay/server.js'
import type { BrowserControlService } from '../service/browser-control-service.js'
import { createBrowserRelayTool, type BrowserRelayControl } from './browser-relay-tool.js'

type BrowserRelayPluginConfig = {
  mode: BrowserBackendMode
  port: number
}

type GatewayRequestOptions = {
  params: Record<string, unknown>
  respond: (success: boolean, data?: unknown, error?: { code: string; message: string }) => void
}

class BrowserRelayRuntime {
  private server: BrowserRelayServer | null = null
  private control: BrowserControlService | null = null
  private iab: IabBrowserClient | null = null
  private stateDir: string | null = null

  async start(config: BrowserRelayPluginConfig, logger: PluginLogger, stateDir: string): Promise<void> {
    if (this.stateDir === stateDir && (config.mode === 'iab'
      ? this.iab
      : this.server && this.server.port === config.port && this.control)) {
      return
    }

    await this.stop()
    if (config.mode === 'iab') {
      this.iab = new IabBrowserClient(stateDir)
      this.stateDir = stateDir
      return
    }

    const [{ BrowserRelayServer }, { BrowserControlService }] = await Promise.all([
      import('../relay/server.js'),
      import('../service/browser-control-service.js'),
    ])
    const server = new BrowserRelayServer({
      port: config.port,
      logger,
      stateDir,
    })
    await server.start()

    this.server = server
    this.control = new BrowserControlService({
      logger,
      relay: server,
      stateDir,
    })
    this.stateDir = stateDir
  }

  async stop(): Promise<void> {
    const iab = this.iab
    const control = this.control
    const server = this.server
    this.iab = null
    this.control = null
    this.server = null
    this.stateDir = null
    iab?.stop()
    if (control) await control.stop()
    if (server) await server.stop()
  }

  requireControl(mode: BrowserBackendMode): BrowserRelayControl {
    const control = mode === 'iab' ? this.iab : this.control
    if (!control) {
      throw new Error(`browser ${mode} backend not running; refresh the OpenClaw tool context after changing browser settings`)
    }
    return control
  }

  get mode(): BrowserBackendMode {
    if (this.iab) return 'iab'
    if (this.control) return 'relay'
    throw new Error('browser backend not running')
  }
}

const runtime = new BrowserRelayRuntime()

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requestBody(params: Record<string, unknown>): Record<string, unknown> {
  return isRecord(params.body) ? params.body : {}
}

function withEnvelopeDefaults(
  params: Record<string, unknown>,
  envelope: Record<string, unknown>,
): BrowserActionParams {
  const query = isRecord(envelope.query) ? envelope.query : {}
  return {
    ...(typeof envelope.timeoutMs === 'number' && Number.isFinite(envelope.timeoutMs) && !('timeoutMs' in params) ? { timeoutMs: envelope.timeoutMs } : {}),
    ...(asString(query.profile) && !('profile' in params) ? { profile: asString(query.profile) } : {}),
    ...(asString(envelope.target) && !('target' in params) ? { target: asString(envelope.target) } : {}),
    ...(asString(envelope.node) && !('node' in params) ? { node: asString(envelope.node) } : {}),
    ...params,
  } as BrowserActionParams
}

function normalizeBrowserRequestPath(value: unknown): string | undefined {
  const requestPath = asString(value)?.split('?')[0]?.replace(/\/+$/, '')
  return requestPath || undefined
}

function resolveHttpBrowserActionParams(params: Record<string, unknown>): BrowserActionParams {
  const method = asString(params.method)?.toUpperCase()
  const requestPath = normalizeBrowserRequestPath(params.path)
  if (!method || !requestPath) {
    throw new Error('method and path are required for HTTP-shaped browser.request')
  }

  const body = requestBody(params)

  if (method === 'GET' && requestPath === '/tabs') {
    return withEnvelopeDefaults({ action: 'tabs' }, params)
  }
  if (method === 'POST' && requestPath === '/start') {
    return withEnvelopeDefaults({ action: 'start' }, params)
  }
  if (method === 'POST' && requestPath === '/tabs/open') {
    return withEnvelopeDefaults({
      action: 'open',
      url: body.url,
      retain: body.retain,
      sessionKey: body.sessionKey,
    }, params)
  }
  if (method === 'POST' && requestPath === '/tabs/focus') {
    return withEnvelopeDefaults({ action: 'focus', targetId: body.targetId }, params)
  }
  if (method === 'DELETE' && requestPath.startsWith('/tabs/')) {
    return withEnvelopeDefaults({
      action: 'close',
      targetId: decodeURIComponent(requestPath.slice('/tabs/'.length)),
    }, params)
  }
  if (method === 'POST' && requestPath === '/navigate') {
    return withEnvelopeDefaults({ ...body, action: 'navigate' }, params)
  }
  if (method === 'POST' && requestPath === '/screenshot') {
    return withEnvelopeDefaults({ ...body, action: 'screenshot', type: 'png' }, params)
  }
  if (method === 'POST' && requestPath === '/act') {
    const request = isRecord(body.request) ? body.request : body
    return withEnvelopeDefaults({
      ...(isRecord(body.request) ? body : {}),
      action: 'act',
      request,
    }, params)
  }

  throw new Error(`Unsupported HTTP-shaped browser.request route: ${method} ${requestPath}`)
}

function resolveBrowserActionParams(params: Record<string, unknown>): BrowserActionParams {
  return asString(params.action)
    ? params as BrowserActionParams
    : resolveHttpBrowserActionParams(params)
}

function resolvePluginConfig(config: OpenClawConfig | undefined): BrowserRelayPluginConfig {
  const plugins = isRecord(config?.plugins) ? config.plugins : null
  const entries = plugins && isRecord(plugins.entries) ? plugins.entries : null
  const entry = entries && isRecord(entries[BROWSER_RELAY_PLUGIN_ID]) ? entries[BROWSER_RELAY_PLUGIN_ID] : null
  const rawConfig = entry && isRecord(entry.config) ? entry.config : null
  const rawPort = typeof rawConfig?.port === 'number' ? rawConfig.port : Number(rawConfig?.port)
  const mode = rawConfig?.mode ?? 'relay'
  if (mode !== 'iab' && mode !== 'relay') {
    throw new Error('Browser backend mode must be iab or relay; no fallback backend was selected.')
  }

  return {
    mode,
    port:
      Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535
        ? rawPort
        : DEFAULT_BROWSER_RELAY_PORT,
  }
}

async function withGatewayGuard(
  options: Pick<GatewayRequestOptions, 'respond'>,
  task: () => Promise<unknown> | unknown,
): Promise<void> {
  try {
    const data = await task()
    options.respond(true, data)
  } catch (error) {
    options.respond(false, undefined, {
      code: 'browser_relay_error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

export function registerBrowserRelayRuntime(api: OpenClawPluginApi): void {
  api.registerService({
    id: `${BROWSER_RELAY_PLUGIN_ID}.server`,
    async start(ctx) {
      await runtime.start(resolvePluginConfig(ctx.config), ctx.logger, ctx.stateDir)
    },
    async stop() {
      await runtime.stop()
    },
  })

  api.registerGatewayMethod('browser.request', async (options: GatewayRequestOptions) => {
    await withGatewayGuard(options, async () => {
      const mode = runtime.mode
      const control = runtime.requireControl(mode)
      if (mode === 'relay') return await control.handleRequest(resolveBrowserActionParams(options.params))
      const { sessionKey: adminSessionKey, agentId: adminAgentId, workspaceDir, sessionId, ...requestParams } = options.params
      const sessionKey = asString(adminSessionKey)
      const agentId = asString(adminAgentId)
      const adminSessionId = asString(sessionId)
      if (!sessionKey || !agentId || !adminSessionId) {
        throw new Error('In-app browser.request requires explicit administrator sessionKey, agentId and sessionId at the request envelope, not inside body or tool parameters.')
      }
      const context: BrowserActionContext = {
        sessionKey,
        agentId,
        sessionId: adminSessionId,
        ...(asString(workspaceDir) ? { workspaceDir: asString(workspaceDir) } : {}),
      }
      return await control.handleRequest(resolveBrowserActionParams(requestParams), { context })
    })
  }, {
    scope: 'operator.admin',
  })

  api.registerTool({
    contextVersion: 2,
    create(toolCtx) {
      const mode = resolvePluginConfig(toolCtx.getRuntimeConfig?.() ?? toolCtx.runtimeConfig ?? toolCtx.config ?? api.config).mode
      return createBrowserRelayTool(toolCtx, () => runtime.requireControl(mode), mode)
    },
  })

  api.logger.info('[browser-relay] plugin registered')
}

export default definePluginEntry({
  id: BROWSER_RELAY_PLUGIN_ID,
  name: BROWSER_RELAY_PLUGIN_NAME,
  description: BROWSER_RELAY_PLUGIN_DESCRIPTION,
  register(api: OpenClawPluginApi) {
    registerBrowserRelayRuntime(api)
  },
})
