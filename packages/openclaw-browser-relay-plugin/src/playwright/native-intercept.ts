import type { BrowserInterceptRule, BrowserUtilityRequest } from '../browser-action-contract.js'
import { readRelayError } from '../relay/errors.js'
import type { NativeTransport } from './native-snapshot.js'

type Policy = { rules: BrowserInterceptRule[]; cacheBypass: boolean }
type Resolution = { method: 'Fetch.continueRequest' | 'Fetch.failRequest' | 'Fetch.fulfillRequest'; params: Record<string, unknown> }

export class NativeInterception {
  private policy: Policy = { rules: [], cacheBypass: false }
  private staged?: Policy
  private readonly sessions = new Map<string | undefined, Policy | undefined>()
  private readonly fetchSessions = new Set<string | undefined>()
  private readonly cacheSessions = new Set<string | undefined>()
  private readonly uncertain = new Map<string | undefined, Set<string>>()
  private readonly tasks = new Set<Promise<void>>()
  private readonly stop: () => void
  private failure?: unknown
  private resetTask?: Promise<void>
  private disposal?: Promise<void>
  private closing = false
  private destroyed = false

  constructor(private readonly transport: NativeTransport) {
    const stopPaused = transport.onEvent('Fetch.requestPaused', (params, sessionId) => {
      const task = this.resolvePaused(params, sessionId)
      this.tasks.add(task)
      void task.then(() => this.tasks.delete(task), (error) => {
        this.failure ??= error
        this.tasks.delete(task)
      })
    })
    const stopDetached = transport.onEvent('Target.detachedFromTarget', (params) => {
      if (typeof params.sessionId !== 'string') return
      const sessionId = params.sessionId
      this.sessions.delete(sessionId)
      this.fetchSessions.delete(sessionId)
      this.cacheSessions.delete(sessionId)
      this.uncertain.delete(sessionId)
    })
    this.stop = () => { stopPaused(); stopDetached() }
  }

  async update(request: Extract<BrowserUtilityRequest, { kind: 'intercept' }>): Promise<Record<string, unknown>> {
    const rules: unknown = typeof request.rules === 'string' ? JSON.parse(request.rules) : request.rules
    if (rules !== undefined) validateRules(rules)
    if (request.clear !== undefined && request.clear !== true) throw interceptError('IAB_INTERCEPT_CLEAR_INVALID', 'Interception clear must be true when provided')
    if (request.cacheBypass !== undefined && typeof request.cacheBypass !== 'boolean') throw interceptError('IAB_INTERCEPT_CACHE_INVALID', 'Interception cacheBypass must be a boolean')
    this.assertCurrent()
    await this.settle()
    if (request.clear === true || rules !== undefined || request.cacheBypass !== undefined) {
      const previous = this.policy
      const next: Policy = {
        rules: request.clear === true ? [] : rules === undefined ? previous.rules : copyRules(rules as BrowserInterceptRule[]),
        cacheBypass: request.cacheBypass ?? previous.cacheBypass,
      }
      const sessionIds = new Set([undefined, ...(await this.transport.frames()).filter((frame) => frame.oopif === true && frame.sessionId !== undefined).map((frame) => frame.sessionId)])
      this.assertCurrent()
      this.staged = next
      try {
        for (const sessionId of sessionIds) await this.apply(next, sessionId)
        await this.settle()
        this.assertCurrent()
        this.policy = next
      } catch (error) {
        this.staged = undefined
        const failures: unknown[] = [error]
        // Restore even a partially acknowledged setup; never replay a paused request.
        if (this.failure === undefined && !this.closing) {
          for (const sessionId of this.sessions.keys()) {
            try { await this.apply(previous, sessionId, true) }
            catch (restoreError) { failures.push(restoreError) }
          }
        }
        if (failures.length > 1) {
          const failure = aggregateFailure(failures, 'Interception setup and policy restoration failed')
          this.failure ??= failure
          throw failure
        }
        throw error
      } finally { this.staged = undefined }
    }
    const enabled = this.policy.rules.length > 0 && this.sessions.get(undefined) === this.policy
    return { rules: copyRules(this.policy.rules), cacheBypass: this.policy.cacheBypass, enabled, ...(enabled ? { note: 'intercept rules must be re-applied after navigation' } : {}) }
  }

