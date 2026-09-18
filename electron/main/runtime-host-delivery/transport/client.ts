import type { RuntimeHostDeliveryIssuer } from '../issuer';

const LOOPBACK_ORIGIN = 'http://127.0.0.1';
const DECISION_TTL_MS = 30_000;
const ELECTRON_MAIN_PRINCIPAL = 'electron-main-local';
const DECISION_REVISION = '1';

export type LoopbackDecision = Readonly<{
  endpoint: string;
  scope: string;
  capability: string;
  subject: string;
}>;

export type LoopbackJsonRequest = Readonly<{
  port: number;
  path: string;
  issuer: RuntimeHostDeliveryIssuer;
  decision: LoopbackDecision;
  method: 'GET' | 'POST';
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
      revision: DECISION_REVISION,
    })}`,
  };
}

export async function sendLoopbackJson(
  request: LoopbackJsonRequest,
): Promise<LoopbackJsonResponse | null> {
  const timeout = request.timeoutMs === undefined
    ? undefined
    : createRequestTimeout(request.timeoutMs, request.signal);
  try {
    const response = await request.fetcher(loopbackUrl(request.port, request.path, request.query), {
      method: request.method,
      headers: {
        ...decisionHeaders(request.issuer, request.decision),
        ...(request.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        ...(request.emptyContentLength ? { 'Content-Length': '0' } : {}),
        ...request.headers,
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: timeout?.signal ?? request.signal,
    });
    return { status: response.status, body: await response.json() };
  } catch {
    return null;
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
