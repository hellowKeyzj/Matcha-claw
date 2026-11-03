import type { BrowserSnapshotAction } from '../browser-action-contract.js'
import { readRelayError } from '../relay/errors.js'
import { captureFusedRows, selectSnapshotScope } from './native-snapshot-dom.js'
import { captureRawRows } from './native-snapshot-raw.js'
import { filterSnapshot } from './snapshot-filter.js'
import type { RoleSnapshotLineMeta } from './role-refs.js'

export type NativeFrame = {
  id: string
  parentId?: string
  name?: string
  url: string
  sessionId?: string
  contextId: number
  oopif?: boolean
}

export type NativeSend = <T = any>(method: string, params?: Record<string, unknown>) => Promise<T>

export type NativeTransport = {
  cursorKey?: object
  readonly deadlineAt?: number
  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string, options?: { deadlineAt?: number }): Promise<T>
  evaluate<T>(expression: string, frame: NativeFrame, returnByValue?: boolean): Promise<T>
  frames(): Promise<NativeFrame[]>
  assertCurrent(): void
  onEvent(method: string, listener: (params: Record<string, any>, sessionId?: string) => void): () => void
  withFrameSession<T>(frameId: string | undefined, run: (session: { send: NativeSend; contextId?: number }) => Promise<T>): Promise<T>
}

export type NativeSnapshotOptions = Pick<BrowserSnapshotAction,
  'limit' | 'maxChars' | 'selector' | 'frame' | 'interactive' | 'compact' | 'efficient' | 'mode' | 'depth' | 'scope' | 'filter'
> & { includeRefs?: boolean; stabilizeRefs?: boolean }

export type NativeRef = {
  ref: string
  role: string
  name?: string
  placeholder?: string
  nth?: number
  backendNodeId?: number
  frameId: string
  sessionId?: string
  bounds?: { x: number; y: number; width: number; height: number }
}

export type NativeSnapshotResult = {
  snapshot: string
  refs: Record<string, NativeRef>
  stats: { lines: number; chars: number; refs: number; interactive: number }
  degraded: boolean
  source: 'fused' | 'a11yTree' | 'domTree'
  degradedReason?: string
  truncated?: boolean
  frames?: { id: string; name: string; url: string }[]
  totalCount?: number
  matchedCount?: number
  returnedCount?: number
  sparse?: boolean
  refRange?: { min: string; max: string }
  actionKey?: 'backendNodeId'
}

export type NativeRow = {
  line: string
  frame: NativeFrame
  backendNodeId?: number
  role: string
  name?: string
  placeholder?: string
  nth?: number
  bounds?: NativeRef['bounds']
  interactive: boolean
  depth: number
}

export type NativeScope = { frames: NativeFrame[]; roots?: Map<string, Set<number>> }
type ActorSnapshot = { generation: number; refs: Record<string, NativeRef>; options: NativeSnapshotOptions; maxCounter: number }
type NativeTarget = { ref?: string; backendNodeId?: number; frameId?: string }

export class NativePageUpdatedError extends Error {
  constructor(public readonly reason: string, public readonly freshSnapshot?: NativeSnapshotResult) {
    super(`Page updated (${reason}); take a fresh snapshot before acting again.`)
    this.name = 'NativePageUpdatedError'
  }
}

// Only ordinary observation/capability failures may enter raw-tree recovery.
export function checkSnapshotFailure(transport: NativeTransport, error: unknown): void {
  transport.assertCurrent()
  const { message, errorDetail } = readRelayError(error)
  const code = String(errorDetail?.code ?? (error && typeof error === 'object' && 'code' in error ? error.code : ''))
  if (errorDetail?.outcome === 'unknown'
    || /(?:UNKNOWN|TIMEOUT|DEADLINE|ABORT|CANCEL|CLAIM|SCOPE|EPOCH|REVOK|STALE|CURRENT|SESSION)/iu.test(code)
    || (error instanceof Error && ['AbortError', 'TimeoutError', 'NativePageUpdatedError'].includes(error.name))
    || /(?:timed?\s*out|timeout|deadline|outcome.?unknown|invocation.*(?:expired|aborted|current)|claim.*(?:lost|revoked)|execution scope changed|session closed|target closed|target page.*closed)/iu.test(message)) throw error
}

function identity(ref: NativeRef): string {
  return `${ref.frameId}\0${ref.role}\0${ref.name ?? ''}\0${ref.placeholder ?? ''}\0${ref.nth ?? 0}`
}

