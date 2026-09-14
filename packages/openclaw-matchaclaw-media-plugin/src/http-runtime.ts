import { fetchWithSsrFGuard, type SsrFPolicy } from 'openclaw/plugin-sdk/ssrf-runtime'
import { isRecord } from './config.js'

export type { SsrFPolicy }

const DEFAULT_GUARDED_HTTP_TIMEOUT_MS = 60_000
const ERROR_BODY_METADATA_LIMIT = 220
const ERROR_BODY_READ_LIMIT = 16 * 1024
const FORBIDDEN_HEADER_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export type PinnedDispatcherPolicy =
  | {
      mode: 'direct'
      connect?: Record<string, unknown>
      pinnedHostname?: { hostname: string; addresses: string[] }
    }
  | {
      mode: 'env-proxy'
      connect?: Record<string, unknown>
      proxyTls?: Record<string, unknown>
      pinnedHostname?: { hostname: string; addresses: string[] }
    }
  | {
      mode: 'explicit-proxy'
      proxyUrl: string
      allowPrivateProxy?: boolean
      proxyTls?: Record<string, unknown>
      pinnedHostname?: { hostname: string; addresses: string[] }
    }

export type GuardedFetchResult = {
  response: Response
  release: () => Promise<void>
}

export type FetchGuardOptions = {
  ssrfPolicy?: SsrFPolicy
  dispatcherPolicy?: PinnedDispatcherPolicy
  auditContext?: string
}

type PostJsonRequestParams = {
  url: string
  headers: Headers
  body: unknown
  timeoutMs?: number
  signal?: AbortSignal
  fetchFn: typeof fetch
  allowPrivateNetwork?: boolean
  ssrfPolicy?: SsrFPolicy
  dispatcherPolicy?: PinnedDispatcherPolicy
}

export class ProviderHttpError extends Error {
  readonly status: number
  readonly statusCode: number
  readonly code?: string
  readonly errorCode?: string
  readonly errorType?: string
  readonly errorBody?: string
  readonly requestId?: string

  constructor(message: string, params: {
    status: number
    code?: string
    type?: string
    body?: string
    requestId?: string
  }) {
    super(message)
    this.name = 'ProviderHttpError'
    this.status = params.status
    this.statusCode = params.status
    this.code = params.code
    this.errorCode = params.code
    this.errorType = params.type
    this.errorBody = params.body
    this.requestId = params.requestId
  }
}

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function normalizeHeaderKey(value: string): string {
  return value.trim().toLowerCase()
}

function mergeHeaders(...headerSets: Array<Record<string, string> | undefined>): Record<string, string> {
  const merged: Record<string, string> = Object.create(null)
  const keysByLowerName = new Map<string, string>()
  for (const headers of headerSets) {
    if (!headers) continue
    for (const [key, value] of Object.entries(headers)) {
      const normalizedKey = normalizeHeaderKey(key)
      if (!normalizedKey || FORBIDDEN_HEADER_KEYS.has(normalizedKey)) continue
      const previousKey = keysByLowerName.get(normalizedKey)
      if (previousKey && previousKey !== key) delete merged[previousKey]
      merged[key] = value
      keysByLowerName.set(normalizedKey, key)
    }
  }
  return merged
}

export function buildHeaders(defaults: Record<string, string>, overrides?: Record<string, string>): Headers {
  return new Headers(mergeHeaders(defaults, overrides))
}

export function normalizeBaseUrl(baseUrl: string | undefined, fallback?: string): string | undefined {
  const raw = baseUrl?.trim() || fallback?.trim()
  return raw ? raw.replace(/\/+$/, '') : undefined
}

function resolveGuardedHttpTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_GUARDED_HTTP_TIMEOUT_MS
}

function mergeSsrfPolicy(params: {
  ssrfPolicy?: SsrFPolicy
  allowPrivateNetwork?: boolean
}): SsrFPolicy | undefined {
  if (!params.ssrfPolicy) {
    return params.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined
  }
  if (!params.allowPrivateNetwork) return params.ssrfPolicy
  return { ...params.ssrfPolicy, allowPrivateNetwork: true }
}

export async function fetchWithTimeoutGuarded(
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
  fetchFn: typeof fetch,
  options?: FetchGuardOptions,
): Promise<GuardedFetchResult> {
  const result = await fetchWithSsrFGuard({
    url,
    fetchImpl: fetchFn,
    init,
    timeoutMs: resolveGuardedHttpTimeoutMs(timeoutMs),
    policy: options?.ssrfPolicy,
    dispatcherPolicy: options?.dispatcherPolicy,
    auditContext: options?.auditContext,
  })
  return {
    response: result.response,
    release: result.release,
  }
}

function resolveGuardedOptions(params: PostJsonRequestParams): FetchGuardOptions | undefined {
  const ssrfPolicy = mergeSsrfPolicy(params)
  if (!ssrfPolicy && !params.dispatcherPolicy) return undefined
  return {
    ...(ssrfPolicy ? { ssrfPolicy } : {}),
    ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
  }
}

export async function postJsonRequest(params: PostJsonRequestParams): Promise<GuardedFetchResult> {
  return await fetchWithTimeoutGuarded(
    params.url,
    {
      method: 'POST',
      headers: params.headers,
      body: JSON.stringify(params.body),
      ...(params.signal ? { signal: params.signal } : {}),
    },
    params.timeoutMs,
    params.fetchFn,
    resolveGuardedOptions(params),
  )
}

