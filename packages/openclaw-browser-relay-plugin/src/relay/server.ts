import type { PluginLogger } from 'openclaw/plugin-sdk'
import { createCipheriv, createDecipheriv, privateDecrypt, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { BrowserCookieInput } from '../browser-action-contract.js'
import { relayDebugInfo } from '../debug-logging.js'
import { RELAY_PRIVATE_KEY_PEM } from './keypair.js'
import {
  claimRelayPortOwnership,
  ensureRelayPortOwnership,
  releaseRelayPortOwnership,
} from './ownership.js'
import { clearRelaySelection, readRelaySelection, writeRelaySelection, type RelaySelectionRecord } from './selection-state.js'

export const RELAY_PROTOCOL_VERSION = 1
export const RELAY_AUTH_HEADER = 'x-phoenix-relay-token'

const ENCRYPTED_PREFIX = 'E:'
const AES_KEY_BYTES = 32
const AES_GCM_IV_BYTES = 12
const AES_GCM_TAG_BYTES = 16
const EXTENSION_HELLO_TIMEOUT_MS = 5_000
const EXTENSION_REQUEST_TIMEOUT_MS = 15_000
const TARGET_ATTACH_TIMEOUT_MS = 5_000
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
  currentSessionId: string | null
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
  private cdpClientState = new WeakMap<WebSocket, CdpClientState>()
  private browserSessions = new Map<string, BrowserSession>()
  private attachedClientSessions = new Map<string, AttachedClientSession>()
  private extensionConnectedListeners = new Set<(connection: BrowserRelayExtensionConnection) => void | Promise<void>>()
  private pendingTargetUrls = new Map<string, string>()
  private pendingOpenReadyHints = new Map<string, { mainFrameUrl: string; readyState: string; executionContextReady: boolean }>()
  private pendingTargetAttachments = new Map<string, Set<PendingTargetAttachmentRequest>>()
  private selectionState: SelectionState = { kind: 'none' }
  private actualPort: number | null = null
  private nextBrowserSessionId = 1
  private nextAttachedSessionId = 1

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
      browserCount: this.extensionClients.size,
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
    ready: boolean
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
    this.pendingOpenReadyHints.clear()
    this.rejectAllPendingTargetAttachments('Relay stopping')
    this.selectionState = { kind: 'none' }
    this.browserSessions.clear()
    this.attachedClientSessions.clear()

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
    this.pendingOpenReadyHints.clear()
    this.rejectAllPendingTargetAttachments('Relay failed to start')
    this.selectionState = { kind: 'none' }
    this.browserSessions.clear()
    this.attachedClientSessions.clear()
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
    return await this.createTargetInClient(await this.resolveClientForBrowserUse(), url)
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

      this.applyPendingOpenReadyHint(target)
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

  async closeTarget(targetId: string): Promise<void> {
    const { client, localTargetId } = this.requireClientForTarget(targetId)
    await this.sendToExtension(client, 'Target.closeTarget', { targetId: localTargetId })
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

  async closeAllAgentTabs(): Promise<unknown> {
    const client = await this.resolveClientForBrowserUse()
    return this.sendToExtension(client, 'Target.closeAllAgentTabs', {})
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

  async ensureExecutionWindowSelectionForBrowserUse(): Promise<boolean> {
    const nextSelection = this.resolveSelectionForExplicitBrowserUse()
    if (nextSelection) {
      const changed = await this.setSelectionState(nextSelection)
      if (changed) {
        this.broadcastBrowserSelection()
      }
      return changed
    }

    return await this.provisionExecutionWindowSelectionForBrowserUse()
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
          connectedAt: Date.now(),
          nextRequestId: 1,
          pendingRequests: new Map(),
          connectedTargets: new Map(),
          currentSessionId: null,
        }
      } catch (error) {
        this.logger.warn?.(`[browser-relay] failed to decrypt session key: ${String(error)}`)
        ws.close(4003, 'Invalid encrypted session key')
        return
      }

      this.extensionClients.set(browserInstanceId, client)
      await this.reconcileSelection(false)

      this.sendExtensionMessage(
        client,
        {
          method: 'Extension.helloAck',
          params: {
            status: 'ok',
            encrypted: true,
            browserCount: this.extensionClients.size,
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
      this.broadcastBrowserSelection()
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

  private handleExtensionClose(client: ExtensionClient): void {
    const current = this.extensionClients.get(client.browserInstanceId)
    if (current !== client) return

    this.rejectPendingRequests(client, 'Extension disconnected')
    this.rejectPendingTargetAttachmentsForBrowser(
      client.browserInstanceId,
      'Extension disconnected before target attachment completed.',
    )
    this.extensionClients.delete(client.browserInstanceId)
    this.clearClientTargets(client, true)
    this.clearBrowserSessionsForBrowser(client.browserInstanceId)

    void this.reconcileSelection()

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
            error: { message: error instanceof Error ? error.message : String(error) },
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
          if (!target) throw new Error('target not found')
          relayDebugInfo(
            this.logger,
            `[browser-relay] Target.getTargetInfo by targetId targetId=${targetId} resolvedSessionId=${target.sessionId} resolvedUrl="${target.targetInfo.url ?? ''}"`,
          )
          return { targetInfo: normalizeTargetInfo(target.targetInfo) }
        }
        if (input.sessionId) {
          if (browserSession) {
            const browserTarget = this.getBrowserTargetInfoForBrowser(browserSession.browserInstanceId)
            relayDebugInfo(
              this.logger,
              `[browser-relay] Target.getTargetInfo by browserSession sessionId=${input.sessionId} browserTargetId=${browserTarget.targetId}`,
            )
            return { targetInfo: browserTarget }
          }
          const target = attachedSession ? this.findTargetByTargetId(attachedSession.targetId) : null
          if (!target) throw new Error('target not found')
          relayDebugInfo(
            this.logger,
            `[browser-relay] Target.getTargetInfo by sessionId sessionId=${input.sessionId} resolvedTargetId=${target.targetId ?? 'null'} resolvedUrl="${target.targetInfo.url ?? ''}"`,
          )
          return { targetInfo: normalizeTargetInfo(target.targetInfo) }
        }
        const browserTarget = this.getBrowserTargetInfo()
        relayDebugInfo(
          this.logger,
          `[browser-relay] Target.getTargetInfo root browserTargetId=${browserTarget.targetId}`,
        )
        return { targetInfo: browserTarget }
      }
      case 'Target.attachToBrowserTarget': {
        const client = await this.resolveClientForBrowserUse()
        const sessionId = this.allocateBrowserSession(client.browserInstanceId, input.cdpClient)
        relayDebugInfo(
          this.logger,
          `[browser-relay] Target.attachToBrowserTarget browserInstanceId=${client.browserInstanceId} browserSessionId=${sessionId}`,
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
          `[browser-relay] Target.attachToTarget allocated attachSessionId=${attachSession.attachSessionId} targetId=${targetId} physicalSessionId=${target.sessionId} url="${target.targetInfo.url ?? ''}"`,
        )
        setTimeout(() => {
          this.replayBootstrapToAttachedSession(attachSession.attachSessionId)
        }, 0)
        return { sessionId: attachSession.attachSessionId }
      }
      case 'Target.detachFromTarget': {
        const detachedSessionId = typeof input.params?.sessionId === 'string' ? input.params.sessionId : undefined
        if (detachedSessionId && this.browserSessions.delete(detachedSessionId)) {
          relayDebugInfo(
            this.logger,
            `[browser-relay] Target.detachFromTarget browserSessionId=${detachedSessionId}`,
          )
          return {}
        }
        if (detachedSessionId && this.releaseAttachedClientSession(detachedSessionId)) {
          relayDebugInfo(
            this.logger,
            `[browser-relay] Target.detachFromTarget released attachSessionId=${detachedSessionId}`,
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
      case 'Target.closeAllAgentTabs': {
        const client = await this.resolveClientForBrowserUse()
        return this.sendToExtension(client, input.method, input.params ?? {})
      }
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
      case 'Extension.tabDiscovered':
        this.handleTabDiscovered(client, eventParams)
        await this.reconcileSelection()
        return
      case 'Extension.tabRemoved':
        this.handleTabRemoved(client, eventParams)
        await this.reconcileSelection()
        return
      case 'Extension.tabUpdated':
        this.handleTabUpdated(client, eventParams)
        await this.reconcileSelection()
        return
      case 'Target.attachedToTarget':
        this.handleAttachedToTarget(client, eventParams)
        await this.reconcileSelection()
        return
      case 'Target.detachedFromTarget':
        this.handleDetachedFromTarget(client, eventParams)
        await this.reconcileSelection()
        return
      case 'Target.targetInfoChanged':
        this.handleTargetInfoChanged(client, eventParams)
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
      mainFrameUrl: '',
      readyState: '',
      executionContextReady: false,
      bootstrapPrimed: false,
      lastLifecycleEvent: null,
      lastExecutionContextCreated: null,
      lastTargetInfoChanged: null,
    })
  }

  private handleTabRemoved(client: ExtensionClient, eventParams: Record<string, unknown>): void {
    const removedLocalSessionId = typeof eventParams.sessionId === 'string' ? eventParams.sessionId : ''
    if (!removedLocalSessionId) return
    const sessionId = encodeExternalSessionId(client.browserInstanceId, removedLocalSessionId)
    const existing = client.connectedTargets.get(sessionId)
    if (!existing) return
    client.connectedTargets.delete(sessionId)
    if (client.currentSessionId === sessionId) {
      client.currentSessionId = null
    }
    if (existing.targetId) {
      this.pendingOpenReadyHints.delete(existing.targetId)
      this.rejectPendingTargetAttachments(
        existing.targetId,
        `Target "${existing.targetId}" was removed before attachment completed.`,
      )
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
    if (existing.physical && typeof existing.targetInfo.url === 'string' && existing.targetInfo.url) {
      existing.mainFrameUrl = existing.targetInfo.url
    }
    existing.windowId = toNullableInteger(eventParams.windowId)
    existing.tabId = toNullableInteger(eventParams.tabId)
    existing.active = eventParams.active === true
  }

  private handleAttachedToTarget(
    client: ExtensionClient,
    eventParams: Record<string, unknown>,
  ): void {
    if (!eventParams.targetInfo || typeof eventParams.sessionId !== 'string') return
    const attachedLocalSessionId = eventParams.sessionId
    const localTargetInfo = eventParams.targetInfo as Partial<RelayTargetInfo> & Pick<RelayTargetInfo, 'targetId'>
    const sessionId = encodeExternalSessionId(client.browserInstanceId, attachedLocalSessionId)
    const normalized = this.normalizeExternalTargetInfo(client, localTargetInfo)
    relayDebugInfo(
      this.logger,
      `[browser-relay] Target.attachedToTarget browserInstanceId=${client.browserInstanceId} localSessionId=${attachedLocalSessionId} localTargetId=${localTargetInfo.targetId} externalSessionId=${sessionId} externalTargetId=${normalized.targetId} type=${normalized.type} url="${normalized.url ?? ''}"`,
    )
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
        mainFrameUrl: existing?.mainFrameUrl ?? '',
        readyState: existing?.readyState ?? '',
        executionContextReady: existing?.executionContextReady ?? false,
        bootstrapPrimed: existing?.bootstrapPrimed ?? false,
        lastLifecycleEvent: existing?.lastLifecycleEvent ?? null,
        lastExecutionContextCreated: existing?.lastExecutionContextCreated ?? null,
        lastTargetInfoChanged: existing?.lastTargetInfoChanged ?? {
          targetInfo: {
            ...localTargetInfo,
            targetId: localTargetInfo.targetId,
          },
          windowId: toNullableInteger(eventParams.windowId),
          tabId: toNullableInteger(eventParams.tabId),
          active: eventParams.active === true,
        },
      })
      this.applyPendingOpenReadyHint(client.connectedTargets.get(sessionId)!)
      this.resolvePendingTargetAttachments(normalized.targetId)
    }
    this.notifyAttachedTargetToAutoAttachClients({
      physicalSessionId: sessionId,
      targetInfo: normalized,
      waitingForDebugger: eventParams.waitingForDebugger === true,
    })
  }

  private handleDetachedFromTarget(
    client: ExtensionClient,
    eventParams: Record<string, unknown>,
  ): void {
    const detachedLocalSessionId = typeof eventParams.sessionId === 'string' ? eventParams.sessionId : ''
    const sessionId = detachedLocalSessionId
      ? encodeExternalSessionId(client.browserInstanceId, detachedLocalSessionId)
      : ''
    const existing = sessionId ? client.connectedTargets.get(sessionId) : undefined
    const detachedTargetId = existing?.targetId ?? null
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
      existing.mainFrameUrl = ''
      existing.readyState = ''
      existing.executionContextReady = false
      existing.bootstrapPrimed = false
      existing.lastLifecycleEvent = null
      existing.lastExecutionContextCreated = null
      existing.lastTargetInfoChanged = null
    }
    if (client.currentSessionId === sessionId) {
      client.currentSessionId = null
    }
    if (detachedTargetId) {
      this.pendingOpenReadyHints.delete(detachedTargetId)
      this.rejectPendingTargetAttachments(
        detachedTargetId,
        `Target "${detachedTargetId}" was detached before attachment completed.`,
      )
    }
    if (sessionId) {
      this.releaseAttachedClientSessionsForPhysicalSession(sessionId, {
        targetId: detachedTargetId,
        reason: typeof eventParams.reason === 'string' ? eventParams.reason : 'target_detached',
      })
    }
  }

  private handleTargetInfoChanged(
    client: ExtensionClient,
    eventParams: Record<string, unknown>,
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
        existing.lastTargetInfoChanged = {
          ...eventParams,
          targetInfo: {
            ...changedTargetInfo,
            targetId: localTargetId,
          },
        }
        if (typeof existing.targetInfo.url === 'string' && existing.targetInfo.url) {
          existing.mainFrameUrl = existing.targetInfo.url
        }
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
    return [...this.extensionClients.values()].flatMap((client) => [...client.connectedTargets.values()])
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
      selectedClient
      ?? (this.extensionClients.size === 1 ? this.extensionClients.values().next().value ?? null : null)
    if (!client) {
      throw new Error('targetId or sessionId is required for Target.getTargetInfo')
    }

    return this.getBrowserTargetInfoForBrowser(client.browserInstanceId)
  }

  private getBrowserTargetInfoForBrowser(browserInstanceId: string): RelayTargetInfo {
    const client = this.extensionClients.get(browserInstanceId)
    if (!client) {
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
    }
    this.attachedClientSessions.set(attachSessionId, attachedSession)
    return attachedSession
  }

  private releaseAttachedClientSession(attachSessionId: string): boolean {
    return this.attachedClientSessions.delete(attachSessionId)
  }

  private releaseAttachedClientSessionsForPhysicalSession(
    physicalSessionId: string,
    options: { targetId: string | null; reason: string },
  ): void {
    for (const [attachSessionId, attachedSession] of [...this.attachedClientSessions.entries()]) {
      if (attachedSession.physicalSessionId !== physicalSessionId) continue
      this.attachedClientSessions.delete(attachSessionId)
      this.sendCdpClientEvent(attachedSession.cdpClient, {
        method: 'Target.detachedFromTarget',
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
      if (attachedSession.browserInstanceId !== browserInstanceId) continue
      this.attachedClientSessions.delete(attachSessionId)
      this.sendCdpClientEvent(attachedSession.cdpClient, {
        method: 'Target.detachedFromTarget',
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
      `[browser-relay] route page-session command attachSessionId=${attachedSession.attachSessionId} -> physicalSessionId=${attachedSession.physicalSessionId} method=${method}`,
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

    this.applyPendingOpenReadyHint(target)

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

  private applyPendingOpenReadyHint(target: ConnectedTarget): void {
    if (!target.targetId) {
      return
    }
    const hint = this.pendingOpenReadyHints.get(target.targetId)
    if (!hint) {
      return
    }
    target.mainFrameUrl = hint.mainFrameUrl
    target.readyState = hint.readyState
    target.executionContextReady = hint.executionContextReady
    if (hint.mainFrameUrl) {
      target.targetInfo = normalizeTargetInfo({
        ...target.targetInfo,
        url: hint.mainFrameUrl,
        targetId: target.targetId,
      })
    }
    this.pendingOpenReadyHints.delete(target.targetId)
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
      if (windowId === null || this.getKnownWindowIdsForClient(client).includes(windowId)) {
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

    if (this.extensionClients.size !== 1) {
      return null
    }

    const [client] = this.extensionClients.values()
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

  private async createTargetInClient(client: ExtensionClient, url: string): Promise<{ targetId: string }> {
    const result = await this.sendToExtension(client, 'Target.createTarget', { url })
    const rawTargetId = readTargetIdFromResult(result)
    if (!rawTargetId) throw new Error('Target.createTarget returned no targetId')
    const targetId = ensureExternalTargetId(client.browserInstanceId, rawTargetId)
    relayDebugInfo(
      this.logger,
      `[browser-relay] Target.createTarget url="${url}" browserInstanceId=${client.browserInstanceId} rawTargetId=${rawTargetId} externalTargetId=${targetId}`,
    )
    this.pendingTargetUrls.set(targetId, url)
    this.pendingOpenReadyHints.set(targetId, {
      mainFrameUrl: url,
      readyState: 'complete',
      executionContextReady: true,
    })
    return { targetId }
  }

  private async provisionExecutionWindowSelectionForBrowserUse(): Promise<boolean> {
    const client = this.resolveClientForProvisionedBrowserUse()
    if (!client) {
      return false
    }

    const created = await this.createTargetInClient(client, 'about:blank')
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
    const clients = [...this.extensionClients.values()]
    if (clients.length === 0) {
      return null
    }

    clients.sort((left, right) => right.connectedAt - left.connectedAt)
    return clients[0] ?? null
  }

  private async resolveClientForBrowserUse(): Promise<ExtensionClient> {
    if (this.selectedBrowserInstanceId) {
      const selectedClient = this.extensionClients.get(this.selectedBrowserInstanceId)
      if (selectedClient) {
        return selectedClient
      }
    }

    if (this.extensionClients.size === 1) {
      const [onlyClient] = this.extensionClients.values()
      if (onlyClient) {
        return onlyClient
      }
    }

    await this.ensureExecutionWindowSelectionForBrowserUse()
    if (this.selectedBrowserInstanceId) {
      const selectedClient = this.extensionClients.get(this.selectedBrowserInstanceId)
      if (selectedClient) {
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
    for (const client of this.extensionClients.values()) {
      this.sendExtensionMessage(
        client,
        {
          method: 'Extension.selectionChanged',
          params: {
            browserCount: this.extensionClients.size,
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
