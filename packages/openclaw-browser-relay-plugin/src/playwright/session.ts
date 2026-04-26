import type { PluginLogger } from 'openclaw/plugin-sdk'
import { BrowserTabState } from '../state/browser-tab-state.js'
import { loadPlaywrightCore } from './dependency.js'
import type { RoleRef } from './role-refs.js'

type ConnectionMode = 'relay' | 'direct-cdp'

type BrowserConnection = {
  browser: any
  cdpUrl: string
  mode: ConnectionMode
  onDisconnected: () => void
}

type PageState = {
  console: Array<{ type: string; text: string; timestamp: string; location?: unknown }>
  errors: Array<{ message: string; name?: string; stack?: string; timestamp: string }>
  requests: Array<{
    id: string
    timestamp: string
    method: string
    url: string
    resourceType: string
    status?: number
    ok?: boolean
    failureText?: string
  }>
  requestIds: WeakMap<any, string>
  nextRequestId: number
  roleRefs?: Record<string, RoleRef>
  roleRefsFrameSelector?: string
  roleRefsMode?: 'role' | 'aria'
}

type RememberedRoleRefs = {
  refs: Record<string, RoleRef>
  frameSelector?: string
  mode?: 'role' | 'aria'
}

function normalizeCdpUrl(cdpUrl: string): string {
  return cdpUrl.replace(/\/$/, '')
}

