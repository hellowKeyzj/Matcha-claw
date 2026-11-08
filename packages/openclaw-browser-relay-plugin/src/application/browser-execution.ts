import type {
  BrowserActionContext,
  BrowserActionInvocation,
  BrowserActionParams,
  BrowserSessionCleanup,
} from '../browser-action-contract.js'
import { hasBrowserActionReceipt } from '../browser-action-contract.js'
import { isIncognitoSessionKey, parseAgentSessionKey } from 'openclaw/plugin-sdk/routing'
import { browserPrincipalId } from '../state/page-ownership.js'
import type { BrowserBackendMode } from '../manifest.js'

type Run = {
  context: BrowserActionContext & { runId: string }
  controller: AbortController
  admitted: boolean
  root?: Run
  work: Set<Promise<unknown>>
  ending?: Promise<void>
}

type Group = {
  runs: Set<Run>
  cleanupContext?: BrowserActionContext
  latestRoot?: Run
  activeRoot?: Run
  cleanup?: Promise<void>
}

type Receipt = { run: Run; signal?: AbortSignal }
type AdminExecution = {
  context?: BrowserActionContext
  controller: AbortController
  admitted: boolean
  work?: Promise<unknown>
}
type EndContext = { agentId?: string; sessionKey: string; sessionId?: string; runId?: string }

function runKey(context: BrowserActionContext & { runId: string }): string {
  return JSON.stringify([context.agentId, context.sessionKey, context.sessionId, context.runId])
}

function sameSession(left: BrowserActionContext, right: BrowserActionContext): boolean {
  return left.agentId === right.agentId && left.sessionKey === right.sessionKey && left.sessionId === right.sessionId
}

export class BrowserExecutions {
  private readonly runs = new Map<string, Run>()
  private readonly groups = new Map<string, Group>()
  private readonly receipts = new Map<string, Receipt>()
  private readonly invocations = new WeakMap<BrowserActionInvocation, Receipt>()
  private readonly administrators = new Set<AdminExecution>()
  private readonly observed = new Map<string, BrowserActionContext & { runId: string }>()
  private readonly ended = new Set<string>()
  private closed = false
  private closing?: Promise<void>

  constructor(
    private readonly cleanup: (request: BrowserSessionCleanup) => Promise<void>,
    private readonly resolve: (context: BrowserActionContext) => BrowserActionContext,
    private readonly mode: BrowserBackendMode,
  ) {}

  captureRun(context: BrowserActionContext & { runId: string }): void {
    this.assertOpen()
    if (!parseAgentSessionKey(context.sessionKey) || isIncognitoSessionKey(context.sessionKey)) return
    if (this.ended.has(runKey(context))) return
    this.observed.set(browserPrincipalId(context), Object.freeze({ ...context }))
  }

  capture(toolCallId: string, context: BrowserActionContext & { runId: string }, signal?: AbortSignal): void {
    this.assertOpen()
    if (!toolCallId || this.receipts.has(toolCallId)) throw new Error('Browser tool call identity is missing or already captured.')
    signal?.throwIfAborted()
    this.receipts.set(toolCallId, { run: this.record(context), signal })
  }

  take(toolCallId: string, expectedContext: BrowserActionContext): BrowserActionInvocation {
    this.assertOpen()
    const receipt = this.receipts.get(toolCallId)
    this.receipts.delete(toolCallId)
    if (!receipt) throw new Error('Browser execution requires a trusted before_tool_call receipt.')
    const expected = expectedContext
    if (!sameSession(receipt.run.context, expected)
      || expected.runId !== undefined && expected.runId !== receipt.run.context.runId) {
      throw new Error('Browser tool call identity does not match its captured execution.')
    }
    const signal = receipt.signal
      ? AbortSignal.any([receipt.signal, receipt.run.controller.signal])
      : receipt.run.controller.signal
    const invocation: BrowserActionInvocation = {
      context: Object.freeze({ ...receipt.run.context, workspaceDir: expected.workspaceDir }),
      signal,
      assertInvocationCurrent: () => this.assertCurrent(receipt.run, signal),
    }
    invocation.assertInvocationCurrent!()
    this.invocations.set(invocation, receipt)
    return invocation
  }

  forget(toolCallId: string): void {
    this.receipts.delete(toolCallId)
  }

  async execute(
    params: BrowserActionParams,
    invocation: BrowserActionInvocation,
    task: (params: BrowserActionParams, invocation: BrowserActionInvocation) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    this.assertOpen()
    const receipt = this.invocations.get(invocation)
    if (!receipt) {
      if (invocation.context?.runId) throw new Error('Browser execution has no captured tool invocation.')
      return await this.executeAdministrator(params, invocation, task)
    }
    this.invocations.delete(invocation)
    const run = receipt.run
    for (;;) {
      await this.admit(run)
      invocation.assertInvocationCurrent?.()
      const pending = this.groups.get(run.context.sessionGroupId!)!.cleanup
      if (!pending) break
      await pending
    }
    const work = Promise.resolve().then(async () => {
      invocation.assertInvocationCurrent?.()
      const result = await task(params, invocation)
      if (!hasBrowserActionReceipt(result)) invocation.assertInvocationCurrent?.()
      return result
    })
    run.work.add(work)
    try {
      return await work
    } finally {
      run.work.delete(work)
    }
  }