  async configureSession(sessionId?: string): Promise<void> {
    this.assertCurrent()
    const policy = this.staged ?? this.policy
    if (this.sessions.get(sessionId) === policy) return
    try { await this.apply(policy, sessionId) }
    catch (error) {
      const failures: unknown[] = [error]
      try { await this.resetSession(sessionId) }
      catch (cleanupError) { failures.push(cleanupError) }
      if (failures.length > 1) {
        const failure = aggregateFailure(failures, 'Interception session setup and cleanup failed')
        this.failure ??= failure
        throw failure
      }
      throw error
    }
  }

  async settle(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks])
    if (this.failure !== undefined) throw this.failure
  }

  dispose(native = true): Promise<void> {
    if (this.disposal) return this.disposal
    this.closing = true
    this.destroyed = !native
    this.disposal = this.finishDispose(native)
    return this.disposal
  }

  private assertCurrent(): void {
    this.transport.assertCurrent()
    if (this.closing) throw interceptError('IAB_INTERCEPT_DISPOSED', 'Native interception owner is disposed')
    if (this.failure !== undefined) throw this.failure
  }

  private async apply(policy: Policy, sessionId: string | undefined, restore = false): Promise<void> {
    if (!restore) this.assertCurrent()
    const previous = this.sessions.get(sessionId)
    this.sessions.set(sessionId, undefined)
    const fetchChanged = Boolean(policy.rules.length) !== Boolean(previous?.rules.length)
    if ((fetchChanged || previous === undefined) && (policy.rules.length > 0 || this.fetchSessions.has(sessionId))) {
      if (policy.rules.length) {
        this.fetchSessions.add(sessionId)
        await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId)
      } else {
        await this.send('Fetch.disable', undefined, sessionId)
        this.fetchSessions.delete(sessionId)
      }
    }
    if (!restore) this.assertCurrent()
    if (policy.cacheBypass !== previous?.cacheBypass && (policy.cacheBypass || this.cacheSessions.has(sessionId))) {
      if (policy.cacheBypass) this.cacheSessions.add(sessionId)
      await this.send('Network.setCacheDisabled', { cacheDisabled: policy.cacheBypass }, sessionId)
      if (!policy.cacheBypass) this.cacheSessions.delete(sessionId)
    }
    if (!restore) this.assertCurrent()
    this.sessions.set(sessionId, policy)
  }

  private async send(method: string, params: Record<string, unknown> | undefined, sessionId: string | undefined): Promise<void> {
    const command = JSON.stringify([method, params])
    if (this.uncertain.get(sessionId)?.has(command)) throw Object.assign(interceptError('IAB_CDP_OUTCOME_UNKNOWN', `Interception command outcome is unknown; it will not be repeated: ${method}`), { errorDetail: { code: 'IAB_CDP_OUTCOME_UNKNOWN', outcome: 'unknown', retryable: false } })
    try { await this.transport.send(method, params, sessionId) }
    catch (error) {
      const { message, errorDetail } = readRelayError(error)
      if (errorDetail?.outcome === 'unknown' || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) || /timeout|timed out|deadline|cancel|abort/i.test(`${errorDetail?.code ?? ''} ${message}`)) {
        let commands = this.uncertain.get(sessionId)
        if (!commands) this.uncertain.set(sessionId, commands = new Set())
        commands.add(command)
      }
      throw error
    }
  }

  private async resolvePaused(params: Record<string, unknown>, sessionId?: string): Promise<void> {
    if (this.destroyed) return
    try {
      const requestId = params.requestId
      if (typeof requestId !== 'string' || !requestId) throw interceptError('IAB_INTERCEPT_REQUEST_INVALID', 'Native intercepted request has no requestId')
      const resolution = resolveIntercept(this.closing || this.failure !== undefined ? [] : (this.staged ?? this.policy).rules, params)
      // The persistent transport checks the live claim, not the installing invocation.
      await this.transport.send(resolution.method, { ...resolution.params, requestId }, sessionId)
    } catch (error) {
      const detail = readRelayError(error).errorDetail
      if (detail?.outcome === 'unknown') this.failure ??= error
      else this.failure ??= Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), { errorDetail: { ...detail, code: 'IAB_INTERCEPT_SETTLEMENT_FAILED', outcome: 'unknown', retryable: false } })
      if (!this.destroyed) {
        try { await this.reset() }
        catch (cleanupError) {
          const failure = aggregateFailure([this.failure, cleanupError], 'Intercepted request settlement and cleanup failed')
          this.failure = failure
          throw failure
        }
      }
      throw error
    }
  }

  private async resetSession(sessionId: string | undefined): Promise<void> {
    const failures: unknown[] = []
    if (this.fetchSessions.has(sessionId)) {
      try {
        await this.send('Fetch.disable', undefined, sessionId)
        this.fetchSessions.delete(sessionId)
      } catch (error) { failures.push(error) }
    }
    if (this.cacheSessions.has(sessionId)) {
      try {
        await this.send('Network.setCacheDisabled', { cacheDisabled: false }, sessionId)
        this.cacheSessions.delete(sessionId)
      } catch (error) { failures.push(error) }
    }
    this.sessions.delete(sessionId)
    if (failures.length > 1) throw aggregateFailure(failures, 'Interception session cleanup failed')
    if (failures.length) throw failures[0]
  }

  private reset(): Promise<void> {
    // Share the one cleanup attempt, including its unknown outcome; do not retry it.
    return this.resetTask ??= (async () => {
      const failures: unknown[] = []
      for (const sessionId of new Set([...this.fetchSessions, ...this.cacheSessions])) {
        try { await this.resetSession(sessionId) }
        catch (error) { failures.push(error) }
      }
      if (failures.length > 1) throw aggregateFailure(failures, 'Interception cleanup failed')
      if (failures.length) throw failures[0]
    })()
  }

  private async finishDispose(native: boolean): Promise<void> {
    const failures: unknown[] = []
    try {
      try { await this.settle() }
      catch (error) { failures.push(error) }
      if (native) {
        try { await this.reset() }
        catch (error) { if (!failures.includes(error)) failures.push(error) }
      }
      try { await this.settle() }
      catch (error) { if (!failures.includes(error)) failures.push(error) }
    } finally {
      this.stop()
      this.sessions.clear()
      this.fetchSessions.clear()
      this.cacheSessions.clear()
      this.uncertain.clear()
      this.policy = { rules: [], cacheBypass: false }
      this.staged = undefined
    }
    if (failures.length > 1) throw aggregateFailure(failures, 'Interception disposal failed')
    if (failures.length) throw failures[0]
  }
}

