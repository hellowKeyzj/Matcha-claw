import type { BrowserActionContext } from '../browser-action-contract.js'
import { readRelayError } from '../relay/errors.js'
import type { PlaywrightInvocation } from './session.js'
import type { NativeFrame, NativeTransport } from './native-snapshot.js'

type EventListener = (params: Record<string, any>, sessionId?: string) => void

type TransportHooks = {
  cursorKey: object
  invocation: () => PlaywrightInvocation | undefined
  owner: () => BrowserActionContext | undefined
  assertCurrent: (input: PlaywrightInvocation) => void
  run: <T>(input: PlaywrightInvocation, operation: () => Promise<T>) => Promise<T>
  track: <T>(input: PlaywrightInvocation, operation: Promise<T>) => Promise<T>
  document: (documentId: string) => void
  persistent?: boolean
}

// The same CDP resources serve one callback or the existing page's utility lifetime.
export class NativeCdpTransport implements NativeTransport {
  readonly cursorKey: object
  private readonly sessions = new Map<string, any>()
  private readonly candidates = new Map<any, string>()
  private readonly contexts = new Map<string, Map<string, number>>()
  private readonly listeners = new Map<string, Set<EventListener>>()
  private readonly framesById = new Map<string, NativeFrame>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly paused = new Set<string>()
  private refresh?: Promise<NativeFrame[]>
  private mainSessionId?: string
  private nextSessionId = 0
  private closed = false
  private unknownError?: unknown

  constructor(private readonly page: any, private readonly hooks: TransportHooks) {
    this.cursorKey = hooks.cursorKey
  }

  get deadlineAt(): number | undefined { return this.hooks.invocation()?.deadlineAt }

  beginOperation(): void { this.unknownError = undefined }

  get hasPending(): boolean { return this.pending.size > 0 }

  assertCurrent(): void {
    if (this.closed) throw new Error('Native CDP transport is closed')
    const invocation = this.hooks.invocation()
    if (!invocation) throw new Error('An active browser operation is required')
    this.hooks.assertCurrent(invocation)
    if (this.unknownError) throw this.unknownError
  }

