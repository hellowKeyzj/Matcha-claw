import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserActionInvocation, BrowserActionParams } from '../browser-action-contract.js'
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

export class IabBrowserClient {
  private readonly stopped = new AbortController()

  constructor(private readonly stateDir: string) {}

  stop(): void {
    this.stopped.abort(new Error('In-app browser backend stopped. The request was not replayed.'))
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
    const { sessionKey, agentId, workspaceDir, sessionId } = context
    const requestContext = { sessionKey, agentId, sessionId, ...(workspaceDir ? { workspaceDir } : {}) }
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
      const discovery = await readDiscovery(this.stateDir, signal)
      const body = JSON.stringify({ params, context: requestContext })
      signal.throwIfAborted()
      invocation.assertInvocationCurrent?.()
      const response = await fetch(`http://127.0.0.1:${discovery.port}/browser`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${discovery.token}` },
        body,
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
    } finally {
      clearTimeout(timer)
    }
  }
}
