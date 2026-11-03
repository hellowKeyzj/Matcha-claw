import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import type { BrowserActionContext, BrowserActionInvocation, BrowserRuntimeSettings, BrowserSessionCleanup, BrowserUtilityRequest } from '../browser-action-contract.js'
import { browserPrincipalId } from '../state/page-ownership.js'
import type { PluginLogger } from '../plugin-types.js'
import { relayOperationError } from '../relay/downloads.js'
import { readRelayError } from '../relay/errors.js'
import { BrowserTabState } from '../state/browser-tab-state.js'
import { waitForBrowserCdpReady } from './cdp-readiness.js'
import { loadPlaywrightCore } from './dependency.js'
import { isRelayDebugEnabled, relayDebugWarn } from '../debug-logging.js'
import { NativeSnapshotOwner, type NativeTransport } from './native-snapshot.js'
import { NativeCdpTransport } from './native-transport.js'
import { NativePageUtility, stealthSource } from './native-utility.js'

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
  settings: BrowserRuntimeSettings
  lastActAt: number
  operationQueue: Promise<void>
  nativeFence?: Promise<void>
  nativeFailure?: unknown
  activeOperation?: PlaywrightInvocation
  utility?: NativePageUtility
  utilityTransport?: NativeCdpTransport
  utilityOwner?: BrowserActionContext
  utilityReady?: boolean
  stealthInstalled?: boolean
  utilityDestroyed?: boolean
  frameConfiguration?: Promise<void>
  frameConfigurationPending?: boolean
  frameConfigurationError?: unknown
  events: Array<Record<string, unknown> & { seq: number; kind: string }>
  nextEventSeq: number
  dialog?: { accept: boolean; promptText?: string }
  eventInvocation?: PlaywrightInvocation
  nativeSnapshot?: NativeSnapshotOwner
  documentId?: string
  cursorKey: object
}

function normalizeCdpUrl(cdpUrl: string): string {
  return cdpUrl.replace(/\/$/, '')
}

export type PlaywrightInvocation = BrowserActionInvocation & { deadlineAt?: number }

function safePageUrl(page: any): string {
  try {
    return typeof page?.url === 'function' ? String(page.url()) : ''
  } catch {
    return ''
  }
}

function safeFrameUrl(frame: any): string {
  try {
    return typeof frame?.url === 'function' ? String(frame.url()) : ''
  } catch {
    return ''
  }
}

function safeFrameName(frame: any): string {
  try {
    return typeof frame?.name === 'function' ? String(frame.name()) : ''
  } catch {
    return ''
  }
}

function safeFrameDetached(frame: any): boolean {
  try {
    return typeof frame?.isDetached === 'function' ? frame.isDetached() === true : false
  } catch {
    return false
  }
}