  async end(context: EndContext): Promise<void> {
    if (this.closed || !context.runId && !context.sessionId) return
    if (context.agentId && context.sessionId && context.runId) this.ended.add(runKey({
      agentId: context.agentId, sessionKey: context.sessionKey, sessionId: context.sessionId, runId: context.runId,
    }))
    const matches = [...this.runs.values()].filter((run) => run.context.sessionKey === context.sessionKey
      && (context.agentId === undefined || run.context.agentId === context.agentId)
      && (context.sessionId === undefined || run.context.sessionId === context.sessionId)
      && (context.runId === undefined || run.context.runId === context.runId))
    for (const [key, observed] of this.observed) {
      if (observed.sessionKey === context.sessionKey
        && (context.agentId === undefined || observed.agentId === context.agentId)
        && (context.sessionId === undefined || observed.sessionId === context.sessionId)
        && (context.runId === undefined || observed.runId === context.runId)) {
        this.ended.add(runKey(observed))
        this.observed.delete(key)
      }
    }
    await Promise.all(matches.map((run) => this.finish(run)))
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.receipts.clear()
    this.observed.clear()
    this.ended.clear()
    for (const run of this.runs.values()) run.controller.abort(new Error('Browser execution owner stopped.'))
    for (const admin of this.administrators) admin.controller.abort(new Error('Browser execution owner stopped.'))
    this.closing = (async () => {
      const administratorWork = Promise.allSettled([...this.administrators].flatMap((admin) => admin.work ? [admin.work] : []))
      const results = await Promise.allSettled([...this.groups.entries()].map(async ([groupId, group]) => {
        const targets = [...group.runs]
        const previousCleanup = group.cleanup
        const settling = Promise.allSettled(targets.flatMap((target) => [...target.work]))
        const errors: unknown[] = []
        if (previousCleanup) try { await previousCleanup } catch (error) { errors.push(error) }
        try {
          const context = group.cleanupContext
          if (context) await this.cleanup({ context, scope: 'group' })
          group.cleanupContext = undefined
        } catch (error) { errors.push(error) }
        finally { await settling }
        if (errors.length) throw new AggregateError(errors, 'Browser session group cleanup failed during shutdown.')
        for (const target of targets) this.runs.delete(runKey(target.context))
        this.groups.delete(groupId)
      }))
      await administratorWork
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Browser execution cleanup failed during shutdown.')
    })()
    return this.closing
  }