function aggregateFailure(errors: unknown[], message: string): AggregateError {
  const failure = new AggregateError(errors, message, { cause: errors[0] })
  for (const error of errors) {
    const detail = readRelayError(error).errorDetail
    if (detail?.outcome === 'unknown') return Object.assign(failure, { errorDetail: { ...detail, message, outcome: 'unknown', retryable: false } })
  }
  return failure
}

function interceptError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function copyRules(rules: BrowserInterceptRule[]): BrowserInterceptRule[] {
  return rules.map((rule) => ({ ...rule, ...(rule.headers ? { headers: { ...rule.headers } } : {}) }))
}

function validateRules(value: unknown): asserts value is BrowserInterceptRule[] {
  if (!Array.isArray(value) || value.length > 50) throw interceptError('IAB_INTERCEPT_RULES_INVALID', 'Interception rules must be an array of at most 50 rules')
  for (const rule of value) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || typeof rule.pattern !== 'string' || !rule.pattern.trim() || rule.pattern.length > 512 || !['block', 'mock', 'modify', 'continue'].includes(rule.action)) throw interceptError('IAB_INTERCEPT_RULE_INVALID', 'Each rule requires a nonempty pattern of at most 512 characters and valid action')
    if (rule.match !== undefined && rule.match !== 'substring' && rule.match !== 'glob') throw interceptError('IAB_INTERCEPT_MATCH_INVALID', 'Interception match must be substring or glob')
    if (rule.match === undefined && rule.pattern.length > 1 && rule.pattern.startsWith('/') && rule.pattern.endsWith('/')) throw interceptError('IAB_INTERCEPT_MATCH_INVALID', 'JavaScript regex is not supported; specify substring or glob explicitly')
    if (rule.method !== undefined && typeof rule.method !== 'string' || rule.contentType !== undefined && typeof rule.contentType !== 'string') throw interceptError('IAB_INTERCEPT_RULE_INVALID', 'Interception method and contentType must be strings')
    if (rule.status !== undefined && (!Number.isInteger(rule.status) || rule.status < 100 || rule.status > 599)) throw interceptError('IAB_INTERCEPT_STATUS_INVALID', 'Mock status must be between 100 and 599')
    if (rule.headers !== undefined && (!rule.headers || typeof rule.headers !== 'object' || Object.entries(rule.headers).some(([name, entry]) => name.includes('\r') || name.includes('\n') || typeof entry !== 'string' || entry.includes('\r') || entry.includes('\n')))) throw interceptError('IAB_INTERCEPT_HEADERS_INVALID', 'Interception headers must contain string values without newlines')
    if (rule.body !== undefined && typeof rule.body !== 'string') throw interceptError('IAB_INTERCEPT_BODY_INVALID', 'Interception body must be a string')
  }
}