  onEvent(method: string, listener: EventListener): () => void {
    let listeners = this.listeners.get(method)
    if (!listeners) this.listeners.set(method, listeners = new Set())
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(method)
    }
  }

  private emit(method: string, params: Record<string, any>, sessionId?: string): void {
    for (const listener of this.listeners.get(method) ?? []) listener(params, sessionId)
  }

  async send<T = any>(method: string, params?: Record<string, unknown>, sessionId = this.mainSessionId, options?: { deadlineAt?: number }): Promise<T> {
    if (this.closed) throw new Error('Native CDP transport is closed')
    if (!this.mainSessionId) await this.frames()
    sessionId ??= this.mainSessionId
    const session = sessionId ? this.sessions.get(sessionId) : undefined
    if (!session) throw new Error(`Native CDP session ${sessionId} is not available`)
    const active = this.hooks.invocation()
    const pausedKey = `${sessionId}\0${params?.requestId ?? ''}`
    const settlement = ['Fetch.continueRequest', 'Fetch.failRequest', 'Fetch.fulfillRequest'].includes(method) && this.paused.has(pausedKey)
    const rollback = method === 'Fetch.disable' || method === 'Network.setCacheDisabled' && params?.cacheDisabled === false
    if (!active && !settlement && !rollback) throw new Error('An active browser operation is required for native effects')
    const input: PlaywrightInvocation = active && !settlement && !rollback
      ? { ...active, deadlineAt: Math.min(active.deadlineAt ?? Infinity, options?.deadlineAt ?? Infinity) }
      : { context: this.hooks.owner(), deadlineAt: Math.min(Date.now() + 5_000, options?.deadlineAt ?? Infinity) }
    this.hooks.assertCurrent(input)
    if (this.unknownError && !settlement && !rollback) throw this.unknownError
    const operation = this.hooks.track(input, session.send(method, params))
    this.pending.add(operation)
    void operation.then(() => {
      if (settlement) this.paused.delete(pausedKey)
      this.pending.delete(operation)
    }, () => this.pending.delete(operation))
    try {
      return await this.hooks.run(input, () => operation) as T
    } catch (error) {
      const { message, errorDetail } = readRelayError(error)
      if (errorDetail?.outcome === 'unknown' || /timeout|timed out|deadline|cancel|abort/i.test(`${errorDetail?.code ?? ''} ${message}`)) this.unknownError ??= error
      throw error
    }
  }

  private async attach(candidate: any): Promise<string | undefined> {
    const existing = this.candidates.get(candidate)
    if (existing && this.sessions.has(existing)) return existing
    this.assertCurrent()
    const input = this.hooks.invocation()!
    let session: any
    const attachment = this.hooks.track(input, this.page.context().newCDPSession(candidate)).then(async (attached: any) => {
      try { this.hooks.assertCurrent(input) }
      catch (error) {
        await this.hooks.track({ context: input.context }, attached.detach())
        throw error
      }
      return attached
    })
    this.pending.add(attachment)
    void attachment.then(() => this.pending.delete(attachment), () => this.pending.delete(attachment))
    try { session = await this.hooks.run(input, () => attachment) } catch (error) {
      this.assertCurrent()
      if (candidate === this.page || !/does not have a separate CDP session|not an out-of-process iframe/i.test(error instanceof Error ? error.message : String(error))) throw error
      return undefined
    }
    const sessionId = `session-${this.nextSessionId++}`
    const contexts = new Map<string, number>()
    this.candidates.set(candidate, sessionId)
    this.sessions.set(sessionId, session)
    this.contexts.set(sessionId, contexts)
    if (candidate === this.page) this.mainSessionId = sessionId
    session.on('event', ({ method, params }: { method: string; params: Record<string, any> }) => {
      if (method === 'Runtime.executionContextCreated') {
        const context = params.context
        if (context?.auxData?.isDefault === true && typeof context.auxData.frameId === 'string') contexts.set(context.auxData.frameId, context.id)
      } else if (method === 'Runtime.executionContextsCleared') contexts.clear()
      else if (method === 'Runtime.executionContextDestroyed') {
        for (const [frameId, contextId] of contexts) if (contextId === params.executionContextId) contexts.delete(frameId)
      } else if (method === 'Page.frameNavigated' && candidate === this.page) this.observeDocument(params.frame)
      if (method === 'Fetch.requestPaused' && typeof params.requestId === 'string') this.paused.add(`${sessionId}\0${params.requestId}`)
      this.emit(method, params, candidate === this.page ? undefined : sessionId)
    })
    session.on('close', () => {
      this.sessions.delete(sessionId)
      this.contexts.delete(sessionId)
      this.candidates.delete(candidate)
    })
    await this.send('Page.enable', undefined, sessionId)
    await this.send('Runtime.enable', undefined, sessionId)
    if (this.hooks.persistent) {
      await this.send('Network.enable', { maxResourceBufferSize: 262_144, maxTotalBufferSize: 1_048_576 }, sessionId)
    }
    return sessionId
  }

  private observeDocument(frame: any): void {
    if (frame?.id && frame.loaderId && !frame.parentId) this.hooks.document(`${frame.id}\0${frame.loaderId}`)
  }

  async frames(): Promise<NativeFrame[]> {
    this.assertCurrent()
    if (this.refresh) return await this.refresh
    const operation = this.refreshFrames()
    this.refresh = operation
    try { return await operation }
    finally { if (this.refresh === operation) this.refresh = undefined }
  }

  private async refreshFrames(): Promise<NativeFrame[]> {
    const frames = new Map<string, NativeFrame>()
    const parentIds = new Map<string, string>()
    const candidates = [this.page, ...this.page.frames().filter((frame: any) => frame !== this.page.mainFrame())]
    const trees: Array<{ candidate: any; sessionId: string; tree: any }> = []
    for (const candidate of candidates) {
      const sessionId = await this.attach(candidate)
      if (sessionId) trees.push({ candidate, sessionId, tree: await this.send<any>('Page.getFrameTree', undefined, sessionId) })
    }
    const childRoots = new Set(trees.filter(({ candidate }) => candidate !== this.page).map(({ tree }) => tree.frameTree?.frame?.id))
    for (const { candidate, sessionId, tree } of trees) {
      const contexts = this.contexts.get(sessionId)!
      if (candidate === this.page) this.observeDocument(tree.frameTree?.frame)
      const collect = async (node: any): Promise<void> => {
        if (!node?.frame) return
        const frame = node.frame
        if (frame.parentId) parentIds.set(frame.id, frame.parentId)
        if (node !== tree.frameTree && childRoots.has(frame.id)) return
        let contextId = contexts.get(frame.id)
        if (contextId === undefined) {
          const world = await this.send<any>('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'matcha-browser-utility' }, sessionId)
          if (typeof world.executionContextId !== 'number') throw new Error(`Frame ${frame.id} has no native execution context`)
          contextId = world.executionContextId
          contexts.set(frame.id, contextId!)
        }
        frames.set(frame.id, { id: frame.id, parentId: frame.parentId ?? parentIds.get(frame.id), name: frame.name, url: frame.url ?? '', sessionId: candidate === this.page ? undefined : sessionId, contextId: contextId!, oopif: candidate !== this.page && node === tree.frameTree })
        for (const child of node.childFrames ?? []) await collect(child)
      }
      await collect(tree.frameTree)
    }
    this.framesById.clear()
    for (const [id, frame] of frames) this.framesById.set(id, frame)
    return [...frames.values()]
  }

  async evaluate<T>(expression: string, frame: NativeFrame, returnByValue = true): Promise<T> {
    const result = await this.send<any>('Runtime.evaluate', { expression, contextId: frame.contextId, returnByValue, awaitPromise: true }, frame.sessionId)
    if (result.exceptionDetails || result.result?.subtype === 'error') throw new Error(String(result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text ?? result.result?.description ?? 'Native expression failed'))
    return (returnByValue ? result.result?.value : result.result?.objectId) as T
  }

  async withFrameSession<T>(frameId: string | undefined, run: (session: { send: <R = any>(method: string, params?: Record<string, unknown>) => Promise<R>; contextId?: number }) => Promise<T>): Promise<T> {
    this.assertCurrent()
    if (!this.mainSessionId) await this.frames()
    const frame = frameId ? this.framesById.get(frameId) : undefined
    if (frameId && !frame) throw new Error(`Frame ${frameId} has no current native execution context`)
    return await run({ send: (method, params) => this.send(method, params, frame?.sessionId), ...(frame ? { contextId: frame.contextId } : {}) })
  }

  detachFrame(frame: any): void {
    const sessionId = this.candidates.get(frame)
    if (sessionId) this.emit('Target.detachedFromTarget', { sessionId }, sessionId)
  }

  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }

  async dispose(native = true): Promise<void> {
    await this.settle()
    this.closed = true
    this.listeners.clear()
    const input = this.hooks.invocation() ?? { context: this.hooks.owner() }
    if (native) await Promise.all([...this.sessions.values()].map((session) => this.hooks.track(input, session.detach())))
    this.sessions.clear()
    this.candidates.clear()
    this.contexts.clear()
    this.framesById.clear()
    this.paused.clear()
  }
}
