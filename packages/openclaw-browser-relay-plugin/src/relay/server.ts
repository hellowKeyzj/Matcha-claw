import type { PluginLogger } from 'openclaw/plugin-sdk'
import { createCipheriv, createDecipheriv, privateDecrypt, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { RELAY_PRIVATE_KEY_PEM } from './keypair.js'
import {
  claimRelayPortOwnership,
  ensureRelayPortOwnership,
  releaseRelayPortOwnership,
} from './ownership.js'

export const RELAY_PROTOCOL_VERSION = 1
export const RELAY_AUTH_HEADER = 'x-phoenix-relay-token'

const ENCRYPTED_PREFIX = 'E:'
const AES_KEY_BYTES = 32
const AES_GCM_IV_BYTES = 12
const AES_GCM_TAG_BYTES = 16
const EXTENSION_HELLO_TIMEOUT_MS = 5_000
const EXTENSION_REQUEST_TIMEOUT_MS = 15_000
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

type RelayTargetInfo = {
  targetId: string
  type: string
  title?: string
  url?: string
  attached?: boolean
  openerId?: string
  browserContextId?: string
  canAccessOpener?: boolean
}

type ConnectedTarget = {
  sessionId: string
  targetId: string
  targetInfo: RelayTargetInfo
  physical: boolean
}

type PendingExtensionRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type CdpClientState = {
  autoAttachPrimed: boolean
  discoverPrimed: boolean
}

type RelayHelloParams = {
  protocolVersion?: number
  encryptedSessionKey?: string
}

export type BrowserRelayServerOptions = {
  port: number
  logger: PluginLogger
  stateDir?: string
}

export type BrowserRelayStatus = {
  running: boolean
  port: number | null
  extensionConnected: boolean
  handshakeOk: boolean
  tabCount: number
}

function isLoopback(remoteAddress?: string | null): boolean {
  return remoteAddress ? LOOPBACK_ADDRESSES.has(remoteAddress) : false
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : undefined
}

function toText(data: RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function normalizeTargetInfo(raw: Partial<RelayTargetInfo> & Pick<RelayTargetInfo, 'targetId'>): RelayTargetInfo {
  return {
    targetId: raw.targetId,
    type: raw.type ?? 'page',
    title: raw.title ?? '',
    url: raw.url ?? '',
    attached: raw.attached ?? true,
    openerId: raw.openerId,
    browserContextId: raw.browserContextId ?? 'default',
    canAccessOpener: raw.canAccessOpener ?? false,
  }
}

function writeJson(res: ServerResponse, statusCode: number, data: unknown, headers?: Record<string, string>): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(data))
}

function decryptSessionKey(encryptedSessionKey: string): Buffer {
  const encrypted = Buffer.from(encryptedSessionKey, 'base64')
  const decrypted = privateDecrypt(
    {
      key: RELAY_PRIVATE_KEY_PEM,
      oaepHash: 'sha256',
    },
    encrypted,
  )
  if (decrypted.length !== AES_KEY_BYTES) {
    throw new Error(`Invalid session key length: ${decrypted.length}`)
  }
  return decrypted
}

