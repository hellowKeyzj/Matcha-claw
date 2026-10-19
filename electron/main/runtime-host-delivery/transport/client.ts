import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { isSessionTraceEnabled, logSessionTrace, readTraceHeader } from './sessions/trace';

const LOOPBACK_ORIGIN = 'http://127.0.0.1';
const DECISION_TTL_MS = 30_000;
const ELECTRON_MAIN_PRINCIPAL = 'electron-main-local';
const DECISION_REVISION = '1';

export type LoopbackDecision = Readonly<{
  endpoint: string;
  scope: string;
  capability: string;
  subject: string;
  revision?: string;
}>;

export type LoopbackJsonRequest = Readonly<{
  port: number;
  path: string;
  issuer: RuntimeHostDeliveryIssuer;
  decision: LoopbackDecision;
  method: 'GET' | 'POST' | 'PUT';
  fetcher: typeof fetch;
  body?: unknown;
  query?: URLSearchParams;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  emptyContentLength?: boolean;
}>;

export type LoopbackJsonResponse = Readonly<{
  status: number;
  body: unknown;
}>;

export type LoopbackJsonDelivery =
  | Readonly<{ outcome: 'response'; response: LoopbackJsonResponse }>
  | Readonly<{ outcome: 'not-attempted' | 'unknown'; reason?: 'invalid_response' | 'observation_interrupted' }>;

export function loopbackUrl(
  port: number,
  path: string,
  query?: URLSearchParams,
): string {
  const suffix = query && query.size > 0 ? `?${query}` : '';
  return `${LOOPBACK_ORIGIN}:${port}${path}${suffix}`;
}

export function decisionHeaders(
  issuer: RuntimeHostDeliveryIssuer,
  decision: LoopbackDecision,
): Readonly<Record<'Authorization', string>> {
  return {
    Authorization: `Bearer ${issuer.signDecision({
      principal: ELECTRON_MAIN_PRINCIPAL,
      endpoint: decision.endpoint,
      scope: decision.scope,
      capability: decision.capability,
      subject: decision.subject,
      expiresAt: Date.now() + DECISION_TTL_MS,
      revision: decision.revision ?? DECISION_REVISION,
    })}`,
  };
}

export async function sendLoopbackJson(
  request: LoopbackJsonRequest,
): Promise<LoopbackJsonResponse | null> {
  const delivery = await sendLoopbackJsonDelivery(request);
  return delivery.outcome === 'response' ? delivery.response : null;
}

export async function sendLoopbackJsonDelivery(
  request: LoopbackJsonRequest,
): Promise<LoopbackJsonDelivery> {
  const timeout = request.timeoutMs === undefined
    ? undefined
    : createRequestTimeout(request.timeoutMs, request.signal);
  const traceId = isSessionTraceEnabled()
    && request.path === '/api/skills/capability/execute'
    && request.decision.capability === 'clawhub.openPath'
    ? readTraceHeader(request.headers ?? {}) : null;
  let attempted = false;
  let phase = 'prepare';
  try {
    const url = loopbackUrl(request.port, request.path, request.query);
    const init = {
      method: request.method,
      headers: {
        ...decisionHeaders(request.issuer, request.decision),
        ...(request.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        ...(request.emptyContentLength ? { 'Content-Length': '0' } : {}),
        ...request.headers,
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: timeout?.signal ?? request.signal,
    };
    attempted = true;
    phase = 'fetch';
    logSessionTrace('skill.open-path.loopback.dispatch', traceId);
    const response = await request.fetcher(url, init);
    logSessionTrace('skill.open-path.loopback.headers', traceId, () => ({ status: response.status }));
    phase = 'decode-response';
    return { outcome: 'response', response: { status: response.status, body: await response.json() } };
  } catch (error) {
    logSessionTrace('skill.open-path.loopback.failed', traceId, () => ({
      phase,
      attempted,
      category: error instanceof SyntaxError ? 'invalid-json'
        : error instanceof Error && error.name === 'AbortError' ? 'aborted'
        : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'transport-error',
    }));
    const reason = phase === 'decode-response' && error instanceof SyntaxError ? 'invalid_response'
      : error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
        ? 'observation_interrupted' : undefined;
    return { outcome: attempted ? 'unknown' : 'not-attempted', ...(reason ? { reason } : {}) };
  } finally {
    timeout?.close();
  }
}

function createRequestTimeout(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Readonly<{ signal: AbortSignal; close: () => void }> {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

export function isJsonValue(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, seen));
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null)
      && Object.values(value).every((entry) => isJsonValue(entry, seen));
  } finally {
    seen.delete(value);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export function isBoundedText(value: unknown, maxLength = 4096): value is string {
  return typeof value === 'string' && value.length <= maxLength && !value.includes('\0');
}

export function isNonEmptyBoundedText(value: unknown, maxLength = 4096): value is string {
  return isBoundedText(value, maxLength) && value.length > 0;
}

export function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}
