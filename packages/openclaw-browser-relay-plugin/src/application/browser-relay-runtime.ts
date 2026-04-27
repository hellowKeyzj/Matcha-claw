import type { OpenClawConfig, OpenClawPluginApi, PluginLogger } from 'openclaw/plugin-sdk'
import { definePluginEntry } from 'openclaw/plugin-sdk/core'
import { BROWSER_RELAY_PLUGIN_DESCRIPTION, BROWSER_RELAY_PLUGIN_ID, BROWSER_RELAY_PLUGIN_NAME, DEFAULT_BROWSER_RELAY_PORT } from '../manifest.js'
import { BrowserRelayServer } from '../relay/server.js'
import { BrowserControlService } from '../service/browser-control-service.js'
import { createBrowserRelayTool } from './browser-relay-tool.js'

type GatewayOptions = {
  params: Record<string, unknown>
  respond: (success: boolean, data?: unknown, error?: { code: string; message: string }) => void
}

type BrowserRelayPluginConfig = {
  port: number
}

class BrowserRelayRuntime {
  private server: BrowserRelayServer | null = null
  private control: BrowserControlService | null = null

  async start(config: BrowserRelayPluginConfig, logger: PluginLogger, stateDir: string): Promise<void> {
    if (this.server && this.server.port === config.port && this.control) {
      return
    }

    await this.stop()

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
  }

  async stop(): Promise<void> {
    if (this.control) {
      await this.control.stop()
      this.control = null
    }
    if (this.server) {
      await this.server.stop()
      this.server = null
    }
  }

  requireControl(): BrowserControlService {
    if (!this.control) {
      throw new Error('browser relay not running')
    }
    return this.control
  }
}

const runtime = new BrowserRelayRuntime()

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function resolvePluginConfig(config: OpenClawConfig | undefined): BrowserRelayPluginConfig {
  const plugins = isRecord(config?.plugins) ? config.plugins : null
  const entries = plugins && isRecord(plugins.entries) ? plugins.entries : null
  const entry = entries && isRecord(entries[BROWSER_RELAY_PLUGIN_ID]) ? entries[BROWSER_RELAY_PLUGIN_ID] : null
  const rawConfig = entry && isRecord(entry.config) ? entry.config : null
  const rawPort = typeof rawConfig?.port === 'number' ? rawConfig.port : Number(rawConfig?.port)

  return {
    port:
      Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535
        ? rawPort
        : DEFAULT_BROWSER_RELAY_PORT,
  }
}

async function withGatewayGuard(options: GatewayOptions, task: () => Promise<unknown> | unknown): Promise<void> {
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

  api.registerGatewayMethod('browser.request', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => runtime.requireControl().handleRequest(options.params))
  })

  api.registerTool((toolCtx) =>
    createBrowserRelayTool(toolCtx, () => runtime.requireControl()),
  )

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
