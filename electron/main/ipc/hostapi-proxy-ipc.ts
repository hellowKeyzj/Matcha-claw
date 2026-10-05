import { ipcMain } from 'electron';
import { isHostApiRequestAllowed } from '../../api/route-boundary';
import { proxyAwareFetch } from '../../utils/proxy-fetch';
import { getHostApiBaseUrl, getHostApiToken, waitForHostApiReady } from '../../api/server';
import { handleE2EHostApiFetch } from '@electron/e2e-fixture-loader';
import {
  isSessionTraceEnabled,
  logSessionTrace,
  readTraceHeader,
  SESSION_TRACE_HEADER,
  summarizeIdentifier,
} from '../runtime-host-delivery/transport/sessions/trace';
import { SESSION_PAGE_HEADER, type RendererSessionObservationRegistry } from '../renderer-event-routes';

type HostApiFetchRequest = {
  requestId?: string;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
};

type HostApiAbortRequest = {
  requestId?: string;
};

const DEFAULT_HOST_API_TIMEOUT_MS = 30_000;

type SafeHostApiProxyFailureCode = 'TIMEOUT' | 'ABORTED' | 'UNAVAILABLE';

type InflightHostApiRequest = {
  controller: AbortController;
  failureCode: SafeHostApiProxyFailureCode;
};

type E2EProcess = typeof process & {
  __matchaclawE2EHostApiBoundary?: Readonly<{
    stage: 'proxy-failure';
    method: string;
    path: string;
  }>;
};

function publishE2EHostApiBoundary(boundary: NonNullable<E2EProcess['__matchaclawE2EHostApiBoundary']>): void {
  if (process.env.MATCHACLAW_E2E !== '1') return;
  Object.defineProperty(process as E2EProcess, '__matchaclawE2EHostApiBoundary', {
    configurable: true,
    enumerable: false,
    value: Object.freeze(boundary),
    writable: false,
  });
}

function normalizeHostApiProxyPath(path: unknown): string {
  if (typeof path !== 'string') {
    return '/';
  }
  const trimmedPath = path.trim();
  if (!trimmedPath || /^[a-z][a-z\d+.-]*:/i.test(trimmedPath) || trimmedPath.startsWith('//')) {
    return '/';
  }
  return trimmedPath.startsWith('/') ? trimmedPath : `/${trimmedPath}`;
}

function withoutRendererAuthenticationHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return {};
  }
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => (
    typeof value === 'string' && !['authorization', 'proxy-authorization', SESSION_PAGE_HEADER.toLowerCase()].includes(name.toLowerCase())
  )));
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === name);
}

function skillKeyFromHostApiBody(body: unknown): string {
  const parsed = typeof body === 'string' ? parseHostApiJson(body) : body;
  if (!parsed || typeof parsed !== 'object' || !('skillKey' in parsed)) return 'none';
  const value = (parsed as { skillKey?: unknown }).skillKey;
  return typeof value === 'string' && value.trim() ? value.trim() : 'invalid';
}

function outcomeFromHostApiBody(body: unknown): string {
  if (!body || typeof body !== 'object' || !('outcome' in body)) return 'unknown';
  const value = (body as { outcome?: unknown }).outcome;
  return typeof value === 'string' ? value : 'unknown';
}

function parseHostApiJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function waitForHostApiReadyOrAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new Error('Host API request aborted.');
  }

  let abortListener: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => reject(new Error('Host API request aborted.'));
    signal.addEventListener('abort', abortListener, { once: true });
  });

  try {
    await Promise.race([waitForHostApiReady(), abortPromise]);
  } finally {
    if (abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
  }

  if (signal.aborted) {
    throw new Error('Host API request aborted.');
  }
}

