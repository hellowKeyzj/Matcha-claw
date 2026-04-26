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

const SESSION_ID_MARKER = '|sid|'
const TARGET_ID_MARKER = '|tid|'

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
  browserInstanceId: string
  browserName: string
  sessionId: string
  localSessionId: string
  targetKey: string
  localTargetKey: string
  targetId: string | null
  localTargetId: string | null
  targetInfo: RelayTargetInfo
  windowId: number | null
  tabId: number | null
  active: boolean
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
  browserInstanceId?: string
  browserName?: string
}

type ExtensionClient = {
  ws: WebSocket
  sessionKey: Buffer | null
  handshakeOk: boolean
  browserInstanceId: string
  browserName: string
  nextRequestId: number
  pendingRequests: Map<number, PendingExtensionRequest>
  connectedTargets: Map<string, ConnectedTarget>
  primarySessionId: string | null
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
  browserCount: number
  selectedBrowserInstanceId: string | null
  selectedWindowId: number | null
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

function encodeExternalSessionId(browserInstanceId: string, localSessionId: string): string {
  return `${browserInstanceId}${SESSION_ID_MARKER}${localSessionId}`
}

function encodeExternalTargetId(browserInstanceId: string, localTargetId: string): string {
  return `${browserInstanceId}${TARGET_ID_MARKER}${localTargetId}`
}

function parseExternalId(value: string, marker: string): { browserInstanceId: string; localId: string } | null {
  const index = value.indexOf(marker)
  if (index <= 0) return null
  const browserInstanceId = value.slice(0, index)
  const localId = value.slice(index + marker.length)
  if (!browserInstanceId || !localId) return null
  return { browserInstanceId, localId }
}

function parseExternalSessionId(value?: string): { browserInstanceId: string; localSessionId: string } | null {
  if (!value) return null
  const parsed = parseExternalId(value, SESSION_ID_MARKER)
  return parsed ? { browserInstanceId: parsed.browserInstanceId, localSessionId: parsed.localId } : null
}

function parseExternalTargetId(value?: string): { browserInstanceId: string; localTargetId: string } | null {
  if (!value) return null
  const parsed = parseExternalId(value, TARGET_ID_MARKER)
  return parsed ? { browserInstanceId: parsed.browserInstanceId, localTargetId: parsed.localId } : null
}

function toNullableInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function ensureExternalTargetId(browserInstanceId: string, targetId: string): string {
  const parsed = parseExternalTargetId(targetId)
  if (parsed) return targetId
  return encodeExternalTargetId(browserInstanceId, targetId)
}

export class BrowserRelayServer {
  private readonly requestedPort: number
  private readonly logger: PluginLogger
  private readonly stateDir: string | undefined
  private readonly authToken = randomBytes(32).toString('base64url')

  private httpServer: Server | null = null
  private extensionWss: WebSocketServer | null = null
  private cdpWss: WebSocketServer | null = null
  private extensionClients = new Map<string, ExtensionClient>()
  private cdpClients = new Set<WebSocket>()
  private cdpClientState = new WeakMap<WebSocket, CdpClientState>()
  private pendingTargetUrls = new Map<string, string>()
  private selectedBrowserInstanceId: string | null = null
  private selectedWindowId: number | null = null
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
    return this.extensionClients.size > 0
  }

  get authHeaders(): Record<string, string> {
    return { [RELAY_AUTH_HEADER]: this.authToken }
  }

  get status(): BrowserRelayStatus {
    return {
      running: this.httpServer !== null,
      port: this.actualPort,
      extensionConnected: this.hasExtensionConnection,
      handshakeOk: this.hasExtensionConnection,
      tabCount: this.getAllConnectedTargets().length,
      browserCount: this.extensionClients.size,
      selectedBrowserInstanceId: this.selectedBrowserInstanceId,
      selectedWindowId: this.selectedWindowId,
    }
  }

  listTabs(): Array<{
    browserInstanceId: string
    browserName: string
    windowId: number | null
    tabId: number | null
    active: boolean
    sessionId: string
    targetKey: string
    targetId: string
    title: string
    url: string
    selectedBrowser: boolean
    selectedWindow: boolean
    physical: boolean
    selected: boolean
    primary: boolean
  }> {
    return this.getAllConnectedTargets().map((target) => ({
      browserInstanceId: target.browserInstanceId,
      browserName: target.browserName,
      windowId: target.windowId,
      tabId: target.tabId,
      active: target.active,
      sessionId: target.sessionId,
      targetKey: target.targetKey,
      targetId: target.targetId ?? '',
      title: target.targetInfo.title ?? '',
      url: target.targetInfo.url ?? '',
      selectedBrowser: target.browserInstanceId === this.selectedBrowserInstanceId,
      selectedWindow: this.isTargetInSelectedWindow(target),
      physical: target.physical,
      selected: this.isTargetInSelectedWindow(target),
      primary: this.getSelectedPrimaryTarget()?.sessionId === target.sessionId,
    }))
  }

  listAttachments(): Array<{
    browserInstanceId: string
    browserName: string
    windowId: number | null
    tabId: number | null
    active: boolean
    sessionId: string
    targetId: string
    title: string
    url: string
    selectedBrowser: boolean
    selectedWindow: boolean
    selected: boolean
    primary: boolean
  }> {
    return this.getInspectablePageTargets().map((target) => ({
      browserInstanceId: target.browserInstanceId,
      browserName: target.browserName,
      windowId: target.windowId,
      tabId: target.tabId,
      active: target.active,
      sessionId: target.sessionId,
      targetId: target.targetId ?? '',
      title: target.targetInfo.title ?? '',
      url: target.targetInfo.url ?? '',
      selectedBrowser: target.browserInstanceId === this.selectedBrowserInstanceId,
      selectedWindow: this.isTargetInSelectedWindow(target),
      selected: this.isTargetInSelectedWindow(target),
      primary: this.getSelectedPrimaryTarget()?.sessionId === target.sessionId,
    }))
  }

  getTargetIdForSession(sessionId: string): string | undefined {
    return this.findTargetBySessionId(sessionId)?.targetId ?? undefined
  }

  getTargetUrl(targetId: string): string | undefined {
    return this.findTargetByTargetId(targetId)?.targetInfo.url ?? this.pendingTargetUrls.get(targetId)
  }

  updateTargetUrl(targetId: string, url: string): void {
    if (!targetId || !url) return
    this.pendingTargetUrls.set(targetId, url)
    const existing = this.findTargetByTargetId(targetId)
    if (!existing) return
    existing.targetInfo = normalizeTargetInfo({
      ...existing.targetInfo,
      url,
      targetId: existing.targetId,
    })
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
        if (!this.hasExtensionConnection) {
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
    for (const client of this.extensionClients.values()) {
      this.rejectPendingRequests(client, 'Relay stopping')
      client.ws.close(1001, 'server stopping')
    }
    this.extensionClients.clear()
    this.pendingTargetUrls.clear()
    this.selectedBrowserInstanceId = null
    this.selectedWindowId = null

    for (const client of this.cdpClients) {
      client.close(1001, 'server stopping')
    }
    this.cdpClients.clear()

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
    this.extensionClients.clear()
    this.pendingTargetUrls.clear()
    this.selectedBrowserInstanceId = null
    this.selectedWindowId = null
    this.cdpClients.clear()

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
    const client = this.requireSelectedClient()
    const result = await this.sendToExtension(client, 'Target.createTarget', { url })
    const rawTargetId = typeof result?.targetId === 'string' ? result.targetId : ''
    if (!rawTargetId) throw new Error('Target.createTarget returned no targetId')
    const targetId = ensureExternalTargetId(client.browserInstanceId, rawTargetId)
    this.pendingTargetUrls.set(targetId, url)
    return { targetId }
  }

  async focusTarget(targetId: string): Promise<void> {
    const { client, localTargetId } = this.requireClientForTarget(targetId)
    await this.sendToExtension(client, 'Target.activateTarget', { targetId: localTargetId })
  }

  async closeTarget(targetId: string): Promise<void> {
    const { client, localTargetId } = this.requireClientForTarget(targetId)
    await this.sendToExtension(client, 'Target.closeTarget', { targetId: localTargetId })
  }

  async evaluate(targetId: string, expression: string): Promise<unknown> {
    const { client, localSessionId } = this.requireClientForTarget(targetId)
    return this.sendToExtension(client, 'Runtime.evaluate', { expression, returnByValue: true }, localSessionId)
  }

  async closeAllAgentTabs(): Promise<unknown> {
    const client = this.requireSelectedClient()
    return this.sendToExtension(client, 'Target.closeAllAgentTabs', {})
  }

  resolveSelectedSessionId(): string {
    return this.requireSelectedPrimaryTarget().sessionId
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
          tabCount: this.hasExtensionConnection ? this.getAllConnectedTargets().length : 0,
          relayPort: this.actualPort,
          connectionType: this.hasExtensionConnection ? 'extension' : 'none',
          selectedBrowserInstanceId: this.selectedBrowserInstanceId,
          selectedWindowId: this.selectedWindowId,
          availability: {
            extension: {
              available: this.hasExtensionConnection,
              browserCount: this.extensionClients.size,
              tabCount: this.hasExtensionConnection ? this.getAllConnectedTargets().length : 0,
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
        this.hasExtensionConnection
          ? { status: 'compatible', protocolVersion: RELAY_PROTOCOL_VERSION }
          : { status: 'unknown', error: 'no_extension_connected' },
        { 'Access-Control-Allow-Origin': '*' },
      )
      return
    }

    if (req.method === 'POST' && pathname === '/cdp-reconnect') {
      for (const client of this.extensionClients.values()) {
        client.ws.close(1012, 'relay reconnect requested')
      }
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
        extensionConnected: this.hasExtensionConnection,
        browserCount: this.extensionClients.size,
        selectedBrowserInstanceId: this.selectedBrowserInstanceId,
        selectedWindowId: this.selectedWindowId,
        physicalTargets: physicalTargets.length,
        virtualTargets: this.getAllConnectedTargets().length - physicalTargets.length,
        cdpClients: this.cdpClients.size,
        pendingRequests: [...this.extensionClients.values()].reduce((sum, client) => sum + client.pendingRequests.size, 0),
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
        ...(this.hasExtensionConnection ? { webSocketDebuggerUrl: cdpUrl } : {}),
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
    const helloTimer = setTimeout(() => {
      this.logger.warn?.('[browser-relay] extension did not send Extension.hello within timeout')
      ws.close(4001, 'Protocol handshake timeout')
    }, EXTENSION_HELLO_TIMEOUT_MS)

    let client: ExtensionClient | null = null

    const onHandshakeMessage = (raw: RawData) => {
      const text = toText(raw)
      let message: { method?: string; params?: RelayHelloParams }
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
        ws.send(JSON.stringify({
          method: 'Extension.helloAck',
          params: {
            status: 'version_mismatch',
            requiredVersion: RELAY_PROTOCOL_VERSION,
          },
        }))
        ws.close(4001, 'Protocol version mismatch')
        return
      }

      if (typeof params.encryptedSessionKey !== 'string' || !params.encryptedSessionKey) {
        ws.send(JSON.stringify({
          method: 'Extension.helloAck',
          params: {
            status: 'encryption_required',
          },
        }))
        ws.close(4002, 'Encrypted session key required')
        return
      }

      const browserInstanceId = typeof params.browserInstanceId === 'string' ? params.browserInstanceId.trim() : ''
      if (!browserInstanceId) {
        ws.close(4004, 'browserInstanceId required')
        return
      }

      const existing = this.extensionClients.get(browserInstanceId)
      if (existing && existing.ws.readyState === WebSocket.OPEN) {
        existing.ws.close(1000, 'replaced by new connection')
      }

      try {
        client = {
          ws,
          sessionKey: decryptSessionKey(params.encryptedSessionKey),
          handshakeOk: true,
          browserInstanceId,
          browserName: typeof params.browserName === 'string' && params.browserName.trim()
            ? params.browserName.trim()
            : browserInstanceId,
          nextRequestId: 1,
          pendingRequests: new Map(),
          connectedTargets: new Map(),
          primarySessionId: null,
        }
      } catch (error) {
        this.logger.warn?.(`[browser-relay] failed to decrypt session key: ${String(error)}`)
        ws.close(4003, 'Invalid encrypted session key')
        return
      }

      this.extensionClients.set(browserInstanceId, client)

      this.sendExtensionMessage(
        client,
        {
          method: 'Extension.helloAck',
          params: {
            status: 'ok',
            encrypted: true,
            selectedBrowserInstanceId: this.selectedBrowserInstanceId,
            selectedWindowId: this.selectedWindowId,
            selected: this.selectedBrowserInstanceId === browserInstanceId,
            selectedBrowser: this.selectedBrowserInstanceId === browserInstanceId,
            selectedWindow:
              this.selectedBrowserInstanceId === browserInstanceId
              && this.selectedWindowId !== null,
          },
        },
        true,
      )

      ws.off('message', onHandshakeMessage)
      ws.on('message', (payload) => {
        if (client) {
          this.onExtensionMessage(client, payload)
        }
      })
      this.broadcastBrowserSelection()
    }

    ws.on('message', onHandshakeMessage)
    ws.on('close', () => {
      clearTimeout(helloTimer)
      if (client) {
        this.handleExtensionClose(client)
      }
    })
    ws.on('error', () => {
      clearTimeout(helloTimer)
      if (client) {
        this.handleExtensionClose(client)
      }
    })
  }

  private handleExtensionClose(client: ExtensionClient): void {
    const current = this.extensionClients.get(client.browserInstanceId)
    if (current !== client) return

    this.rejectPendingRequests(client, 'Extension disconnected')
    this.extensionClients.delete(client.browserInstanceId)
    this.clearClientTargets(client, true)

    if (this.selectedBrowserInstanceId === client.browserInstanceId) {
      this.selectedBrowserInstanceId = null
      this.selectedWindowId = null
      this.broadcastBrowserSelection()
    }

    if (!this.hasExtensionConnection) {
      for (const cdpClient of this.cdpClients) {
        cdpClient.close(1011, 'extension disconnected')
      }
      this.cdpClients.clear()
    }
  }

  private handleCdpConnection(ws: WebSocket): void {
    this.cdpClients.add(ws)
    this.cdpClientState.set(ws, {
      autoAttachPrimed: false,
      discoverPrimed: false,
    })

    ws.on('message', async (raw) => {
      let message: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string }
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
          const target = this.findTargetByTargetId(targetId)
          if (!target) throw new Error('target not found')
          return { targetInfo: normalizeTargetInfo(target.targetInfo) }
        }
        if (input.sessionId) {
          const target = this.findTargetBySessionId(input.sessionId)
          if (!target) throw new Error('target not found')
          return { targetInfo: normalizeTargetInfo(target.targetInfo) }
        }
        const selectedTarget = this.requireSelectedPrimaryTarget()
        return { targetInfo: normalizeTargetInfo(selectedTarget.targetInfo) }
      }
      case 'Target.attachToTarget': {
        const targetId = typeof input.params?.targetId === 'string' ? input.params.targetId : undefined
        if (!targetId) throw new Error('targetId required')
        const target = this.findTargetByTargetId(targetId)
        if (!target) throw new Error('target not found')
        return { sessionId: target.sessionId }
      }
      case 'Target.createTarget': {
        const client = this.requireSelectedClient()
        const result = await this.sendToExtension(client, input.method, input.params ?? {})
        const rawTargetId = typeof result?.targetId === 'string' ? result.targetId : ''
        const externalTargetId = rawTargetId
          ? ensureExternalTargetId(client.browserInstanceId, rawTargetId)
          : ''
        return {
          ...((result && typeof result === 'object') ? result as Record<string, unknown> : {}),
          ...(externalTargetId ? { targetId: externalTargetId } : {}),
        }
      }
      case 'Target.closeTarget': {
        const targetId = typeof input.params?.targetId === 'string' ? input.params.targetId : undefined
        if (!targetId) throw new Error('targetId required')
        const { client, localTargetId } = this.requireClientForTarget(targetId)
        return this.sendToExtension(client, input.method, { ...(input.params ?? {}), targetId: localTargetId })
      }
      case 'Target.closeAllAgentTabs': {
        const client = this.requireSelectedClient()
        return this.sendToExtension(client, input.method, input.params ?? {})
      }
      case 'Runtime.enable':
      case 'Network.enable':
        if (!input.sessionId) return {}
        return this.sendToExtensionForExternalSession(input.sessionId, input.method, input.params ?? {})
      default:
        if (!input.sessionId) {
          throw new Error(`sessionId is required for method ${input.method}`)
        }
        return this.sendToExtensionForExternalSession(input.sessionId, input.method, input.params ?? {})
    }
  }

  private onExtensionMessage(client: ExtensionClient, raw: RawData): void {
    const text = this.decodeExtensionPayload(client, toText(raw))
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
      | undefined

    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (!message) return

    if (message.method === 'ping') {
      this.sendExtensionMessage(client, { method: 'pong' }, true)
      return
    }
    if (message.method === 'pong') {
      return
    }

    if (typeof message.id === 'number') {
      const pending = client.pendingRequests.get(message.id)
      if (!pending) return
      client.pendingRequests.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error != null) {
        pending.reject(new Error(String(message.error)))
        return
      }
      pending.resolve(this.normalizeExtensionResult(client, message.result))
      return
    }

    if (message.method === 'Extension.selectExecutionWindow') {
      const selectedWindowId = toNullableInteger(message.params?.windowId)
      if (selectedWindowId === null) {
        return
      }
      this.selectedBrowserInstanceId = client.browserInstanceId
      this.selectedWindowId = selectedWindowId
      this.broadcastBrowserSelection()
      return
    }

    if (message.method === 'Extension.primaryTargetChanged') {
      const localSessionId = typeof message.params?.sessionId === 'string' ? message.params.sessionId : ''
      const externalSessionId = localSessionId
        ? encodeExternalSessionId(client.browserInstanceId, localSessionId)
        : null
      const target = externalSessionId ? client.connectedTargets.get(externalSessionId) ?? null : null
      client.primarySessionId =
        target
        && target.physical
        && this.selectedBrowserInstanceId === client.browserInstanceId
        && target.windowId !== null
        && target.windowId === this.selectedWindowId
          ? externalSessionId
          : null
      return
    }

    if (message.method !== 'forwardCDPEvent') return

    const eventMethod = typeof message.params?.method === 'string' ? message.params.method : ''
    const eventParams = (message.params?.params ?? {}) as Record<string, unknown>
    const localSessionId = typeof message.params?.sessionId === 'string' ? message.params.sessionId : undefined
    const externalSessionId = localSessionId
      ? encodeExternalSessionId(client.browserInstanceId, localSessionId)
      : undefined
    if (!eventMethod) return

    switch (eventMethod) {
      case 'Extension.tabDiscovered':
        this.handleTabDiscovered(client, eventParams)
        return
      case 'Extension.tabRemoved':
        this.handleTabRemoved(client, eventParams)
        return
      case 'Extension.tabUpdated':
        this.handleTabUpdated(client, eventParams)
        return
      case 'Target.attachedToTarget':
        this.handleAttachedToTarget(client, eventParams, externalSessionId)
        return
      case 'Target.detachedFromTarget':
        this.handleDetachedFromTarget(client, eventParams, externalSessionId)
        return
      case 'Target.targetInfoChanged':
        this.handleTargetInfoChanged(client, eventParams, externalSessionId)
        return
      default:
        this.broadcastToCdpClients({
          method: eventMethod,
          params: eventParams,
          sessionId: externalSessionId,
        })
    }
  }

  private handleTabDiscovered(client: ExtensionClient, eventParams: Record<string, unknown>): void {
    const discoveredLocalSessionId = typeof eventParams.sessionId === 'string' ? eventParams.sessionId : ''
    const targetInfo = eventParams.targetInfo as Partial<RelayTargetInfo> | undefined
    if (!discoveredLocalSessionId || !targetInfo?.targetId) return
    const sessionId = encodeExternalSessionId(client.browserInstanceId, discoveredLocalSessionId)
    const localTargetKey = typeof eventParams.targetKey === 'string' && eventParams.targetKey
      ? eventParams.targetKey
      : targetInfo.targetId
    const targetKey = encodeExternalTargetId(client.browserInstanceId, localTargetKey)
    const pendingUrl = this.pendingTargetUrls.get(targetKey)
    const normalized = this.normalizeExternalTargetInfo(client, {
      ...targetInfo,
      url: pendingUrl ?? targetInfo.url,
      targetId: localTargetKey,
    })
    this.pendingTargetUrls.delete(targetKey)
    client.connectedTargets.set(sessionId, {
      browserInstanceId: client.browserInstanceId,
      browserName: client.browserName,
      sessionId,
      localSessionId: discoveredLocalSessionId,
      targetKey,
      localTargetKey,
      targetId: null,
      localTargetId: null,
      targetInfo: normalized,
      windowId: toNullableInteger(eventParams.windowId),
      tabId: toNullableInteger(eventParams.tabId),
      active: eventParams.active === true,
      physical: false,
    })
  }

  private handleTabRemoved(client: ExtensionClient, eventParams: Record<string, unknown>): void {
    const removedLocalSessionId = typeof eventParams.sessionId === 'string' ? eventParams.sessionId : ''
    if (!removedLocalSessionId) return
    const sessionId = encodeExternalSessionId(client.browserInstanceId, removedLocalSessionId)
    const existing = client.connectedTargets.get(sessionId)
    if (!existing) return
    client.connectedTargets.delete(sessionId)
    if (client.primarySessionId === sessionId) {
      client.primarySessionId = null
    }
    if (existing.physical) {
      this.broadcastToCdpClients({
        method: 'Target.detachedFromTarget',
        params: { sessionId, targetId: existing.targetId, reason: 'target_removed' },
      })
    }
  }

  private handleTabUpdated(client: ExtensionClient, eventParams: Record<string, unknown>): void {
    const updatedLocalSessionId = typeof eventParams.sessionId === 'string' ? eventParams.sessionId : ''
    const targetInfo = eventParams.targetInfo as Partial<RelayTargetInfo> | undefined
    const sessionId = encodeExternalSessionId(client.browserInstanceId, updatedLocalSessionId)
    const existing = client.connectedTargets.get(sessionId)
    if (!updatedLocalSessionId || !existing || !targetInfo) return
    existing.targetInfo = this.normalizeExternalTargetInfo(client, {
      ...existing.targetInfo,
      ...targetInfo,
      targetId: existing.localTargetId ?? existing.localTargetKey,
    })
    existing.windowId = toNullableInteger(eventParams.windowId)
    existing.tabId = toNullableInteger(eventParams.tabId)
    existing.active = eventParams.active === true
  }

  private handleAttachedToTarget(
    client: ExtensionClient,
    eventParams: Record<string, unknown>,
    externalSessionId?: string,
  ): void {
    if (!eventParams.targetInfo || typeof eventParams.sessionId !== 'string') return
    const attachedLocalSessionId = eventParams.sessionId
    const localTargetInfo = eventParams.targetInfo as Partial<RelayTargetInfo> & Pick<RelayTargetInfo, 'targetId'>
    const sessionId = encodeExternalSessionId(client.browserInstanceId, attachedLocalSessionId)
    const normalized = this.normalizeExternalTargetInfo(client, localTargetInfo)
    if (normalized.type === 'page') {
      const existing = client.connectedTargets.get(sessionId)
      const targetKey = existing?.targetKey ?? encodeExternalTargetId(
        client.browserInstanceId,
        typeof eventParams.targetKey === 'string' && eventParams.targetKey ? eventParams.targetKey : localTargetInfo.targetId,
      )
      client.connectedTargets.set(sessionId, {
        browserInstanceId: client.browserInstanceId,
        browserName: client.browserName,
        sessionId,
        localSessionId: attachedLocalSessionId,
        targetKey,
        localTargetKey: existing?.localTargetKey
          ?? (typeof eventParams.targetKey === 'string' && eventParams.targetKey ? eventParams.targetKey : localTargetInfo.targetId),
        targetId: normalized.targetId,
        localTargetId: localTargetInfo.targetId,
        targetInfo: normalized,
        windowId: toNullableInteger(eventParams.windowId),
        tabId: toNullableInteger(eventParams.tabId),
        active: eventParams.active === true,
        physical: true,
      })
    }
    this.broadcastToCdpClients({
      method: 'Target.attachedToTarget',
      params: {
        ...eventParams,
        sessionId,
        targetInfo: normalized,
      },
      sessionId: externalSessionId,
    })
  }

  private handleDetachedFromTarget(
    client: ExtensionClient,
    eventParams: Record<string, unknown>,
    externalSessionId?: string,
  ): void {
    const detachedLocalSessionId = typeof eventParams.sessionId === 'string' ? eventParams.sessionId : ''
    const sessionId = detachedLocalSessionId
      ? encodeExternalSessionId(client.browserInstanceId, detachedLocalSessionId)
      : ''
    const existing = sessionId ? client.connectedTargets.get(sessionId) : undefined
    if (existing) {
      existing.physical = false
      existing.targetId = null
      existing.localTargetId = null
      existing.active = eventParams.active === true
      existing.windowId = toNullableInteger(eventParams.windowId)
      existing.tabId = toNullableInteger(eventParams.tabId)
      existing.targetInfo = this.normalizeExternalTargetInfo(client, {
        ...existing.targetInfo,
        targetId: existing.localTargetKey,
      })
    }
    if (client.primarySessionId === sessionId) {
      client.primarySessionId = null
    }
    this.broadcastToCdpClients({
      method: 'Target.detachedFromTarget',
      params: {
        ...eventParams,
        ...(sessionId ? { sessionId } : {}),
        ...(existing?.targetId ? { targetId: existing.targetId } : {}),
      },
      sessionId: externalSessionId,
    })
  }

  private handleTargetInfoChanged(
    client: ExtensionClient,
    eventParams: Record<string, unknown>,
    externalSessionId?: string,
  ): void {
    const changedTargetInfo = eventParams.targetInfo as Partial<RelayTargetInfo> | undefined
    const localTargetId = changedTargetInfo?.targetId
    if (localTargetId) {
      for (const existing of client.connectedTargets.values()) {
        if (existing.localTargetId !== localTargetId) continue
        existing.targetInfo = this.normalizeExternalTargetInfo(client, {
          ...existing.targetInfo,
          ...changedTargetInfo,
          targetId: localTargetId,
        })
        existing.windowId = toNullableInteger(eventParams.windowId)
        existing.tabId = toNullableInteger(eventParams.tabId)
        existing.active = eventParams.active === true
      }
    }
    this.broadcastToCdpClients({
      method: 'Target.targetInfoChanged',
      params: {
        ...eventParams,
        ...(changedTargetInfo?.targetId
          ? { targetInfo: this.normalizeExternalTargetInfo(client, changedTargetInfo as Partial<RelayTargetInfo> & Pick<RelayTargetInfo, 'targetId'>) }
          : {}),
      },
      sessionId: externalSessionId,
    })
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

  private getAllConnectedTargets(): ConnectedTarget[] {
    return [...this.extensionClients.values()].flatMap((client) => [...client.connectedTargets.values()])
  }

  private getPhysicalTargets(): ConnectedTarget[] {
    return this.getAllConnectedTargets().filter((target) => target.physical)
  }

  private getInspectablePageTargets(): ConnectedTarget[] {
    return this.getPhysicalTargets().filter((target) => target.targetInfo.type === 'page')
  }

  private getPrimaryTargetForClient(client: ExtensionClient | undefined): ConnectedTarget | null {
    if (!client?.primarySessionId) return null
    const target = client.connectedTargets.get(client.primarySessionId)
    return target && target.physical ? target : null
  }

  private getSelectedPrimaryTarget(): ConnectedTarget | null {
    if (!this.selectedBrowserInstanceId || this.selectedWindowId === null) {
      return null
    }
    const target = this.getPrimaryTargetForClient(this.extensionClients.get(this.selectedBrowserInstanceId))
    return target && this.isTargetInSelectedWindow(target) ? target : null
  }

  private isTargetInSelectedWindow(target: ConnectedTarget): boolean {
    return this.selectedBrowserInstanceId !== null
      && this.selectedWindowId !== null
      && target.browserInstanceId === this.selectedBrowserInstanceId
      && target.windowId === this.selectedWindowId
  }

  private findTargetBySessionId(sessionId: string): ConnectedTarget | null {
    const parsed = parseExternalSessionId(sessionId)
    if (!parsed) return null
    return this.extensionClients.get(parsed.browserInstanceId)?.connectedTargets.get(sessionId) ?? null
  }

  private findTargetByTargetId(targetId: string): ConnectedTarget | null {
    for (const client of this.extensionClients.values()) {
      for (const target of client.connectedTargets.values()) {
        if (target.targetId === targetId) return target
      }
    }
    return null
  }

  private requireSelectedClient(): ExtensionClient {
    if (!this.selectedBrowserInstanceId) {
      throw new Error('No browser instance selected. Select a browser before using browser control.')
    }
    const client = this.extensionClients.get(this.selectedBrowserInstanceId)
    if (!client) {
      throw new Error('Selected browser instance is not connected.')
    }
    return client
  }

  private requireSelectedPrimaryTarget(): ConnectedTarget {
    if (this.selectedWindowId === null) {
      throw new Error('No browser window selected. Select a window before using browser control.')
    }
    const target = this.getSelectedPrimaryTarget()
    if (!target) {
      throw new Error('Selected window has no active attached page.')
    }
    return target
  }

  private requireClientForTarget(targetId: string): { client: ExtensionClient; localTargetId: string; localSessionId?: string } {
    const parsed = parseExternalTargetId(targetId)
    if (!parsed) {
      throw new Error('Invalid targetId')
    }
    const client = this.extensionClients.get(parsed.browserInstanceId)
    if (!client) {
      throw new Error('Target browser instance is not connected.')
    }
    const target = this.findTargetByTargetId(targetId)
    if (!target) {
      throw new Error('target not found')
    }
    return {
      client,
      localTargetId: parsed.localTargetId,
      localSessionId: target.localSessionId,
    }
  }

  private sendToExtensionForExternalSession(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const parsed = parseExternalSessionId(sessionId)
    if (!parsed) {
      return Promise.reject(new Error('Invalid sessionId'))
    }
    const client = this.extensionClients.get(parsed.browserInstanceId)
    if (!client) {
      return Promise.reject(new Error('Target browser instance is not connected.'))
    }
    return this.sendToExtension(client, method, params, parsed.localSessionId)
  }

  private sendToExtension(
    client: ExtensionClient,
    method: string,
    params: Record<string, unknown>,
    localSessionId?: string,
  ): Promise<unknown> {
    if (client.ws.readyState !== WebSocket.OPEN || !client.handshakeOk) {
      return Promise.reject(new Error('Chrome extension not connected'))
    }

    const id = client.nextRequestId++
    const payload = {
      id,
      ts: Date.now(),
      method: 'forwardCDPCommand',
      params: {
        ...(localSessionId ? { sessionId: localSessionId } : {}),
        method,
        params,
      },
    }

    this.sendExtensionMessage(client, payload, true)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.pendingRequests.delete(id)
        reject(new Error(`Extension request timeout: ${method}`))
      }, EXTENSION_REQUEST_TIMEOUT_MS)
      client.pendingRequests.set(id, { resolve, reject, timer })
    })
  }

  private sendExtensionMessage(client: ExtensionClient, payload: unknown, encrypt: boolean): void {
    if (client.ws.readyState !== WebSocket.OPEN) return
    const raw = JSON.stringify(payload)
    const message =
      encrypt && client.sessionKey ? encryptWireMessage(client.sessionKey, raw) : raw
    client.ws.send(message)
  }

  private decodeExtensionPayload(client: ExtensionClient, payload: string): string | null {
    try {
      if (client.sessionKey) {
        return decryptWireMessage(client.sessionKey, payload)
      }
      return payload
    } catch (error) {
      this.logger.warn?.(`[browser-relay] failed to decrypt extension payload: ${String(error)}`)
      return null
    }
  }

  private rejectPendingRequests(client: ExtensionClient, message: string): void {
    for (const pending of client.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    client.pendingRequests.clear()
  }

  private clearClientTargets(client: ExtensionClient, broadcastDetach: boolean): void {
    if (client.primarySessionId) {
      client.primarySessionId = null
    }
    if (broadcastDetach) {
      for (const target of client.connectedTargets.values()) {
        if (!target.physical) continue
        this.broadcastToCdpClients({
          method: 'Target.detachedFromTarget',
          params: {
            sessionId: target.sessionId,
            targetId: target.targetId,
            reason: 'browser_disconnected',
          },
        })
      }
    }
    client.connectedTargets.clear()
  }

  private normalizeExternalTargetInfo(
    client: ExtensionClient,
    raw: Partial<RelayTargetInfo> & Pick<RelayTargetInfo, 'targetId'>,
  ): RelayTargetInfo {
    return normalizeTargetInfo({
      ...raw,
      targetId: encodeExternalTargetId(client.browserInstanceId, raw.targetId),
      openerId: raw.openerId ? encodeExternalTargetId(client.browserInstanceId, raw.openerId) : undefined,
    })
  }

  private normalizeExtensionResult(client: ExtensionClient, result: unknown): unknown {
    if (!result || typeof result !== 'object') return result
    const record = result as Record<string, unknown>
    const localTargetId = typeof record.targetId === 'string' ? record.targetId : ''
    if (!localTargetId) return result
    return {
      ...record,
      targetId: encodeExternalTargetId(client.browserInstanceId, localTargetId),
    }
  }

  private broadcastBrowserSelection(): void {
    for (const client of this.extensionClients.values()) {
      this.sendExtensionMessage(
        client,
        {
          method: 'Extension.selectionChanged',
          params: {
            selectedBrowserInstanceId: this.selectedBrowserInstanceId,
            selectedWindowId: this.selectedWindowId,
            selected: client.browserInstanceId === this.selectedBrowserInstanceId,
            selectedBrowser: client.browserInstanceId === this.selectedBrowserInstanceId,
            selectedWindow:
              client.browserInstanceId === this.selectedBrowserInstanceId
              && this.selectedWindowId !== null,
          },
        },
        true,
      )
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