function encryptWireMessage(sessionKey: Buffer, plaintext: string): string {
  const iv = randomBytes(AES_GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', sessionKey, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENCRYPTED_PREFIX}${Buffer.concat([iv, ciphertext, tag]).toString('base64')}`
}

function decryptWireMessage(sessionKey: Buffer, wireMessage: string): string {
  if (!wireMessage.startsWith(ENCRYPTED_PREFIX)) return wireMessage
  const payload = Buffer.from(wireMessage.slice(ENCRYPTED_PREFIX.length), 'base64')
  const iv = payload.subarray(0, AES_GCM_IV_BYTES)
  const ciphertext = payload.subarray(AES_GCM_IV_BYTES, payload.length - AES_GCM_TAG_BYTES)
  const tag = payload.subarray(payload.length - AES_GCM_TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', sessionKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export class BrowserRelayServer {
  private readonly requestedPort: number
  private readonly logger: PluginLogger
  private readonly stateDir: string | undefined
  private readonly authToken = randomBytes(32).toString('base64url')

  private httpServer: Server | null = null
  private extensionWss: WebSocketServer | null = null
  private cdpWss: WebSocketServer | null = null
  private extensionWs: WebSocket | null = null
  private extensionSessionKey: Buffer | null = null
  private handshakeOk = false
  private nextRequestId = 1
  private pendingExtensionRequests = new Map<number, PendingExtensionRequest>()
  private cdpClients = new Set<WebSocket>()
  private cdpClientState = new WeakMap<WebSocket, CdpClientState>()
  private connectedTargets = new Map<string, ConnectedTarget>()
  private pendingTargetUrls = new Map<string, string>()
  private actualPort: number | null = null

  constructor(options: BrowserRelayServerOptions) {
    this.requestedPort = options.port
    this.logger = options.logger
    this.stateDir = options.stateDir
  }

  get port(): number | null {
    return this.actualPort
  }

  get relayPort(): number | null {
    return this.actualPort
  }

  get hasExtensionConnection(): boolean {
    return this.extensionWs?.readyState === WebSocket.OPEN && this.handshakeOk
  }

  get authHeaders(): Record<string, string> {
    return { [RELAY_AUTH_HEADER]: this.authToken }
  }

  get status(): BrowserRelayStatus {
    return {
      running: this.httpServer !== null,
      port: this.actualPort,
      extensionConnected: this.extensionWs?.readyState === WebSocket.OPEN,
      handshakeOk: this.handshakeOk,
      tabCount: this.connectedTargets.size,
    }
  }

  listTabs(): Array<{ sessionId: string; targetId: string; title: string; url: string; physical: boolean }> {
    return Array.from(this.connectedTargets.values()).map((target) => ({
      sessionId: target.sessionId,
      targetId: target.targetId,
      title: target.targetInfo.title ?? '',
      url: target.targetInfo.url ?? '',
      physical: target.physical,
    }))
  }

  listAttachments(): Array<{ sessionId: string; targetId: string; title: string; url: string }> {
    return this.getInspectablePageTargets().map((target) => ({
      sessionId: target.sessionId,
      targetId: target.targetId,
      title: target.targetInfo.title ?? '',
      url: target.targetInfo.url ?? '',
    }))
  }

  getTargetIdForSession(sessionId: string): string | undefined {
    return this.connectedTargets.get(sessionId)?.targetId
  }

  getTargetUrl(targetId: string): string | undefined {
    return Array.from(this.connectedTargets.values()).find((target) => target.targetId === targetId)?.targetInfo.url ?? this.pendingTargetUrls.get(targetId)
  }

  updateTargetUrl(targetId: string, url: string): void {
    if (!targetId || !url) return
    this.pendingTargetUrls.set(targetId, url)
    for (const [sessionId, target] of this.connectedTargets.entries()) {
      if (target.targetId !== targetId) continue
      this.connectedTargets.set(sessionId, {
        ...target,
        targetInfo: {
          ...target.targetInfo,
          url,
        },
      })
    }
  }

  async start(): Promise<void> {
    if (this.httpServer) return

    await ensureRelayPortOwnership({
      port: this.requestedPort,
      logger: this.logger,
      stateDir: this.stateDir,
    })

    this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res))
    this.extensionWss = new WebSocketServer({ noServer: true })
    this.cdpWss = new WebSocketServer({ noServer: true })

    this.httpServer.on('upgrade', (req, socket, head) => {
      if (!isLoopback(req.socket.remoteAddress)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }

      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.requestedPort}`)
      if (url.pathname === '/extension') {
        const origin = getHeader(req, 'origin')
        if (origin && !origin.startsWith('chrome-extension://')) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.destroy()
          return
        }
        this.extensionWss?.handleUpgrade(req, socket, head, (ws) => {
          this.extensionWss?.emit('connection', ws, req)
        })
        return
      }

      if (url.pathname === '/cdp') {
        const authHeader = getHeader(req, RELAY_AUTH_HEADER)
        if (authHeader !== this.authToken) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
        if (!this.handshakeOk) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
          socket.destroy()
          return
        }
        this.cdpWss?.handleUpgrade(req, socket, head, (ws) => {
          this.cdpWss?.emit('connection', ws, req)
        })
        return
      }

      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
    })

    this.extensionWss.on('connection', (ws) => this.handleExtensionConnection(ws))
    this.cdpWss.on('connection', (ws) => this.handleCdpConnection(ws))

    try {
      await new Promise<void>((resolve, reject) => {
        const server = this.httpServer
        if (!server) {
          reject(new Error('HTTP server missing'))
          return
        }
        const onError = (error: Error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          const address = server.address()
          if (!address || typeof address === 'string') {
            reject(new Error('Failed to resolve relay listen address'))
            return
          }
          this.actualPort = address.port
          this.logger.info(
            `[browser-relay] listening on 127.0.0.1:${this.actualPort} (HTTP /json/*, WS /extension, WS /cdp)`,
          )
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.requestedPort, '127.0.0.1')
      })

      await claimRelayPortOwnership({
        port: this.actualPort ?? this.requestedPort,
        logger: this.logger,
        stateDir: this.stateDir,
      })
    } catch (error) {
      await this.disposeFailedStart()
      throw error
    }
  }

  async stop(): Promise<void> {
    for (const pending of this.pendingExtensionRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Relay stopping'))
    }
    this.pendingExtensionRequests.clear()

    this.extensionWs?.close(1001, 'server stopping')
    this.extensionWs = null
    this.extensionSessionKey = null
    this.handshakeOk = false

    for (const client of this.cdpClients) {
      client.close(1001, 'server stopping')
    }
    this.cdpClients.clear()
    this.connectedTargets.clear()
    this.pendingTargetUrls.clear()

    await new Promise<void>((resolve) => {
      this.extensionWss?.close()
      this.cdpWss?.close()
      this.extensionWss = null
      this.cdpWss = null

      if (!this.httpServer) {
        this.actualPort = null
        resolve()
        return
      }

      const server = this.httpServer
      this.httpServer = null
      server.close(() => {
        this.actualPort = null
        resolve()
      })
    })

    await releaseRelayPortOwnership({
      port: this.requestedPort,
      stateDir: this.stateDir,
    })
  }

  private async disposeFailedStart(): Promise<void> {
    this.extensionWs = null
    this.extensionSessionKey = null
    this.handshakeOk = false
    this.connectedTargets.clear()
    this.pendingTargetUrls.clear()
    this.cdpClients.clear()
    this.pendingExtensionRequests.clear()

    await new Promise<void>((resolve) => {
      this.extensionWss?.close()
      this.cdpWss?.close()
      this.extensionWss = null
      this.cdpWss = null

      if (!this.httpServer) {
        this.actualPort = null
        resolve()
        return
      }

      const server = this.httpServer
      this.httpServer = null
      server.close(() => {
        this.actualPort = null
        resolve()
      })
    })
  }

  async openTarget(url: string): Promise<{ targetId: string }> {
    const result = await this.sendToExtension('Target.createTarget', { url })
    const targetId = typeof result?.targetId === 'string' ? result.targetId : ''
    if (!targetId) throw new Error('Target.createTarget returned no targetId')
    this.pendingTargetUrls.set(targetId, url)
    return { targetId }
  }

  async focusTarget(targetId: string): Promise<void> {
    const sessionId = this.findSessionId(targetId)
    await this.sendToExtension('Target.activateTarget', { targetId }, sessionId)
  }

  async closeTarget(targetId: string): Promise<void> {
    const sessionId = this.findSessionId(targetId)
    await this.sendToExtension('Target.closeTarget', { targetId }, sessionId)
  }

  async evaluate(targetId: string, expression: string): Promise<unknown> {
    const sessionId = this.findSessionId(targetId)
    return this.sendToExtension('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
  }

  async closeAllAgentTabs(): Promise<unknown> {
    return this.sendToExtension('Target.closeAllAgentTabs', {})
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const requestUrl = req.url ?? '/'
    const pathname = requestUrl.split('?')[0] ?? '/'

    if (req.method === 'HEAD' && pathname === '/') {
      res.writeHead(200, { 'Content-Length': '0', Connection: 'close' })
      res.end()
      return
    }

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK')
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': RELAY_AUTH_HEADER,
      })
      res.end()
      return
    }

    if (req.method === 'GET' && pathname === '/status') {
      writeJson(
        res,
        200,
        {
          connected: this.hasExtensionConnection,
          tabCount: this.hasExtensionConnection ? this.connectedTargets.size : 0,
          relayPort: this.actualPort,
          connectionType: this.hasExtensionConnection ? 'extension' : 'none',
          availability: {
            extension: {
              available: this.hasExtensionConnection,
              tabCount: this.hasExtensionConnection ? this.connectedTargets.size : 0,
            },
          },
        },
        { 'Access-Control-Allow-Origin': '*' },
      )
      return
    }

    if (req.method === 'GET' && pathname === '/version') {
      writeJson(
        res,
        200,
        this.handshakeOk
          ? { status: 'compatible', protocolVersion: RELAY_PROTOCOL_VERSION }
          : { status: 'unknown', error: 'no_extension_connected' },
        { 'Access-Control-Allow-Origin': '*' },
      )
      return
    }

    if (req.method === 'POST' && pathname === '/cdp-reconnect') {
      this.handleExtensionClose()
      writeJson(res, 200, { ok: true }, { 'Access-Control-Allow-Origin': '*' })
      return
    }

    if (req.method === 'GET' && pathname === '/diagnostics') {
      if (getHeader(req, RELAY_AUTH_HEADER) !== this.authToken) {
        res.writeHead(401)
        res.end('Unauthorized')
        return
      }
      const physicalTargets = this.getInspectablePageTargets()
      writeJson(res, 200, {
        extensionConnected: this.handshakeOk,
        physicalTargets: physicalTargets.length,
        virtualTargets: this.connectedTargets.size - physicalTargets.length,
        cdpClients: this.cdpClients.size,
        pendingRequests: this.pendingExtensionRequests.size,
      })
      return
    }

    if (!pathname.startsWith('/json')) {
      res.writeHead(404)
      res.end()
      return
    }

    if (getHeader(req, RELAY_AUTH_HEADER) !== this.authToken) {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }

    const cdpUrl = `ws://127.0.0.1:${this.actualPort}/cdp`
    if (new Set(['/json/version', '/json/version/']).has(pathname) && (req.method === 'GET' || req.method === 'PUT')) {
      writeJson(res, 200, {
        Browser: 'OpenClaw/browser-relay',
        'Protocol-Version': '1.3',
        ...(this.handshakeOk ? { webSocketDebuggerUrl: cdpUrl } : {}),
      })
      return
    }

    if (new Set(['/json', '/json/', '/json/list', '/json/list/']).has(pathname) && (req.method === 'GET' || req.method === 'PUT')) {
      writeJson(
        res,
        200,
        this.getInspectablePageTargets().map((target) => ({
          id: target.targetId,
          type: target.targetInfo.type,
          title: target.targetInfo.title ?? '',
          description: target.targetInfo.title ?? '',
          url: target.targetInfo.url ?? '',
          webSocketDebuggerUrl: cdpUrl,
          devtoolsFrontendUrl: `/devtools/inspector.html?ws=${cdpUrl.replace('ws://', '')}`,
        })),
      )
      return
    }

    const activateMatch = pathname.match(/^\/json\/activate\/(.+)$/)
    if (activateMatch && (req.method === 'GET' || req.method === 'PUT')) {
      void this.focusTarget(decodeURIComponent(activateMatch[1] ?? ''))
        .then(() => {
          res.writeHead(200)
          res.end('OK')
        })
        .catch((error) => {
          res.writeHead(500)
          res.end(String(error))
        })
      return
    }

    const closeMatch = pathname.match(/^\/json\/close\/(.+)$/)
    if (closeMatch && (req.method === 'GET' || req.method === 'PUT')) {
      void this.closeTarget(decodeURIComponent(closeMatch[1] ?? ''))
        .then(() => {
          res.writeHead(200)
          res.end('OK')
        })
        .catch((error) => {
          res.writeHead(500)
          res.end(String(error))
        })
      return
    }

    res.writeHead(404)
    res.end()
  }

  private handleExtensionConnection(ws: WebSocket): void {
    if (this.extensionWs && this.extensionWs.readyState === WebSocket.OPEN) {
      this.extensionWs.close(1000, 'replaced by new connection')
    }

    this.extensionWs = ws
    this.extensionSessionKey = null
    this.handshakeOk = false

    const helloTimer = setTimeout(() => {
      this.logger.warn?.('[browser-relay] extension did not send Extension.hello within timeout')
      ws.close(4001, 'Protocol handshake timeout')
    }, EXTENSION_HELLO_TIMEOUT_MS)

    const onHandshakeMessage = (raw: RawData) => {
      const text = toText(raw)
      let message: { method?: string; params?: RelayHelloParams } | null = null
      try {
        message = JSON.parse(text)
      } catch {
        return
      }
      if (message?.method !== 'Extension.hello') {
        return
      }

      clearTimeout(helloTimer)
      const params = message.params ?? {}
      if (params.protocolVersion !== RELAY_PROTOCOL_VERSION) {
        this.sendExtensionMessage(
          {
            method: 'Extension.helloAck',
            params: {
              status: 'version_mismatch',
              requiredVersion: RELAY_PROTOCOL_VERSION,
            },
          },
          false,
        )
        ws.close(4001, 'Protocol version mismatch')
        return
      }

      if (typeof params.encryptedSessionKey !== 'string' || !params.encryptedSessionKey) {
        this.sendExtensionMessage(
          {
            method: 'Extension.helloAck',
            params: {
              status: 'encryption_required',
            },
          },
          false,
        )
        ws.close(4002, 'Encrypted session key required')
        return
      }

      try {
        this.extensionSessionKey = decryptSessionKey(params.encryptedSessionKey)
      } catch (error) {
        this.logger.warn?.(`[browser-relay] failed to decrypt session key: ${String(error)}`)
        ws.close(4003, 'Invalid encrypted session key')
        return
      }

      this.handshakeOk = true
      this.sendExtensionMessage(
        {
          method: 'Extension.helloAck',
          params: {
            status: 'ok',
            encrypted: true,
          },
        },
        true,
      )

      ws.off('message', onHandshakeMessage)
      ws.on('message', (payload) => this.onExtensionMessage(payload))
    }

    ws.on('message', onHandshakeMessage)
    ws.on('close', () => {
      clearTimeout(helloTimer)
      if (this.extensionWs === ws) this.handleExtensionClose()
    })
    ws.on('error', () => {
      clearTimeout(helloTimer)
      if (this.extensionWs === ws) this.handleExtensionClose()
    })
  }

  private handleExtensionClose(): void {
    for (const pending of this.pendingExtensionRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Extension disconnected'))
    }
    this.pendingExtensionRequests.clear()
    this.extensionWs = null
    this.extensionSessionKey = null
    this.handshakeOk = false
    this.connectedTargets.clear()
    for (const client of this.cdpClients) {
      client.close(1011, 'extension disconnected')
    }
    this.cdpClients.clear()
  }

  private handleCdpConnection(ws: WebSocket): void {
    this.cdpClients.add(ws)
    this.cdpClientState.set(ws, {
      autoAttachPrimed: false,
      discoverPrimed: false,
    })

    ws.on('message', async (raw) => {
      let message: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string } | null = null
      try {
        message = JSON.parse(toText(raw))
      } catch {
        return
      }
      if (!message || typeof message.id !== 'number' || typeof message.method !== 'string') return

      try {
        const result = await this.routeCdpCommand({
          method: message.method,
          params: message.params ?? {},
          sessionId: message.sessionId,
        })

        if (message.method === 'Target.setAutoAttach') {
          this.ensureTargetEventsForClient(ws, 'autoAttach')
        }
        if (message.method === 'Target.setDiscoverTargets' && message.params?.discover === true) {
          this.ensureTargetEventsForClient(ws, 'discover')
        }

        ws.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, result }))
      } catch (error) {
        ws.send(
          JSON.stringify({
            id: message.id,
            sessionId: message.sessionId,
            error: { message: error instanceof Error ? error.message : String(error) },
          }),
        )
      }
    })

    ws.on('close', () => {
      this.cdpClients.delete(ws)
      this.cdpClientState.delete(ws)
    })
    ws.on('error', () => {
      this.cdpClients.delete(ws)
      this.cdpClientState.delete(ws)
    })
  }

  private async routeCdpCommand(input: {
    method: string
    params?: Record<string, unknown>
    sessionId?: string
  }): Promise<unknown> {
    switch (input.method) {
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: 'Chrome/OpenClaw-Browser-Relay',
          revision: '0',
          userAgent: 'OpenClaw-Browser-Relay',
          jsVersion: 'V8',
        }
      case 'Browser.setDownloadBehavior':
      case 'Browser.getWindowForTarget':
      case 'Target.setAutoAttach':
      case 'Target.setDiscoverTargets':
      case 'Target.detachFromTarget':
      case 'Page.enable':
      case 'Log.enable':
      case 'Inspector.enable':
      case 'Performance.enable':
        return {}
      case 'Target.getBrowserContexts':
        return { browserContextIds: [] }
      case 'Target.getTargets':
        return {
          targetInfos: this.getInspectablePageTargets().map((target) => ({
            ...normalizeTargetInfo(target.targetInfo),
            attached: true,
          })),
        }
      case 'Target.getTargetInfo': {
        const targetId = typeof input.params?.targetId === 'string' ? input.params.targetId : undefined
        if (targetId) {
          const target = Array.from(this.connectedTargets.values()).find((entry) => entry.targetId === targetId)
          if (!target) throw new Error('target not found')
          return { targetInfo: normalizeTargetInfo(target.targetInfo) }
        }
        if (input.sessionId) {
          const target = this.connectedTargets.get(input.sessionId)
          if (!target) throw new Error('target not found')
          return { targetInfo: normalizeTargetInfo(target.targetInfo) }
        }
        const fallback = this.getInspectablePageTargets()[0]
        if (!fallback) throw new Error('target not found')
        return { targetInfo: normalizeTargetInfo(fallback.targetInfo) }
      }
      case 'Target.attachToTarget': {
        const targetId = typeof input.params?.targetId === 'string' ? input.params.targetId : undefined
        if (!targetId) throw new Error('targetId required')
        const target = this.getInspectablePageTargets().find((entry) => entry.targetId === targetId)
        if (!target) throw new Error('target not found')
        return { sessionId: target.sessionId }
      }
      case 'Target.createTarget':
      case 'Target.closeTarget':
      case 'Target.closeAllAgentTabs':
        return this.sendToExtension(input.method, input.params ?? {}, input.sessionId)
      case 'Runtime.enable':
      case 'Network.enable':
        return input.sessionId ? this.sendToExtension(input.method, input.params ?? {}, input.sessionId) : {}
      default:
        return this.sendToExtension(input.method, input.params ?? {}, input.sessionId)
    }
  }

  private onExtensionMessage(raw: RawData): void {
    const text = this.decodeExtensionPayload(toText(raw))
    if (!text) return

    let message:
      | {
          id?: number
          method?: string
          params?: Record<string, unknown> & {
            method?: string
            sessionId?: string
            params?: Record<string, unknown>
          }
          error?: unknown
          result?: unknown
        }
      | null = null

    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (!message) return

    if (message.method === 'ping') {
      this.sendExtensionMessage({ method: 'pong' }, true)
      return
    }
    if (message.method === 'pong') {
      return
    }

    if (typeof message.id === 'number') {
      const pending = this.pendingExtensionRequests.get(message.id)
      if (!pending) return
      this.pendingExtensionRequests.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error != null) {
        pending.reject(new Error(String(message.error)))
        return
      }
      pending.resolve(message.result)
      return
    }

    if (message.method !== 'forwardCDPEvent') return

    const eventMethod = typeof message.params?.method === 'string' ? message.params.method : ''
    const eventParams = (message.params?.params ?? {}) as Record<string, unknown>
    const sessionId = typeof message.params?.sessionId === 'string' ? message.params.sessionId : undefined
    if (!eventMethod) return

    switch (eventMethod) {
      case 'Extension.tabDiscovered': {
        const discoveredSessionId = typeof eventParams.sessionId === 'string' ? eventParams.sessionId : ''
        const targetInfo = eventParams.targetInfo as Partial<RelayTargetInfo> | undefined
        if (!discoveredSessionId || !targetInfo?.targetId) return
        const pendingUrl = this.pendingTargetUrls.get(targetInfo.targetId)
        const normalized = normalizeTargetInfo({
          ...targetInfo,
          url: pendingUrl ?? targetInfo.url,
          targetId: targetInfo.targetId,
        })
        this.pendingTargetUrls.delete(targetInfo.targetId)
        this.connectedTargets.set(discoveredSessionId, {
          sessionId: discoveredSessionId,
          targetId: normalized.targetId,
          targetInfo: normalized,
          physical: false,
        })
        return
      }
      case 'Extension.tabRemoved': {
        const removedSessionId = typeof eventParams.sessionId === 'string' ? eventParams.sessionId : ''
        if (!removedSessionId) return
        this.connectedTargets.delete(removedSessionId)
        return
      }
      case 'Extension.tabUpdated': {
        const updatedSessionId = typeof eventParams.sessionId === 'string' ? eventParams.sessionId : ''
        const targetInfo = eventParams.targetInfo as Partial<RelayTargetInfo> | undefined
        const existing = this.connectedTargets.get(updatedSessionId)
        if (!updatedSessionId || !existing || !targetInfo) return
        this.connectedTargets.set(updatedSessionId, {
          ...existing,
          targetInfo: normalizeTargetInfo({
            ...existing.targetInfo,
            ...targetInfo,
            targetId: existing.targetId,
          }),
        })
        return
      }
      case 'Target.attachedToTarget': {
        if (eventParams.targetInfo && typeof eventParams.sessionId === 'string') {
          const attachedTargetInfo = eventParams.targetInfo as Partial<RelayTargetInfo> & Pick<RelayTargetInfo, 'targetId'>
          const normalized = normalizeTargetInfo(attachedTargetInfo)
          if (normalized.type === 'page') {
            this.connectedTargets.set(eventParams.sessionId, {
              sessionId: eventParams.sessionId,
              targetId: normalized.targetId,
              targetInfo: normalized,
              physical: true,
            })
          }
          this.broadcastToCdpClients({
            method: eventMethod,
            params: {
              ...eventParams,
              targetInfo: normalized,
            },
            sessionId,
          })
        }
        return
      }
      case 'Target.detachedFromTarget': {
        if (typeof eventParams.sessionId === 'string') {
          const existing = this.connectedTargets.get(eventParams.sessionId)
          if (existing) {
            this.connectedTargets.set(eventParams.sessionId, {
              ...existing,
              physical: false,
            })
          }
        }
        this.broadcastToCdpClients({ method: eventMethod, params: eventParams, sessionId })
        return
      }
      case 'Target.targetInfoChanged': {
        const changedTargetInfo = eventParams.targetInfo as Partial<RelayTargetInfo> | undefined
        const targetId = changedTargetInfo?.targetId
        if (targetId) {
          for (const [entrySessionId, existing] of this.connectedTargets.entries()) {
            if (existing.targetId !== targetId) continue
            this.connectedTargets.set(entrySessionId, {
              ...existing,
              targetInfo: normalizeTargetInfo({
                ...existing.targetInfo,
                ...changedTargetInfo,
                targetId,
              }),
            })
          }
        }
        this.broadcastToCdpClients({
          method: eventMethod,
          params: {
            ...eventParams,
            ...(changedTargetInfo?.targetId
              ? { targetInfo: normalizeTargetInfo(changedTargetInfo as Partial<RelayTargetInfo> & Pick<RelayTargetInfo, 'targetId'>) }
              : {}),
          },
          sessionId,
        })
        return
      }
      default:
        this.broadcastToCdpClients({ method: eventMethod, params: eventParams, sessionId })
    }
  }

  private ensureTargetEventsForClient(client: WebSocket, mode: 'autoAttach' | 'discover'): void {
    const state = this.cdpClientState.get(client)
    if (state) {
      if (mode === 'autoAttach' && state.autoAttachPrimed) {
        return
      }
      if (mode === 'discover' && state.discoverPrimed) {
        return
      }
      if (mode === 'autoAttach') {
        state.autoAttachPrimed = true
      } else {
        state.discoverPrimed = true
      }
    }

    for (const target of this.getInspectablePageTargets()) {
      const message =
        mode === 'autoAttach'
          ? {
              method: 'Target.attachedToTarget',
              params: {
                sessionId: target.sessionId,
                targetInfo: {
                  ...normalizeTargetInfo(target.targetInfo),
                  attached: true,
                },
                waitingForDebugger: false,
              },
            }
          : {
              method: 'Target.targetCreated',
              params: {
                targetInfo: {
                  ...normalizeTargetInfo(target.targetInfo),
                  attached: true,
                },
              },
            }
      client.send(JSON.stringify(message))
    }
  }

  private getPhysicalTargets(): ConnectedTarget[] {
    return Array.from(this.connectedTargets.values()).filter((target) => target.physical)
  }

  private getInspectablePageTargets(): ConnectedTarget[] {
    return this.getPhysicalTargets().filter((target) => target.targetInfo.type === 'page')
  }

  private findSessionId(targetId?: string): string | undefined {
    if (targetId) {
      return Array.from(this.connectedTargets.values()).find((entry) => entry.targetId === targetId)?.sessionId
    }
    return this.getInspectablePageTargets()[0]?.sessionId ?? this.getPhysicalTargets()[0]?.sessionId
  }

  private sendToExtension(method: string, params: Record<string, unknown>, sessionId?: string): Promise<any> {
    const ws = this.extensionWs
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.handshakeOk) {
      return Promise.reject(new Error('Chrome extension not connected'))
    }

    const id = this.nextRequestId++
    const payload = {
      id,
      ts: Date.now(),
      method: 'forwardCDPCommand',
      params: {
        ...(sessionId ? { sessionId } : {}),
        method,
        params,
      },
    }

    this.sendExtensionMessage(payload, true)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingExtensionRequests.delete(id)
        reject(new Error(`Extension request timeout: ${method}`))
      }, EXTENSION_REQUEST_TIMEOUT_MS)
      this.pendingExtensionRequests.set(id, { resolve, reject, timer })
    })
  }

  private sendExtensionMessage(payload: unknown, encrypt: boolean): void {
    const ws = this.extensionWs
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const raw = JSON.stringify(payload)
    const message =
      encrypt && this.extensionSessionKey ? encryptWireMessage(this.extensionSessionKey, raw) : raw
    ws.send(message)
  }

  private decodeExtensionPayload(payload: string): string | null {
    try {
      if (this.extensionSessionKey) {
        return decryptWireMessage(this.extensionSessionKey, payload)
      }
      return payload
    } catch (error) {
      this.logger.warn?.(`[browser-relay] failed to decrypt extension payload: ${String(error)}`)
      return null
    }
  }

  private broadcastToCdpClients(payload: unknown): void {
    const message = JSON.stringify(payload)
    for (const client of this.cdpClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message)
      }
    }
  }
}
