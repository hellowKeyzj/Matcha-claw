import { createHash } from 'node:crypto';
import type {
  SearchConfig, SearchEngine, SearchRuntimeState, SearchSnapshot, SearchVerification, SearchVerifyRequest,
} from '../../../../src/types/network-search';
import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { hasExactKeys, isRecord, sendLoopbackJsonDelivery } from './client';

export type SearchConfigRequest = { expectedRevision: number; config: SearchConfig };
export type SearchResponse<T> = { status: 200; body: T } | { status: 400 | 401 | 409 | 503; body: { success: false; error: string } };
export interface SearchTransport {
  read(signal?: AbortSignal): Promise<SearchResponse<SearchSnapshot>>;
  configure(request: SearchConfigRequest, signal?: AbortSignal): Promise<SearchResponse<SearchSnapshot>>;
  prepare(signal?: AbortSignal): Promise<SearchResponse<SearchSnapshot>>;
  restart(signal?: AbortSignal): Promise<SearchResponse<SearchSnapshot>>;
  stop(signal?: AbortSignal): Promise<SearchResponse<SearchSnapshot>>;
  verify(request: SearchVerifyRequest, signal?: AbortSignal): Promise<SearchResponse<SearchVerification>>;
  logs(signal?: AbortSignal): Promise<SearchResponse<{ lines: string[] }>>;
}

const SAFE_ERRORS = new Set([
  'Network search request is invalid',
  'Native runtime search verification is not supported; use an existing runtime tool session',
  'Network search is unavailable; prepare or restart the service',
  'Native runtime policy denied network search; check runtime tool permissions',
  'Native runtime search failed; check the runtime session and retry',
  'Network search configuration changed; reload before saving',
  'Network search configuration could not be saved; check storage and retry',
  'Prepare and enable network search before selecting categories',
  'Network search configuration is invalid; check the selected engines and options',
  'Network search resources are missing; reinstall the search component',
  'Network search storage is unavailable; check application storage permissions',
  'Python 3.12 is unavailable; prepare the application toolchain',
  'Network search dependency preparation failed; prepare the component again',
  'Network search service is stopped; enable or restart it before verifying',
  'Network search could not start; check configuration and prepare it again',
  'Network search cleanup could not be confirmed; restart the application before retrying',
  'Network search request failed; check the component is running',
  'Network search timed out; check engine connectivity or request timeout',
  'Network search response exceeded the size limit',
  'Network search returned an invalid response; restart the component',
  'Network search is rate limited; wait before retrying',
  'Network search authorization is invalid',
]);
const UNAVAILABLE = { success: false, error: 'Network search is unavailable; prepare or restart the service' } as const;
const UNOBSERVED = { success: false, error: 'Network search result could not be observed; reload its status before retrying' } as const;
const SERVICE_PHASES = ['stopped', 'preparing', 'starting', 'running', 'failed'];
const RUNTIME_PHASES = ['disabled', 'notConfigured', 'pendingRestart', 'ready', 'failed'];

export function createSearchTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): SearchTransport {
  async function request<T>(
    operation: string, path: string, method: 'GET' | 'POST' | 'PUT',
    body: unknown, decode: (value: unknown) => value is T, timeoutMs: number, signal?: AbortSignal,
  ): Promise<SearchResponse<T>> {
    const serialized = body === undefined ? '' : JSON.stringify(body);
    const delivery = await sendLoopbackJsonDelivery({
      port, path, method, issuer, fetcher, body, signal, timeoutMs,
      emptyContentLength: method !== 'GET' && body === undefined,
      decision: {
        endpoint: path, scope: method === 'GET' ? 'search:read' : 'search:write',
        capability: `search.${operation}`, subject: 'network-search',
        revision: method === 'GET' ? '1' : createHash('sha256').update(serialized).digest('hex'),
      },
    });
    if (delivery.outcome !== 'response') return { status: 503, body: delivery.outcome === 'unknown' ? UNOBSERVED : UNAVAILABLE };
    const { status, body: response } = delivery.response;
    if (status === 200 && decode(response)) return { status, body: response };
    if ((status === 400 || status === 401 || status === 409 || status === 503) && isSafeFailure(response)) return { status, body: response };
    return { status: 503, body: UNAVAILABLE };
  }
  return {
    read: (signal) => request('read', '/api/search', 'GET', undefined, isSnapshot, 10_000, signal),
    configure: (body, signal) => request('configure', '/api/search/config', 'PUT', body, isSnapshot, 900_000, signal),
    prepare: (signal) => request('prepare', '/api/search/prepare', 'POST', undefined, isSnapshot, 900_000, signal),
    restart: (signal) => request('restart', '/api/search/restart', 'POST', undefined, isSnapshot, 900_000, signal),
    stop: (signal) => request('stop', '/api/search/stop', 'POST', undefined, isSnapshot, 90_000, signal),
    verify: (body, signal) => request('verify', '/api/search/verify', 'POST', body, isVerification, 180_000, signal),
    logs: (signal) => request('logs', '/api/search/logs', 'GET', undefined, isLogs, 10_000, signal),
  };
}