function renderRows(rows: NativeRow[], options: NativeSnapshotOptions, previous?: ActorSnapshot, prefix = ''): { result: NativeSnapshotResult; maxCounter: number } {
  const refs: Record<string, NativeRef> = {}, lineMeta: RoleSnapshotLineMeta[] = []
  const interactive = new Set<string>(), used = new Set<string>()
  const old = new Map(Object.entries(previous?.refs ?? {}).map(([ref, value]) => [identity(value), ref]))
  let counter = previous?.maxCounter ?? 0
  const assigned = new Map<NativeRow, string>()
  // Reserve reused numbers before allocating new numbers, even when rows were reordered.
  for (const row of rows) {
    if (row.backendNodeId === undefined) continue
    const ref = old.get(identity({ ...row, ref: '', frameId: row.frame.id }))
    if (ref && !used.has(ref)) { assigned.set(row, ref); used.add(ref) }
  }
  for (const row of rows) {
    let ref = assigned.get(row)
    if (row.backendNodeId !== undefined && !ref) {
      do { ref = `e${++counter}` } while (used.has(ref))
      used.add(ref)
    }
    let line = row.line
    if (ref) {
      refs[ref] = { ref, role: row.role, name: row.name, placeholder: row.placeholder, nth: row.nth, backendNodeId: row.backendNodeId, frameId: row.frame.id, sessionId: row.frame.sessionId, bounds: row.bounds }
      line += options.includeRefs === false ? (line.includes('[dom=') ? '' : ` [dom=${row.backendNodeId}]`) : ` [ref=${ref}]`
      if (row.interactive) interactive.add(ref)
    }
    lineMeta.push({ text: line, indent: row.depth * 2, ref, role: row.role.toLowerCase(), name: row.name })
  }
  const full = lineMeta.map((line) => line.text).join('\n')
  const filtered = options.filter ? filterSnapshot(lineMeta, options.filter) : null
  let snapshot = prefix + (filtered?.prunedSnapshot ?? full)
  let truncated = filtered?.truncated ?? false
  if (options.limit !== undefined) {
    const lines = snapshot.split('\n'), maximum = Math.max(0, Math.floor(options.limit))
    if (lines.length > maximum) { snapshot = lines.slice(0, maximum).join('\n'); truncated = true }
  }
  if (options.maxChars !== undefined && snapshot.length > options.maxChars) {
    snapshot = snapshot.slice(0, Math.max(0, options.maxChars)); truncated = true
  }
  const visibleLines = new Set(snapshot.split('\n'))
  const visible = options.includeRefs === false
    ? new Set(lineMeta.filter((line) => visibleLines.has(line.text)).map((line) => line.ref))
    : new Set([...snapshot.matchAll(/\[ref=(e\d+)\]/gu)].map((match) => match[1]))
  for (const ref of Object.keys(refs)) if (!visible.has(ref)) delete refs[ref]
  const result: NativeSnapshotResult = {
    snapshot, refs,
    stats: { lines: snapshot ? snapshot.split('\n').length : 0, chars: snapshot.length, refs: Object.keys(refs).length, interactive: Object.keys(refs).filter((ref) => interactive.has(ref)).length },
    degraded: false, source: 'fused', truncated,
    ...(filtered ? { totalCount: lineMeta.filter((line) => line.ref).length, matchedCount: filtered.matchedCount, returnedCount: Object.keys(refs).length, sparse: filtered.sparse, refRange: filtered.refRange } : {}),
  }
  return { result, maxCounter: counter }
}

export function renderRawSnapshot(rows: NativeRow[], options: NativeSnapshotOptions, frames: NativeFrame[], source: 'a11yTree' | 'domTree', reason: string | undefined, previous?: ActorSnapshot): NativeSnapshotResult {
  const prefix = `[degraded snapshot: ${source}; actionKey=backendNodeId]\nReason: ${reason}\nUse backendNodeId from [dom=N] with its frameId. Take a fresh snapshot after navigation.\n\n`
  const { result } = renderRows(rows, { ...options, includeRefs: false }, previous, prefix)
  result.source = source
  result.degraded = true
  result.degradedReason = reason
  result.frames = frames.map((frame) => ({ id: frame.id, name: frame.name ?? '', url: frame.url }))
  result.actionKey = 'backendNodeId'
  result.refs = {}
  result.stats.refs = 0
  result.stats.interactive = 0
  if (result.returnedCount !== undefined) result.returnedCount = 0
  return result
}

export class NativeSnapshotOwner {
  private generation = 0
  private disposed = false
  private readonly actors = new Map<string, ActorSnapshot>()

  invalidateDocument(): void { this.generation++ }

  dispose(): void {
    this.disposed = true
    this.generation++
    this.actors.clear()
  }

  private assertCurrent(transport: NativeTransport): void {
    transport.assertCurrent()
    if (this.disposed) throw new Error('Native snapshot owner is disposed')
  }

