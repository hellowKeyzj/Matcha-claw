import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserActionContext, BrowserActionInvocation, BrowserActionParams, BrowserSessionCleanup } from '../browser-action-contract.js'
import { resolveRelayPluginStatePath } from '../relay/paths.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

async function readDiscovery(stateDir: string, signal: AbortSignal) {
  try {
    const descriptor: unknown = JSON.parse(await fs.readFile(resolveRelayPluginStatePath('iab.json', stateDir), { encoding: 'utf8', signal }))
    if (!isRecord(descriptor) || !isNonEmptyString(descriptor.discovery)
      || !path.isAbsolute(descriptor.discovery) || /^[/\\]{2}/.test(descriptor.discovery)
      || descriptor.discovery.includes('\0')) {
      throw new Error('invalid descriptor')
    }
    const discovery: unknown = JSON.parse(await fs.readFile(descriptor.discovery, { encoding: 'utf8', signal }))
    if (!isRecord(discovery) || !isNonEmptyString(discovery.identity)
      || typeof discovery.port !== 'number' || !Number.isInteger(discovery.port)
      || discovery.port < 1 || discovery.port > 65535
      || !isNonEmptyString(discovery.token) || /[\r\n]/.test(discovery.token)) {
      throw new Error('invalid discovery')
    }
    return { identity: discovery.identity, port: discovery.port, token: discovery.token }
  } catch {
    signal.throwIfAborted()
    throw new Error('In-app browser discovery is missing or invalid. Enable the in-app browser in Matcha and try again.')
  }
}

type Discovery = Awaited<ReturnType<typeof readDiscovery>>

function runKey(context: BrowserActionContext): string {
  return JSON.stringify([context.agentId, context.sessionKey, context.sessionId, context.runId])
}

function requestContext(context: BrowserActionContext): BrowserActionContext {
  const { sessionKey, agentId, workspaceDir, sessionId, runId } = context
  return { sessionKey, agentId, sessionId, ...(workspaceDir ? { workspaceDir } : {}), ...(runId ? { runId } : {}) }
}

export class IabBrowserClient {
  private readonly stopped = new AbortController()
  private readonly runs = new Map<string, { groupId: string; context: BrowserActionContext; discovery: Promise<Discovery> }>()

  constructor(private readonly stateDir: string) {}

  stop(): void {
    this.stopped.abort(new Error('In-app browser backend stopped. The request was not replayed.'))
    this.runs.clear()
  }

  async handleRequest(params: BrowserActionParams, invocation: BrowserActionInvocation = {}): Promise<Record<string, unknown>> {
    const context = invocation.context
    if (!context || !isNonEmptyString(context.sessionKey)) {
      throw new Error('In-app browser requires a trusted OpenClaw sessionKey; no current UI session or global owner is used.')
    }
    if (!isNonEmptyString(context.agentId)) {
      throw new Error('In-app browser requires a trusted OpenClaw agentId; model parameters cannot supply this identity.')
    }
    if (!isNonEmptyString(context.sessionId)) {
      throw new Error('In-app browser requires a trusted OpenClaw sessionId to verify the current session generation.')
    }
    const request = (params.action === 'act' || params.action === 'utility') ? params.request : undefined
    const timeoutMs = ('timeoutMs' in params ? params.timeoutMs : undefined)
      ?? request?.timeoutMs
      ?? (params.action === 'utility' && params.request?.kind === 'download' ? 60_000 : 30_000)
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new Error('In-app browser timeoutMs must be a positive number no greater than 2147483647.')
    }
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('In-app browser request timed out. Its outcome may be unknown; the request was not replayed.')), Math.ceil(timeoutMs))
    const signal = AbortSignal.any([
      this.stopped.signal,
      timeout.signal,
      ...(invocation.signal ? [invocation.signal] : []),
    ])
    try {
      signal.throwIfAborted()
      const key = context.runId ? runKey(context) : undefined
      let run = key ? this.runs.get(key) : undefined
      if (key && !run) {
        // Pin discovery independently of a tool cancellation; cleanup must reach the original Main.
        run = { groupId: context.sessionGroupId!, context: { ...context }, discovery: readDiscovery(this.stateDir, this.stopped.signal) }
        this.runs.set(key, run)
      }
      let target: Discovery
      try { target = await (run?.discovery ?? readDiscovery(this.stateDir, signal)) }
      catch (error) {
        if (key && this.runs.get(key) === run) this.runs.delete(key)
        throw error
      }
      signal.throwIfAborted()
      invocation.assertInvocationCurrent?.()
      return await this.post(target, '/browser', { params, context: requestContext(context) }, signal)
    } finally {
      clearTimeout(timer)
    }
  }

  async cleanupSession(request: BrowserSessionCleanup): Promise<void> {
    const key = runKey(request.context)
    const run = this.runs.get(key)
    const runs = request.scope === 'group'
      ? [...this.runs].filter(([, candidate]) => candidate.groupId === request.context.sessionGroupId)
      : run ? [[key, run] as const] : []
    if (!runs.length) return
    const signal = AbortSignal.any([this.stopped.signal, AbortSignal.timeout(30_000)])
    const outcomes = await Promise.allSettled(runs.map(async ([, candidate]) => {
      let target: Discovery
      try { target = await candidate.discovery }
      catch { return } // Discovery failed before this pin could post a browser request.
      const result = await this.post(target, '/browser/session-end', {
        context: requestContext(candidate.context), scope: request.scope,
      }, signal)
      if (result.released !== true) throw new Error('In-app browser session cleanup could not be confirmed.')
    }))
    const failures = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'In-app browser session cleanup could not be confirmed.')
    if (request.scope === 'group') {
      for (const [key, candidate] of runs) {
        if (this.runs.get(key) === candidate) this.runs.delete(key)
      }
    }
  }

  private async post(discovery: Discovery, route: string, payload: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    const response = await fetch(`http://127.0.0.1:${discovery.port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${discovery.token}` },
      body: JSON.stringify(payload),
      signal,
      redirect: 'error',
    })
    const envelope: unknown = await response.json()
    signal.throwIfAborted()
    if (isRecord(envelope) && !('result' in envelope) && isRecord(envelope.error)
      && isNonEmptyString(envelope.error.code) && typeof envelope.error.message === 'string') {
      return { ok: false, errorCode: envelope.error.code, error: envelope.error.message }
    }
    if (!response.ok || !isRecord(envelope) || 'error' in envelope || !isRecord(envelope.result)) {
      throw new Error('In-app browser returned an invalid response. The request was not replayed.')
    }
    return envelope.result
  }
}