function isSnapshot(value: unknown): value is SearchSnapshot {
  return isRecord(value) && hasExactKeys(value, ['revision', 'appliedRevision', 'config', 'service', 'engines', 'runtimes'])
    && integer(value.revision) && (value.appliedRevision === null || (integer(value.appliedRevision) && value.appliedRevision <= value.revision))
    && isConfig(value.config) && isRecord(value.service) && hasExactKeys(value.service, ['phase', 'error'])
    && typeof value.service.phase === 'string' && SERVICE_PHASES.includes(value.service.phase) && safeError(value.service.error)
    && list(value.engines, isEngine, 1024) && list(value.runtimes, isRuntimeState, 16);
}
function isConfig(value: unknown): value is SearchConfig {
  return isRecord(value) && hasExactKeys(value, ['enabled', 'autoStart', 'categories', 'language', 'safeSearch', 'resultCount', 'requestTimeoutSeconds', 'proxyUrl', 'engines', 'runtimes'])
    && typeof value.enabled === 'boolean' && typeof value.autoStart === 'boolean' && texts(value.categories, 32)
    && text(value.language, 64) && integer(value.safeSearch, 0, 2) && integer(value.resultCount, 1, 10)
    && integer(value.requestTimeoutSeconds, 1, 120) && (value.proxyUrl === null || isProxy(value.proxyUrl))
    && list(value.engines, (engine) => isRecord(engine) && hasExactKeys(engine, ['name', 'enabled', 'timeoutSeconds', 'weight'])
      && text(engine.name, 256) && typeof engine.enabled === 'boolean' && (engine.timeoutSeconds === null || integer(engine.timeoutSeconds, 1, 120))
      && (engine.weight === null || (typeof engine.weight === 'number' && Number.isFinite(engine.weight) && engine.weight > 0 && engine.weight <= 100)), 1024)
    && list(value.runtimes, (runtime) => isRecord(runtime) && hasExactKeys(runtime, ['endpoint', 'enabled'])
      && isEndpoint(runtime.endpoint) && typeof runtime.enabled === 'boolean', 16);
}
function isEngine(value: unknown): value is SearchEngine {
  return isRecord(value) && hasExactKeys(value, ['name', 'categories', 'enabled', 'languageSupport', 'safeSearch', 'timeoutSeconds'])
    && text(value.name, 256) && texts(value.categories, 32) && typeof value.enabled === 'boolean'
    && typeof value.languageSupport === 'boolean' && typeof value.safeSearch === 'boolean'
    && typeof value.timeoutSeconds === 'number' && Number.isFinite(value.timeoutSeconds) && value.timeoutSeconds > 0;
}
function isRuntimeState(value: unknown): value is SearchRuntimeState {
  return isRecord(value) && hasExactKeys(value, ['endpoint', 'enabled', 'phase', 'error']) && isEndpoint(value.endpoint)
    && typeof value.enabled === 'boolean' && typeof value.phase === 'string' && RUNTIME_PHASES.includes(value.phase) && safeError(value.error);
}
function isEndpoint(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId']) && value.kind === 'native-runtime'
    && text(value.runtimeAdapterId, 256) && text(value.runtimeInstanceId, 256);
}
function isVerification(value: unknown): value is SearchVerification {
  return isRecord(value) && hasExactKeys(value, ['results', 'unresponsiveEngines', 'elapsedMs']) && integer(value.elapsedMs)
    && list(value.results, (hit) => isRecord(hit) && hasExactKeys(hit, ['title', 'url', 'snippet'])
      && resultText(hit.title, 16 * 1024) && resultText(hit.snippet, 64 * 1024) && isPublicUrl(hit.url), 10)
    && list(value.unresponsiveEngines, (entry) => Array.isArray(entry) && entry.length === 2 && text(entry[0], 256) && entry[1] === 'unavailable', 1024);
}
function isLogs(value: unknown): value is { lines: string[] } {
  return isRecord(value) && hasExactKeys(value, ['lines']) && list(value.lines, (line) =>
    typeof line === 'string' && /^\[search\] [a-z ]{1,160}$/.test(line), 256);
}
function isSafeFailure(value: unknown): value is { success: false; error: string } {
  return isRecord(value) && hasExactKeys(value, ['success', 'error']) && value.success === false
    && typeof value.error === 'string' && SAFE_ERRORS.has(value.error);
}
function safeError(value: unknown): boolean { return value === null || (typeof value === 'string' && SAFE_ERRORS.has(value)); }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max && !/[\0\r\n]/.test(value); }
function resultText(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max && !value.includes('\0'); }
function list(value: unknown, valid: (entry: unknown) => boolean, max: number): value is unknown[] {
  return Array.isArray(value) && value.length <= max && value.every(valid);
}
function texts(value: unknown, max: number): value is string[] { return list(value, (entry) => text(entry, 256), max); }
function isProxy(value: unknown): boolean {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) && !!url.hostname
      && !url.username && !url.password && !url.search && !url.hash && (url.pathname === '' || url.pathname === '/');
  } catch { return false; }
}
function isPublicUrl(value: unknown): boolean {
  if (!text(value, 8192)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