export function registerHostApiProxyHandlers(sessionObservers?: RendererSessionObservationRegistry): void {
  // requestId → AbortController 注册表，让 renderer 通过 hostapi:abort 真正取消正在进行的 upstream fetch，
  // 避免页面切换后还白白等几秒再丢弃响应。
  const inflightRequests = new Map<string, InflightHostApiRequest>();

  ipcMain.handle('hostapi:abort', (_, request: HostApiAbortRequest) => {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    if (!requestId) {
      return { ok: false };
    }
    const inflightRequest = inflightRequests.get(requestId);
    if (!inflightRequest) {
      return { ok: false };
    }
    inflightRequest.failureCode = 'ABORTED';
    inflightRequest.controller.abort();
    return { ok: true };
  });

  ipcMain.handle('hostapi:base-url', () => getHostApiBaseUrl());

  ipcMain.handle('hostapi:fetch', async (event, request: HostApiFetchRequest) => {
    const traceStartedAt = isSessionTraceEnabled() ? Date.now() : 0;
    const sessionTraceId = readTraceHeader(request?.headers ?? {});
    const sessionPage = event.senderFrame === event.sender.mainFrame
      ? sessionObservers?.capture(event.sender) : undefined;
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    const normalizedPath = normalizeHostApiProxyPath(request?.path);
    const method = (request?.method || 'GET').toUpperCase();
    const traceActive = traceStartedAt !== 0 && sessionTraceId !== null
      && normalizedPath.split(/[?#]/, 1)[0] === '/api/capabilities/execute';
    const requestIdHash = traceActive ? summarizeIdentifier(requestId).hash : null;
    const trace = (stage: string, payload: Record<string, unknown> = {}): void => {
      if (!traceActive) return;
      logSessionTrace(`electron.hostapi.proxy.${stage}`, sessionTraceId, {
        path: '/api/capabilities/execute', requestIdHash, elapsedMs: Date.now() - traceStartedAt, ...payload,
      });
    };
    trace('received');
    let inflightRequest: InflightHostApiRequest | null = null;
    try {
      const routeUrl = new URL(normalizedPath, 'http://127.0.0.1');
      if (!isHostApiRequestAllowed(method, routeUrl.pathname)) {
        throw new Error(`hostapi route is not available: ${method} ${routeUrl.pathname}`);
      }
      trace('e2e.start');
      const e2eMock = await handleE2EHostApiFetch(request);
      trace('e2e.end', { outcome: e2eMock ? 'mocked' : 'passthrough' });
      if (e2eMock) {
        return e2eMock;
      }
      const timeoutMs =
        typeof request?.timeoutMs === 'number' && request.timeoutMs > 0
          ? request.timeoutMs
          : DEFAULT_HOST_API_TIMEOUT_MS;

      const controller = new AbortController();
      const pendingRequest: InflightHostApiRequest = { controller, failureCode: 'UNAVAILABLE' };
      inflightRequest = pendingRequest;
      if (requestId) {
        inflightRequests.set(requestId, inflightRequest);
      }
      const timer = setTimeout(() => {
        pendingRequest.failureCode = 'TIMEOUT';
        controller.abort();
      }, timeoutMs);
      try {
        trace('ready.start');
        await waitForHostApiReadyOrAbort(controller.signal);
        trace('ready.end', { outcome: 'ready' });

        if (normalizedPath === '/api/sealed-skills/export') {
          console.info('[startup-trace]', {
            source: 'sealed-skills-export',
            phase: 'hostapi-proxy',
            detail: 'request',
            method,
            skillKey: skillKeyFromHostApiBody(request?.body),
          });
        }

        const headers = withoutRendererAuthenticationHeaders(request?.headers);
        const traceId = typeof request?.headers?.[SESSION_TRACE_HEADER] === 'string'
          ? request.headers[SESSION_TRACE_HEADER]
          : typeof request?.headers?.[SESSION_TRACE_HEADER.toLowerCase()] === 'string'
            ? request.headers[SESSION_TRACE_HEADER.toLowerCase()]
            : null;
        if (traceId) {
          headers[SESSION_TRACE_HEADER] = traceId;
        }
        headers.Authorization = `Bearer ${getHostApiToken()}`;
        if (sessionObservers?.isCurrent(sessionPage)) headers[SESSION_PAGE_HEADER] = sessionPage.token;
        let body: string | undefined;
        if (request?.body !== undefined && request.body !== null && method !== 'GET' && method !== 'HEAD') {
          body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
          if (!hasHeader(headers, 'content-type')) {
            headers['Content-Type'] = 'application/json';
          }
        }

        trace('fetch.request');
        const response = await proxyAwareFetch(`${getHostApiBaseUrl()}${normalizedPath}`, {
          method,
          headers,
          body,
          signal: controller.signal,
        });

        trace('fetch.headers', { status: response.status });
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('application/json')) {
          trace('body.start', { outcome: 'json', status: response.status });
          const json = await response.json();
          trace('body.end', { outcome: 'json', status: response.status });
          if (normalizedPath === '/api/sealed-skills/export') {
            console.info('[startup-trace]', {
              source: 'sealed-skills-export',
              phase: 'hostapi-proxy',
              detail: 'response',
              status: response.status,
              outcome: outcomeFromHostApiBody(json),
            });
          }
          return {
            ok: true,
            data: {
              status: response.status,
              ok: response.ok,
              json,
            },
          };
        }

        trace('body.start', { outcome: 'text', status: response.status });
        const text = await response.text();
        trace('body.end', { outcome: 'text', status: response.status });
        if (normalizedPath === '/api/sealed-skills/export') {
          console.info('[startup-trace]', {
            source: 'sealed-skills-export',
            phase: 'hostapi-proxy',
            detail: 'text-response',
            status: response.status,
          });
        }
        return {
          ok: true,
          data: {
            status: response.status,
            ok: response.ok,
            text,
          },
        };
      } finally {
        clearTimeout(timer);
        if (requestId) {
          inflightRequests.delete(requestId);
        }
      }
    } catch {
      trace('failure', { outcome: inflightRequest?.failureCode ?? 'UNAVAILABLE' });
      if (normalizedPath === '/api/sealed-skills/export') {
        console.info('[startup-trace]', {
          source: 'sealed-skills-export',
          phase: 'hostapi-proxy',
          detail: 'failure',
          code: inflightRequest?.failureCode ?? 'UNAVAILABLE',
        });
      }
      publishE2EHostApiBoundary({ stage: 'proxy-failure', method, path: normalizedPath });
      return {
        ok: false,
        error: {
          message: 'Host API request is unavailable.',
          code: inflightRequest?.failureCode ?? 'UNAVAILABLE',
        },
      };
    }
  });
}
