import { HOST_API_STARTUP_PATHS, HOST_API_STARTUP_TRACE_HEADER, type HostApiProxyFailureCode } from '../../../src/lib/host-api-transport-contract';
import { isTraceEnabled, startupTrace, traceDebug } from '../../utils/trace-logger';
import { ipcMain } from 'electron';
import { getHostApiRequestDependency } from '../../api/route-boundary';
import { proxyAwareFetch } from '../../utils/proxy-fetch';
import { fetchLoopbackHttp } from '../../utils/loopback-http';
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
import { releaseStagedAttachments } from './dialog-attachment-staging';

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
const ASYNC_ADMISSION_PATHS = new Set([
  '/api/plugins/configuration',
  '/api/plugins/operation',
  '/api/toolchain/uv/prepare',
  '/api/skills/import/markdown',
  '/api/skills/import/bundle',
]);

type InflightHostApiRequest = {
  controller: AbortController;
  failureCode: HostApiProxyFailureCode;
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

function sessionSendStagedAttachmentIds(request: HostApiFetchRequest, path: string, method: string): string[] {
  if (method !== 'POST' || path.split(/[?#]/, 1)[0] !== '/api/capabilities/execute') return [];
  const body = typeof request?.body === 'string' ? parseHostApiJson(request.body) : request?.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const { id, operationId, input } = body as Record<string, unknown>;
  if (id !== 'session.prompt' || (operationId !== 'sessions.prompt' && operationId !== 'sessions.sendWithMedia')
    || !input || typeof input !== 'object' || Array.isArray(input)) return [];
  const { attachments } = input as Record<string, unknown>;
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((attachment) => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return [];
    const { stagedAttachmentId } = attachment as Record<string, unknown>;
    return typeof stagedAttachmentId === 'string' && stagedAttachmentId.length > 0 ? [stagedAttachmentId] : [];
  });
}

function parseHostApiJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function waitForHostApiReadyOrAbort(signal: AbortSignal, runtimeReady?: Promise<unknown>): Promise<void> {
  if (signal.aborted) {
    throw new Error('Host API request aborted.');
  }

  let abortListener: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => reject(new Error('Host API request aborted.'));
    signal.addEventListener('abort', abortListener, { once: true });
  });

  try {
    await Promise.race([Promise.all([waitForHostApiReady(), runtimeReady]), abortPromise]);
  } finally {
    if (abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
  }

  if (signal.aborted) {
    throw new Error('Host API request aborted.');
  }
}

export function registerHostApiProxyHandlers(
  runtimeReady: Promise<unknown>,
  sessionObservers?: RendererSessionObservationRegistry,
): void {
  void runtimeReady.catch(() => undefined);
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
    const sessionTraceId = traceStartedAt ? readTraceHeader(request?.headers ?? {}) : null;
    const sessionPage = event.senderFrame === event.sender.mainFrame
      ? sessionObservers?.capture(event.sender) : undefined;
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    const normalizedPath = normalizeHostApiProxyPath(request?.path);
    const method = (request?.method || 'GET').toUpperCase();
    const stagedAttachmentIds = sessionSendStagedAttachmentIds(request, normalizedPath, method);
    const traceActive = traceStartedAt !== 0 && sessionTraceId !== null
      && normalizedPath.split(/[?#]/, 1)[0] === '/api/capabilities/execute';
    const startupPath = isTraceEnabled() ? normalizedPath.split(/[?#]/, 1)[0] : '';
    const startupTracing = isTraceEnabled() && method === 'GET' && HOST_API_STARTUP_PATHS.has(startupPath);
    const startupStartedAt = startupTracing ? performance.now() : 0;
    const requestIdHash = traceActive || startupTracing ? summarizeIdentifier(requestId).hash : null;
    const traceStartup = (phase: string, detail?: () => Record<string, unknown>): void => {
      if (!startupTracing) return;
      startupTrace('electron.hostapi.proxy', phase, () => ({
        path: startupPath, method: 'GET', requestIdHash,
        elapsedMs: Math.round(performance.now() - startupStartedAt), ...detail?.(),
      }));
    };
    let startupStage: 'boundary' | 'e2e' | 'ready' | 'fetch' | 'body' | null = 'boundary';
    let startupStatus: number | null = null;
    const trace = (stage: string, payload: () => Record<string, unknown> = () => ({})): void => {
      if (!traceActive) return;
      logSessionTrace(`electron.hostapi.proxy.${stage}`, sessionTraceId, {
        path: '/api/capabilities/execute', requestIdHash, elapsedMs: Date.now() - traceStartedAt, ...payload(),
      });
    };
    trace('received');
    traceStartup('received');
    let inflightRequest: InflightHostApiRequest | null = null;
    try {
      traceStartup('boundary.start');
      const routeUrl = new URL(normalizedPath, 'http://127.0.0.1');
      const dependency = getHostApiRequestDependency(method, routeUrl.pathname);
      if (dependency === null) {
        throw new Error(`hostapi route is not available: ${method} ${routeUrl.pathname}`);
      }
      traceStartup('boundary.end', () => ({ outcome: 'passed' }));
      startupStage = 'e2e';
      trace('e2e.start');
      traceStartup('e2e.start');
      const e2eMock = await handleE2EHostApiFetch(request);
      trace('e2e.end', () => ({ outcome: e2eMock ? 'mocked' : 'passthrough' }));
      traceStartup('e2e.end', () => ({ outcome: e2eMock ? 'mocked' : 'passthrough' }));
      startupStage = null;
      if (e2eMock) {
        traceStartup('return', () => ({ outcome: 'mocked' }));
        return e2eMock;
      }
      const explicitTimeout = typeof request?.timeoutMs === 'number' && request.timeoutMs > 0
        ? request.timeoutMs : undefined;
      const timeoutMs = explicitTimeout ?? DEFAULT_HOST_API_TIMEOUT_MS;
      const admission = explicitTimeout === undefined && method === 'POST' && ASYNC_ADMISSION_PATHS.has(routeUrl.pathname);
      const slowSearch = (method === 'PUT' && routeUrl.pathname === '/api/search/config')
        || (method === 'POST' && (routeUrl.pathname === '/api/search/prepare' || routeUrl.pathname === '/api/search/restart'));

      const controller = new AbortController();
      const pendingRequest: InflightHostApiRequest = { controller, failureCode: 'UNAVAILABLE' };
      inflightRequest = pendingRequest;
      if (requestId) {
        inflightRequests.set(requestId, inflightRequest);
      }
      const startedAt = performance.now();
      let remainingMs = timeoutMs;
      let waitingForAdmission = false;
      const expire = () => {
        pendingRequest.failureCode = 'TIMEOUT';
        controller.abort();
      };
      let timer = setTimeout(expire, timeoutMs);
      const senderClosed = () => {
        pendingRequest.failureCode = 'ABORTED';
        controller.abort();
      };
      if (admission || slowSearch) event.sender.once('destroyed', senderClosed);
      try {
        if ((admission || slowSearch) && event.sender.isDestroyed()) senderClosed();
        trace('ready.start');
        startupStage = 'ready';
        traceStartup('ready.start');
        await waitForHostApiReadyOrAbort(controller.signal, dependency === 'runtime' ? runtimeReady : undefined);
        trace('ready.end', () => ({ outcome: 'ready' }));
        traceStartup('ready.end', () => ({ outcome: 'ready' }));
        startupStage = null;

        if (normalizedPath === '/api/sealed-skills/export') {
          traceDebug(() => ['[startup-trace]', {
            source: 'sealed-skills-export',
            phase: 'hostapi-proxy',
            detail: 'request',
            method,
            skillKey: skillKeyFromHostApiBody(request?.body),
          }]);
        }

        let headers = withoutRendererAuthenticationHeaders(request?.headers);
        if (startupTracing) {
          headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== HOST_API_STARTUP_TRACE_HEADER.toLowerCase()));
          if (requestIdHash) headers[HOST_API_STARTUP_TRACE_HEADER] = requestIdHash;
        }
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
        startupStage = 'fetch';
        traceStartup('fetch.request');
        const url = `${getHostApiBaseUrl()}${normalizedPath}`;
        const init = { method, headers, body, signal: controller.signal };
        const response = admission || slowSearch
          ? await fetchLoopbackHttp(url, init, admission ? {
            uploadFinished: () => {
              // Only owner admission is outside the readiness/body I/O budget.
              clearTimeout(timer);
              remainingMs -= performance.now() - startedAt;
              waitingForAdmission = true;
              if (remainingMs <= 0) expire();
            },
            responseStarted: () => {
              if (waitingForAdmission) timer = setTimeout(expire, Math.max(0, remainingMs));
            },
          } : undefined)
          : await proxyAwareFetch(url, init);

        trace('fetch.headers', () => ({ status: response.status }));
        startupStatus = response.status;
        traceStartup('fetch.headers', () => ({ status: startupStatus }));
        startupStage = null;
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('application/json')) {
          trace('body.start', () => ({ outcome: 'json', status: response.status }));
          startupStage = 'body';
          traceStartup('body.start', () => ({ outcome: 'json', status: startupStatus }));
          const json = await response.json().catch((error: unknown) => {
            if (error instanceof SyntaxError) pendingRequest.failureCode = 'INVALID_RESPONSE';
            throw error;
          });
          trace('body.end', () => ({ outcome: 'json', status: response.status }));
          traceStartup('body.end', () => ({ outcome: 'json', status: startupStatus }));
          startupStage = null;
          if (normalizedPath === '/api/sealed-skills/export') {
            traceDebug(() => ['[startup-trace]', {
              source: 'sealed-skills-export',
              phase: 'hostapi-proxy',
              detail: 'response',
              status: response.status,
              outcome: outcomeFromHostApiBody(json),
            }]);
          }
          traceStartup('return', () => ({ outcome: 'received', status: startupStatus }));
          return {
            ok: true,
            data: {
              status: response.status,
              ok: response.ok,
              json,
            },
          };
        }

        trace('body.start', () => ({ outcome: 'text', status: response.status }));
        startupStage = 'body';
        traceStartup('body.start', () => ({ outcome: 'text', status: startupStatus }));
        const text = await response.text();
        trace('body.end', () => ({ outcome: 'text', status: response.status }));
        traceStartup('body.end', () => ({ outcome: 'text', status: startupStatus }));
        startupStage = null;
        if (normalizedPath === '/api/sealed-skills/export') {
          traceDebug(() => ['[startup-trace]', {
            source: 'sealed-skills-export',
            phase: 'hostapi-proxy',
            detail: 'text-response',
            status: response.status,
          }]);
        }
        traceStartup('return', () => ({ outcome: 'received', status: startupStatus }));
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
        if (admission || slowSearch) event.sender.removeListener('destroyed', senderClosed);
        if (requestId) {
          inflightRequests.delete(requestId);
        }
      }
    } catch {
      trace('failure', () => ({ outcome: inflightRequest?.failureCode ?? 'UNAVAILABLE' }));
      if (startupStage) traceStartup(`${startupStage}.end`, () => ({ outcome: 'failed', status: startupStatus }));
      traceStartup('error', () => ({ code: inflightRequest?.failureCode ?? 'UNAVAILABLE', status: startupStatus }));
      if (normalizedPath === '/api/sealed-skills/export') {
        traceDebug(() => ['[startup-trace]', {
          source: 'sealed-skills-export',
          phase: 'hostapi-proxy',
          detail: 'failure',
          code: inflightRequest?.failureCode ?? 'UNAVAILABLE',
        }]);
      }
      publishE2EHostApiBoundary({ stage: 'proxy-failure', method, path: normalizedPath });
      return {
        ok: false,
        error: {
          message: 'Host API request is unavailable.',
          code: inflightRequest?.failureCode ?? 'UNAVAILABLE',
        },
      };
    } finally {
      // A materializing send has already taken its entire batch out of this registry.
      if (stagedAttachmentIds.length > 0) await releaseStagedAttachments(stagedAttachmentIds);
    }
  });
}