  private async executeAdministrator(
    params: BrowserActionParams,
    invocation: BrowserActionInvocation,
    task: (params: BrowserActionParams, invocation: BrowserActionInvocation) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const context = invocation.context ? this.resolve(invocation.context) : undefined
    const admin: AdminExecution = { context, controller: new AbortController(), admitted: false }
    const signal = invocation.signal ? AbortSignal.any([invocation.signal, admin.controller.signal]) : admin.controller.signal
    const assertOwnershipCurrent = () => {
      if (context) {
        const latest = this.resolve(context)
        if (!sameSession(context, latest) || latest.sessionGroupId !== context.sessionGroupId) {
          throw new Error('Administrator browser session ownership is no longer current.')
        }
      }
    }
    const current = () => {
      this.assertOpen()
      signal.throwIfAborted()
      invocation.assertInvocationCurrent?.()
      if (this.mode === 'relay') assertOwnershipCurrent()
    }
    this.administrators.add(admin)
    const work = Promise.resolve().then(async () => {
      for (;;) {
        current()
        const pending = context?.sessionGroupId ? this.groups.get(context.sessionGroupId)?.cleanup : undefined
        if (!pending) break
        await pending
      }
      current()
      if (this.mode === 'iab') assertOwnershipCurrent()
      admin.admitted = true
      if (context?.sessionGroupId) {
        let group = this.groups.get(context.sessionGroupId)
        if (!group) {
          group = { runs: new Set() }
          this.groups.set(context.sessionGroupId, group)
        }
        group.cleanupContext = context
      }
      const result = await task(params, { ...invocation, context, signal, assertInvocationCurrent: current })
      if (!hasBrowserActionReceipt(result)) current()
      return result
    })
    admin.work = work
    try {
      return await work
    } finally {
      this.administrators.delete(admin)
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Browser execution owner stopped.')
  }

  private record(context: BrowserActionContext & { runId: string }): Run {
    this.assertOpen()
    if (!context.runId) throw new Error('Browser execution requires a trusted runId.')
    const resolved = this.resolve(context)
    if (!resolved.rootSessionKey || !resolved.sessionGroupId) throw new Error('Browser execution requires a trusted session group.')
    const captured = Object.freeze({ ...resolved, runId: context.runId, rootSessionKey: resolved.rootSessionKey, sessionGroupId: resolved.sessionGroupId })
    const root = parseAgentSessionKey(captured.rootSessionKey)
    const rootIdentity = root && JSON.stringify([root.agentId, captured.rootSessionKey])
    const observedRoot = rootIdentity ? this.observed.get(rootIdentity) : undefined
    if (observedRoot && browserPrincipalId(observedRoot) !== browserPrincipalId(captured)) this.record(observedRoot)
    const key = runKey(captured)
    if (this.ended.has(key)) throw new Error('Browser execution already ended.')
    const existing = this.runs.get(key)
    if (existing) {
      this.assertCurrent(existing)
      if (!existing.root) existing.root = this.groups.get(captured.sessionGroupId)?.latestRoot
      if (existing.context.sessionGroupId !== captured.sessionGroupId) throw new Error('Browser execution session group changed.')
      return existing
    }
    const run: Run = { context: captured, controller: new AbortController(), admitted: false, work: new Set() }
    this.runs.set(key, run)
    let group = this.groups.get(captured.sessionGroupId)
    if (!group) {
      group = { runs: new Set() }
      this.groups.set(captured.sessionGroupId, group)
    }
    group.runs.add(run)
    if (captured.rootSessionKey === captured.sessionKey) {
      group.latestRoot = run
      run.root = run
    } else run.root = group.latestRoot
    return run
  }

  private assertCurrent(run: Run, signal?: AbortSignal): void {
    this.assertOpen()
    run.controller.signal.throwIfAborted()
    signal?.throwIfAborted()
    if (this.mode === 'relay') this.assertOwnershipCurrent(run)
  }

  private assertOwnershipCurrent(run: Run): void {
    const current = this.resolve(run.context)
    if (!sameSession(current, run.context) || current.rootSessionKey !== run.context.rootSessionKey
      || current.sessionGroupId !== run.context.sessionGroupId) {
      throw new Error('Browser execution session ownership is no longer current.')
    }
  }

  private async admit(run: Run): Promise<void> {
    for (;;) {
      this.assertCurrent(run)
      const group = this.groups.get(run.context.sessionGroupId!)!
      if (group.cleanup) {
        await group.cleanup
        continue
      }
      const root = run.root ?? group.latestRoot
      root?.controller.signal.throwIfAborted()
      if (group.latestRoot && root && group.latestRoot !== root) throw new Error('Browser execution belongs to a superseded root run.')
      if (group.activeRoot && root && group.activeRoot !== root) {
        await this.finish(group.activeRoot)
        continue
      }
      const previous = [...this.runs.values()].find((other) => other !== run && other.admitted
        && browserPrincipalId(other.context) === browserPrincipalId(run.context))
      if (previous) {
        await this.finish(previous)
        continue
      }
      this.assertCurrent(run)
      if (this.mode === 'iab') this.assertOwnershipCurrent(run)
      run.admitted = true
      group.cleanupContext = run.context
      if (root) group.activeRoot = root
      return
    }
  }

  private finish(run: Run): Promise<void> {
    if (run.ending) return run.ending
    const group = this.groups.get(run.context.sessionGroupId!)!
    const wholeGroup = run.context.rootSessionKey === run.context.sessionKey
      && (group.activeRoot === run || !group.activeRoot && group.latestRoot === run)
    const targets = wholeGroup ? [...group.runs].filter((member) => member.admitted || member === run) : [run]
    const cleanupContext = wholeGroup ? group.cleanupContext : run.admitted ? run.context : undefined
    const administrators = wholeGroup ? [...this.administrators].filter((admin) => admin.admitted
      && admin.context?.sessionGroupId === run.context.sessionGroupId) : []
    for (const admin of administrators) admin.controller.abort(new Error('Browser session group ended.'))
    for (const target of targets) {
      if (!this.closed) this.ended.add(runKey(target.context))
      target.controller.abort(new Error('Browser execution ended.'))
      for (const [toolCallId, receipt] of this.receipts) if (receipt.run === target) this.receipts.delete(toolCallId)
    }
    const previousCleanup = group.cleanup
    const settling = Promise.allSettled([
      ...targets.flatMap((target) => [...target.work]),
      ...administrators.flatMap((admin) => admin.work ? [admin.work] : []),
    ])
    const ending = (async () => {
      try {
        if (previousCleanup) await previousCleanup
        if (cleanupContext) await this.cleanup({ context: cleanupContext, scope: wholeGroup ? 'group' : 'executor' })
      } finally {
        await settling
      }
      for (const target of targets) {
        this.runs.delete(runKey(target.context))
        group.runs.delete(target)
      }
      if (wholeGroup) {
        group.activeRoot = undefined
        group.cleanupContext = undefined
      }
      if (group.latestRoot === run) group.latestRoot = undefined
    })()
    for (const target of targets) target.ending = ending
    if (cleanupContext) group.cleanup = ending
    void ending.then(() => {
      if (group.cleanup === ending) group.cleanup = undefined
      if (!group.runs.size && !group.cleanup && !group.cleanupContext) this.groups.delete(run.context.sessionGroupId!)
    }, () => {})
    return ending
  }
}