function truncateErrorDetail(detail: string, limit = ERROR_BODY_METADATA_LIMIT): string {
  return detail.length <= limit ? detail : `${detail.slice(0, Math.max(0, limit - 1))}…`
}

async function readResponseTextLimited(response: Response, limitBytes = ERROR_BODY_READ_LIMIT): Promise<string> {
  if (limitBytes <= 0) return ''
  const reader = response.body?.getReader()
  if (!reader) return await response.text()
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < limitBytes) {
    const { done, value } = await reader.read()
    if (done || !value) break
    const remaining = limitBytes - total
    const chunk = value.length > remaining ? value.slice(0, remaining) : value
    chunks.push(chunk)
    total += chunk.length
    if (value.length > remaining) break
  }
  await reader.cancel().catch(() => undefined)
  return new TextDecoder().decode(Buffer.concat(chunks))
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/(api[_-]?key|token|authorization|access[_-]?token)(["'\s:=]+)([^"'\s,}]+)/gi, '$1$2<redacted>')
}

function formatProviderErrorPayload(payload: unknown): string | undefined {
  const root = isRecord(payload) ? payload : undefined
  const detailObject = isRecord(root?.detail) ? root.detail : undefined
  const subject = isRecord(root?.error) ? root.error : detailObject ?? root
  if (!subject) return undefined
  const errorDescription = trimToUndefined(subject.error_description) ?? trimToUndefined(root?.error_description)
  const oauthCode = errorDescription ? trimToUndefined(root?.error) : undefined
  const message =
    trimToUndefined(subject.message) ??
    trimToUndefined(subject.detail) ??
    errorDescription ??
    trimToUndefined(root?.message) ??
    trimToUndefined(root?.error) ??
    trimToUndefined(root?.detail)
  const type = trimToUndefined(subject.type)
  const code = trimToUndefined(subject.code) ?? trimToUndefined(subject.status) ?? oauthCode
  const metadata = [type ? `type=${type}` : undefined, code ? `code=${code}` : undefined]
    .filter((value): value is string => Boolean(value))
    .join(', ')
  if (message && metadata) return `${truncateErrorDetail(message)} [${metadata}]`
  if (message) return truncateErrorDetail(message)
  return metadata ? `[${metadata}]` : undefined
}

function extractProviderRequestId(response: Response): string | undefined {
  return trimToUndefined(response.headers.get('x-request-id')) ?? trimToUndefined(response.headers.get('request-id'))
}

async function extractProviderErrorInfo(response: Response, requestHeaders?: HeadersInit): Promise<{
  detail?: string
  code?: string
  type?: string
  body?: string
  requestId?: string
}> {
  const requestHeaderValues = requestHeaders ? [...new Headers(requestHeaders).values()] : []
  const redactRequestHeaders = (value: string) => requestHeaderValues.reduce(
    (current, headerValue) => headerValue ? current.replaceAll(headerValue, '<redacted>') : current,
    value,
  )
  const rawBody = trimToUndefined(await readResponseTextLimited(response).catch(() => ''))
  const requestId = trimToUndefined(redactRequestHeaders(extractProviderRequestId(response) ?? ''))
  if (!rawBody) return requestId ? { requestId } : {}
  const safeBody = redactRequestHeaders(redactSensitiveText(rawBody))
  const body = truncateErrorDetail(safeBody)
  try {
    const payload = JSON.parse(safeBody)
    const detail = formatProviderErrorPayload(payload)
    const root = isRecord(payload) ? payload : undefined
    const detailObject = isRecord(root?.detail) ? root.detail : undefined
    const subject = isRecord(root?.error) ? root.error : detailObject ?? root
    const errorDescription = isRecord(subject) ? trimToUndefined(subject.error_description) : undefined
    const code = isRecord(subject)
      ? trimToUndefined(subject.code) ?? trimToUndefined(subject.status) ?? (errorDescription ? trimToUndefined(root?.error) : undefined)
      : undefined
    const type = isRecord(subject) ? trimToUndefined(subject.type) : undefined
    return {
      detail: detail ? redactSensitiveText(detail) : body,
      ...(code ? { code } : {}),
      ...(type ? { type } : {}),
      body,
      ...(requestId ? { requestId } : {}),
    }
  } catch {
    return {
      detail: body,
      body,
      ...(requestId ? { requestId } : {}),
    }
  }
}

export async function assertOkOrThrowHttpError(
  response: Response,
  label: string,
  options?: { requestHeaders?: HeadersInit },
): Promise<void> {
  if (response.ok) return
  const info = await extractProviderErrorInfo(response, options?.requestHeaders)
  const message = `${label} (HTTP ${response.status})${info.detail ? `: ${info.detail}` : ''}${info.requestId ? ` [request_id=${info.requestId}]` : ''}`
  throw new ProviderHttpError(message, {
    status: response.status,
    ...(info.code ? { code: info.code } : {}),
    ...(info.type ? { type: info.type } : {}),
    ...(info.body ? { body: info.body } : {}),
    ...(info.requestId ? { requestId: info.requestId } : {}),
  })
}
