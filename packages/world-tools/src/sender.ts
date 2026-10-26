import { createHash, createHmac, createSecretKey, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { OpenClawPluginApi, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry'
import { decodeResponse } from './schema.js'

const ENDPOINT = '/api/world/peer'
const LIFETIME_MS = 60_000

type AcceptedCorrelation = Readonly<{
  bindingId: string
  acceptedRequestId: string
  acceptedRunId: string
  acceptedInputId: string
  contentBudgetDigest: string
  nativeAttemptId: string
  nativeInstanceId: string
}>

type ToolContext = {
  agentId?: string
  sessionKey?: string
  sessionId?: string
  runId?: string
  toolCallId?: string
  toolName: string
  worldInvestigation?: AcceptedCorrelation
  abortSignal?: AbortSignal
  requester?: {
    channel?: string
    accountId?: string
    senderId?: string
    senderIsOwner?: boolean
    roleIds?: readonly string[]
  }
}
type Admission = {
  context: ToolContext
  digest: string
  expiresAt: number
  cleanup: () => void
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  throw new Error('World input must contain only JSON values')
}

function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function validCorrelation(value: unknown): value is AcceptedCorrelation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const fields = ['bindingId', 'acceptedRequestId', 'acceptedRunId', 'acceptedInputId',
    'contentBudgetDigest', 'nativeAttemptId', 'nativeInstanceId']
  const record = value as Record<string, unknown>
  return Object.keys(record).length === fields.length
    && fields.every(key => typeof record[key] === 'string' && record[key].length > 0
      && record[key].length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(record[key]))
    && /^sha256:[a-f0-9]{64}$/.test(record.contentBudgetDigest as string)
}

let signingMaterial: ReturnType<typeof material> | undefined

function material() {
  const location = process.env.MATCHA_WORLD_PROJECTION
  delete process.env.MATCHA_WORLD_PROJECTION
  if (!location || !path.isAbsolute(location)) throw new Error('World private projection is unavailable')
  const file = openSync(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(file)
    if (!stat.isFile() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('World private projection is invalid')
    }
    const bytes = readFileSync(file)
    try {
      const value = JSON.parse(bytes.toString('utf8')) as { endpoint: string; runtimeInstance: string; signingKey: string }
      const endpoint = new URL(value.endpoint)
      if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port
          || endpoint.pathname !== ENDPOINT || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
          || typeof value.runtimeInstance !== 'string' || !value.runtimeInstance) {
        throw new Error('World private endpoint is invalid')
      }
      const key = Buffer.from(value.signingKey, 'base64url')
      if (key.length !== 32 || key.toString('base64url') !== value.signingKey) throw new Error('World private signing material is invalid')
      const signingKey = createSecretKey(key)
      key.fill(0)
      return { endpoint, runtimeInstance: value.runtimeInstance, signingKey }
    } finally {
      bytes.fill(0)
    }
  } finally {
    closeSync(file)
  }
}

/** Only the native hook may create admission; no exported sign(context, JSON) surface exists. */
export function createSender(api: OpenClawPluginApi, toolNames: ReadonlySet<string>) {
  const admissions = new Map<string, Admission>()
  api.on('before_tool_call', (event, context) => {
    if (!toolNames.has(event.toolName)) return
    if (!context.agentId || !context.sessionKey || !context.sessionId || !context.runId || !context.toolCallId
        || context.toolName !== event.toolName || event.runId !== context.runId || event.toolCallId !== context.toolCallId
        || !context.abortSignal || context.abortSignal.aborted || admissions.has(context.toolCallId)) {
      return { block: true, blockReason: 'World requires a current native execution context' }
    }
    const investigation = (context as typeof context & { worldInvestigation?: unknown }).worldInvestigation
    if (investigation !== undefined && !validCorrelation(investigation)) {
      return { block: true, blockReason: 'World accepted-input execution context is invalid' }
    }
    const toolCallId = context.toolCallId
    const signal = context.abortSignal
    const clear = () => { clearTimeout(timer); admissions.delete(toolCallId); signal.removeEventListener('abort', clear) }
    const timer = setTimeout(clear, LIFETIME_MS)
    timer.unref()
    signal.addEventListener('abort', clear, { once: true })
    admissions.set(toolCallId, {
      context: {
        agentId: context.agentId, sessionKey: context.sessionKey, sessionId: context.sessionId,
        runId: context.runId, toolCallId, toolName: event.toolName, abortSignal: signal,
        worldInvestigation: investigation === undefined ? undefined : Object.freeze({ ...investigation }),
        requester: context.requester ? {
          channel: context.requester.channel, accountId: context.requester.accountId,
          senderId: context.requester.senderId, senderIsOwner: context.requester.senderIsOwner,
          roleIds: context.requester.roleIds ? [...context.requester.roleIds] : undefined,
        } : undefined,
      },
      digest: digest(canonical(event.params)),
      expiresAt: Date.now() + LIFETIME_MS,
      cleanup: clear,
    })
  })

  api.on('after_tool_call', (event) => {
    if (event.toolCallId) admissions.get(event.toolCallId)?.cleanup()
  })

  return (factory: OpenClawPluginToolContext, toolName: string, operation: string) =>
    async (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
      const admitted = admissions.get(toolCallId)
      if (!admitted) throw new Error('World native execution admission is missing')
      admitted.cleanup()
      const context = admitted.context
      if (context.toolName !== toolName || context.agentId !== factory.agentId
          || context.sessionKey !== factory.sessionKey || context.sessionId !== factory.sessionId
          || !factory.workspaceDir || !path.isAbsolute(factory.workspaceDir) || typeof factory.sandboxed !== 'boolean'
          || admitted.digest !== digest(canonical(params)) || admitted.expiresAt <= Date.now()) {
        throw new Error('World native execution binding changed')
      }
      const lifetime = signal ? AbortSignal.any([signal, context.abortSignal!]) : context.abortSignal!
      lifetime.throwIfAborted()
      if (Object.keys(params).some(key => !['world', 'requestId', 'request'].includes(key))
          || !params.world || typeof params.requestId !== 'string' || !params.request) {
        throw new Error('World tool request is invalid')
      }
      const request = Buffer.from(canonical({ world: params.world, requestId: params.requestId, operation: { kind: operation, request: params.request } }))
      if (request.length > 1_048_576) throw new Error('World request is too large')
      const privateMaterial = signingMaterial ??= material()
      const now = Date.now()
      const proof = Buffer.from(JSON.stringify({
        audience: 'matcha.world.openclaw.v1', runtimeInstance: privateMaterial.runtimeInstance,
        endpoint: ENDPOINT, toolName, requestDigest: digest(request), nonce: randomUUID(),
        issuedAt: now, expiresAt: Math.min(admitted.expiresAt, now + LIFETIME_MS),
        native: {
          agentId: context.agentId, sessionKey: context.sessionKey, sessionId: context.sessionId,
          runId: context.runId, toolCallId, workspace: factory.workspaceDir, sandboxed: factory.sandboxed,
          requester: context.requester,
          worldInvestigation: context.worldInvestigation,
        },
      }))
      const signature = createHmac('sha256', privateMaterial.signingKey).update(proof).digest('base64url')
      const response = await fetch(privateMaterial.endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ proof: proof.toString('base64url'), signature, request: request.toString('base64url') }),
        signal: AbortSignal.any([lifetime, AbortSignal.timeout(admitted.expiresAt - now)]),
      })
      const value: unknown = await response.json().catch(error => {
        if (error instanceof SyntaxError) throw new Error('World response is not valid JSON')
        throw error
      })
      const result = decodeResponse(operation, response.ok, value)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result }
    }
}
