import type { PluginLogger } from '../plugin-types.js'
import { createCipheriv, createDecipheriv, privateDecrypt, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { BrowserCookieInput } from '../browser-action-contract.js'
import { isRelayDebugEnabled, relayDebugInfo } from '../debug-logging.js'
import { RELAY_PRIVATE_KEY_PEM } from './keypair.js'
import {
  claimRelayPortOwnership,
  ensureRelayPortOwnership,
  releaseRelayPortOwnership,
} from './ownership.js'
import { clearRelaySelection, readRelaySelection, writeRelaySelection, type RelaySelectionRecord } from './selection-state.js'
import { RelayDownloadWatches, relayOperationError, type RelayDownload } from './downloads.js'
import { formatRelayErrorMessage } from './errors.js'
import { canAccessPage, claimPage } from '../state/page-ownership.js'

export const RELAY_PROTOCOL_VERSION = 1
export const RELAY_AUTH_HEADER = 'x-phoenix-relay-token'

const ENCRYPTED_PREFIX = 'E:'
const AES_KEY_BYTES = 32
const AES_GCM_IV_BYTES = 12
const AES_GCM_TAG_BYTES = 16
const EXTENSION_HELLO_TIMEOUT_MS = 5_000
const EXTENSION_PING_INTERVAL_MS = 5_000
const EXTENSION_LIVENESS_TIMEOUT_MS = 30_000
const EXTENSION_RECONNECT_GRACE_MS = 45_000
const EXTENSION_REQUEST_TIMEOUT_MS = 30_000
const LONG_RUNNING_METHODS = new Set(['Page.captureScreenshot', 'Extension.captureViewport', 'Accessibility.getFullAXTree'])
const TARGET_ATTACH_TIMEOUT_MS = 5_000
const HTTP_SERVER_CLOSE_GRACE_MS = 1_000
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

const SESSION_ID_MARKER = '|sid|'
const TARGET_ID_MARKER = '|tid|'
const BROWSER_SESSION_ID_MARKER = '|bsid|'
const ATTACHED_SESSION_ID_MARKER = '|asid|'

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
  createdByAgent: boolean
  createdBy: string | null
  claimedBy: string | null
  sessionGroupId: string | null
  retained: boolean
  openerVtabId?: string
  targetInfo: RelayTargetInfo
  windowId: number | null
  tabId: number | null
  active: boolean
  physical: boolean
  mainFrameUrl: string
  readyState: string
  executionContextReady: boolean
  bootstrapPrimed: boolean
  lastLifecycleEvent: Record<string, unknown> | null
  lastExecutionContextCreated: Record<string, unknown> | null
  lastTargetInfoChanged: Record<string, unknown> | null
}

type PendingExtensionRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type PendingTargetAttachmentRequest = {
  resolve: (target: AttachedRelayTarget) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type CdpClientState = {
  autoAttachPrimed: boolean
  discoverPrimed: boolean
}

type BrowserSession = {
  browserInstanceId: string
  cdpClient: WebSocket
}

type AttachedClientSession = {
  attachSessionId: string
  browserInstanceId: string
  cdpClient: WebSocket
  physicalSessionId: string
  localPhysicalSessionId: string
  targetId: string
  localTargetId: string
  autoAttached: boolean
  autoAttachChildren: boolean
  parentAttachSessionId?: string
}

type ChildTarget = {
  browserInstanceId: string
  sessionId: string
  localSessionId: string
  targetId: string
  localTargetId: string
  parentSessionId: string
  targetInfo: RelayTargetInfo
  waitingForDebugger: boolean
}

export type RelayCloseTargetReceipt = {
  success: boolean
  alreadyClosed?: boolean
  skipped?: boolean
  reason?: string
  error?: string
  timedOut?: boolean
  outcome?: string
  retryable?: boolean
}

export type RelayCloseAllReceipt = {
  success: boolean
  closed: number
  alreadyClosed: number
  retained: number
  denied: number
  failed: number
  timedOut: number
  closedIds: string[]
  alreadyClosedIds: string[]
  retainedIds: string[]
  deniedIds: string[]
  timedOutIds: string[]
  failedIds: string[]
  deniedDetails: Array<{ targetId: string; error: string }>
  failedDetails: Array<{ targetId: string; error: string }>
  timedOutDetails: Array<{ targetId: string; error: string; outcome: string; retryable: boolean }>
  outcome?: string
  retryable?: boolean
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
  connectedAt: number
  nextRequestId: number
  pendingRequests: Map<number, PendingExtensionRequest>
  connectedTargets: Map<string, ConnectedTarget>
  childTargets: Map<string, ChildTarget>
  resyncEpoch: number
  currentSessionId: string | null
  pingTimer: NodeJS.Timeout | null
  lastPongAt: number
  lastHeartbeatTickAt: number
  recoveryProbeStartedAt: number | null
  reconnectTimer: NodeJS.Timeout | null
}

type SelectionState =
  | {
      kind: 'none'
    }
  | {
      kind: 'manual' | 'auto'
      browserInstanceId: string
      windowId: number | null
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

export type BrowserRelayExtensionConnection = {
  browserInstanceId: string
  browserName: string
}

export type AttachedRelayTarget = {
  browserInstanceId: string
  browserName: string
  sessionId: string
  targetId: string
  windowId: number | null
  tabId: number | null
  active: boolean
  title: string
  url: string
}

export type ReadyRelayTarget = AttachedRelayTarget & {
  mainFrameUrl: string
  readyState: string
  executionContextReady: boolean
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

function readTargetIdFromResult(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return ''
  }
  const targetId = (result as { targetId?: unknown }).targetId
  return typeof targetId === 'string' ? targetId : ''
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

function encodeExternalBrowserSessionId(browserInstanceId: string, localSessionId: string): string {
  return `${browserInstanceId}${BROWSER_SESSION_ID_MARKER}${localSessionId}`
}

function encodeExternalAttachedSessionId(browserInstanceId: string, localSessionId: string): string {
  return `${browserInstanceId}${ATTACHED_SESSION_ID_MARKER}${localSessionId}`
}

function parseExternalBrowserSessionId(value?: string): { browserInstanceId: string; localSessionId: string } | null {
  if (!value) return null
  const parsed = parseExternalId(value, BROWSER_SESSION_ID_MARKER)
  return parsed ? { browserInstanceId: parsed.browserInstanceId, localSessionId: parsed.localId } : null
}

function toNullableInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function ensureExternalTargetId(browserInstanceId: string, targetId: string): string {
  const parsed = parseExternalTargetId(targetId)
  if (parsed) return targetId
  return encodeExternalTargetId(browserInstanceId, targetId)
}

type AttachedSessionNormalizationDirection = 'toExternal' | 'toLocal'

const TARGET_IDENTIFIER_KEYS = new Set(['targetId', 'openerId'])
const FRAME_IDENTIFIER_KEYS = new Set(['frameId', 'parentFrameId'])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isInteractiveReadyState(value: string): boolean {
  return value === 'interactive' || value === 'complete'
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
  private httpSockets = new Set<Socket>()
  private cdpClientState = new WeakMap<WebSocket, CdpClientState>()
  private browserSessions = new Map<string, BrowserSession>()
  private attachedClientSessions = new Map<string, AttachedClientSession>()
  private extensionConnectedListeners = new Set<(connection: BrowserRelayExtensionConnection) => void | Promise<void>>()
  private pendingTargetUrls = new Map<string, string>()
  private pendingTargetAttachments = new Map<string, Set<PendingTargetAttachmentRequest>>()
  private selectionState: SelectionState = { kind: 'none' }
  private actualPort: number | null = null
  private nextBrowserSessionId = 1
  private nextAttachedSessionId = 1
  private readonly downloadWatches = new RelayDownloadWatches()
  // Session claims survive disconnects; null records a release awaiting native confirmation.
  private readonly desiredTabClaims = new Map<string, { browserInstanceId: string; localTargetKey: string; principalId: string | null; sessionGroupId: string | null }>()
  private readonly pendingSessionReleases = new Map<string, Set<string>>()
  private readonly sessionBrowsers = new Map<string, { sessionGroupId: string; browsers: Set<string> }>()
  private claimSyncChain = Promise.resolve()
  private readonly pendingDownloadDisarms = new Map<string, Map<string, number>>()
  private readonly downloadDisarmChains = new Map<string, Promise<void>>()
  private readonly downloadOperations = new Set<AbortController>()

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

  private get connectedExtensionClients(): ExtensionClient[] {
    return [...this.extensionClients.values()].filter((client) => client.handshakeOk && client.ws.readyState === WebSocket.OPEN)
  }

  get hasExtensionConnection(): boolean {
    return this.connectedExtensionClients.length > 0
  }

  get authHeaders(): Record<string, string> {
    return { [RELAY_AUTH_HEADER]: this.authToken }
  }

  private get selectedBrowserInstanceId(): string | null {
    return this.selectionState.kind === 'none' ? null : this.selectionState.browserInstanceId
  }

  private get selectedWindowId(): number | null {
    return this.selectionState.kind === 'none' ? null : this.selectionState.windowId
  }

  private get hasSelection(): boolean {
    return this.selectionState.kind !== 'none'
  }

  private get hasManualSelection(): boolean {
    return this.selectionState.kind === 'manual'
  }

  get status(): BrowserRelayStatus {
    return {
      running: this.httpServer !== null,
      port: this.actualPort,
      extensionConnected: this.hasExtensionConnection,
      handshakeOk: this.hasExtensionConnection,
      tabCount: this.getAllConnectedTargets().length,
      browserCount: this.connectedExtensionClients.length,
      selectedBrowserInstanceId: this.selectedBrowserInstanceId,
      selectedWindowId: this.selectedWindowId,
    }
  }

  onExtensionConnected(listener: (connection: BrowserRelayExtensionConnection) => void | Promise<void>): () => void {
    this.extensionConnectedListeners.add(listener)
    return () => {
      this.extensionConnectedListeners.delete(listener)
    }
  }

  listTabs(principalId?: string, sessionGroupId = principalId): Array<{
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
    isAgent: boolean
    isRetained: boolean
    createdBy: string | null
    claimedBy: string | null
    sessionGroupId: string | null
    ready: boolean
    selected: boolean
    primary: boolean
  }> {
    return this.getAllConnectedTargets().filter((target) => {
      if (principalId === undefined) return true
      const desired = this.desiredTabClaims.get(target.targetKey)
      return canAccessPage(target, principalId, sessionGroupId) && (!desired || canAccessPage({
        ...target, claimedBy: desired.principalId, sessionGroupId: desired.sessionGroupId,
      }, principalId, sessionGroupId))
    }).map((target) => ({
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
      isAgent: target.createdByAgent,
      isRetained: target.createdByAgent && target.retained,
      createdBy: target.createdBy,
      claimedBy: target.claimedBy,
      sessionGroupId: target.sessionGroupId,
      ready: this.isTargetReady(target),
      selected: this.isTargetInSelectedWindow(target),
      primary: this.getSelectedCurrentTarget()?.sessionId === target.sessionId,
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
    ready: boolean
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
      ready: this.isTargetReady(target),
      selected: this.isTargetInSelectedWindow(target),
      primary: this.getSelectedCurrentTarget()?.sessionId === target.sessionId,
    }))
  }

  getTargetIdForSession(sessionId: string): string | undefined {
    return this.attachedClientSessions.get(sessionId)?.targetId
      ?? this.findTargetBySessionId(sessionId)?.targetId
      ?? undefined
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
      targetId: existing.targetId ?? existing.targetInfo.targetId,
    })
  }

  async start(): Promise<void> {
    if (this.httpServer) return

    await this.restoreSelectionState()
    await ensureRelayPortOwnership({
      port: this.requestedPort,
      logger: this.logger,
      stateDir: this.stateDir,
    })

    this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res))
    this.extensionWss = new WebSocketServer({ noServer: true })
    this.cdpWss = new WebSocketServer({ noServer: true })

    this.httpServer.on('connection', (socket) => {
      this.httpSockets.add(socket)
      socket.once('close', () => this.httpSockets.delete(socket))
    })

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
          relayDebugInfo(
            this.logger,
            () => `[browser-relay] listening on 127.0.0.1:${this.actualPort} (HTTP /json/*, WS /extension, WS /cdp)`,
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
    for (const operation of this.downloadOperations) operation.abort(relayOperationError('Relay stopping; browser download completion is unknown.', 'DOWNLOAD_STOPPED'))
    this.downloadWatches.stop()
    this.desiredTabClaims.clear()
    this.pendingSessionReleases.clear()
    this.sessionBrowsers.clear()
    for (const client of this.extensionClients.values()) {
      client.handshakeOk = false
      if (client.pingTimer) clearInterval(client.pingTimer)
      if (client.reconnectTimer) clearTimeout(client.reconnectTimer)
      this.rejectPendingRequests(client, 'Relay stopping')
      client.ws.close(1001, 'server stopping')
    }
    this.extensionClients.clear()
    this.pendingTargetUrls.clear()
    this.rejectAllPendingTargetAttachments('Relay stopping')
    this.selectionState = { kind: 'none' }
    this.browserSessions.clear()
    this.attachedClientSessions.clear()

    for (const client of this.cdpClients) {
      client.close(1001, 'server stopping')
    }
    this.cdpClients.clear()

    await this.closeServers()

    await releaseRelayPortOwnership({
      port: this.requestedPort,
      stateDir: this.stateDir,
    })
  }

  private async disposeFailedStart(): Promise<void> {
    for (const client of this.extensionClients.values()) {
      client.handshakeOk = false
      if (client.pingTimer) clearInterval(client.pingTimer)
      if (client.reconnectTimer) clearTimeout(client.reconnectTimer)
      this.rejectPendingRequests(client, 'Relay failed to start')
      client.ws.close(1001, 'server failed to start')
    }
    this.extensionClients.clear()
    this.pendingTargetUrls.clear()
    this.rejectAllPendingTargetAttachments('Relay failed to start')
    this.selectionState = { kind: 'none' }
    this.browserSessions.clear()
    this.attachedClientSessions.clear()
    this.cdpClients.clear()

    await this.closeServers()
  }

  private async closeServers(): Promise<void> {
    this.extensionWss?.close()
    this.cdpWss?.close()
    this.extensionWss = null
    this.cdpWss = null

    const server = this.httpServer
    this.httpServer = null
    if (!server) {
      this.actualPort = null
      return
    }

    await new Promise<void>((resolve) => {
      const sockets = new Set(this.httpSockets)
      let finished = false
      let timer: NodeJS.Timeout | null = null
      const clearClosedSockets = () => {
        for (const socket of sockets) this.httpSockets.delete(socket)
      }
      const finish = () => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        clearClosedSockets()
        this.actualPort = null
        resolve()
      }
      timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections?.()
        finish()
      }, HTTP_SERVER_CLOSE_GRACE_MS)

      server.closeIdleConnections?.()
      server.close(finish)
    })
  }

  async openTarget(url: string, options: { retain?: boolean; principalId?: string; sessionGroupId?: string } = {}): Promise<{ targetId: string }> {
    return await this.createTargetInClient(await this.resolveClientForBrowserUse(options.principalId, options.sessionGroupId), url, options)
  }

  async withTargetClaim<T>(targetId: string, principalId: string, task: () => Promise<T>, sessionGroupId = principalId): Promise<T> {
    await this.syncTabClaims(() => {
      const { client } = this.requireClientForTarget(targetId)
      const target = this.findTargetByTargetId(targetId)!
      const ownership = claimPage(target, principalId, sessionGroupId)
      const desired = this.desiredTabClaims.get(target.targetKey)
      if (desired) claimPage({ ...target, claimedBy: desired.principalId, sessionGroupId: desired.sessionGroupId }, principalId, sessionGroupId)
      this.rememberSessionBrowser(principalId, sessionGroupId, client.browserInstanceId)
      this.desiredTabClaims.set(target.targetKey, { browserInstanceId: client.browserInstanceId, localTargetKey: target.localTargetKey, principalId, sessionGroupId: ownership.sessionGroupId })
      if (client.ws.readyState === WebSocket.OPEN && client.resyncEpoch >= 0
        && !this.pendingSessionReleases.has(client.browserInstanceId)
        && target.claimedBy === principalId && target.sessionGroupId === ownership.sessionGroupId) return []
      return [client.browserInstanceId]
    })
    return await task()
  }

  async releaseSessionClaims(principalId: string, sessionGroupId = principalId, scope: 'executor' | 'group' = 'executor'): Promise<void> {
    await this.syncTabClaims(() => {
      const browsers = new Set<string>()
      const principals = new Set([principalId])
      for (const [executorId, usage] of this.sessionBrowsers) {
        if (scope === 'group' ? usage.sessionGroupId !== sessionGroupId : executorId !== principalId) continue
        principals.add(executorId)
        for (const browserInstanceId of usage.browsers) browsers.add(browserInstanceId)
      }
      for (const target of this.getAllConnectedTargets()) {
        if (scope === 'group' ? target.sessionGroupId !== sessionGroupId : target.claimedBy !== principalId) continue
        browsers.add(target.browserInstanceId)
        if (target.claimedBy) principals.add(target.claimedBy)
      }
      for (const claim of this.desiredTabClaims.values()) {
        if (scope === 'group' ? claim.sessionGroupId !== sessionGroupId : claim.principalId !== principalId) continue
        browsers.add(claim.browserInstanceId)
        if (claim.principalId) principals.add(claim.principalId)
        claim.principalId = null
      }
      for (const browserInstanceId of this.extensionClients.keys()) browsers.add(browserInstanceId)
      for (const browserInstanceId of browsers) {
        let released = this.pendingSessionReleases.get(browserInstanceId)
        if (!released) { released = new Set(); this.pendingSessionReleases.set(browserInstanceId, released) }
        for (const executorId of principals) released.add(executorId)
      }
      return browsers
    }, { principalId, sessionGroupId, scope })
  }

  private rememberSessionBrowser(principalId: string, sessionGroupId: string, browserInstanceId: string): void {
    let usage = this.sessionBrowsers.get(principalId)
    if (!usage) {
      usage = { sessionGroupId, browsers: new Set() }
      this.sessionBrowsers.set(principalId, usage)
    }
    usage.sessionGroupId = sessionGroupId
    usage.browsers.add(browserInstanceId)
  }

  completeSessionGroupCleanup(sessionGroupId: string): void {
    for (const [principalId, usage] of this.sessionBrowsers) {
      if (usage.sessionGroupId === sessionGroupId) this.sessionBrowsers.delete(principalId)
    }
  }

  private syncTabClaims(update: () => Iterable<string>, cleanup?: { principalId: string; sessionGroupId: string; scope: 'executor' | 'group' }): Promise<void> {
    const sync = this.claimSyncChain.catch(() => {}).then(async () => {
      // Mutate and confirm one snapshot before the next transition can observe it.
      const browsers = update()
      const results = await Promise.allSettled([...browsers].map(async (browserInstanceId) => {
        const client = this.extensionClients.get(browserInstanceId)
        if (!client?.handshakeOk || client.ws.readyState !== WebSocket.OPEN) {
          if (cleanup) throw new Error('Browser session cleanup could not be confirmed: Chrome extension disconnected.')
          return
        }
        if (cleanup && client.resyncEpoch < 0) throw new Error('Browser session cleanup requires an authoritative tab resync.')
        const released = this.pendingSessionReleases.get(browserInstanceId)
        const desired = new Map([...client.connectedTargets.values()]
          .map((target) => [target.localTargetKey, { principalId: target.claimedBy && !released?.has(target.claimedBy) ? target.claimedBy : null, sessionGroupId: target.sessionGroupId }]))
        for (const claim of this.desiredTabClaims.values()) {
          if (claim.browserInstanceId === browserInstanceId) desired.set(claim.localTargetKey, claim)
        }
        const claims = [...desired].flatMap(([targetId, claim]) => claim.principalId ? [{ targetId, principalId: claim.principalId, sessionGroupId: claim.sessionGroupId }] : [])
        await this.sendToExtension(client, 'Extension.syncAgentClaimedUserTabs', { claims, ...(cleanup ? { cleanup } : {}) })
        if (cleanup) {
          for (const claim of this.desiredTabClaims.values()) {
            if (claim.browserInstanceId === browserInstanceId && (cleanup.scope === 'group'
              ? claim.sessionGroupId === cleanup.sessionGroupId
              : claim.principalId === cleanup.principalId)) claim.principalId = null
          }
        }
        if (client.resyncEpoch >= 0) this.pendingSessionReleases.delete(browserInstanceId)
        for (const target of client.connectedTargets.values()) {
          if (target.claimedBy === null && this.desiredTabClaims.get(target.targetKey)?.principalId === null) {
            this.desiredTabClaims.delete(target.targetKey)
          }
        }
      }))
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure) throw failure.reason
    })
    this.claimSyncChain = sync.catch(() => {})
    return sync
  }

  async watchDownload(targetId: string, timeoutMs: number, trigger?: (context: { signal: AbortSignal; deadlineAt: number }) => Promise<void>, signal?: AbortSignal): Promise<RelayDownload & { browserInstanceId: string; triggerOutcome: string; triggerError?: string }> {
    const { client } = this.requireClientForTarget(targetId)
    let triggerOutcome = trigger ? 'pending' : 'not_requested'
    let triggerError: string | undefined
    const watch = this.downloadWatches.arm(client.browserInstanceId, timeoutMs)
    const operation = new AbortController()
    this.downloadOperations.add(operation)
    const onAbort = () => operation.abort(relayOperationError('Browser download cancelled; completion is unknown.', 'DOWNLOAD_CANCELLED'))
    const timer = setTimeout(() => operation.abort(relayOperationError('Timed out waiting for browser download; do not repeat the trigger automatically.', 'DOWNLOAD_TIMEOUT')), Math.max(0, watch.expiresAtMs - Date.now()))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const aborted = new Promise<never>((_, reject) => {
      if (operation.signal.aborted) reject(operation.signal.reason)
      else operation.signal.addEventListener('abort', () => reject(operation.signal.reason), { once: true })
    })
    try {
      await Promise.race([
        (async () => {
          operation.signal.throwIfAborted()
          await this.flushDownloadDisarms(client.browserInstanceId)
          operation.signal.throwIfAborted()
          await this.sendToExtension(client, 'Extension.armDownloadWatch', { watchId: watch.watchId, sinceTs: watch.sinceTs, expiresAtMs: watch.expiresAtMs }, undefined, { deadlineAt: watch.expiresAtMs, signal: operation.signal })
          operation.signal.throwIfAborted()
          if (trigger) {
            if (watch.records.size) throw relayOperationError('A browser-wide download started before the trigger; attribution is ambiguous.', 'DOWNLOAD_AMBIGUOUS')
            void Promise.resolve().then(() => {
              operation.signal.throwIfAborted()
              return trigger({ signal: operation.signal, deadlineAt: watch.expiresAtMs })
            }).then(() => { triggerOutcome = 'completed' }, (error) => {
              triggerOutcome = 'failed'
              triggerError = error instanceof Error ? error.message : String(error)
              if (![...watch.records.values()].some((record) => record.state === 'completed')) {
                this.downloadWatches.reject(watch, error instanceof Error ? error : new Error(String(error)))
              }
            })
            await watch.terminal
          } else {
            await watch.terminal
          }
        })(),
        aborted,
      ])
      return {
        ...this.downloadWatches.result(watch),
        browserInstanceId: client.browserInstanceId,
        triggerOutcome: triggerOutcome === 'pending' ? 'unknown' : triggerOutcome,
        ...(triggerError ? { triggerError } : {}),
      }
    } catch (error) {
      this.downloadWatches.reject(watch, error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      this.downloadOperations.delete(operation)
      operation.abort()
      const disarms = this.pendingDownloadDisarms.get(client.browserInstanceId) ?? new Map<string, number>()
      disarms.set(watch.watchId, watch.expiresAtMs)
      this.pendingDownloadDisarms.set(client.browserInstanceId, disarms)
      this.downloadWatches.disarm(watch)
      void this.flushDownloadDisarms(client.browserInstanceId).catch((error) => {
        this.logger.warn?.(`[browser-relay] failed to disarm download watch: ${String(error)}`)
      })
    }
  }

  private flushDownloadDisarms(browserInstanceId: string): Promise<void> {
    const previous = this.downloadDisarmChains.get(browserInstanceId) ?? Promise.resolve()
    const flush = previous.catch(() => {}).then(async () => {
      const disarms = this.pendingDownloadDisarms.get(browserInstanceId)
      if (!disarms) return
      for (const [watchId, expiresAtMs] of disarms) {
        if (expiresAtMs > Date.now()) {
          const client = this.extensionClients.get(browserInstanceId)
          if (!client?.handshakeOk || client.ws.readyState !== WebSocket.OPEN) return
          await this.sendToExtension(client, 'Extension.disarmDownloadWatch', { watchId }, undefined, { deadlineAt: Math.min(expiresAtMs, Date.now() + 1_000) })
        }
        disarms.delete(watchId)
      }
      if (!disarms.size) this.pendingDownloadDisarms.delete(browserInstanceId)
    })
    this.downloadDisarmChains.set(browserInstanceId, flush)
    void flush.finally(() => {
      if (this.downloadDisarmChains.get(browserInstanceId) === flush) this.downloadDisarmChains.delete(browserInstanceId)
    }).catch(() => {})
    return flush
  }

  async releaseServiceResources(): Promise<void> {
    for (const operation of this.downloadOperations) operation.abort(relayOperationError('Relay stopping; browser download completion is unknown.', 'DOWNLOAD_STOPPED'))
    this.downloadWatches.stop()
    await this.syncTabClaims(() => {
      const browsers = new Set([...this.desiredTabClaims.values()].map((claim) => claim.browserInstanceId))
      for (const claim of this.desiredTabClaims.values()) claim.principalId = null
      return browsers
    })
  }

  async waitForAttachedTarget(targetId: string, timeoutMs = TARGET_ATTACH_TIMEOUT_MS): Promise<AttachedRelayTarget> {
    const existing = this.findTargetByTargetId(targetId)
    if (existing?.physical) {
      return this.toAttachedRelayTarget(existing)
    }

    return await new Promise<AttachedRelayTarget>((resolve, reject) => {
      const pending: PendingTargetAttachmentRequest = {
        resolve: (target) => {
          clearTimeout(pending.timer)
          resolve(target)
        },
        reject: (error) => {
          clearTimeout(pending.timer)
          reject(error)
        },
        timer: setTimeout(() => {
          this.deletePendingTargetAttachment(targetId, pending)
          this.logger.warn?.(
            `[browser-relay] waitForAttachedTarget timed out targetId=${targetId} knownTargets=${this.getPhysicalTargets().map((target) => `${target.targetId ?? 'null'}@${target.targetInfo.url ?? ''}`).join(', ')}`,
          )
          reject(new Error(`Timed out waiting for target "${targetId}" to become attached.`))
        }, timeoutMs),
      }

      const waiters = this.pendingTargetAttachments.get(targetId) ?? new Set<PendingTargetAttachmentRequest>()
      waiters.add(pending)
      this.pendingTargetAttachments.set(targetId, waiters)
    })
  }

  async resolveReadyTarget(targetId: string, timeoutMs = TARGET_ATTACH_TIMEOUT_MS): Promise<ReadyRelayTarget> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      const attached = await this.waitForAttachedTarget(targetId, Math.max(100, timeoutMs - (Date.now() - startedAt)))
      const target = this.findTargetByTargetId(attached.targetId)
      if (!target?.physical) {
        await sleep(50)
        continue
      }

      if (this.isTargetReady(target)) {
        return this.toReadyRelayTarget(target)
      }

      await this.primePhysicalTargetBootstrap(target)
      if (this.isTargetReady(target)) {
        return this.toReadyRelayTarget(target)
      }

      await sleep(50)
    }

    throw new Error(`Target "${targetId}" is not ready for browser control yet.`)
  }

  async focusTarget(targetId: string): Promise<void> {
    const { client, localTargetId } = this.requireClientForTarget(targetId)
    await this.sendToExtension(client, 'Target.activateTarget', { targetId: localTargetId })
  }

  async closeTarget(targetId: string, principalId?: string): Promise<RelayCloseTargetReceipt> {
    const { client, localTargetId } = this.requireClientForTarget(targetId)
    return await this.sendToExtension(client, 'Target.closeTarget', { targetId: localTargetId, principalId }) as RelayCloseTargetReceipt
  }

  async evaluate(targetId: string, expression: string): Promise<unknown> {
    const { client, localSessionId } = this.requireClientForTarget(targetId)
    return this.sendToExtension(client, 'Runtime.evaluate', { expression, returnByValue: true }, localSessionId)
  }

  async getCookies(targetId: string): Promise<unknown[]> {
    const { client, localTargetId } = this.requireClientForTarget(targetId)
    const result = await this.sendToExtension(client, 'Extension.getCookies', { targetId: localTargetId })
    return Array.isArray(result) ? result : []
  }

  async setCookies(targetId: string, cookies: BrowserCookieInput[]): Promise<void> {
    const { client, localTargetId } = this.requireClientForTarget(targetId)
    await this.sendToExtension(client, 'Extension.setCookies', { targetId: localTargetId, cookies })
  }

  async clearCookies(targetId: string): Promise<void> {
    const { client, localTargetId } = this.requireClientForTarget(targetId)
    await this.sendToExtension(client, 'Extension.clearCookies', { targetId: localTargetId })
  }

  async closeAgentTabs(targetIds: string[], principalId: string, sessionGroupId?: string): Promise<RelayCloseAllReceipt> {
    const groups = new Map<ExtensionClient, string[]>()
    for (const targetId of new Set(targetIds)) {
      const { client, localTargetId } = this.requireClientForTarget(targetId)
      const ids = groups.get(client) ?? []
      ids.push(localTargetId)
      groups.set(client, ids)
    }
    const receipt: RelayCloseAllReceipt = {
      success: true, closed: 0, alreadyClosed: 0, retained: 0, denied: 0, failed: 0, timedOut: 0,
      closedIds: [], alreadyClosedIds: [], retainedIds: [], deniedIds: [], failedIds: [], timedOutIds: [],
      deniedDetails: [], failedDetails: [], timedOutDetails: [],
    }
    await Promise.all([...groups].map(async ([client, ids]) => {
      const result = await this.sendToExtension(client, 'Target.closeAgentTabsByIds', { targetIds: ids, principalId, ...(sessionGroupId ? { sessionGroupId } : {}) }) as Record<string, unknown>
      for (const key of ['closed', 'alreadyClosed', 'retained', 'denied'] as const) {
        const values = Array.isArray(result[key]) ? result[key] as string[] : []
        receipt[key] += values.length
        receipt[`${key}Ids`].push(...values.map((id) => ensureExternalTargetId(client.browserInstanceId, id)))
      }
      if (Array.isArray(result.deniedDetails)) {
        for (const detail of result.deniedDetails as Array<{ targetId: string; error: string }>) {
          receipt.deniedDetails.push({ targetId: ensureExternalTargetId(client.browserInstanceId, detail.targetId), error: detail.error })
        }
      }
      for (const key of ['failed', 'timedOut'] as const) {
        const values = Array.isArray(result[key]) ? result[key] as Array<{ targetId: string; error?: string }> : []
        receipt[key] += values.length
        for (const value of values) {
          const targetId = ensureExternalTargetId(client.browserInstanceId, value.targetId)
          receipt[`${key}Ids`].push(targetId)
          if (key === 'failed') receipt.failedDetails.push({ targetId, error: value.error ?? '' })
          else receipt.timedOutDetails.push({ targetId, error: value.error ?? '', outcome: 'unknown', retryable: false })
        }
      }
    }))
    receipt.success = receipt.denied === 0 && receipt.failed === 0 && receipt.timedOut === 0
    if (receipt.timedOut) Object.assign(receipt, { outcome: 'unknown', retryable: false })
    return receipt
  }

  async closeAllAgentTabs(principalId?: string): Promise<RelayCloseAllReceipt> {
    const client = await this.resolveClientForBrowserUse()
    // Removal events can retire routes before the command response arrives.
    const targets = new Map([...client.connectedTargets.values()].map((target) => [target.tabId, target.targetId ?? target.targetKey]))
    const result = await this.sendToExtension(client, 'Target.closeAllAgentTabs', { principalId }) as Record<string, unknown>
    const externalId = (id: unknown): string => typeof id === 'number'
      ? targets.get(id) ?? encodeExternalTargetId(client.browserInstanceId, `vtab-${id}`)
      : ensureExternalTargetId(client.browserInstanceId, String(id))
    const ids = (key: string): string[] => Array.isArray(result[key]) ? result[key].map(externalId) : []
    const details = (key: string): Array<{ targetId: string; error: string }> => Array.isArray(result[key])
      ? result[key].map((item: Record<string, unknown>) => ({ targetId: externalId(item.tabId ?? item.targetId), error: String(item.error ?? '') }))
      : []
    return {
      success: result.success === true,
      closed: Number(result.closed ?? 0), alreadyClosed: Number(result.alreadyClosed ?? 0),
      retained: Number(result.retained ?? 0), denied: Number(result.denied ?? 0),
      failed: Number(result.failed ?? 0), timedOut: Number(result.timedOut ?? 0),
      closedIds: ids('closedIds'), alreadyClosedIds: ids('alreadyClosedIds'),
      retainedIds: ids('retainedIds'), deniedIds: ids('deniedIds'),
      timedOutIds: ids('timedOutIds'), failedIds: ids('failedIds'),
      deniedDetails: details('deniedDetails'),
      failedDetails: details('failedDetails'),
      timedOutDetails: details('timedOutDetails').map((detail) => ({ ...detail, outcome: 'unknown', retryable: false })),
      ...(result.outcome === 'unknown' ? { outcome: 'unknown', retryable: false } : {}),
    }
  }

  async selectExecutionWindowForTargetIfUnset(targetId: string): Promise<boolean> {
    const target = this.findTargetByTargetId(targetId)
    if (!target?.windowId || this.hasSelection) {
      return false
    }

    const changed = await this.setSelectionState({
      kind: 'auto',
      browserInstanceId: target.browserInstanceId,
      windowId: target.windowId,
    })
    if (changed) {
      this.broadcastBrowserSelection()
    }
    return changed
  }

  async ensureExecutionWindowSelectionForBrowserUse(principalId?: string, sessionGroupId = principalId): Promise<boolean> {
    const nextSelection = this.resolveSelectionForExplicitBrowserUse()
    if (nextSelection) {
      const changed = await this.setSelectionState(nextSelection)
      if (changed) {
        this.broadcastBrowserSelection()
      }
      return changed
    }

    return await this.provisionExecutionWindowSelectionForBrowserUse(principalId, sessionGroupId)
  }

  resolveSelectedSessionId(): string {
    return this.requireSelectedCurrentTarget().sessionId
  }

  private async restoreSelectionState(): Promise<void> {
    const selection = await readRelaySelection(this.stateDir)
    this.selectionState = selection ?? { kind: 'none' }
  }

  private async persistSelectionState(): Promise<void> {
    if (this.selectionState.kind === 'none') {
      await clearRelaySelection(this.stateDir)
      return
    }

    const record: RelaySelectionRecord = {
      kind: this.selectionState.kind,
      browserInstanceId: this.selectionState.browserInstanceId,
      windowId: this.selectionState.windowId,
    }

    await writeRelaySelection(
      record,
      this.stateDir,
    )
  }

  private async setSelectionState(next: SelectionState): Promise<boolean> {
    const changed = this.selectionStatesDiffer(this.selectionState, next)
    this.selectionState = next
    try {
      await this.persistSelectionState()
    } catch (error) {
      this.logger.warn?.(`[browser-relay] failed to persist selected window: ${String(error)}`)
    }
    return changed
  }

  private selectionStatesDiffer(left: SelectionState, right: SelectionState): boolean {
    return left.kind !== right.kind
      || left.kind !== 'none' && (
        right.kind === 'none'
        || left.browserInstanceId !== right.browserInstanceId
        || left.windowId !== right.windowId
      )
  }

  private async setManualSelection(browserInstanceId: string, windowId: number): Promise<boolean> {
    return await this.setSelectionState({
      kind: 'manual',
      browserInstanceId,
      windowId,
    })
  }

  private async clearSelection(): Promise<boolean> {
    return await this.setSelectionState({ kind: 'none' })
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
              browserCount: this.connectedExtensionClients.length,
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
        browserCount: this.connectedExtensionClients.length,
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
        .then((receipt) => {
          writeJson(res, receipt.success && !receipt.skipped ? 200 : 409, receipt)
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

    const onHandshakeMessage = async (raw: RawData) => {
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

      try {
        client = {
          ws,
          sessionKey: decryptSessionKey(params.encryptedSessionKey),
          handshakeOk: true,
          browserInstanceId,
          browserName: typeof params.browserName === 'string' && params.browserName.trim()
            ? params.browserName.trim()
            : browserInstanceId,
          connectedAt: Date.now(),
          nextRequestId: 1,
          pendingRequests: new Map(),
          connectedTargets: existing?.connectedTargets ?? new Map(),
          childTargets: new Map(),
          resyncEpoch: -1,
          currentSessionId: null,
          pingTimer: null,
          lastPongAt: Date.now(),
          lastHeartbeatTickAt: Date.now(),
          recoveryProbeStartedAt: null,
          reconnectTimer: null,
        }
      } catch (error) {
        this.logger.warn?.(`[browser-relay] failed to decrypt session key: ${String(error)}`)
        ws.close(4003, 'Invalid encrypted session key')
        return
      }

      if (existing) {
        if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer)
        existing.reconnectTimer = null
        this.handleExtensionClose(existing, true)
        existing.ws.close(1000, 'replaced by new connection')
      }
      this.extensionClients.set(browserInstanceId, client)
      await this.reconcileSelection(false)
      if (this.extensionClients.get(browserInstanceId) !== client || ws.readyState !== WebSocket.OPEN) return

      this.sendExtensionMessage(
        client,
        {
          method: 'Extension.helloAck',
          params: {
            status: 'ok',
            encrypted: true,
            traceEnabled: isRelayDebugEnabled(),
            browserCount: this.connectedExtensionClients.length,
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
          void this.onExtensionMessage(client, payload).catch((error) => {
            this.logger.warn?.(`[browser-relay] failed to process extension message: ${String(error)}`)
          })
        }
      })
      client.lastPongAt = Date.now()
      client.lastHeartbeatTickAt = client.lastPongAt
      client.pingTimer = setInterval(() => this.runExtensionHeartbeat(client!), EXTENSION_PING_INTERVAL_MS)
      this.broadcastBrowserSelection()
      void this.flushDownloadDisarms(browserInstanceId).catch((error) => this.logger.warn?.(`[browser-relay] failed to resync download disarms: ${String(error)}`))
      this.notifyExtensionConnected({
        browserInstanceId,
        browserName: client.browserName,
      })
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

  private handleExtensionClose(client: ExtensionClient, replacing = false): void {
    if (this.extensionClients.get(client.browserInstanceId) !== client || !client.handshakeOk) return
    client.handshakeOk = false
    client.sessionKey = null
    if (client.pingTimer) clearInterval(client.pingTimer)
    client.pingTimer = null
    this.rejectPendingRequests(client, 'Extension disconnected')
    this.rejectPendingTargetAttachmentsForBrowser(
      client.browserInstanceId,
      'Extension disconnected before target attachment completed.',
    )
    for (const target of client.connectedTargets.values()) {
      this.handleDetachedFromTarget(client, { sessionId: target.localSessionId, reason: 'browser_disconnected' })
    }
    this.clearBrowserSessionsForBrowser(client.browserInstanceId)

    if (replacing) return
    client.reconnectTimer = setTimeout(() => this.finalizeExtensionDisconnect(client), EXTENSION_RECONNECT_GRACE_MS)
  }

  private finalizeExtensionDisconnect(client: ExtensionClient): void {
    if (this.extensionClients.get(client.browserInstanceId) !== client || client.handshakeOk) return
    client.reconnectTimer = null
    this.extensionClients.delete(client.browserInstanceId)
    this.clearClientTargets(client, true)
    void this.reconcileSelection()
    if (this.extensionClients.size === 0) {
      for (const cdpClient of this.cdpClients) cdpClient.close(1011, 'extension disconnected')
      this.cdpClients.clear()
    }
  }

  private runExtensionHeartbeat(client: ExtensionClient): void {
    if (this.extensionClients.get(client.browserInstanceId) !== client || !client.handshakeOk) return
    const now = Date.now()
    const delayed = now - client.lastHeartbeatTickAt > EXTENSION_PING_INTERVAL_MS * 2
    client.lastHeartbeatTickAt = now
    if (client.recoveryProbeStartedAt !== null) {
      if (client.lastPongAt >= client.recoveryProbeStartedAt) {
        client.recoveryProbeStartedAt = null
        return
      }
      if (delayed) {
        this.startExtensionRecoveryProbe(client, now)
        return
      }
      if (now - client.recoveryProbeStartedAt >= EXTENSION_PING_INTERVAL_MS * 2) {
        this.failExtensionLiveness(client, 'no pong after local timer recovery probe')
      }
      return
    }
    if (now - client.lastPongAt > EXTENSION_LIVENESS_TIMEOUT_MS) {
      if (delayed) this.startExtensionRecoveryProbe(client, now)
      else this.failExtensionLiveness(client, `no pong for ${Math.round((now - client.lastPongAt) / 1_000)}s`)
      return
    }
    this.sendExtensionPing(client)
  }

  private startExtensionRecoveryProbe(client: ExtensionClient, now: number): void {
    client.recoveryProbeStartedAt = now
    this.logger.warn?.('[browser-relay] heartbeat timer delayed; probing extension before liveness verdict')
    this.sendExtensionPing(client)
  }

  private sendExtensionPing(client: ExtensionClient): void {
    try {
      if (client.ws.readyState !== WebSocket.OPEN) throw new Error('Extension socket is not open')
      this.sendExtensionMessage(client, { method: 'ping' }, true)
    } catch (error) {
      this.failExtensionLiveness(client, `ping send failed: ${String(error)}`)
    }
  }

  private failExtensionLiveness(client: ExtensionClient, reason: string): void {
    this.logger.warn?.(`[browser-relay] extension liveness failed: ${reason}`)
    this.handleExtensionClose(client)
    client.ws.close(4004, 'Extension liveness timeout')
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
        if (!this.hasExtensionConnection) throw new Error('Extension not connected')
        const result = await this.routeCdpCommand({
          cdpClient: ws,
          method: message.method,
          params: message.params ?? {},
          sessionId: message.sessionId,
        })

        const browserSession = typeof message.sessionId === 'string' ? this.browserSessions.get(message.sessionId) : null
        if ((!message.sessionId || browserSession?.cdpClient === ws) && message.method === 'Target.setAutoAttach') {
          this.ensureTargetEventsForClient(ws, 'autoAttach')
        }
        if (
          (!message.sessionId || browserSession?.cdpClient === ws)
          && message.method === 'Target.setDiscoverTargets'
          && message.params?.discover === true
        ) {
          this.ensureTargetEventsForClient(ws, 'discover')
        }

        ws.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, result }))
      } catch (error) {
        ws.send(
          JSON.stringify({
            id: message.id,
            sessionId: message.sessionId,
            error: {
              message: formatRelayErrorMessage(error),
            },
          }),
        )
      }
    })

    ws.on('close', () => {
      this.clearSessionsForCdpClient(ws)
      this.cdpClients.delete(ws)
      this.cdpClientState.delete(ws)
    })
    ws.on('error', () => {
      this.clearSessionsForCdpClient(ws)
      this.cdpClients.delete(ws)
      this.cdpClientState.delete(ws)
    })
  }

  private async routeCdpCommand(input: {
    cdpClient: WebSocket
    method: string
    params?: Record<string, unknown>
    sessionId?: string
  }): Promise<unknown> {
    const routedSession = input.sessionId
      ? this.resolveRoutedSession(input.cdpClient, input.sessionId)
      : null
    if (input.sessionId && !routedSession) {
      throw new Error(`Unknown sessionId: ${input.sessionId}`)
    }
    const attachedSession = routedSession?.kind === 'attach' ? routedSession.attachSession : null
    const browserSession = routedSession?.kind === 'browser' ? routedSession.browserSession : null
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
        if (attachedSession) {
          return this.sendToExtensionForAttachedSession(attachedSession, input.method, input.params ?? {})
        }
        return {}
      case 'Target.setAutoAttach':
        if (attachedSession) {
          const result = await this.sendToExtensionForAttachedSession(attachedSession, input.method, input.params ?? {})
          attachedSession.autoAttachChildren = input.params?.autoAttach === true
          if (attachedSession.autoAttachChildren) {
            setTimeout(() => this.replayChildTargets(attachedSession), 0)
          }
          return result
        }
        return {}
      case 'Target.setDiscoverTargets':
      case 'Page.enable':
      case 'Log.enable':
      case 'Inspector.enable':
      case 'Performance.enable':
        if (attachedSession) {
          return this.sendToExtensionForAttachedSession(attachedSession, input.method, input.params ?? {})
        }
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
            ?? [...this.extensionClients.values()].flatMap((client) => [...client.childTargets.values()]).find((child) => child.targetId === targetId)
          if (!target) throw new Error('target not found')
          relayDebugInfo(
            this.logger,
            () => `[browser-relay] Target.getTargetInfo by targetId targetId=${targetId} resolvedSessionId=${target.sessionId} resolvedUrl="${target.targetInfo.url ?? ''}"`,
          )
          return { targetInfo: normalizeTargetInfo(target.targetInfo) }
        }
        if (input.sessionId) {
          if (browserSession) {
            const browserTarget = this.getBrowserTargetInfoForBrowser(browserSession.browserInstanceId)
            relayDebugInfo(
              this.logger,
              () => `[browser-relay] Target.getTargetInfo by browserSession sessionId=${input.sessionId} browserTargetId=${browserTarget.targetId}`,
            )
            return { targetInfo: browserTarget }
          }
          const target = attachedSession ? this.findTargetByTargetId(attachedSession.targetId)
            ?? this.extensionClients.get(attachedSession.browserInstanceId)?.childTargets.get(attachedSession.physicalSessionId) : null
          if (!target) throw new Error('target not found')
          relayDebugInfo(
            this.logger,
            () => `[browser-relay] Target.getTargetInfo by sessionId sessionId=${input.sessionId} resolvedTargetId=${target.targetId ?? 'null'} resolvedUrl="${target.targetInfo.url ?? ''}"`,
          )
          return { targetInfo: normalizeTargetInfo(target.targetInfo) }
        }
        const browserTarget = this.getBrowserTargetInfo()
        relayDebugInfo(
          this.logger,
          () => `[browser-relay] Target.getTargetInfo root browserTargetId=${browserTarget.targetId}`,
        )
        return { targetInfo: browserTarget }
      }
      case 'Target.attachToBrowserTarget': {
        const client = await this.resolveClientForBrowserUse()
        const sessionId = this.allocateBrowserSession(client.browserInstanceId, input.cdpClient)
        relayDebugInfo(
          this.logger,
          () => `[browser-relay] Target.attachToBrowserTarget browserInstanceId=${client.browserInstanceId} browserSessionId=${sessionId}`,
        )
        return { sessionId }
      }
      case 'Target.attachToTarget': {
        const targetId = typeof input.params?.targetId === 'string' ? input.params.targetId : undefined
        if (!targetId) throw new Error('targetId required')
        const target = this.findTargetByTargetId(targetId)
        if (!target) throw new Error('target not found')
        if (input.sessionId) {
          const routedBrowserInstanceId = browserSession?.browserInstanceId ?? attachedSession?.browserInstanceId ?? null
          if (routedBrowserInstanceId && routedBrowserInstanceId !== target.browserInstanceId) {
            throw new Error('target belongs to a different browser session')
          }
        }
        const attachSession = this.allocateAttachedClientSession(target, input.cdpClient, { autoAttached: false })
        relayDebugInfo(
          this.logger,
          () => `[browser-relay] Target.attachToTarget allocated attachSessionId=${attachSession.attachSessionId} targetId=${targetId} physicalSessionId=${target.sessionId} url="${target.targetInfo.url ?? ''}"`,
        )
        setTimeout(() => {
          this.replayBootstrapToAttachedSession(attachSession.attachSessionId)
        }, 0)
        return { sessionId: attachSession.attachSessionId }
      }
      case 'Target.detachFromTarget': {
        const detachedSessionId = typeof input.params?.sessionId === 'string' ? input.params.sessionId : undefined
        if (detachedSessionId) this.resolveRoutedSession(input.cdpClient, detachedSessionId)
        if (detachedSessionId && this.browserSessions.delete(detachedSessionId)) {
          relayDebugInfo(
            this.logger,
            () => `[browser-relay] Target.detachFromTarget browserSessionId=${detachedSessionId}`,
          )
          return {}
        }
        if (detachedSessionId && this.releaseAttachedClientSession(detachedSessionId)) {
          relayDebugInfo(
            this.logger,
            () => `[browser-relay] Target.detachFromTarget released attachSessionId=${detachedSessionId}`,
          )
        }
        return {}
      }
      case 'Target.createTarget': {
        const client = await this.resolveClientForBrowserUse()
        const result = await this.sendToExtension(client, input.method, input.params ?? {})
        const rawTargetId = readTargetIdFromResult(result)
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
      case 'Target.closeAllAgentTabs':
        return this.closeAllAgentTabs(typeof input.params?.principalId === 'string' ? input.params.principalId : undefined)
      case 'Runtime.enable':
      case 'Network.enable':
        if (!attachedSession) return {}
        return this.sendToExtensionForAttachedSession(attachedSession, input.method, input.params ?? {})
      default:
        if (!input.sessionId) {
          throw new Error(`sessionId is required for method ${input.method}`)
        }
        if (!attachedSession) {
          throw new Error(`Unsupported browser-session method ${input.method}`)
        }
        return this.sendToExtensionForAttachedSession(attachedSession, input.method, input.params ?? {})
    }
  }

  private async onExtensionMessage(client: ExtensionClient, raw: RawData): Promise<void> {
    if (this.extensionClients.get(client.browserInstanceId) !== client || !client.handshakeOk) return
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
          errorDetail?: unknown
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
      client.lastPongAt = Date.now()
      return
    }

    if (typeof message.id === 'number') {
      const pending = client.pendingRequests.get(message.id)
      if (!pending) return
      client.pendingRequests.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error != null) {
        const error = new Error(String(message.error))
        if (message.errorDetail && typeof message.errorDetail === 'object' && !Array.isArray(message.errorDetail)) {
          Object.assign(error, { errorDetail: message.errorDetail })
        }
        pending.reject(error)
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
      if (await this.setManualSelection(client.browserInstanceId, selectedWindowId)) {
        this.broadcastBrowserSelection()
      }
      return
    }

    if (message.method === 'Extension.clearExecutionWindowSelection') {
      if (await this.clearSelection()) {
        this.broadcastBrowserSelection()
      }
      return
    }

    if (message.method === 'Extension.currentTargetChanged') {
      const localSessionId = typeof message.params?.sessionId === 'string' ? message.params.sessionId : ''
      if (!localSessionId) {
        client.currentSessionId = null
        return
      }
      const externalSessionId = encodeExternalSessionId(client.browserInstanceId, localSessionId)
      const target = client.connectedTargets.get(externalSessionId) ?? null
      client.currentSessionId = target?.physical ? externalSessionId : null
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
      case 'Extension.downloadCreated':
      case 'Extension.downloadCompleted':
      case 'Extension.downloadInterrupted':
        this.downloadWatches.receive(client.browserInstanceId, eventMethod, eventParams)
        return
      case 'Extension.tabDiscovered':
        this.handleTabDiscovered(client, eventParams)
        this.refreshOpenerIds(client)
        await this.reconcileSelection()
        return
      case 'Extension.tabRemoved':
        this.handleTabRemoved(client, eventParams)
        this.refreshOpenerIds(client)
        await this.reconcileSelection()
        return
      case 'Extension.tabUpdated':
        this.handleTabUpdated(client, eventParams)
        this.refreshOpenerIds(client)
        await this.reconcileSelection()
        return
      case 'Extension.tabsResyncComplete':
        this.handleTabsResyncComplete(client, eventParams)
        void this.syncTabClaims(() => [client.browserInstanceId]).catch((error) => this.logger.warn?.(`[browser-relay] failed to resync tab claims: ${String(error)}`))
        await this.reconcileSelection()
        return
      case 'Extension.tabOpenerUpdated':
        this.handleTabUpdated(client, eventParams)
        this.refreshOpenerIds(client)
        return
      case 'Target.attachedToTarget':
        this.handleAttachedToTarget(client, eventParams, externalSessionId)
        await this.reconcileSelection()
        return
      case 'Target.detachedFromTarget':
        this.handleDetachedFromTarget(client, eventParams, externalSessionId)
        this.refreshOpenerIds(client)
        await this.reconcileSelection()
        return
      case 'Target.targetInfoChanged':
        this.handleTargetInfoChanged(client, eventParams, externalSessionId)
        await this.reconcileSelection()
        return
      default:
        if (externalSessionId) {
          this.recordSessionScopedEvent(externalSessionId, eventMethod, eventParams)
          this.forwardSessionScopedEvent(externalSessionId, eventMethod, eventParams)
          return
        }
        this.broadcastToCdpClients({
          method: eventMethod,
          params: eventParams,
        })
    }
  }

  private findEventTarget(client: ExtensionClient, params: Record<string, unknown>): ConnectedTarget | undefined {
    if (typeof params.sessionId === 'string') {
      const target = client.connectedTargets.get(encodeExternalSessionId(client.browserInstanceId, params.sessionId))
      if (target) return target
    }
    const key = typeof params.targetKey === 'string' ? params.targetKey : typeof params.vtabId === 'string' ? params.vtabId : params.targetId
    return [...client.connectedTargets.values()].find((target) => target.localTargetKey === key || target.localTargetId === key)
  }

  private updateTabMetadata(target: ConnectedTarget, params: Record<string, unknown>): void {
    if ('windowId' in params) target.windowId = toNullableInteger(params.windowId)
    if ('tabId' in params) target.tabId = toNullableInteger(params.tabId)
    if (typeof params.active === 'boolean') target.active = params.active
    if (typeof params.createdByAgent === 'boolean') target.createdByAgent = params.createdByAgent
    if (typeof params.createdBy === 'string' || params.createdBy === null) target.createdBy = params.createdBy
    if (typeof params.sessionGroupId === 'string' || params.sessionGroupId === null) target.sessionGroupId = params.sessionGroupId
    if (typeof params.claimedBy === 'string' || params.claimedBy === null) {
      target.claimedBy = params.claimedBy
      if (target.claimedBy && !this.desiredTabClaims.has(target.targetKey)) {
        this.desiredTabClaims.set(target.targetKey, { browserInstanceId: target.browserInstanceId, localTargetKey: target.localTargetKey, principalId: this.pendingSessionReleases.get(target.browserInstanceId)?.has(target.claimedBy) ? null : target.claimedBy, sessionGroupId: target.sessionGroupId })
      }
    }
    if (typeof params.retained === 'boolean') target.retained = params.retained
    if (typeof params.openerVtabId === 'string') target.openerVtabId = params.openerVtabId
  }

  private storeTab(client: ExtensionClient, params: Record<string, unknown>, physical: boolean): ConnectedTarget | null {
    const localSessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const info = params.targetInfo as Partial<RelayTargetInfo> | undefined
    const localTargetKey = typeof params.targetKey === 'string' ? params.targetKey : typeof params.vtabId === 'string' ? params.vtabId : ''
    if (!localSessionId || !localTargetKey || !info?.targetId) return null
    const sessionId = encodeExternalSessionId(client.browserInstanceId, localSessionId)
    let existing = [...client.connectedTargets.values()].find((target) => target.localTargetKey === localTargetKey)
    const previousMetadata = existing
    if (existing && (existing.sessionId !== sessionId || existing.physical && (!physical || existing.localTargetId !== info.targetId))) {
      this.retireTargetRoutes(client, existing, 'attachment_replaced')
      client.connectedTargets.delete(existing.sessionId)
      existing = undefined
    }
    const target: ConnectedTarget = existing ?? {
      browserInstanceId: client.browserInstanceId,
      browserName: client.browserName,
      sessionId,
      localSessionId,
      targetKey: encodeExternalTargetId(client.browserInstanceId, localTargetKey),
      localTargetKey,
      targetId: null,
      localTargetId: null,
      createdByAgent: false,
      createdBy: null,
      claimedBy: null,
      sessionGroupId: null,
      retained: false,
      targetInfo: normalizeTargetInfo({ targetId: '' }),
      windowId: null,
      tabId: null,
      active: false,
      physical: false,
      mainFrameUrl: '',
      readyState: '',
      executionContextReady: false,
      bootstrapPrimed: false,
      lastLifecycleEvent: null,
      lastExecutionContextCreated: null,
      lastTargetInfoChanged: null,
    }
    if (previousMetadata && !existing) {
      target.createdBy = previousMetadata.createdBy
      target.claimedBy = previousMetadata.claimedBy
      target.sessionGroupId = previousMetadata.sessionGroupId
      target.createdByAgent = previousMetadata.createdByAgent
      target.retained = previousMetadata.retained
      target.windowId = previousMetadata.windowId
      target.tabId = previousMetadata.tabId
      target.active = previousMetadata.active
    }
    target.physical = physical
    target.localTargetId = physical ? info.targetId : null
    target.targetId = physical ? encodeExternalTargetId(client.browserInstanceId, info.targetId) : null
    target.targetInfo = this.normalizeExternalTargetInfo(client, { ...info, targetId: physical ? info.targetId : localTargetKey })
    this.updateTabMetadata(target, params)
    client.connectedTargets.set(sessionId, target)
    return target
  }

  private handleTabDiscovered(client: ExtensionClient, eventParams: Record<string, unknown>): void {
    this.storeTab(client, eventParams, false)
  }

  private retireTargetRoutes(client: ExtensionClient, target: ConnectedTarget, reason: string): void {
    for (const child of [...client.childTargets.values()]) {
      if (child.parentSessionId === target.sessionId) this.removeChildTarget(client, child, reason)
    }
    this.releaseAttachedClientSessionsForPhysicalSession(target.sessionId, { targetId: target.targetId, reason })
    if (client.currentSessionId === target.sessionId) client.currentSessionId = null
    for (const id of new Set([target.targetKey, target.targetId].filter((id): id is string => Boolean(id)))) {
      this.pendingTargetUrls.delete(id)
      this.rejectPendingTargetAttachments(id, `Target "${id}" was detached before attachment completed.`)
    }
  }

  private handleTabRemoved(client: ExtensionClient, eventParams: Record<string, unknown>): void {
    const target = this.findEventTarget(client, eventParams)
    if (!target) return
    this.retireTargetRoutes(client, target, 'target_removed')
    client.connectedTargets.delete(target.sessionId)
    for (const [claimId, claim] of this.desiredTabClaims) {
      if (claim.browserInstanceId === client.browserInstanceId && claim.localTargetKey === target.localTargetKey) this.desiredTabClaims.delete(claimId)
    }
  }

  private handleTabUpdated(client: ExtensionClient, eventParams: Record<string, unknown>): void {
    const target = this.findEventTarget(client, eventParams)
    if (!target) return
    this.updateTabMetadata(target, eventParams)
    const info = eventParams.targetInfo as Partial<RelayTargetInfo> | undefined
    if (info) {
      target.targetInfo = this.normalizeExternalTargetInfo(client, { ...target.targetInfo, ...info, targetId: target.localTargetId ?? target.localTargetKey })
      if (target.physical && info.url) target.mainFrameUrl = info.url
    }
  }

  private handleAttachedToTarget(client: ExtensionClient, eventParams: Record<string, unknown>, parentSessionId?: string): void {
    if (parentSessionId) {
      this.handleChildAttached(client, eventParams, parentSessionId)
      return
    }
    const target = this.storeTab(client, eventParams, true)
    if (!target) return
    target.lastTargetInfoChanged = { targetInfo: { ...eventParams.targetInfo as Record<string, unknown> } }
    this.resolvePendingTargetAttachments(target.targetId!)
    this.resolvePendingTargetAttachments(target.targetKey)
    this.refreshOpenerIds(client)
    this.notifyAttachedTargetToAutoAttachClients({ physicalSessionId: target.sessionId, targetInfo: target.targetInfo, waitingForDebugger: eventParams.waitingForDebugger === true })
  }

  private handleChildAttached(client: ExtensionClient, params: Record<string, unknown>, parentSessionId: string): void {
    const localSessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const info = params.targetInfo as Partial<RelayTargetInfo> | undefined
    if (!localSessionId || !info?.targetId || !client.connectedTargets.has(parentSessionId) && !client.childTargets.has(parentSessionId)) return
    const sessionId = encodeExternalSessionId(client.browserInstanceId, localSessionId)
    const child: ChildTarget = { browserInstanceId: client.browserInstanceId, sessionId, localSessionId, targetId: encodeExternalTargetId(client.browserInstanceId, info.targetId), localTargetId: info.targetId, parentSessionId, targetInfo: this.normalizeExternalTargetInfo(client, { ...info, targetId: info.targetId }), waitingForDebugger: params.waitingForDebugger === true }
    client.childTargets.set(sessionId, child)
    for (const parent of [...this.attachedClientSessions.values()]) {
      if (parent.physicalSessionId === parentSessionId) this.notifyChildAttached(parent, child)
    }
  }

  private replayChildTargets(parent: AttachedClientSession): void {
    if (!parent.autoAttachChildren || this.attachedClientSessions.get(parent.attachSessionId) !== parent) return
    for (const child of this.extensionClients.get(parent.browserInstanceId)?.childTargets.values() ?? []) {
      if (child.parentSessionId === parent.physicalSessionId) this.notifyChildAttached(parent, child)
    }
  }

  private notifyChildAttached(parent: AttachedClientSession, child: ChildTarget): void {
    if (!parent.autoAttachChildren) return
    const existing = [...this.attachedClientSessions.values()].find((session) =>
      session.parentAttachSessionId === parent.attachSessionId && session.physicalSessionId === child.sessionId)
    if (existing) return
    const attachSessionId = encodeExternalAttachedSessionId(child.browserInstanceId, String(this.nextAttachedSessionId++))
    const session: AttachedClientSession = {
      attachSessionId,
      browserInstanceId: child.browserInstanceId,
      cdpClient: parent.cdpClient,
      physicalSessionId: child.sessionId,
      localPhysicalSessionId: child.localSessionId,
      targetId: child.targetId,
      localTargetId: child.localTargetId,
      autoAttached: true,
      autoAttachChildren: false,
      parentAttachSessionId: parent.attachSessionId,
    }
    this.attachedClientSessions.set(attachSessionId, session)
    this.sendCdpClientEvent(parent.cdpClient, {
      method: 'Target.attachedToTarget',
      sessionId: parent.attachSessionId,
      params: { sessionId: attachSessionId, targetInfo: child.targetInfo, waitingForDebugger: child.waitingForDebugger },
    })
  }

  private removeChildTarget(client: ExtensionClient, child: ChildTarget, reason: string): void {
    for (const nested of [...client.childTargets.values()]) {
      if (nested.parentSessionId === child.sessionId) this.removeChildTarget(client, nested, reason)
    }
    this.releaseAttachedClientSessionsForPhysicalSession(child.sessionId, { targetId: child.targetId, reason })
    client.childTargets.delete(child.sessionId)
  }

  private handleDetachedFromTarget(client: ExtensionClient, eventParams: Record<string, unknown>, parentSessionId?: string): void {
    const localSessionId = typeof eventParams.sessionId === 'string' ? eventParams.sessionId : ''
    const sessionId = encodeExternalSessionId(client.browserInstanceId, localSessionId)
    const child = client.childTargets.get(sessionId)
    const reason = typeof eventParams.reason === 'string' ? eventParams.reason : 'target_detached'
    if (parentSessionId) {
      if (child?.parentSessionId === parentSessionId) this.removeChildTarget(client, child, reason)
      return
    }
    const target = localSessionId ? client.connectedTargets.get(sessionId) : this.findEventTarget(client, eventParams)
    if (!target) return
    this.retireTargetRoutes(client, target, reason)
    target.physical = false
    target.targetId = null
    target.localTargetId = null
    this.updateTabMetadata(target, eventParams)
    target.targetInfo = this.normalizeExternalTargetInfo(client, { ...target.targetInfo, targetId: target.localTargetKey, attached: false })
    target.mainFrameUrl = ''
    target.readyState = ''
    target.executionContextReady = false
    target.bootstrapPrimed = false
    target.lastLifecycleEvent = null
    target.lastExecutionContextCreated = null
    target.lastTargetInfoChanged = null
  }

  private handleTargetInfoChanged(client: ExtensionClient, eventParams: Record<string, unknown>, parentSessionId?: string): void {
    const info = eventParams.targetInfo as Partial<RelayTargetInfo> | undefined
    if (!info?.targetId) return
    const target = [...client.connectedTargets.values()].find((entry) => entry.localTargetId === info.targetId)
    if (target) {
      this.updateTabMetadata(target, eventParams)
      target.targetInfo = this.normalizeExternalTargetInfo(client, { ...target.targetInfo, ...info, targetId: info.targetId })
      target.lastTargetInfoChanged = { ...eventParams }
      if (info.url) target.mainFrameUrl = info.url
    }
    for (const child of client.childTargets.values()) {
      if (child.localTargetId === info.targetId) child.targetInfo = this.normalizeExternalTargetInfo(client, { ...child.targetInfo, ...info, targetId: info.targetId })
    }
    if (parentSessionId) this.forwardSessionScopedEvent(parentSessionId, 'Target.targetInfoChanged', eventParams)
    else this.broadcastToCdpClients({ method: 'Target.targetInfoChanged', params: { ...eventParams, targetInfo: this.normalizeExternalTargetInfo(client, { ...info, targetId: info.targetId }) } })
  }

  private handleTabsResyncComplete(client: ExtensionClient, params: Record<string, unknown>): void {
    if (params.authoritative !== true || !Array.isArray(params.activeVtabIds) || typeof params.epoch !== 'number' || params.epoch < client.resyncEpoch) return
    client.resyncEpoch = params.epoch
    const active = new Set(params.activeVtabIds)
    for (const target of [...client.connectedTargets.values()]) {
      if (!active.has(target.localTargetKey)) this.handleTabRemoved(client, { sessionId: target.localSessionId })
    }
    for (const [targetKey, claim] of this.desiredTabClaims) {
      if (claim.browserInstanceId === client.browserInstanceId && !active.has(claim.localTargetKey)) this.desiredTabClaims.delete(targetKey)
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
                sessionId: this.allocateAttachedClientSession(target, client, {
                  autoAttached: true,
                  reuseAutoAttached: true,
                }).attachSessionId,
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
    return this.connectedExtensionClients.flatMap((client) => [...client.connectedTargets.values()])
  }

  private getPhysicalTargets(): ConnectedTarget[] {
    return this.getAllConnectedTargets().filter((target) => target.physical)
  }

  private getInspectablePageTargets(): ConnectedTarget[] {
    return this.getPhysicalTargets().filter((target) => target.targetInfo.type === 'page')
  }

  private toAttachedRelayTarget(target: ConnectedTarget): AttachedRelayTarget {
    return {
      browserInstanceId: target.browserInstanceId,
      browserName: target.browserName,
      sessionId: target.sessionId,
      targetId: target.targetId ?? '',
      windowId: target.windowId,
      tabId: target.tabId,
      active: target.active,
      title: target.targetInfo.title ?? '',
      url: target.targetInfo.url ?? '',
    }
  }

  private toReadyRelayTarget(target: ConnectedTarget): ReadyRelayTarget {
    return {
      ...this.toAttachedRelayTarget(target),
      mainFrameUrl: target.mainFrameUrl,
      readyState: target.readyState,
      executionContextReady: target.executionContextReady,
    }
  }

  private getBrowserTargetInfo(): RelayTargetInfo {
    const selectedClient = this.selectedBrowserInstanceId
      ? this.extensionClients.get(this.selectedBrowserInstanceId) ?? null
      : null
    const client =
      (selectedClient?.handshakeOk ? selectedClient : null)
      ?? (this.connectedExtensionClients.length === 1 ? this.connectedExtensionClients[0] : null)
    if (!client) {
      throw new Error('targetId or sessionId is required for Target.getTargetInfo')
    }

    return this.getBrowserTargetInfoForBrowser(client.browserInstanceId)
  }

  private getBrowserTargetInfoForBrowser(browserInstanceId: string): RelayTargetInfo {
    const client = this.extensionClients.get(browserInstanceId)
    if (!client?.handshakeOk || client.ws.readyState !== WebSocket.OPEN) {
      throw new Error('browser instance is not connected')
    }

    return normalizeTargetInfo({
      targetId: encodeExternalTargetId(client.browserInstanceId, 'browser'),
      type: 'browser',
      title: client.browserName,
      url: '',
      attached: true,
      browserContextId: 'default',
      canAccessOpener: false,
    })
  }

  private allocateBrowserSession(browserInstanceId: string, cdpClient: WebSocket): string {
    const sessionId = encodeExternalBrowserSessionId(
      browserInstanceId,
      String(this.nextBrowserSessionId++),
    )
    this.browserSessions.set(sessionId, { browserInstanceId, cdpClient })
    return sessionId
  }

  private clearBrowserSessionsForBrowser(browserInstanceId: string): void {
    for (const sessionId of [...this.browserSessions.keys()]) {
      const parsed = parseExternalBrowserSessionId(sessionId)
      if (parsed?.browserInstanceId === browserInstanceId) {
        this.browserSessions.delete(sessionId)
      }
    }
  }

  private allocateAttachedClientSession(
    target: ConnectedTarget,
    cdpClient: WebSocket,
    options: { autoAttached: boolean; reuseAutoAttached?: boolean },
  ): AttachedClientSession {
    if (!target.targetId || !target.localTargetId) {
      throw new Error('target is not physically attached')
    }

    if (options.reuseAutoAttached) {
      for (const existing of this.attachedClientSessions.values()) {
        if (
          existing.cdpClient === cdpClient
          && existing.physicalSessionId === target.sessionId
          && existing.autoAttached
        ) {
          return existing
        }
      }
    }

    const attachSessionId = encodeExternalAttachedSessionId(
      target.browserInstanceId,
      String(this.nextAttachedSessionId++),
    )
    const attachedSession: AttachedClientSession = {
      attachSessionId,
      browserInstanceId: target.browserInstanceId,
      cdpClient,
      physicalSessionId: target.sessionId,
      localPhysicalSessionId: target.localSessionId,
      targetId: target.targetId,
      localTargetId: target.localTargetId,
      autoAttached: options.autoAttached,
      autoAttachChildren: false,
    }
    this.attachedClientSessions.set(attachSessionId, attachedSession)
    return attachedSession
  }

  private releaseAttachedClientSession(attachSessionId: string): boolean {
    const session = this.attachedClientSessions.get(attachSessionId)
    if (!session) return false
    for (const child of [...this.attachedClientSessions.values()]) {
      if (child.parentAttachSessionId === attachSessionId) this.releaseAttachedClientSession(child.attachSessionId)
    }
    return this.attachedClientSessions.delete(attachSessionId)
  }

  private releaseAttachedClientSessionsForPhysicalSession(
    physicalSessionId: string,
    options: { targetId: string | null; reason: string },
  ): void {
    for (const [attachSessionId, attachedSession] of [...this.attachedClientSessions.entries()]) {
      if (attachedSession.physicalSessionId !== physicalSessionId) continue
      this.releaseAttachedClientSession(attachSessionId)
      this.sendCdpClientEvent(attachedSession.cdpClient, {
        method: 'Target.detachedFromTarget',
        ...(attachedSession.parentAttachSessionId ? { sessionId: attachedSession.parentAttachSessionId } : {}),
        params: {
          sessionId: attachSessionId,
          ...(options.targetId ? { targetId: options.targetId } : {}),
          reason: options.reason,
        },
      })
    }
  }

  private releaseAttachedClientSessionsForBrowser(browserInstanceId: string, reason: string): void {
    for (const [attachSessionId, attachedSession] of [...this.attachedClientSessions.entries()]) {
      if (attachedSession.browserInstanceId !== browserInstanceId || !this.attachedClientSessions.has(attachSessionId)) continue
      this.releaseAttachedClientSession(attachSessionId)
      this.sendCdpClientEvent(attachedSession.cdpClient, {
        method: 'Target.detachedFromTarget',
        ...(attachedSession.parentAttachSessionId ? { sessionId: attachedSession.parentAttachSessionId } : {}),
        params: {
          sessionId: attachSessionId,
          targetId: attachedSession.targetId,
          reason,
        },
      })
    }
  }

  private deleteAttachedClientSessionsForBrowser(browserInstanceId: string): void {
    for (const [attachSessionId, attachedSession] of [...this.attachedClientSessions.entries()]) {
      if (attachedSession.browserInstanceId === browserInstanceId) {
        this.attachedClientSessions.delete(attachSessionId)
      }
    }
  }

  private clearSessionsForCdpClient(cdpClient: WebSocket): void {
    for (const [sessionId, browserSession] of [...this.browserSessions.entries()]) {
      if (browserSession.cdpClient === cdpClient) {
        this.browserSessions.delete(sessionId)
      }
    }
    for (const [attachSessionId, attachedSession] of [...this.attachedClientSessions.entries()]) {
      if (attachedSession.cdpClient === cdpClient) {
        this.attachedClientSessions.delete(attachSessionId)
      }
    }
  }

  private resolveRoutedSession(
    cdpClient: WebSocket,
    sessionId: string,
  ): { kind: 'browser'; browserSession: BrowserSession } | { kind: 'attach'; attachSession: AttachedClientSession } | null {
    const browserSession = this.browserSessions.get(sessionId)
    if (browserSession) {
      if (browserSession.cdpClient !== cdpClient) {
        throw new Error('Session belongs to a different CDP client')
      }
      return { kind: 'browser', browserSession }
    }

    const attachSession = this.attachedClientSessions.get(sessionId)
    if (attachSession) {
      if (attachSession.cdpClient !== cdpClient) {
        throw new Error('Session belongs to a different CDP client')
      }
      return { kind: 'attach', attachSession }
    }

    return null
  }

  private sendToExtensionForAttachedSession(
    attachedSession: AttachedClientSession,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const client = this.extensionClients.get(attachedSession.browserInstanceId)
    if (!client) {
      return Promise.reject(new Error('Target browser instance is not connected.'))
    }
    relayDebugInfo(
      this.logger,
      () => `[browser-relay] route page-session command attachSessionId=${attachedSession.attachSessionId} -> physicalSessionId=${attachedSession.physicalSessionId} method=${method}`,
    )
    return this.sendToExtension(
      client,
      method,
      this.normalizeAttachedSessionPayload(attachedSession, method, params, 'toLocal') as Record<string, unknown>,
      attachedSession.localPhysicalSessionId,
    ).then((result) => {
      this.recordSessionScopedResult(attachedSession.physicalSessionId, method, result)
      if (method === 'Runtime.enable' || method === 'Page.setLifecycleEventsEnabled') {
        setTimeout(() => {
          this.replayBootstrapToAttachedSession(attachedSession.attachSessionId, method)
        }, 0)
      }
      return this.normalizeAttachedSessionPayload(attachedSession, method, result, 'toExternal')
    })
  }

  private sendCdpClientEvent(client: WebSocket, payload: unknown): void {
    if (client.readyState !== WebSocket.OPEN) return
    client.send(JSON.stringify(payload))
  }

  private notifyAttachedTargetToAutoAttachClients(input: {
    physicalSessionId: string
    targetInfo: RelayTargetInfo
    waitingForDebugger: boolean
  }): void {
    const target = this.findTargetBySessionId(input.physicalSessionId)
    if (!target) return

    for (const cdpClient of this.cdpClients) {
      const state = this.cdpClientState.get(cdpClient)
      if (!state?.autoAttachPrimed) continue
      const attachedSession = this.allocateAttachedClientSession(target, cdpClient, {
        autoAttached: true,
        reuseAutoAttached: true,
      })
      this.sendCdpClientEvent(cdpClient, {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: attachedSession.attachSessionId,
          targetInfo: {
            ...normalizeTargetInfo(input.targetInfo),
            attached: true,
          },
          waitingForDebugger: input.waitingForDebugger,
        },
      })
    }
  }

  private forwardSessionScopedEvent(
    physicalSessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): void {
    for (const attachedSession of this.attachedClientSessions.values()) {
      if (attachedSession.physicalSessionId !== physicalSessionId) continue
      this.sendAttachedSessionEvent(attachedSession, method, params)
    }
  }

  private sendAttachedSessionEvent(
    attachedSession: AttachedClientSession,
    method: string,
    params: Record<string, unknown>,
  ): void {
    this.sendCdpClientEvent(attachedSession.cdpClient, {
      method,
      params: this.normalizeAttachedSessionPayload(attachedSession, method, params, 'toExternal'),
      sessionId: attachedSession.attachSessionId,
    })
  }

  private async primePhysicalTargetBootstrap(target: ConnectedTarget): Promise<void> {
    if (!target.physical || !target.localSessionId) {
      return
    }

    const client = this.extensionClients.get(target.browserInstanceId)
    if (!client) {
      throw new Error('Target browser instance is not connected.')
    }

    target.bootstrapPrimed = true

    const frameTree = await this.sendToExtension(client, 'Page.getFrameTree', {}, target.localSessionId).catch(() => null)
    if (frameTree) {
      this.recordSessionScopedResult(target.sessionId, 'Page.getFrameTree', frameTree)
    }

    const readyStateResult = await this.sendToExtension(
      client,
      'Runtime.evaluate',
      {
        expression: 'document.readyState',
        returnByValue: true,
      },
      target.localSessionId,
    ).catch(() => null)
    if (readyStateResult && typeof readyStateResult === 'object') {
      const readyState = typeof (readyStateResult as Record<string, unknown>).result === 'object'
        ? typeof ((readyStateResult as Record<string, unknown>).result as Record<string, unknown>).value === 'string'
          ? String(((readyStateResult as Record<string, unknown>).result as Record<string, unknown>).value)
          : ''
        : ''
      if (readyState) {
        target.readyState = readyState
        target.executionContextReady = true
      }
    }

    if (!target.mainFrameUrl && typeof target.targetInfo.url === 'string' && target.targetInfo.url) {
      target.mainFrameUrl = target.targetInfo.url
    }
  }

  private recordSessionScopedResult(
    physicalSessionId: string,
    method: string,
    result: unknown,
  ): void {
    const target = this.findTargetBySessionId(physicalSessionId)
    if (!target?.physical || !result || typeof result !== 'object') {
      return
    }

    if (method === 'Page.getFrameTree') {
      const mainFrame = this.extractFrameTreeMainFrame(result)
      if (mainFrame) {
        this.recordMainFrame(target, mainFrame)
      }
    }
  }

  private recordSessionScopedEvent(
    physicalSessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const target = this.findTargetBySessionId(physicalSessionId)
    if (!target?.physical) {
      return
    }

    switch (method) {
      case 'Page.frameNavigated': {
        const frame = params.frame
        if (frame && typeof frame === 'object') {
          this.recordMainFrame(target, frame)
        }
        return
      }
      case 'Page.navigatedWithinDocument': {
        const frameId = typeof params.frameId === 'string' ? params.frameId : ''
        if (frameId && frameId === target.localTargetId) {
          const url = typeof params.url === 'string' ? params.url : ''
          if (url) {
            target.mainFrameUrl = url
            target.targetInfo = normalizeTargetInfo({
              ...target.targetInfo,
              url,
              targetId: target.targetId ?? target.targetInfo.targetId,
            })
          }
        }
        return
      }
      case 'Page.frameStartedLoading':
      case 'Page.frameStartedNavigating': {
        const frameId = typeof params.frameId === 'string' ? params.frameId : ''
        if (!frameId || frameId !== target.localTargetId) {
          return
        }
        target.readyState = ''
        target.executionContextReady = false
        target.lastLifecycleEvent = null
        target.lastExecutionContextCreated = null
        return
      }
      case 'Page.lifecycleEvent': {
        const frameId = typeof params.frameId === 'string' ? params.frameId : ''
        if (!frameId || frameId !== target.localTargetId) {
          return
        }
        target.lastLifecycleEvent = { ...params }
        const name = typeof params.name === 'string' ? params.name : ''
        if (name === 'DOMContentLoaded') {
          target.readyState = 'interactive'
        } else if (name === 'load') {
          target.readyState = 'complete'
        }
        return
      }
      case 'Runtime.executionContextCreated': {
        const context = params.context
        if (!context || typeof context !== 'object') {
          return
        }
        const auxData = (context as Record<string, unknown>).auxData
        const frameId = auxData && typeof auxData === 'object'
          ? typeof (auxData as Record<string, unknown>).frameId === 'string'
            ? String((auxData as Record<string, unknown>).frameId)
            : ''
          : ''
        if (frameId && frameId !== target.localTargetId) {
          return
        }
        target.executionContextReady = true
        target.lastExecutionContextCreated = { ...params }
        return
      }
      default:
        return
    }
  }

  private recordMainFrame(target: ConnectedTarget, frame: unknown): void {
    if (!frame || typeof frame !== 'object') {
      return
    }

    const frameRecord = frame as Record<string, unknown>
    const frameId = typeof frameRecord.id === 'string' ? frameRecord.id : ''
    if (frameId && frameId !== target.localTargetId) {
      return
    }

    const url = typeof frameRecord.url === 'string' ? frameRecord.url : ''
    if (!url) {
      return
    }

    target.mainFrameUrl = url
    target.targetInfo = normalizeTargetInfo({
      ...target.targetInfo,
      url,
      targetId: target.targetId ?? target.targetInfo.targetId,
    })
  }

  private extractFrameTreeMainFrame(result: unknown): Record<string, unknown> | null {
    if (!result || typeof result !== 'object') {
      return null
    }
    const frameTree = (result as Record<string, unknown>).frameTree
    if (!frameTree || typeof frameTree !== 'object') {
      return null
    }
    const frame = (frameTree as Record<string, unknown>).frame
    return frame && typeof frame === 'object' ? frame as Record<string, unknown> : null
  }

  private replayBootstrapToAttachedSession(
    attachSessionId: string,
    triggerMethod?: string,
  ): void {
    const attachedSession = this.attachedClientSessions.get(attachSessionId)
    if (!attachedSession) {
      return
    }

    const target = this.findTargetByTargetId(attachedSession.targetId)
    if (!target?.physical) {
      return
    }

    if (!triggerMethod && target.lastTargetInfoChanged) {
      this.sendAttachedSessionEvent(attachedSession, 'Target.targetInfoChanged', target.lastTargetInfoChanged)
    }
    if (triggerMethod === 'Page.setLifecycleEventsEnabled' && target.lastLifecycleEvent) {
      this.sendAttachedSessionEvent(attachedSession, 'Page.lifecycleEvent', target.lastLifecycleEvent)
    }
    if (triggerMethod === 'Runtime.enable' && target.lastExecutionContextCreated) {
      this.sendAttachedSessionEvent(attachedSession, 'Runtime.executionContextCreated', target.lastExecutionContextCreated)
    }
  }

  private isTargetReady(target: ConnectedTarget): boolean {
    return target.physical
      && Boolean(target.targetId)
      && Boolean(target.mainFrameUrl)
      && target.executionContextReady
      && isInteractiveReadyState(target.readyState)
  }

  private getCurrentTargetForWindow(
    client: ExtensionClient | undefined,
    windowId: number | null,
  ): ConnectedTarget | null {
    if (!client || windowId === null) return null

    if (client.currentSessionId) {
      const current = client.connectedTargets.get(client.currentSessionId)
      if (current?.physical && current.windowId === windowId) {
        return current
      }
    }

    const physicalTargets = [...client.connectedTargets.values()].filter((target) => (
      target.physical
      && target.windowId === windowId
    ))
    const activeTargets = physicalTargets.filter((target) => target.active)
    if (activeTargets.length > 0) {
      return activeTargets[0]
    }

    return physicalTargets.length === 1 ? physicalTargets[0] : null
  }

  private getKnownWindowIdsForClient(client: ExtensionClient): number[] {
    return [...new Set(
      [...client.connectedTargets.values()]
        .map((target) => target.windowId)
        .filter((windowId): windowId is number => windowId !== null),
    )]
  }

  private resolveSingleKnownWindowId(client: ExtensionClient): number | null {
    const knownWindowIds = this.getKnownWindowIdsForClient(client)
    return knownWindowIds.length === 1 ? knownWindowIds[0] : null
  }

  private resolveSelectionForExplicitBrowserUse(): SelectionState | null {
    if (this.selectionState.kind === 'manual') {
      return this.selectionState
    }

    if (this.selectionState.kind === 'auto') {
      const client = this.extensionClients.get(this.selectionState.browserInstanceId)
      if (!client) {
        return { kind: 'none' }
      }
      const windowId = this.selectionState.windowId
      if (client.resyncEpoch < 0 || windowId === null || this.getKnownWindowIdsForClient(client).includes(windowId)) {
        return this.selectionState
      }
      const nextWindowId = this.resolveSingleKnownWindowId(client)
      return nextWindowId === null
        ? { kind: 'none' }
        : {
            kind: 'auto',
            browserInstanceId: client.browserInstanceId,
            windowId: nextWindowId,
          }
    }

    if (this.connectedExtensionClients.length !== 1) {
      return null
    }

    const [client] = this.connectedExtensionClients
    if (!client) {
      return null
    }

    const windowId = this.resolveSingleKnownWindowId(client)
    if (windowId === null) {
      return null
    }

    return {
      kind: 'auto',
      browserInstanceId: client.browserInstanceId,
      windowId,
    }
  }

  private async createTargetInClient(client: ExtensionClient, url: string, options: { retain?: boolean; principalId?: string; sessionGroupId?: string; createInWindow?: boolean } = {}): Promise<{ targetId: string }> {
    await this.syncTabClaims(() => this.pendingSessionReleases.has(client.browserInstanceId) ? [client.browserInstanceId] : [])
    if (options.principalId) this.rememberSessionBrowser(options.principalId, options.sessionGroupId ?? options.principalId, client.browserInstanceId)
    const result = await this.sendToExtension(client, 'Target.createTarget', { url, ...options })
    const rawTargetId = readTargetIdFromResult(result)
    if (!rawTargetId) throw new Error('Target.createTarget returned no targetId')
    const targetId = ensureExternalTargetId(client.browserInstanceId, rawTargetId)
    const createdTarget = this.findTargetByTargetId(targetId)
    const receipt = result as Record<string, unknown>
    if (createdTarget && typeof receipt.mainFrameUrl === 'string' && typeof receipt.readyState === 'string') {
      createdTarget.mainFrameUrl = receipt.mainFrameUrl
      createdTarget.readyState = receipt.readyState
      createdTarget.executionContextReady = receipt.readyState === 'interactive' || receipt.readyState === 'complete'
      createdTarget.targetInfo.url = receipt.mainFrameUrl
    }
    relayDebugInfo(
      this.logger,
      () => `[browser-relay] Target.createTarget url="${url}" browserInstanceId=${client.browserInstanceId} rawTargetId=${rawTargetId} externalTargetId=${targetId}`,
    )
    this.pendingTargetUrls.set(targetId, typeof receipt.mainFrameUrl === 'string' ? receipt.mainFrameUrl : url)
    return { targetId }
  }

  private async provisionExecutionWindowSelectionForBrowserUse(principalId?: string, sessionGroupId = principalId): Promise<boolean> {
    const client = this.resolveClientForProvisionedBrowserUse()
    if (!client) {
      return false
    }

    await this.setSelectionState({ kind: 'auto', browserInstanceId: client.browserInstanceId, windowId: null })
    this.broadcastBrowserSelection()
    const created = await this.createTargetInClient(client, 'about:blank', { createInWindow: true, principalId, sessionGroupId })
    const readyTarget = await this.resolveReadyTarget(created.targetId)
    if (readyTarget.windowId === null) {
      return false
    }

    const changed = await this.setSelectionState({
      kind: 'auto',
      browserInstanceId: readyTarget.browserInstanceId,
      windowId: readyTarget.windowId,
    })
    if (changed) {
      this.broadcastBrowserSelection()
    }
    return changed
  }

  private resolveClientForProvisionedBrowserUse(): ExtensionClient | null {
    const clients = this.connectedExtensionClients
    if (clients.length === 0) {
      return null
    }

    clients.sort((left, right) => right.connectedAt - left.connectedAt)
    return clients[0] ?? null
  }

  private async resolveClientForBrowserUse(principalId?: string, sessionGroupId = principalId): Promise<ExtensionClient> {
    if (this.selectedBrowserInstanceId) {
      const selectedClient = this.extensionClients.get(this.selectedBrowserInstanceId)
      if (selectedClient?.handshakeOk && selectedClient.ws.readyState === WebSocket.OPEN) {
        return selectedClient
      }
    }

    if (this.connectedExtensionClients.length === 1) {
      const [onlyClient] = this.connectedExtensionClients
      if (onlyClient) {
        return onlyClient
      }
    }

    await this.ensureExecutionWindowSelectionForBrowserUse(principalId, sessionGroupId)
    if (this.selectedBrowserInstanceId) {
      const selectedClient = this.extensionClients.get(this.selectedBrowserInstanceId)
      if (selectedClient?.handshakeOk && selectedClient.ws.readyState === WebSocket.OPEN) {
        return selectedClient
      }
    }

    throw new Error('No browser instance selected. Select a browser before using browser control.')
  }

  private async reconcileSelection(broadcast = true): Promise<void> {
    const nextSelection = this.resolveSelectionAfterTopologyChange()
    if (!nextSelection) {
      return
    }

    if (await this.setSelectionState(nextSelection) && broadcast) {
      this.broadcastBrowserSelection()
    }
  }

  private resolveSelectionAfterTopologyChange(): SelectionState | null {
    if (this.selectionState.kind === 'none') {
      return null
    }

    const client = this.extensionClients.get(this.selectionState.browserInstanceId)
    if (!client) {
      return this.selectionState.kind === 'manual'
        ? null
        : { kind: 'none' }
    }

    if (!client.handshakeOk || client.resyncEpoch < 0) return null

    if (this.selectionState.windowId === null) {
      if (this.selectionState.kind === 'manual') {
        const nextWindowId = this.resolveSingleKnownWindowId(client)
        return nextWindowId === null
          ? null
          : {
              kind: 'manual',
              browserInstanceId: client.browserInstanceId,
              windowId: nextWindowId,
            }
      }
      const nextWindowId = this.resolveSingleKnownWindowId(client)
      return nextWindowId === null
        ? { kind: 'none' }
        : {
            kind: 'auto',
            browserInstanceId: client.browserInstanceId,
            windowId: nextWindowId,
          }
    }

    const knownWindowIds = this.getKnownWindowIdsForClient(client)
    if (knownWindowIds.includes(this.selectionState.windowId)) {
      return null
    }

    if (this.selectionState.kind === 'manual') {
      return {
        kind: 'manual',
        browserInstanceId: client.browserInstanceId,
        windowId: null,
      }
    }

    const nextWindowId = this.resolveSingleKnownWindowId(client)
    return nextWindowId === null
      ? { kind: 'none' }
      : {
          kind: 'auto',
          browserInstanceId: client.browserInstanceId,
          windowId: nextWindowId,
        }
  }

  private getSelectedCurrentTarget(): ConnectedTarget | null {
    if (!this.selectedBrowserInstanceId || this.selectedWindowId === null) {
      return null
    }
    return this.getCurrentTargetForWindow(
      this.extensionClients.get(this.selectedBrowserInstanceId),
      this.selectedWindowId,
    )
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
    const client = this.extensionClients.get(parsed.browserInstanceId)
    return client?.handshakeOk && client.ws.readyState === WebSocket.OPEN
      ? client.connectedTargets.get(sessionId) ?? null
      : null
  }

  private findTargetByTargetId(targetId: string): ConnectedTarget | null {
    for (const client of this.connectedExtensionClients) {
      for (const target of client.connectedTargets.values()) {
        if (target.targetId === targetId || target.targetKey === targetId) return target
      }
    }
    return null
  }

  private requireSelectedCurrentTarget(): ConnectedTarget {
    if (this.selectedWindowId === null) {
      throw new Error('No browser window selected. Select a window before using browser control.')
    }
    const target = this.getSelectedCurrentTarget()
    if (!target) {
      throw new Error('Selected window has no current attached page.')
    }
    return target
  }

  private requireClientForTarget(targetId: string): { client: ExtensionClient; localTargetId: string; localSessionId?: string } {
    const parsed = parseExternalTargetId(targetId)
    if (!parsed) {
      throw new Error('Invalid targetId')
    }
    const client = this.extensionClients.get(parsed.browserInstanceId)
    if (!client?.handshakeOk || client.ws.readyState !== WebSocket.OPEN) {
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

  private sendToExtension(
    client: ExtensionClient,
    method: string,
    params: Record<string, unknown>,
    localSessionId?: string,
    options: { deadlineAt?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (client.ws.readyState !== WebSocket.OPEN || !client.handshakeOk) {
      return Promise.reject(new Error('Chrome extension not connected'))
    }
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)

    const id = client.nextRequestId++
    const sentAt = Date.now()
    const deadlineAt = Math.min(options.deadlineAt ?? Infinity,
      sentAt + (LONG_RUNNING_METHODS.has(method) ? 60_000 : EXTENSION_REQUEST_TIMEOUT_MS))
    if (deadlineAt <= sentAt) {
      return Promise.reject(relayOperationError(`Extension request expired: ${method}`, 'COMMAND_DEADLINE_EXCEEDED', { method, outcome: 'not_started' }))
    }
    const payload = {
      id,
      ts: sentAt,
      sentAt,
      deadlineAt,
      method: 'forwardCDPCommand',
      params: {
        ...(localSessionId ? { sessionId: localSessionId } : {}),
        method,
        params,
      },
    }

    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        client.pendingRequests.delete(id)
      }
      const fail = (error: Error) => { finish(); reject(error) }
      const onAbort = () => fail(options.signal?.reason ?? relayOperationError('Extension request aborted; completion is unknown.', 'COMMAND_CANCELLED'))
      const timer = setTimeout(() => {
        fail(relayOperationError(`Extension request timeout: ${method}`, 'COMMAND_DEADLINE_EXCEEDED', { method, requestId: id, sentAt, deadlineAt }))
      }, Math.max(0, deadlineAt - Date.now()) + 2_000)
      client.pendingRequests.set(id, {
        resolve: (value) => { finish(); resolve(value) },
        reject: fail,
        timer,
      })
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.sendExtensionMessage(client, payload, true)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
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
      pending.reject(relayOperationError(message, 'EXTENSION_DISCONNECTED'))
    }
    client.pendingRequests.clear()
  }

  private deletePendingTargetAttachment(targetId: string, pending: PendingTargetAttachmentRequest): void {
    const waiters = this.pendingTargetAttachments.get(targetId)
    if (!waiters) return
    waiters.delete(pending)
    if (waiters.size === 0) {
      this.pendingTargetAttachments.delete(targetId)
    }
  }

  private resolvePendingTargetAttachments(targetId: string): void {
    const waiters = this.pendingTargetAttachments.get(targetId)
    if (!waiters?.size) return
    const attachedTarget = this.findTargetByTargetId(targetId)
    if (!attachedTarget?.physical) return
    this.pendingTargetAttachments.delete(targetId)
    for (const pending of waiters) {
      pending.resolve(this.toAttachedRelayTarget(attachedTarget))
    }
  }

  private rejectPendingTargetAttachments(targetId: string, message: string): void {
    const waiters = this.pendingTargetAttachments.get(targetId)
    if (!waiters?.size) return
    this.pendingTargetAttachments.delete(targetId)
    for (const pending of waiters) {
      pending.reject(new Error(message))
    }
  }

  private rejectPendingTargetAttachmentsForBrowser(browserInstanceId: string, message: string): void {
    for (const targetId of [...this.pendingTargetAttachments.keys()]) {
      const parsed = parseExternalTargetId(targetId)
      if (parsed?.browserInstanceId === browserInstanceId) {
        this.rejectPendingTargetAttachments(targetId, message)
      }
    }
  }

  private rejectAllPendingTargetAttachments(message: string): void {
    for (const targetId of [...this.pendingTargetAttachments.keys()]) {
      this.rejectPendingTargetAttachments(targetId, message)
    }
  }

  private clearClientTargets(client: ExtensionClient, broadcastDetach: boolean): void {
    if (client.currentSessionId) {
      client.currentSessionId = null
    }
    if (broadcastDetach) {
      this.releaseAttachedClientSessionsForBrowser(client.browserInstanceId, 'browser_disconnected')
    } else {
      this.deleteAttachedClientSessionsForBrowser(client.browserInstanceId)
    }
    client.connectedTargets.clear()
  }

  private refreshOpenerIds(client: ExtensionClient): void {
    const targetsByKey = new Map([...client.connectedTargets.values()].map((target) => [target.localTargetKey, target]))
    for (const target of client.connectedTargets.values()) {
      if (!target.openerVtabId) continue
      const opener = targetsByKey.get(target.openerVtabId)
      target.targetInfo.openerId = opener?.targetId ?? encodeExternalTargetId(client.browserInstanceId, target.openerVtabId)
    }
  }

  private normalizeExternalTargetInfo(
    client: ExtensionClient,
    raw: Partial<RelayTargetInfo> & Pick<RelayTargetInfo, 'targetId'>,
  ): RelayTargetInfo {
    return normalizeTargetInfo({
      ...raw,
      targetId: encodeExternalTargetId(client.browserInstanceId, raw.targetId),
      openerId: raw.openerId ? ensureExternalTargetId(client.browserInstanceId, raw.openerId) : undefined,
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

  private normalizeAttachedSessionPayload(
    attachedSession: AttachedClientSession,
    method: string,
    payload: unknown,
    direction: AttachedSessionNormalizationDirection,
  ): unknown {
    if (!payload || typeof payload !== 'object') {
      return payload
    }

    const normalized = this.normalizeAttachedSessionIdentifiers(attachedSession, payload, direction)
    if (!normalized || typeof normalized !== 'object') {
      return normalized
    }

    const record = normalized as Record<string, unknown>
    if ((method === 'Page.getFrameTree' || method === 'Page.getResourceTree') && record.frameTree) {
      return {
        ...record,
        frameTree: this.normalizeAttachedSessionFrameTree(attachedSession, record.frameTree, direction),
      }
    }
    if (method === 'Page.frameNavigated' && record.frame) {
      return {
        ...record,
        frame: this.normalizeAttachedSessionFrame(attachedSession, record.frame, direction),
      }
    }

    return record
  }

  private normalizeAttachedSessionIdentifiers(
    attachedSession: AttachedClientSession,
    value: unknown,
    direction: AttachedSessionNormalizationDirection,
    parentKey?: string,
  ): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => this.normalizeAttachedSessionIdentifiers(attachedSession, entry, direction, parentKey))
    }

    if (typeof value === 'string' && parentKey) {
      return this.normalizeAttachedSessionIdentifier(attachedSession, parentKey, value, direction)
    }

    if (!value || typeof value !== 'object') {
      return value
    }

    const record = value as Record<string, unknown>
    const normalized: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(record)) {
      normalized[key] = this.normalizeAttachedSessionIdentifiers(attachedSession, entry, direction, key)
    }
    return normalized
  }

  private normalizeAttachedSessionIdentifier(
    attachedSession: AttachedClientSession,
    key: string,
    value: string,
    direction: AttachedSessionNormalizationDirection,
  ): string {
    if (TARGET_IDENTIFIER_KEYS.has(key)) {
      if (direction === 'toExternal') {
        return ensureExternalTargetId(attachedSession.browserInstanceId, value)
      }
      const parsed = parseExternalTargetId(value)
      if (parsed?.browserInstanceId === attachedSession.browserInstanceId) {
        return parsed.localTargetId
      }
      return value
    }

    if (FRAME_IDENTIFIER_KEYS.has(key)) {
      return this.normalizeAttachedSessionMainFrameId(attachedSession, value, direction)
    }

    return value
  }

  private normalizeAttachedSessionMainFrameId(
    attachedSession: AttachedClientSession,
    value: string,
    direction: AttachedSessionNormalizationDirection,
  ): string {
    if (direction === 'toExternal') {
      return value === attachedSession.localTargetId ? attachedSession.targetId : value
    }
    return value === attachedSession.targetId ? attachedSession.localTargetId : value
  }

  private normalizeAttachedSessionFrameTree(
    attachedSession: AttachedClientSession,
    value: unknown,
    direction: AttachedSessionNormalizationDirection,
  ): unknown {
    if (!value || typeof value !== 'object') {
      return value
    }

    const record = value as Record<string, unknown>
    return {
      ...record,
      ...(record.frame ? { frame: this.normalizeAttachedSessionFrame(attachedSession, record.frame, direction) } : {}),
      ...(Array.isArray(record.childFrames)
        ? {
            childFrames: record.childFrames.map((child) => (
              this.normalizeAttachedSessionFrameTree(attachedSession, child, direction)
            )),
          }
        : {}),
    }
  }

  private normalizeAttachedSessionFrame(
    attachedSession: AttachedClientSession,
    value: unknown,
    direction: AttachedSessionNormalizationDirection,
  ): unknown {
    if (!value || typeof value !== 'object') {
      return value
    }

    const record = value as Record<string, unknown>
    return {
      ...record,
      ...(typeof record.id === 'string'
        ? { id: this.normalizeAttachedSessionMainFrameId(attachedSession, record.id, direction) }
        : {}),
      ...(typeof record.parentId === 'string'
        ? { parentId: this.normalizeAttachedSessionMainFrameId(attachedSession, record.parentId, direction) }
        : {}),
    }
  }

  private broadcastBrowserSelection(): void {
    for (const client of this.connectedExtensionClients) {
      this.sendExtensionMessage(
        client,
        {
          method: 'Extension.selectionChanged',
          params: {
            browserCount: this.connectedExtensionClients.length,
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

  private notifyExtensionConnected(connection: BrowserRelayExtensionConnection): void {
    for (const listener of this.extensionConnectedListeners) {
      void Promise.resolve(listener(connection)).catch((error) => {
        this.logger.warn?.(`[browser-relay] extension connection listener failed: ${String(error)}`)
      })
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
