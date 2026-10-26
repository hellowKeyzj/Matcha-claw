import { AsyncLocalStorage } from 'node:async_hooks'
import {
  createHash,
  createHmac,
  createSecretKey,
  randomUUID,
} from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs'
import path from 'node:path'
import type { ToolUseContext } from '../Tool.js'
import { getSessionId } from '../bootstrap/state.js'
import { getCwd } from '../utils/cwd.js'
import { currentInvestigation, type AcceptedCorrelation } from './investigation.js'
import { decodeResponse } from './schema.js'

const ENDPOINT = '/api/world/peer'
const LIFETIME_MS = 60_000

type LaunchContext = {
  agentId: string
  sessionId: string
  instanceId: string
  workspace: string
}
type Admission = {
  toolName: string
  digest: string
  runId: string
  toolCallId: string
  workspace: string
  signal: AbortSignal
  expiresAt: number
  investigation: AcceptedCorrelation | undefined
  consumed: boolean
}
const admissions = new AsyncLocalStorage<Admission>()

function material() {
  const location = process.env.MATCHA_WORLD_PROJECTION
  const rawContext = process.env.MATCHA_WORLD_CONTEXT
  delete process.env.MATCHA_WORLD_PROJECTION
  delete process.env.MATCHA_WORLD_CONTEXT
  if (!location && !rawContext) return undefined
  if (
    !location ||
    !path.isAbsolute(location) ||
    !rawContext ||
    rawContext.length > 65_536
  ) {
    throw new Error('World private launch projection is invalid')
  }
  const context = JSON.parse(rawContext) as LaunchContext
  if (
    !context ||
    Object.keys(context).some(
      key => !['agentId', 'sessionId', 'instanceId', 'workspace'].includes(key),
    ) ||
    typeof context.agentId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(context.agentId) ||
    !uuid(context.sessionId) ||
    !uuid(context.instanceId) ||
    typeof context.workspace !== 'string' ||
    !path.isAbsolute(context.workspace)
  ) {
    throw new Error('World native launch context is invalid')
  }
  const file = openSync(
    location,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const stat = fstatSync(file)
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error('World private projection is invalid')
    }
    const bytes = readFileSync(file)
    try {
      const value = JSON.parse(bytes.toString('utf8')) as {
        endpoint: string
        runtimeInstance: string
        signingKey: string
      }
      const endpoint = new URL(value.endpoint)
      if (
        Object.keys(value).some(
          key => !['endpoint', 'runtimeInstance', 'signingKey'].includes(key),
        ) ||
        endpoint.protocol !== 'http:' ||
        endpoint.hostname !== '127.0.0.1' ||
        !endpoint.port ||
        endpoint.pathname !== ENDPOINT ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        typeof value.runtimeInstance !== 'string' ||
        !value.runtimeInstance ||
        value.runtimeInstance.length > 256 ||
        typeof value.signingKey !== 'string'
      )
        throw new Error('World private endpoint is invalid')
      const key = Buffer.from(value.signingKey, 'base64url')
      try {
        if (key.length !== 32 || key.toString('base64url') !== value.signingKey)
          throw new Error('World private signing material is invalid')
        return {
          endpoint,
          runtimeInstance: value.runtimeInstance,
          signingKey: createSecretKey(key),
          context,
        }
      } finally {
        key.fill(0)
      }
    } finally {
      bytes.fill(0)
    }
  } finally {
    closeSync(file)
  }
}

// Consume and remove private launch variables before any native tool can spawn a child.
const privateMaterial = material()
export function available(): boolean {
  return privateMaterial !== undefined
}

function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (
    typeof value === 'object' &&
    value &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort()
      .map(
        key =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  }
  throw new Error('World input must contain only JSON values')
}
function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

/** Called only at the canonical permission-allow site for an exact registered World Tool. */
export function admitted<T>(
  toolName: string,
  input: unknown,
  context: ToolUseContext,
  invoke: () => T,
): T {
  if (
    !privateMaterial ||
    context.agentId ||
    getSessionId() !== privateMaterial.context.sessionId ||
    !uuid(context.queryTracking?.chainId) ||
    !context.toolUseId ||
    context.abortController.signal.aborted ||
    path.resolve(getCwd()) !== path.resolve(privateMaterial.context.workspace)
  ) {
    throw new Error('World requires a current native root execution context')
  }
  return admissions.run(
    {
      toolName,
      digest: digest(canonical(input)),
      runId: context.queryTracking.chainId,
      toolCallId: context.toolUseId,
      workspace: getCwd(),
      signal: context.abortController.signal,
      expiresAt: Date.now() + LIFETIME_MS,
      investigation: currentInvestigation(),
      consumed: false,
    },
    invoke,
  )
}

export async function execute(
  toolName: string,
  operation: string,
  input: unknown,
) {
  const admission = admissions.getStore()
  if (
    !privateMaterial ||
    !admission ||
    admission.consumed ||
    admission.toolName !== toolName ||
    admission.expiresAt <= Date.now() ||
    admission.investigation !== currentInvestigation() ||
    (admission.investigation !== undefined &&
      admission.investigation.nativeInstanceId !== privateMaterial.context.instanceId) ||
    digest(canonical(input)) !== admission.digest
  ) {
    throw new Error('World native execution admission is missing or changed')
  }
  admission.consumed = true
  admission.signal.throwIfAborted()
  const params = input as {
    world: unknown
    requestId: string
    request: unknown
  }
  const request = Buffer.from(
    canonical({
      world: params.world,
      requestId: params.requestId,
      operation: { kind: operation, request: params.request },
    }),
  )
  if (request.length > 1_048_576) throw new Error('World request is too large')
  const now = Date.now()
  const proof = Buffer.from(
    JSON.stringify({
      audience: 'matcha.world.matcha-agent.v1',
      runtimeInstance: privateMaterial.runtimeInstance,
      endpoint: ENDPOINT,
      toolName,
      requestDigest: digest(request),
      nonce: randomUUID(),
      issuedAt: now,
      expiresAt: admission.expiresAt,
      native: {
        agentId: privateMaterial.context.agentId,
        sessionId: privateMaterial.context.sessionId,
        instanceId: privateMaterial.context.instanceId,
        runId: admission.runId,
        toolCallId: admission.toolCallId,
        workspace: admission.workspace,
        sandboxed: false,
        worldInvestigation: admission.investigation,
      },
    }),
  )
  const signature = createHmac('sha256', privateMaterial.signingKey)
    .update(proof)
    .digest('base64url')
  const response = await fetch(privateMaterial.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    redirect: 'error',
    body: JSON.stringify({
      proof: proof.toString('base64url'),
      signature,
      request: request.toString('base64url'),
    }),
    signal: AbortSignal.any([
      admission.signal,
      AbortSignal.timeout(Math.max(1, admission.expiresAt - now)),
    ]),
  })
  const value: unknown = await response.json().catch(error => {
    if (error instanceof SyntaxError)
      throw new Error('World response is not valid JSON')
    throw error
  })
  return decodeResponse(operation, response.ok, value)
}