  async capture(actorKey: string, options: NativeSnapshotOptions, transport: NativeTransport): Promise<NativeSnapshotResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.assertCurrent(transport)
      const generation = this.generation
      try {
        const frames = await transport.frames()
        const scope = await selectSnapshotScope(transport, frames, options)
        let rows: NativeRow[], source: NativeSnapshotResult['source'] = 'fused', reason: string | undefined
        try {
          rows = await captureFusedRows(transport, frames, scope, options)
        } catch (error) {
          checkSnapshotFailure(transport, error)
          if (generation !== this.generation) throw error
          reason = error instanceof Error ? error.message : String(error)
          const raw = await captureRawRows(transport, frames, scope, options)
          rows = raw.rows; source = raw.source
        }
        this.assertCurrent(transport)
        if (generation === this.generation) {
          const previous = this.actors.get(actorKey)
          const stable = options.stabilizeRefs !== false && previous?.generation === generation ? previous : undefined
          if (source !== 'fused') return renderRawSnapshot(rows, options, frames, source, reason, stable)
          const { result, maxCounter } = renderRows(rows, options, stable)
          result.degradedReason = reason
          result.frames = frames.map((frame) => ({ id: frame.id, name: frame.name ?? '', url: frame.url }))
          this.actors.set(actorKey, { generation, refs: result.refs, options: { ...options }, maxCounter })
          return result
        }
      } catch (error) {
        checkSnapshotFailure(transport, error)
        if (generation === this.generation) throw error
      }
    }
    return { snapshot: '', refs: {}, stats: { lines: 0, chars: 0, refs: 0, interactive: 0 }, degraded: true, source: 'fused', degradedReason: 'document_changed' }
  }

  private async pageUpdated(actorKey: string, reason: string, transport: NativeTransport): Promise<never> {
    const previous = this.actors.get(actorKey)
    let fresh: NativeSnapshotResult | undefined
    if (previous) {
      try {
        const snapshot = await this.capture(actorKey, previous.options, transport)
        if (!snapshot.degraded) fresh = snapshot
      } catch (error) {
        if (!(error instanceof NativePageUpdatedError)) checkSnapshotFailure(transport, error)
      }
    }
    throw new NativePageUpdatedError(reason, fresh)
  }

  async resolve(actorKey: string, target: NativeTarget, transport: NativeTransport): Promise<{ backendNodeId: number; frame: NativeFrame }> {
    this.assertCurrent(transport)
    const generation = this.generation
    let backendNodeId = target.backendNodeId, frameId = target.frameId
    if (!(typeof backendNodeId === 'number' && Number.isInteger(backendNodeId) && backendNodeId > 0)) {
      if (!target.ref) throw new Error('A ref or positive backendNodeId is required')
      const previous = this.actors.get(actorKey)
      if (!previous) throw new Error('No snapshot refs exist for this executor. Take a snapshot first.')
      if (previous.generation !== generation) return this.pageUpdated(actorKey, 'document_changed', transport)
      const ref = target.ref.replace(/^@/u, '')
      const entry = previous.refs[ref]
      if (!entry) throw new Error(`Unknown ref ${JSON.stringify(target.ref)} in the current snapshot. Take a fresh snapshot or correct the ref.`)
      backendNodeId = entry.backendNodeId
      frameId = entry.frameId
      if (!backendNodeId) return this.pageUpdated(actorKey, 'no_backend', transport)
    }
    const frames = await transport.frames()
    const frame = frameId ? frames.find((item) => item.id === frameId) : frames.find((item) => !item.parentId) ?? frames[0]
    if (!frame) return this.pageUpdated(actorKey, 'document_changed', transport)
    let exists = false
    try {
      exists = await transport.withFrameSession(frame.id, async ({ send, contextId }) => {
        const result = await send<{ object?: { objectId?: string; subtype?: string } }>('DOM.resolveNode', { backendNodeId, ...(contextId === undefined ? {} : { executionContextId: contextId }) })
        const objectId = result.object?.objectId
        if (!objectId) return false
        try { return result.object?.subtype !== 'null' }
        finally { await send('Runtime.releaseObject', { objectId }) }
      })
    } catch (error) {
      checkSnapshotFailure(transport, error)
      const { message } = readRelayError(error)
      if (!/(?:No node with given id|Could not find node|Node with given id does not belong|Could not resolve node|node.*detached|Cannot find context with specified id|Execution context was destroyed|Inspected target navigated)/iu.test(message)) throw error
    }
    this.assertCurrent(transport)
    if (generation !== this.generation) return this.pageUpdated(actorKey, 'document_changed', transport)
    if (!exists) return this.pageUpdated(actorKey, 'no_backend', transport)
    return { backendNodeId: backendNodeId!, frame }
  }
}
