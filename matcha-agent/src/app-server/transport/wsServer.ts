import { Buffer } from 'node:buffer'
import {
  APP_SERVER_PROTOCOL_VERSION,
  type AppServerConfig,
} from '../protocol/types.js'
import { ClientHub, type ClientHubCloseReason } from './clientHub.js'
import type { AppServerPorts } from './ports.js'
import { ProtocolGateway } from './protocolGateway.js'

const WEBSOCKET_AUTH_PROTOCOL_PREFIX = 'rcs.auth.'

type WsClientData = {
  clientId: string
}

export type WsServerOptions = {
  config: Pick<
    AppServerConfig,
    'host' | 'port' | 'authToken' | 'maxClientQueueSize'
  >
  ports: AppServerPorts
  serverVersion: string
  clientHub: ClientHub
  createClientId?: () => string
}

export class WsServer {
  private readonly gateway: ProtocolGateway
  private readonly createClientId: () => string
  private readonly clientSockets = new Map<
    string,
    Bun.ServerWebSocket<WsClientData>
  >()
  private server: Bun.Server<WsClientData> | undefined

  constructor(private readonly options: WsServerOptions) {
    this.gateway = new ProtocolGateway(options.ports)
    this.createClientId = options.createClientId ?? createDefaultClientId
  }

  start(): Bun.Server<WsClientData> {
    if (this.server) return this.server

    this.server = Bun.serve<WsClientData>({
      hostname: this.options.config.host,
      port: this.options.config.port,
      fetch: (request, server) => this.handleHttpRequest(request, server),
      websocket: {
        open: ws => {
          this.options.clientHub.registerClient(payload => {
            ws.send(payload)
          }, ws.data.clientId)
          this.clientSockets.set(ws.data.clientId, ws)
        },
        message: async (ws, message) => {
          if (typeof message !== 'string') {
            ws.close(1003, 'text messages only')
            return
          }

          const response = await this.gateway.handleTextMessage(
            ws.data.clientId,
            message,
          )
          if (response) ws.send(response)
        },
        close: ws => {
          this.clientSockets.delete(ws.data.clientId)
          this.options.clientHub.close(ws.data.clientId, 'clientClosed')
        },
      },
    })

    return this.server
  }

  stop(closeActiveConnections = true): void {
    for (const clientId of this.clientSockets.keys()) {
      this.options.clientHub.close(clientId, 'clientClosed')
    }
    this.clientSockets.clear()
    this.server?.stop(closeActiveConnections)
    this.server = undefined
  }

  closeClient(clientId: string, reason: ClientHubCloseReason): void {
    const socket = this.clientSockets.get(clientId)
    this.clientSockets.delete(clientId)
    if (!socket) return

    try {
      socket.close(closeCodeForHubReason(reason), reason)
    } catch {
      // The hub has already discarded its queue; socket close is best-effort cleanup.
    }
  }

  private handleHttpRequest(
    request: Request,
    server: Bun.Server<WsClientData>,
  ): Response | undefined {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, version: this.options.serverVersion })
    }

    if (url.pathname === '/version') {
      return jsonResponse({
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        serverVersion: this.options.serverVersion,
      })
    }

    if (url.pathname !== '/ws') {
      return jsonResponse({ error: 'not found' }, 404)
    }

    if (!this.isAuthorized(request)) {
      return jsonResponse({ error: 'unauthorized' }, 401)
    }

    if (!isAllowedWebSocketOrigin(request, this.options.config.host)) {
      return jsonResponse({ error: 'forbidden origin' }, 403)
    }

    const upgraded = server.upgrade(request, {
      data: { clientId: this.createClientId() },
    })
    if (upgraded) return undefined

    return jsonResponse({ error: 'websocket upgrade failed' }, 400)
  }

  private isAuthorized(request: Request): boolean {
    const expectedToken = this.options.config.authToken
    if (!expectedToken) return true

    const bearerToken = readBearerToken(request.headers.get('authorization'))
    if (bearerToken === expectedToken) return true

    return (
      readWebSocketProtocolToken(
        request.headers.get('sec-websocket-protocol'),
      ) === expectedToken
    )
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function readBearerToken(headerValue: string | null): string | undefined {
  if (!headerValue) return undefined
  const prefix = 'Bearer '
  if (!headerValue.startsWith(prefix)) return undefined
  const token = headerValue.slice(prefix.length).trim()
  return token === '' ? undefined : token
}

export function readWebSocketProtocolToken(
  headerValue: string | null,
): string | undefined {
  if (!headerValue) return undefined

  for (const protocol of headerValue.split(',')) {
    const trimmedProtocol = protocol.trim()
    if (trimmedProtocol.startsWith(WEBSOCKET_AUTH_PROTOCOL_PREFIX)) {
      const token = decodeWebSocketAuthToken(
        trimmedProtocol.slice(WEBSOCKET_AUTH_PROTOCOL_PREFIX.length),
      )
      if (token) return token
    }
  }

  return undefined
}

function decodeWebSocketAuthToken(encodedToken: string): string | undefined {
  if (encodedToken === '') return undefined
  try {
    const token = Buffer.from(encodedToken, 'base64url').toString('utf8')
    return token === '' ? undefined : token
  } catch {
    return undefined
  }
}

export function isAllowedWebSocketOrigin(
  request: Request,
  host: string,
): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true

  let originUrl: URL
  try {
    originUrl = new URL(origin)
  } catch {
    return false
  }

  return isLoopbackHost(host) && isLoopbackHost(originUrl.hostname)
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function closeCodeForHubReason(reason: ClientHubCloseReason): number {
  switch (reason) {
    case 'clientClosed':
    case 'clientReplaced':
      return 1000
    case 'queueOverflow':
    case 'sendFailed':
      return 1011
  }
}

function createDefaultClientId(): string {
  return crypto.randomUUID()
}