function safePageClosed(page: any): boolean {
  try {
    return typeof page?.isClosed === 'function' ? page.isClosed() === true : false
  } catch {
    return false
  }
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
  private readonly targetIdCache = new WeakMap<any, string>()
  private readonly targetIdByPage = new WeakMap<any, string>()
  private readonly pageStateInitialized = new WeakSet<any>()
  private readonly nativeInvocations = new Map<Promise<unknown>, BrowserActionContext>()
  private readonly pageOperation = new AsyncLocalStorage<{ page: any; input: { cdpUrl: string; targetId?: string; mode?: ConnectionMode } & PlaywrightInvocation }>()
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

  assertInvocationCurrent(invocation: PlaywrightInvocation = {}): void {
    try {
      invocation.signal?.throwIfAborted()
      invocation.assertInvocationCurrent?.()
    } catch (error) {
      const { message, errorDetail } = readRelayError(error)
      throw relayOperationError(message, 'COMMAND_CANCELLED', { ...errorDetail, outcome: 'unknown', retryable: false })
    }
    if (invocation.deadlineAt !== undefined && Date.now() >= invocation.deadlineAt) {
      throw relayOperationError('Browser operation deadline expired; completion is unknown. Do not repeat the action automatically.', 'COMMAND_TIMEOUT')
    }
  }

  withInvocationDeadline<T extends PlaywrightInvocation & { timeoutMs?: number }>(input: T, fallback = 20_000): T {
    const timeoutMs = Math.max(500, Math.min(120_000, typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) ? input.timeoutMs : fallback))
    return { ...input, deadlineAt: Math.min(input.deadlineAt ?? Infinity, Date.now() + timeoutMs) }
  }

  remainingTimeout(invocation: PlaywrightInvocation, maximumMs = 120_000): number {
    this.assertInvocationCurrent(invocation)
    return Math.max(1, Math.min(maximumMs, (invocation.deadlineAt ?? Date.now() + maximumMs) - Date.now()))
  }

  async runInvocation<T>(input: PlaywrightInvocation, operation: () => T): Promise<Awaited<T>> {
    this.assertInvocationCurrent(input)
    return await new Promise<Awaited<T>>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (error: unknown, result?: Awaited<T>) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onAbort)
        if (error !== undefined) {
          const { message, errorDetail } = readRelayError(error)
          const interrupted = /timeout|timed out|deadline|cancel|abort/i.test(`${errorDetail?.code ?? ''} ${message}`)
          const receipt = error && typeof error === 'object' ? error as { actionPerformed?: boolean; observationComplete?: boolean; partial?: unknown } : undefined
          reject(errorDetail || interrupted
            ? Object.assign(relayOperationError(message, 'PLAYWRIGHT_ACTION_FAILED', {
                ...errorDetail,
                ...(interrupted ? { outcome: 'unknown', retryable: false } : {}),
              }), {
                ...(receipt?.actionPerformed === true ? { actionPerformed: true } : {}),
                ...(receipt?.observationComplete === false ? { observationComplete: false } : {}),
                ...(receipt?.partial ? { partial: receipt.partial } : {}),
              })
            : error)
        } else {
          resolve(result as Awaited<T>)
        }
      }
      const onAbort = () => finish(relayOperationError('Browser operation cancelled; completion is unknown. Do not repeat the action automatically.', 'COMMAND_CANCELLED'))
      input.signal?.addEventListener('abort', onAbort, { once: true })
      if (input.deadlineAt !== undefined) {
        timer = setTimeout(() => finish(relayOperationError('Browser operation deadline expired; completion is unknown. Do not repeat the action automatically.', 'COMMAND_TIMEOUT')), this.remainingTimeout(input, Infinity))
      }
      try {
        // Stopping this wait does not cancel an already submitted Playwright/CDP operation.
        this.assertInvocationCurrent(input)
        this.trackNativeInvocation(input, operation()).then((result) => {
          try {
            this.assertInvocationCurrent(input)
            finish(undefined, result)
          } catch (error) {
            finish(error)
          }
        }, (error) => finish(error))
      } catch (error) {
        finish(error)
      }
    })
  }

  private trackNativeInvocation<T>(input: PlaywrightInvocation, result: T): Promise<Awaited<T>> {
    const operation = Promise.resolve(result)
    const current = this.pageOperation.getStore()
    const state = current && this.pageState.get(current.page)
    if (current && state && state.activeOperation === current.input) {
      state.nativeFence = Promise.allSettled([state.nativeFence, operation]).then(() => {})
    }
    if (input.context) {
      this.nativeInvocations.set(operation, input.context)
      const release = () => { this.nativeInvocations.delete(operation) }
      void operation.then(release, release)
    }
    return operation
  }

  async drainSession({ context, scope }: BrowserSessionCleanup): Promise<void> {
    const principalId = browserPrincipalId(context)
    const sessionGroupId = context.sessionGroupId ?? principalId
    while (true) {
      const pending = [...this.nativeInvocations].filter(([, owner]) => scope === 'group'
        ? (owner.sessionGroupId ?? browserPrincipalId(owner)) === sessionGroupId
        : browserPrincipalId(owner) === principalId).map(([operation]) => operation)
      if (!pending.length) return
      await Promise.allSettled(pending)
    }
  }

  clearCachedState(targetId?: string): void {
    for (const connection of [this.relayConnection, this.directConnection]) {
      for (const page of connection?.browser.contexts().flatMap((context: any) => context.pages()) ?? []) {
        if (targetId && this.targetIdByPage.get(page) !== targetId && this.targetIdCache.get(page) !== targetId) continue
        const state = this.pageState.get(page)
        if (!state) continue
        state.nativeSnapshot?.invalidateDocument()
        state.console.length = 0
        state.errors.length = 0
        state.utility?.network.clear()
      }
    }

  }

  async closeConnections(mode?: ConnectionMode): Promise<void> {
    const modes = mode ? [mode] : ['relay', 'direct-cdp'] satisfies ConnectionMode[]
    const failures: unknown[] = []

    for (const currentMode of modes) {
      const connection = currentMode === 'relay' ? this.relayConnection : this.directConnection
      if (!connection) continue
      for (const page of connection.browser.contexts().flatMap((context: any) => context.pages())) {
        const state = this.pageState.get(page)
        if (state?.utility) {
          try { await this.cleanupPageUtilities(page, state) } catch (error) { failures.push(error) }
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Browser utility cleanup failed before disconnect')

      if (currentMode === 'relay') {
        this.relayConnection = null
        this.relayConnectPromise = null
      } else {
        this.directConnection = null
        this.directConnectPromise = null
        this.directAutoConnectLocked = false
      }

      try {
        if (typeof connection.browser.off === 'function') {
          connection.browser.off('disconnected', connection.onDisconnected)
        }
      } catch (error) {
        failures.push(error)
      }

      try {
        await connection.browser.close()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Browser connection cleanup failed')
  }

  ensurePageState(page: any): PageState {
    const existing = this.pageState.get(page)
    if (existing) return existing

    const state: PageState = {
      console: [],
      errors: [],
      settings: {},
      lastActAt: 0,
      operationQueue: Promise.resolve(),
      events: [],
      nextEventSeq: 0,
      cursorKey: {},
    }

    this.pageState.set(page, state)
    if (this.pageStateInitialized.has(page)) {
      return state
    }

    this.pageStateInitialized.add(page)
    const addEvent = (kind: string, details: Record<string, unknown> = {}) => {
      state.events.push({ seq: ++state.nextEventSeq, timestamp: new Date().toISOString(), kind, ...details })
      if (state.events.length > 100) state.events.splice(0, state.events.length - 100)
    }
    page.on('dialog', (dialog: any) => {
      const policy = state.dialog ?? { accept: dialog.type() === 'beforeunload' }
      state.dialog = undefined
      addEvent('dialog', { type: dialog.type(), message: dialog.message(), defaultPrompt: dialog.defaultValue(), accept: policy.accept, ...(policy.promptText !== undefined ? { promptText: policy.promptText } : {}) })
      void this.trackNativeInvocation(state.eventInvocation ?? {}, policy.accept ? dialog.accept(policy.promptText) : dialog.dismiss()).catch(() => {})
    })
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

    page.on('frameattached', (frame: any) => {
      this.configureUtilityFrames(state)
      relayDebugWarn(
        this.logger,
        () => `[browser-playwright] frameattached targetId=${this.targetIdByPage.get(page) ?? 'unknown'} isMainFrame=${frame === page.mainFrame()} frameName="${safeFrameName(frame)}" frameUrl="${safeFrameUrl(frame)}" frameDetached=${safeFrameDetached(frame)}`,
      )
    })

    page.on('framenavigated', (frame: any) => {
      this.configureUtilityFrames(state)
      relayDebugWarn(
        this.logger,
        () => `[browser-playwright] framenavigated targetId=${this.targetIdByPage.get(page) ?? 'unknown'} isMainFrame=${frame === page.mainFrame()} frameName="${safeFrameName(frame)}" frameUrl="${safeFrameUrl(frame)}" frameDetached=${safeFrameDetached(frame)}`,
      )
    })

    page.on('framedetached', (frame: any) => {
      state.utilityTransport?.detachFrame(frame)
      relayDebugWarn(
        this.logger,
        () => `[browser-playwright] framedetached targetId=${this.targetIdByPage.get(page) ?? 'unknown'} isMainFrame=${frame === page.mainFrame()} frameName="${safeFrameName(frame)}" frameUrl="${safeFrameUrl(frame)}" frameDetached=${safeFrameDetached(frame)}`,
      )
    })

    page.on('crash', () => {
      addEvent('rendererCrash')
      relayDebugWarn(
        this.logger,
        () => `[browser-playwright] page crashed targetId=${this.targetIdByPage.get(page) ?? 'unknown'} pageUrl="${safePageUrl(page)}" mainFrameUrl="${safeFrameUrl(page.mainFrame?.())}"`,
      )
    })

    page.on('close', () => {
      relayDebugWarn(
        this.logger,
        () => `[browser-playwright] page closed targetId=${this.targetIdByPage.get(page) ?? 'unknown'} pageUrl="${safePageUrl(page)}" mainFrameUrl="${safeFrameUrl(page.mainFrame?.())}"`,
      )
      state.nativeSnapshot?.dispose()
      state.utilityDestroyed = true
      if (state.utility) void this.trackNativeInvocation({ context: state.utilityOwner }, this.cleanupPageUtilities(page, state, false)).catch((error) => {
        relayDebugWarn(this.logger, () => `[browser-playwright] closed page utility cleanup failed: ${String(error)}`)
      })
      this.pageState.delete(page)
      this.pageStateInitialized.delete(page)
      this.targetIdCache.delete(page)
      this.targetIdByPage.delete(page)
    })

    return state
  }

  async sendBrowserCdpCommand(cdpUrl: string, method: string, params?: Record<string, unknown>, mode?: ConnectionMode, invocation: PlaywrightInvocation = {}, onResult?: (result: any) => void): Promise<any> {
    invocation = this.withInvocationDeadline(invocation)
    const { browser } = await this.connectBrowser(cdpUrl, mode, invocation)
    this.assertInvocationCurrent(invocation)
    const session = await this.trackNativeInvocation(invocation, browser.newBrowserCDPSession())
    try {
      this.assertInvocationCurrent(invocation)
      return await this.runInvocation(invocation, async () => {
        const result = await session.send(method, params)
        onResult?.(result)
        return result
      })
    } finally {
      await this.trackNativeInvocation(invocation, session.detach().catch(() => {}))
    }
  }

  async sendPageCdpCommand(
    input: { cdpUrl: string; targetId?: string; mode?: ConnectionMode } & PlaywrightInvocation,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<any> {
    input = this.withInvocationDeadline(input)
    const page = await this.getPageForTargetId(input)
    this.assertInvocationCurrent(input)
    return await this.withTemporaryPageSession(page, async (session) => await this.runInvocation(input, () => session.send(method, params)), input)
  }

  async waitForNetworkIdle(input: { cdpUrl: string; targetId?: string; mode?: ConnectionMode; timeoutMs?: number } & PlaywrightInvocation): Promise<void> {
    input = this.withInvocationDeadline(input, 30_000)
    const page = await this.getPageForTargetId(input)
    const timeoutMs = this.remainingTimeout(input)
    const until = Date.now() + timeoutMs
    await this.runInvocation(input, () => this.withTemporaryPageSession(page, async (session) => {
      const pending = new Set<string>()
      let changedAt: number
      const onRequest = (event: any) => {
        if (typeof event.requestId === 'string') pending.add(event.requestId)
        changedAt = Date.now()
      }
      const onComplete = (event: any) => {
        if (typeof event.requestId === 'string') pending.delete(event.requestId)
        changedAt = Date.now()
      }
      session.on('Network.requestWillBeSent', onRequest)
      session.on('Network.loadingFinished', onComplete)
      session.on('Network.loadingFailed', onComplete)
      try {
        await this.trackNativeInvocation(input, session.send('Network.enable'))
        this.assertInvocationCurrent(input)
        changedAt = Date.now()
        while (Date.now() < until) {
          this.assertInvocationCurrent(input)
          if (!pending.size && Date.now() - changedAt >= 500) return
          await sleep(Math.min(50, until - Date.now()), undefined, { signal: input.signal })
        }
        throw new Error(`wait: network did not become idle within ${timeoutMs}ms`)
      } finally {
        session.off('Network.requestWillBeSent', onRequest)
        session.off('Network.loadingFinished', onComplete)
        session.off('Network.loadingFailed', onComplete)
      }
    }, input))
  }

  private configureUtilityFrames(state: PageState): void {
    if (!state.activeOperation || !state.utilityReady || state.utilityDestroyed) return
    state.frameConfigurationPending = true
    if (state.frameConfiguration) return
    const input = state.activeOperation
    const task = this.trackNativeInvocation(input, (async () => {
      while (state.frameConfigurationPending) {
        state.frameConfigurationPending = false
        this.assertInvocationCurrent(input)
        await state.utility!.configureSessions()
      }
    })())
    state.frameConfiguration = task
    void task.then(() => { state.frameConfiguration = undefined }, (error) => {
      state.frameConfigurationError = error
      state.frameConfiguration = undefined
    })
  }

  private createNativeTransport(page: any, state: PageState, invocation: () => PlaywrightInvocation | undefined, persistent = false): NativeCdpTransport {
    return new NativeCdpTransport(page, {
      cursorKey: state.cursorKey,
      invocation,
      owner: () => state.utilityOwner,
      assertCurrent: (input) => this.assertInvocationCurrent(input),
      run: (input, operation) => this.runInvocation(input, operation),
      track: (input, operation) => this.trackNativeInvocation(input, operation),
      document: (documentId) => {
        if (state.documentId !== undefined && state.documentId !== documentId) state.nativeSnapshot?.invalidateDocument()
        state.documentId = documentId
      },
      persistent,
    })
  }

  async withPageOperation<T>(input: { cdpUrl: string; targetId?: string; mode?: ConnectionMode } & PlaywrightInvocation, operation: () => Promise<T>): Promise<T> {
    if (input.deadlineAt === undefined) input = this.withInvocationDeadline(input)
    if (!input.context) throw new Error('Trusted browser invocation context is required')
    const page = await this.getPageForTargetId(input)
    const state = this.ensurePageState(page)
    const parent = this.pageOperation.getStore()
    if (parent && parent.page === page && state.activeOperation === parent.input) return await operation()
    const previous = state.operationQueue
    let release!: () => void
    state.operationQueue = new Promise<void>((resolve) => { release = resolve })
    try { await this.runInvocation(input, () => previous) }
    catch (error) {
      void previous.then(release, release)
      throw error
    }
    try {
      this.assertInvocationCurrent(input)
      if (state.nativeFailure !== undefined) throw state.nativeFailure
      if (state.utilityDestroyed || safePageClosed(page)) throw new Error('Browser page is closed')
      state.activeOperation = input
      state.utilityOwner = input.context
      const transport = state.utilityTransport ??= this.createNativeTransport(page, state, () => state.activeOperation, true)
      transport.beginOperation()
      const utility = state.utility ??= new NativePageUtility(transport, state, {
        stealth: async () => {
          const active = state.activeOperation
          if (!active) throw new Error('An active browser operation is required')
          if (!state.stealthInstalled) {
            await this.runInvocation(active, () => page.addInitScript(stealthSource))
            state.stealthInstalled = true
          }
          for (const frame of page.frames()) await this.runInvocation(active, () => frame.evaluate(stealthSource))
        },
        waitForLoad: async () => {
          const active = state.activeOperation
          if (!active) throw new Error('An active browser operation is required')
          await this.runInvocation(active, () => page.waitForFunction('document.readyState === "complete"', undefined, { timeout: this.remainingTimeout(active), polling: 100 }))
        },
      })
      const failures: unknown[] = []
      let value: T | undefined
      let endNetwork: (() => void) | undefined
      try {
        if (!state.utilityReady) {
          utility.initialize()
          state.utilityReady = true
        }
        await utility.configureSessions()
        endNetwork = utility.network.beginOperation(this.bindNativeOperation(transport, input))
        value = await this.pageOperation.run({ page, input }, operation)
      } catch (error) { failures.push(error) }
      finally {
        while (state.frameConfiguration) {
          try { await state.frameConfiguration } catch (error) { failures.push(error) }
        }
        if (state.frameConfigurationError !== undefined) {
          if (!failures.includes(state.frameConfigurationError)) failures.push(state.frameConfigurationError)
          state.frameConfigurationError = undefined
        }
        try { await utility.settle() } catch (error) { failures.push(error) }
        endNetwork?.()
      }
      if (failures.length) {
        const primary = failures.find((error) => readRelayError(error).errorDetail?.outcome === 'unknown') ?? failures[0]
        if (failures.length > 1 && primary && typeof primary === 'object') Object.assign(primary, { errors: failures })
        throw primary
      }
      return value as T
    } finally {
      state.activeOperation = undefined
      const fence = Promise.allSettled([state.utilityTransport?.settle(), state.nativeFence]).then((results) => {
        for (const result of results) if (result.status === 'rejected') state.nativeFailure ??= result.reason
      })
      state.nativeFence = fence
      void fence.then(release, release)
    }
  }

  private bindNativeOperation(transport: NativeTransport, input: PlaywrightInvocation): NativeTransport {
    return {
      cursorKey: transport.cursorKey,
      deadlineAt: input.deadlineAt,
      assertCurrent: () => { this.assertInvocationCurrent(input); transport.assertCurrent() },
      send: async (method, params, sessionId, options) => {
        this.assertInvocationCurrent(input)
        return await transport.send(method, params, sessionId, { deadlineAt: Math.min(input.deadlineAt ?? Infinity, options?.deadlineAt ?? Infinity) })
      },
      evaluate: (expression, frame, returnByValue) => { this.assertInvocationCurrent(input); return transport.evaluate(expression, frame, returnByValue) },
      frames: () => { this.assertInvocationCurrent(input); return transport.frames() },
      onEvent: (method, listener) => transport.onEvent(method, listener),
      withFrameSession: (frameId, run) => { this.assertInvocationCurrent(input); return transport.withFrameSession(frameId, run) },
    }
  }

  async executeUtility(input: { cdpUrl: string; targetId?: string; mode?: ConnectionMode } & PlaywrightInvocation, request: BrowserUtilityRequest, captureScreenshot?: () => Promise<string>): Promise<Record<string, unknown>> {
    return await this.withPageOperation(input, async () => {
      const page = await this.getPageForTargetId(input)
      const state = this.ensurePageState(page)
      return { targetId: input.targetId, ...await state.utility!.execute({ ...request, targetId: input.targetId }, captureScreenshot) }
    })
  }

  async beforeInput(input: { cdpUrl: string; targetId?: string; mode?: ConnectionMode } & PlaywrightInvocation, humanize?: boolean): Promise<boolean> {
    return await this.withPageOperation(input, async () => {
      const page = await this.getPageForTargetId(input)
      return await this.ensurePageState(page).utility!.beforeInput(humanize)
    })
  }

  async clearNetwork(input: { cdpUrl: string; targetId?: string; mode?: ConnectionMode } & PlaywrightInvocation): Promise<void> {
    await this.withPageOperation(input, async () => {
      const page = await this.getPageForTargetId(input)
      const utility = this.ensurePageState(page).utility!
      await utility.network.settle()
      utility.network.clear()
    })
  }

  async cleanupSessionUtilities({ context, scope }: BrowserSessionCleanup): Promise<void> {
    const principalId = browserPrincipalId(context)
    const group = context.sessionGroupId ?? principalId
    const failures: unknown[] = []
    for (const connection of [this.relayConnection, this.directConnection]) {
      for (const page of connection?.browser.contexts().flatMap((entry: any) => entry.pages()) ?? []) {
        const state = this.pageState.get(page)
        const owner = state?.utilityOwner
        if (!state || !owner || (scope === 'group' ? (owner.sessionGroupId ?? browserPrincipalId(owner)) !== group : browserPrincipalId(owner) !== principalId)) continue
        try { await this.cleanupPageUtilities(page, state) } catch (error) { failures.push(error) }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Browser session utility cleanup failed', { cause: failures[0] })
  }

  private async cleanupPageUtilities(page: any, state: PageState, native = true): Promise<void> {
    await state.operationQueue
    if (!state.utility) return
    const input: PlaywrightInvocation = { context: state.utilityOwner, deadlineAt: Date.now() + 10_000 }
    state.activeOperation = input
    state.utilityTransport?.beginOperation()
    try {
      const resetNative = native && !safePageClosed(page)
      await state.utility.dispose(resetNative)
      await state.utilityTransport?.dispose(resetNative)
      state.utility = undefined
      state.utilityTransport = undefined
      state.utilityReady = false
      if (state.nativeFailure !== undefined) throw state.nativeFailure
    } finally { state.activeOperation = undefined }
  }

  async withFrameCdpSession<T>(
    input: { cdpUrl: string; targetId?: string; mode?: ConnectionMode } & PlaywrightInvocation,
    frameId: string | undefined,
    callback: (session: { send: <R = any>(method: string, params?: Record<string, unknown>) => Promise<R>; contextId?: number }) => Promise<T>,
  ): Promise<T> {
    return await this.withNativeTransport(input, async (transport) => await transport.withFrameSession(frameId, callback))
  }

  async withNativeTransport<T>(
    input: { cdpUrl: string; targetId?: string; mode?: ConnectionMode } & PlaywrightInvocation,
    callback: (transport: NativeTransport, owner: NativeSnapshotOwner, actorKey: string) => Promise<T>,
  ): Promise<T> {
    const page = await this.getPageForTargetId(input)
    const state = this.ensurePageState(page)
    const owner = state.nativeSnapshot ??= new NativeSnapshotOwner()
    if (!input.context) throw new Error('Trusted browser invocation context is required')
    const actorKey = browserPrincipalId(input.context)
    return await this.runInvocation(input, async () => {
      const transport = this.createNativeTransport(page, state, () => input)
      try { return await callback(transport, owner, actorKey) }
      finally {
        if (transport.hasPending) {
          const cleanup = this.trackNativeInvocation(input, transport.dispose())
          state.nativeFence = Promise.allSettled([state.nativeFence, cleanup]).then((results) => {
            for (const result of results) if (result.status === 'rejected') state.nativeFailure ??= result.reason
          })
          void cleanup.catch((error) => {
            relayDebugWarn(this.logger, () => `[browser-playwright] native transport cleanup failed: ${String(error)}`)
          })
        } else await transport.dispose()
      }
    })
  }

  async connectBrowser(cdpUrl?: string, preferredMode?: ConnectionMode, invocation: PlaywrightInvocation = {}): Promise<BrowserConnection> {
    invocation = this.withInvocationDeadline(invocation, 50_000)
    this.assertInvocationCurrent(invocation)
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
      return await this.runInvocation(invocation, () => currentPromise)
    }

    if (mode === 'direct-cdp' && this.directAutoConnectLocked) {
      throw new Error('Direct CDP auto-connect already attempted. Please reconnect manually.')
    }

    const connectPromise = this.createConnection(normalizedUrl, mode, invocation)
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

    return await this.runInvocation(invocation, () => connectPromise)
  }

  async getPageForTargetId(input: { cdpUrl: string; targetId?: string; mode?: ConnectionMode } & PlaywrightInvocation): Promise<any> {
    input = this.withInvocationDeadline(input, 50_000)
    this.assertInvocationCurrent(input)
    if (!input.targetId) {
      throw new Error('targetId is required')
    }

    const current = this.pageOperation.getStore()
    if (current
      && current.input.targetId === input.targetId
      && current.input.cdpUrl === input.cdpUrl
      && current.input.mode === input.mode
      && current.input.context === input.context
      && this.pageState.get(current.page)?.activeOperation === current.input) return current.page

    const mode = input.mode ?? this.getActiveConnectionMode() ?? 'relay'

    const existing = await this.findExistingPage({ ...input, mode })
    this.assertInvocationCurrent(input)
    if (existing) {
      relayDebugWarn(
        this.logger,
        () => `[browser-playwright] resolved page immediately targetId=${input.targetId} mode=${mode} pageUrl="${safePageUrl(existing)}"`,
      )
      await this.logPageSnapshot('getPageForTargetId resolved immediately', existing, input.targetId)
      return existing
    }

    const retries = 3
    for (let attempt = 0; attempt < retries; attempt += 1) {
      await this.runInvocation(input, () => sleep(Math.min(this.remainingTimeout(input), 2_000, 600 * (attempt + 1)), undefined, { signal: input.signal }))
      this.assertInvocationCurrent(input)
      const retried = await this.findExistingPage({ ...input, mode })
      this.assertInvocationCurrent(input)
      if (retried) {
        relayDebugWarn(
          this.logger,
          () => `[browser-playwright] resolved page after retry targetId=${input.targetId} attempt=${attempt + 1} mode=${mode} pageUrl="${safePageUrl(retried)}"`,
        )
        await this.logPageSnapshot('getPageForTargetId resolved after retry', retried, input.targetId)
        return retried
      }
    }

    if (mode === 'relay') {
      relayDebugWarn(
        this.logger,
        () => `[browser-playwright] rebuilding relay projection after page miss targetId=${input.targetId}`,
      )
      await this.closeConnections('relay')
      this.assertInvocationCurrent(input)
      const rebuilt = await this.findExistingPage({ ...input, mode })
      this.assertInvocationCurrent(input)
      if (rebuilt) {
        relayDebugWarn(
          this.logger,
          () => `[browser-playwright] resolved page after relay rebuild targetId=${input.targetId} mode=${mode} pageUrl="${safePageUrl(rebuilt)}"`,
        )
        await this.logPageSnapshot('getPageForTargetId resolved after relay rebuild', rebuilt, input.targetId)
        return rebuilt
      }
    }

    const connection = await this.connectBrowser(input.cdpUrl, mode, input)
    const pages = connection.browser.contexts().flatMap((context: any) => context.pages())
    if (isRelayDebugEnabled()) {
      const pageSummaries = await Promise.all(
        pages.map(async (page: any, index: number) => {
          const resolvedTargetId = await this.resolveTargetId(page)
          return `#${index + 1} targetId=${resolvedTargetId ?? 'null'} url="${safePageUrl(page)}"`
        }),
      )
      relayDebugWarn(
        this.logger,
        () => `[browser-playwright] failed to resolve page targetId=${input.targetId} mode=${mode} openPages=${pageSummaries.join('; ')}`,
      )
    }
    throw new Error(
      `Page not found for targetId="${input.targetId}" after retries. There are ${pages.length} open page(s): ${pages.map((page: any) => page.url()).join(', ')}`,
    )
  }

  async resolvePageTargetId(page: any, invocation: PlaywrightInvocation = {}): Promise<string | null> {
    return await this.resolveTargetId(page, invocation)
  }

  async logPageSnapshot(label: string, page: any, expectedTargetId?: string, error?: unknown): Promise<void> {
    if (!isRelayDebugEnabled()) return
    const cachedTargetId = this.targetIdByPage.get(page) ?? this.targetIdCache.get(page)
    const resolvedTargetId = cachedTargetId ?? await this.resolveTargetId(page)
    const mainFrame = page.mainFrame?.()
    const errorText = error instanceof Error ? error.message : error ? String(error) : ''
    const suffix = errorText ? ` error="${errorText}"` : ''
    relayDebugWarn(
      this.logger,
      () => `[browser-playwright] ${label} expectedTargetId=${expectedTargetId ?? 'null'} resolvedTargetId=${resolvedTargetId ?? 'null'} pageUrl="${safePageUrl(page)}" pageClosed=${safePageClosed(page)} mainFrameName="${safeFrameName(mainFrame)}" mainFrameUrl="${safeFrameUrl(mainFrame)}" mainFrameDetached=${safeFrameDetached(mainFrame)}${suffix}`,
    )
  }

  private resolveDefaultCdpUrl(relayStatus: { connected: boolean; relayPort: number | null }): string {
    if (relayStatus.relayPort !== null) {
      return `http://127.0.0.1:${relayStatus.relayPort}`
    }
    throw new Error('No CDP endpoint available')
  }

  private async createConnection(cdpUrl: string, mode: ConnectionMode, invocation: PlaywrightInvocation): Promise<BrowserConnection> {
    const headers = mode === 'relay' ? this.getRelayStatus().authHeaders : undefined
    const timeouts = mode === 'relay' ? [10_000, 12_000, 14_000] : [15_000, 18_000]
    let lastError: unknown

    if (mode === 'relay') {
      const relayStatus = this.getRelayStatus()
      if (!relayStatus.connected || relayStatus.relayPort === null) {
        throw new Error('Chrome extension not connected')
      }
    }

    await this.runInvocation(invocation, () => waitForBrowserCdpReady({
      cdpUrl,
      headers,
      httpTimeoutMs: this.remainingTimeout(invocation, mode === 'relay' ? 1_200 : 2_000),
      readyTimeoutMs: this.remainingTimeout(invocation, mode === 'relay' ? 3_000 : 4_000),
      label: mode === 'relay' ? 'Browser relay' : 'Direct CDP browser',
    }))

    const playwright = await this.runInvocation(invocation, () => loadPlaywrightCore())

    for (const timeout of timeouts) {
      this.assertInvocationCurrent(invocation)
      try {
        const browser = await playwright.chromium.connectOverCDP(cdpUrl, {
          timeout: this.remainingTimeout(invocation, timeout),
          ...(cdpUrl.startsWith('ws://') || cdpUrl.startsWith('wss://') ? {} : headers ? { headers } : {}),
        })
        const onDisconnected = () => {
          for (const page of browser.contexts().flatMap((context: any) => context.pages())) {
            const state = this.pageState.get(page)
            if (!state) continue
            state.utilityDestroyed = true
            if (state.utility) void this.trackNativeInvocation({ context: state.utilityOwner }, this.cleanupPageUtilities(page, state, false)).catch((error) => {
              relayDebugWarn(this.logger, () => `[browser-playwright] disconnected utility cleanup failed: ${String(error)}`)
            })
          }
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
        this.assertInvocationCurrent(invocation)
        lastError = error
        await this.runInvocation(invocation, () => sleep(Math.min(250, this.remainingTimeout(invocation)), undefined, { signal: invocation.signal }))
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

  private async findExistingPage(input: { cdpUrl: string; targetId?: string; mode?: ConnectionMode } & PlaywrightInvocation): Promise<any | null> {
    this.assertInvocationCurrent(input)
    const browser = (await this.connectBrowser(input.cdpUrl, input.mode, input)).browser
    this.assertInvocationCurrent(input)
    const pages = browser.contexts().flatMap((context: any) => context.pages())
    if (pages.length === 0) return null
    if (!input.targetId) return null

    for (const page of pages) {
      this.assertInvocationCurrent(input)
      const targetId = await this.runInvocation(input, () => this.resolveTargetId(page, input))
      this.assertInvocationCurrent(input)
      if (targetId === input.targetId) {
        return page
      }
    }
    relayDebugWarn(
      this.logger,
      () => `[browser-playwright] targetId miss targetId=${input.targetId} mode=${input.mode ?? 'auto'} scannedPages=${pages.length}`,
    )
    return null
  }

  private async resolveTargetId(page: any, invocation: PlaywrightInvocation = {}): Promise<string | null> {
    this.assertInvocationCurrent(invocation)
    const cached = this.targetIdCache.get(page)
    if (cached !== undefined) {
      return cached
    }

    try {
      return await this.withTemporaryPageSession(page, async (session) => {
        const info = await this.runInvocation(invocation, () => session.send('Target.getTargetInfo'))
        this.assertInvocationCurrent(invocation)
        const targetId = String(info?.targetInfo?.targetId ?? '').trim()
        if (targetId) {
          this.targetIdCache.set(page, targetId)
          this.targetIdByPage.set(page, targetId)
          relayDebugWarn(
            this.logger,
            () => `[browser-playwright] resolved Target.getTargetInfo targetId=${targetId} pageUrl="${safePageUrl(page)}"`,
          )
          return targetId
        }
        return null
      }, invocation)
    } catch (error) {
      this.assertInvocationCurrent(invocation)
      relayDebugWarn(
        this.logger,
        () => `[browser-playwright] resolveTargetId failed pageUrl="${safePageUrl(page)}" error=${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    }
  }

  private async withTemporaryPageSession<T>(page: any, callback: (session: any) => Promise<T>, invocation: PlaywrightInvocation = {}): Promise<T> {
    this.assertInvocationCurrent(invocation)
    const session = await this.trackNativeInvocation(invocation, page.context().newCDPSession(page))
    try {
      this.assertInvocationCurrent(invocation)
      return await callback(session)
    } finally {
      await this.trackNativeInvocation(invocation, session.detach().catch(() => {}))
    }
  }

  mapActionError(error: unknown): string {
    const { message, errorDetail } = readRelayError(error)
    if (errorDetail) return message
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
      return `${message.split('\n')[0].trim()}\nPage navigated or reloaded while the script was running. The outcome is unknown; inspect page state before deciding whether to retry.`
    }
    if (message.includes('missing chromium.connectOverCDP')) {
      return `${message.split('\n')[0].trim()}\nBrowser automation runtime failed to initialize correctly.`
    }
    if (message.includes('HTTP endpoint is not reachable') || message.includes('CDP endpoint is not reachable')) {
      return `${message.split('\n')[0].trim()}\nBrowser is not ready for control yet. Wait a moment and retry.`
    }
    if (message.includes('Timed out waiting for target "') && message.includes('" to become attached.')) {
      return `${message.split('\n')[0].trim()}\nThe new tab was created, but the extension did not finish attaching it in time.`
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
