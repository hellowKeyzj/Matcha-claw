import { PLUGIN_ID, type MediaErrorReason, type MediaGenerationErrorOptions } from './types.js'

export class MatchaClawMediaError extends Error {
  readonly reason: MediaErrorReason
  readonly provider?: string
  readonly model?: string
  readonly profileId?: string
  readonly status?: number
  readonly code?: string
  readonly rawError?: string

  constructor(message: string, options: MediaGenerationErrorOptions) {
    super(message, { cause: options.cause })
    this.name = 'FailoverError'
    this.reason = options.reason
    this.provider = options.provider ?? PLUGIN_ID
    this.model = options.model
    this.profileId = options.profileId
    this.status = options.status
    this.code = options.code
    this.rawError = options.rawError ?? message
  }
}

export function protocolError(message: string, cause?: unknown): MatchaClawMediaError {
  return new MatchaClawMediaError(message, {
    reason: 'format',
    status: 400,
    code: 'matchaclaw_media_protocol',
    cause,
  })
}

export function modelNotFoundError(message: string, cause?: unknown): MatchaClawMediaError {
  return new MatchaClawMediaError(message, {
    reason: 'model_not_found',
    status: 404,
    code: 'matchaclaw_media_model_not_found',
    cause,
  })
}

export function authError(message: string, cause?: unknown): MatchaClawMediaError {
  return new MatchaClawMediaError(message, {
    reason: 'auth',
    status: 401,
    code: 'matchaclaw_media_auth',
    cause,
  })
}

export function timeoutError(message: string, cause?: unknown): MatchaClawMediaError {
  return new MatchaClawMediaError(message, {
    reason: 'timeout',
    status: 408,
    code: 'matchaclaw_media_timeout',
    cause,
  })
}

export function upstreamError(message: string, status?: number, cause?: unknown): MatchaClawMediaError {
  return new MatchaClawMediaError(message, {
    reason: classifyUpstreamStatus(status, message),
    status,
    code: 'matchaclaw_media_upstream',
    cause,
  })
}

export function classifyUnknownError(error: unknown): MatchaClawMediaError {
  if (error instanceof MatchaClawMediaError) return error
  const status = readErrorStatus(error)
  const message = error instanceof Error ? error.message : String(error)
  if (message.toLowerCase().includes('timeout')) {
    return timeoutError(message, error)
  }
  return upstreamError(message, status, error)
}

export function readErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const direct = error as Record<string, unknown>
  const status = direct.status ?? direct.statusCode
  if (typeof status === 'number') return status
  if (typeof status === 'string' && /^\d+$/.test(status)) return Number(status)
  return readErrorStatus(direct.cause)
}

function classifyUpstreamStatus(status: number | undefined, message: string): MediaErrorReason {
  const lower = message.toLowerCase()
  if (status === 401) return 'auth'
  if (status === 403) return 'auth_permanent'
  if (status === 402 || lower.includes('billing') || lower.includes('quota')) return 'billing'
  if (status === 404) return 'model_not_found'
  if (status === 408 || lower.includes('timeout')) return 'timeout'
  if (status === 429) return 'rate_limit'
  if (status && status >= 500) return 'overloaded'
  return 'format'
}