function resolveRoleRefCacheKey(cdpUrl: string, targetId: string): string {
  return `${normalizeCdpUrl(cdpUrl)}::${targetId}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isPageCloseLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return [
    'Target closed',
    'Execution context was destroyed',
    'Protocol error',
    'Connection closed',
    'Browser has been closed',
    'Browser closed',
    'Target page, context or browser has been closed',
    'Navigation failed because page was closed',
  ].some((fragment) => message.includes(fragment))
}

export class PlaywrightSession {
  private relayConnection: BrowserConnection | null = null
  private directConnection: BrowserConnection | null = null
  private relayConnectPromise: Promise<BrowserConnection> | null = null
  private directConnectPromise: Promise<BrowserConnection> | null = null
  private readonly pageState = new WeakMap<any, PageState>()
  private readonly targetIdCache = new WeakMap<any, string | null>()
  private readonly targetIdByPage = new WeakMap<any, string>()
  private readonly pageStateInitialized = new WeakSet<any>()
  private readonly rememberedRoleRefs = new Map<string, RememberedRoleRefs>()
  private directAutoConnectLocked = false

  constructor(
    private readonly logger: PluginLogger,
    private readonly tabState: BrowserTabState,
    private readonly getRelayStatus: () => { connected: boolean; relayPort: number | null; authHeaders: Record<string, string> },
  ) {}

  isPlaywrightConnected(): boolean {
    return this.isConnected('relay') || this.isConnected('direct-cdp')
  }

  isConnected(mode: ConnectionMode): boolean {
    const connection = mode === 'relay' ? this.relayConnection : this.directConnection
    return Boolean(connection && connection.browser.isConnected())
  }

  getConnection(mode: ConnectionMode): BrowserConnection | null {
    const connection = mode === 'relay' ? this.relayConnection : this.directConnection
    return connection && connection.browser.isConnected() ? connection : null
  }

  getActiveConnectionMode(): ConnectionMode | null {
    if (this.isConnected('relay')) return 'relay'
    if (this.isConnected('direct-cdp')) return 'direct-cdp'
    return null
  }

  resetDirectCdpAutoConnect(): void {
    this.directAutoConnectLocked = false
  }

  async tryDirectCdpConnect(cdpUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
    this.directAutoConnectLocked = false
    try {
      await this.connectBrowser(cdpUrl, 'direct-cdp')
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async closeConnections(mode?: ConnectionMode): Promise<void> {
    const modes = mode ? [mode] : ['relay', 'direct-cdp'] satisfies ConnectionMode[]

    for (const currentMode of modes) {
      const connection = currentMode === 'relay' ? this.relayConnection : this.directConnection
      if (!connection) continue

      if (currentMode === 'relay') {
        this.relayConnection = null
        this.relayConnectPromise = null
      } else {
        this.directConnection = null
        this.directConnectPromise = null
      }

      try {
        if (typeof connection.browser.off === 'function') {
          connection.browser.off('disconnected', connection.onDisconnected)
        }
      } catch {
        // noop
      }

      try {
        await connection.browser.close()
      } catch {
        // noop
      }
    }
  }

  ensurePageState(page: any): PageState {
    const existing = this.pageState.get(page)
    if (existing) return existing

    const state: PageState = {
      console: [],
      errors: [],
      requests: [],
      requestIds: new WeakMap(),
      nextRequestId: 0,
    }

    this.pageState.set(page, state)
    if (this.pageStateInitialized.has(page)) {
      return state
    }

    this.pageStateInitialized.add(page)
    page.on('console', (entry: any) => {
      state.console.push({
        type: entry.type(),
        text: entry.text(),
        timestamp: new Date().toISOString(),
        location: entry.location(),
      })
      if (state.console.length > 500) {
        state.console.splice(0, state.console.length - 500)
      }
    })

    page.on('pageerror', (error: any) => {
      state.errors.push({
        message: String(error?.message ?? error),
        name: error?.name ? String(error.name) : undefined,
        stack: error?.stack ? String(error.stack) : undefined,
        timestamp: new Date().toISOString(),
      })
      if (state.errors.length > 200) {
        state.errors.splice(0, state.errors.length - 200)
      }
    })

    page.on('request', (request: any) => {
      state.nextRequestId += 1
      const requestId = `r${state.nextRequestId}`
      state.requestIds.set(request, requestId)
      state.requests.push({
        id: requestId,
        timestamp: new Date().toISOString(),
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
      })
      if (state.requests.length > 500) {
        state.requests.splice(0, state.requests.length - 500)
      }
    })

    page.on('response', (response: any) => {
      const requestId = state.requestIds.get(response.request())
      if (!requestId) return
      const current = state.requests.findLast((entry) => entry.id === requestId)
      if (!current) return
      current.status = response.status()
      current.ok = response.ok()
    })

    page.on('requestfailed', (request: any) => {
      const requestId = state.requestIds.get(request)
      if (!requestId) return
      const current = state.requests.findLast((entry) => entry.id === requestId)
      if (!current) return
      current.ok = false
      current.failureText = request.failure()?.errorText
    })

    page.on('close', () => {
      const targetId = this.targetIdByPage.get(page) ?? null
      this.pageState.delete(page)
      this.pageStateInitialized.delete(page)
      this.targetIdCache.delete(page)
      this.targetIdByPage.delete(page)
      if (targetId) {
        this.tabState.closeTab(targetId)
      }
    })

    return state
  }

  rememberRoleRefs(input: {
    cdpUrl: string
    targetId?: string
    page: any
    refs: Record<string, RoleRef>
    frameSelector?: string
    mode?: 'role' | 'aria'
  }): void {
    const state = this.ensurePageState(input.page)
    state.roleRefs = input.refs
    state.roleRefsFrameSelector = input.frameSelector
    state.roleRefsMode = input.mode

    const targetId = input.targetId?.trim()
    if (!targetId) return

    const key = resolveRoleRefCacheKey(input.cdpUrl, targetId)
    this.rememberedRoleRefs.set(key, {
      refs: input.refs,
      ...(input.frameSelector ? { frameSelector: input.frameSelector } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    })

    while (this.rememberedRoleRefs.size > 50) {
      const first = this.rememberedRoleRefs.keys().next()
      if (first.done) break
      this.rememberedRoleRefs.delete(first.value)
    }
  }

  restoreRoleRefs(input: { cdpUrl: string; targetId?: string; page: any }): void {
    const targetId = input.targetId?.trim()
    if (!targetId) return

    const remembered = this.rememberedRoleRefs.get(resolveRoleRefCacheKey(input.cdpUrl, targetId))
    if (!remembered) return

    const state = this.ensurePageState(input.page)
    if (!state.roleRefs) {
      state.roleRefs = remembered.refs
      state.roleRefsFrameSelector = remembered.frameSelector
      state.roleRefsMode = remembered.mode
    }
  }

  refLocator(page: any, ref: string): any {
    const normalizedRef = ref.trim().startsWith('@')
      ? ref.trim().slice(1)
      : ref.trim().startsWith('ref=')
        ? ref.trim().slice(4)
        : ref.trim()
    if (!normalizedRef) {
      throw new Error('ref is required')
    }

    if (/^e\d+$/.test(normalizedRef)) {
      const state = this.ensurePageState(page)
      if (state.roleRefsMode === 'aria') {
        const scope = state.roleRefsFrameSelector ? page.frameLocator(state.roleRefsFrameSelector) : page
        return scope.locator(`aria-ref=${normalizedRef}`)
      }

      const target = state.roleRefs?.[normalizedRef]
      if (!target) {
        throw new Error(`Unknown ref "${normalizedRef}". Run a new snapshot and use a ref from that snapshot.`)
      }

      const scope = state.roleRefsFrameSelector ? page.frameLocator(state.roleRefsFrameSelector) : page
      const locator = target.name
        ? scope.getByRole(target.role, { name: target.name, exact: true })
        : scope.getByRole(target.role)
      return target.nth !== undefined ? locator.nth(target.nth) : locator
    }

    return page.locator(`aria-ref=${normalizedRef}`)
  }

  async sendBrowserCdpCommand(cdpUrl: string, method: string, params?: Record<string, unknown>, mode?: ConnectionMode): Promise<any> {
    const { browser } = await this.connectBrowser(cdpUrl, mode)
    const session = await browser.newBrowserCDPSession()
    try {
      return await session.send(method, params)
    } finally {
      await session.detach().catch(() => {})
    }
  }

  async connectBrowser(cdpUrl?: string, preferredMode?: ConnectionMode): Promise<BrowserConnection> {
    const relayStatus = this.getRelayStatus()
    const normalizedUrl = normalizeCdpUrl(cdpUrl ?? this.resolveDefaultCdpUrl(relayStatus))
    const mode =
      preferredMode
      ?? (relayStatus.relayPort !== null && normalizedUrl === `http://127.0.0.1:${relayStatus.relayPort}` ? 'relay' : this.isConnected('direct-cdp') ? 'direct-cdp' : 'relay')

    const currentConnection = mode === 'relay' ? this.relayConnection : this.directConnection
    if (currentConnection && currentConnection.browser.isConnected()) {
      return currentConnection
    }

    const currentPromise = mode === 'relay' ? this.relayConnectPromise : this.directConnectPromise
    if (currentPromise) {
      return await currentPromise
    }

    if (mode === 'direct-cdp' && this.directAutoConnectLocked) {
      throw new Error('Direct CDP auto-connect already attempted. Please reconnect manually.')
    }

    const connectPromise = this.createConnection(normalizedUrl, mode)
      .then((connection) => {
        if (mode === 'relay') {
          this.relayConnection = connection
        } else {
          this.directConnection = connection
          this.directAutoConnectLocked = true
        }
        return connection
      })
      .finally(() => {
        if (mode === 'relay') {
          this.relayConnectPromise = null
        } else {
          this.directConnectPromise = null
        }
      })

    if (mode === 'relay') {
      this.relayConnectPromise = connectPromise
    } else {
      this.directConnectPromise = connectPromise
    }

    return await connectPromise
  }

  async getPageForTargetId(input: { cdpUrl: string; targetId?: string; mode?: ConnectionMode }): Promise<any> {
    if (!input.targetId) {
      throw new Error('targetId is required')
    }

    const existing = await this.findExistingPage(input)
    if (existing) return existing

    const retries = 3
    for (let attempt = 0; attempt < retries; attempt += 1) {
      if (attempt === 0 && (input.mode ?? this.getActiveConnectionMode()) === 'relay') {
        try {
          await this.sendBrowserCdpCommand(input.cdpUrl, 'Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
          }, input.mode)
        } catch {
          // noop
        }
      }

      await sleep(Math.min(2_000, 600 * (attempt + 1)))
      const retried = await this.findExistingPage(input)
      if (retried) return retried
    }

    const connection = await this.connectBrowser(input.cdpUrl, input.mode)
    const pages = connection.browser.contexts().flatMap((context: any) => context.pages())
    throw new Error(
      `Page not found for targetId="${input.targetId}" after retries. There are ${pages.length} open page(s): ${pages.map((page: any) => page.url()).join(', ')}`,
    )
  }

  private resolveDefaultCdpUrl(relayStatus: { connected: boolean; relayPort: number | null }): string {
    if (relayStatus.relayPort !== null) {
      return `http://127.0.0.1:${relayStatus.relayPort}`
    }
    throw new Error('No CDP endpoint available')
  }

  private async createConnection(cdpUrl: string, mode: ConnectionMode): Promise<BrowserConnection> {
    const playwright = await loadPlaywrightCore()
    const headers = mode === 'relay' ? this.getRelayStatus().authHeaders : undefined
    const timeouts = mode === 'relay' ? [10_000, 12_000, 14_000] : [15_000, 18_000]
    let lastError: unknown

    if (mode === 'relay') {
      const relayStatus = this.getRelayStatus()
      if (!relayStatus.connected || relayStatus.relayPort === null) {
        throw new Error('Chrome extension not connected')
      }
    }

    for (const timeout of timeouts) {
      try {
        const browser = await playwright.chromium.connectOverCDP(cdpUrl, {
          timeout,
          ...(cdpUrl.startsWith('ws://') || cdpUrl.startsWith('wss://') ? {} : headers ? { headers } : {}),
        })
        const onDisconnected = () => {
          if (mode === 'relay') {
            if (this.relayConnection?.browser === browser) this.relayConnection = null
          } else {
            if (this.directConnection?.browser === browser) this.directConnection = null
            this.directAutoConnectLocked = false
          }
        }
        browser.on('disconnected', onDisconnected)
        this.installBrowserObservers(browser)
        return { browser, cdpUrl, mode, onDisconnected }
      } catch (error) {
        lastError = error
        await sleep(250)
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private installBrowserObservers(browser: any): void {
    for (const context of browser.contexts()) {
      this.installContextObservers(context)
    }
    browser.on('context', (context: any) => this.installContextObservers(context))
  }

  private installContextObservers(context: any): void {
    for (const page of context.pages()) {
      this.ensurePageState(page)
    }
    context.on('page', (page: any) => {
      this.ensurePageState(page)
    })
  }

  private async findExistingPage(input: { cdpUrl: string; targetId?: string; mode?: ConnectionMode }): Promise<any | null> {
    const browser = (await this.connectBrowser(input.cdpUrl, input.mode)).browser
    const pages = browser.contexts().flatMap((context: any) => context.pages())
    if (pages.length === 0) return null
    if (!input.targetId) return null

    for (const page of pages) {
      const targetId = await this.resolveTargetId(page)
      if (targetId === input.targetId) {
        return page
      }
    }
    return null
  }

  private async resolveTargetId(page: any): Promise<string | null> {
    const cached = this.targetIdCache.get(page)
    if (cached !== undefined) {
      return cached
    }

    try {
      const delegateTargetId = page?._delegate?._targetId
      if (delegateTargetId) {
        this.targetIdCache.set(page, delegateTargetId)
        this.targetIdByPage.set(page, delegateTargetId)
        return delegateTargetId
      }
    } catch {
      // noop
    }

    try {
      const session = await page.context().newCDPSession(page)
      try {
        const info = await session.send('Target.getTargetInfo')
        const targetId = String(info?.targetInfo?.targetId ?? '').trim() || null
        this.targetIdCache.set(page, targetId)
        if (targetId) {
          this.targetIdByPage.set(page, targetId)
        }
        return targetId
      } finally {
        if (this.getActiveConnectionMode() !== 'relay') {
          await session.detach().catch(() => {})
        }
      }
    } catch {
      this.targetIdCache.set(page, null)
      return null
    }
  }

  mapActionError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('connectOverCDP') && message.includes('Timeout')) {
      return `${message.split('\n')[0].trim()}\nBrowser is temporarily unreachable. Check that Chrome is running with remote debugging enabled.`
    }
    if (message.includes('CDP WebSocket connection timed out') || message.includes('CDP WebSocket error')) {
      return `${message.split('\n')[0].trim()}\nBrowser connection failed. Chrome may not be running or the debug port is unavailable.`
    }
    if (message.includes('No CDP endpoint available')) {
      return `${message.split('\n')[0].trim()}\nNo browser found. Ensure Chrome is running with remote debugging enabled.`
    }
    if (message.includes('Extension not connected') || message.includes('Chrome extension not connected')) {
      return `${message.split('\n')[0].trim()}\nBrowser extension is not connected. The user may need to re-enable or reinstall it.`
    }
    if (message.includes('Target closed') || message.includes('Target page, context or browser has been closed')) {
      return `${message.split('\n')[0].trim()}\nThe browser tab was closed unexpectedly. Re-open the page and retry.`
    }
    if (message.includes('Browser has been closed') || message.includes('Browser closed')) {
      return `${message.split('\n')[0].trim()}\nBrowser was closed. It needs to be restarted before retrying.`
    }
    if (message.includes('Execution context was destroyed')) {
      return `${message.split('\n')[0].trim()}\nPage navigated or reloaded while the script was running. Re-run after the page settles.`
    }
    if (message.includes('Call log:')) {
      return message.split('Call log:')[0].trim()
    }
    return message
  }

  isRecoverableCloseError(error: unknown): boolean {
    return isPageCloseLikeError(error)
  }
}