function resolveIntercept(rules: readonly BrowserInterceptRule[], params: Record<string, unknown>): Resolution {
  const request = params.request as Record<string, unknown> | undefined
  const budget = { remaining: 1_000_000 }
  const rule = rules.find((candidate) => matchUrl(String(request?.url ?? ''), candidate, budget))
  if (!rule || rule.action === 'continue') return { method: 'Fetch.continueRequest', params: {} }
  if (rule.action === 'block') return { method: 'Fetch.failRequest', params: { errorReason: 'BlockedByClient' } }
  const headers = { ...(rule.headers ?? {}), ...(rule.contentType ? { 'Content-Type': rule.contentType } : {}) }
  if (rule.action === 'mock') return { method: 'Fetch.fulfillRequest', params: { responseCode: rule.status ?? 200, responseHeaders: headerEntries(headers), body: Buffer.from(rule.body ?? '').toString('base64') } }
  return { method: 'Fetch.continueRequest', params: { ...(rule.method ? { method: rule.method } : {}), ...(rule.headers ? { headers: headerEntries(rule.headers) } : {}) } }
}

function headerEntries(headers: Record<string, string>): { name: string; value: string }[] {
  const entries: { name: string; value: string }[] = [], seen = new Set<string>()
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    if (!seen.has(key)) { seen.add(key); entries.push({ name, value }) }
  }
  return entries
}

function matchUrl(url: string, rule: BrowserInterceptRule, budget: { remaining: number }): boolean {
  if (url.length > 65536 || budget.remaining <= 0) return false
  const pattern = rule.pattern
  if (rule.match !== 'glob') {
    budget.remaining -= url.length + pattern.length
    return budget.remaining >= 0 && url.includes(pattern)
  }
  let cursor = 0, offset = 0, star = -1, retry = 0
  while (offset < url.length) {
    if (--budget.remaining < 0) return false
    if (pattern[cursor] === '?' || pattern[cursor] === url[offset]) { cursor++; offset++ }
    else if (pattern[cursor] === '*') { star = cursor++; retry = offset }
    else if (star >= 0) { cursor = star + 1; offset = ++retry }
    else return false
  }
  while (pattern[cursor] === '*') { if (--budget.remaining < 0) return false; cursor++ }
  return cursor === pattern.length
}
