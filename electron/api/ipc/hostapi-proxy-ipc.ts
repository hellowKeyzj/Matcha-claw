import { HOST_API_STARTUP_PATHS, HOST_API_STARTUP_TRACE_HEADER, type HostApiProxyFailureCode } from '../../../src/lib/host-api-transport-contract';
import { isTraceEnabled, startupTrace, traceDebug } from '../../utils/trace-logger';
import { ipcMain } from 'electron';
import { getHostApiRequestDependency } from '../route-boundary';
import { toUSVString } from 'node:util';
import { getHostApiBaseUrl } from '../server';
import { HostApiBodyTooLarge, jsonResult, parseJsonText, type HostApiDispatcher, type HostApiRequest } from '../execution';
import { handleE2EHostApiFetch } from '@electron/e2e-fixture-loader';
import {
  isSessionTraceEnabled,
  logSessionTrace,
  readTraceHeader,
  SESSION_TRACE_HEADER,
  summarizeIdentifier,
} from '../../main/runtime-host-delivery/transport/sessions/trace';
import { SESSION_PAGE_HEADER, type RendererSessionObservationRegistry } from '../../main/sessions/observations';
import { releaseSessionSendStagedAttachments, sessionSendStagedAttachmentIds } from '../../main/sessions/attachments';

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

function parseHostApiJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function waitOrAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abortListener: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => reject(new Error('Host API request aborted.'));
    if (signal.aborted) abortListener();
    else signal.addEventListener('abort', abortListener, { once: true });
  });

  try {
    return await Promise.race([pending, abortPromise]);
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

export function registerHostApiProxyHandlers(
  dispatch: HostApiDispatcher,
  runtimeReady: Promise<unknown>,
  sessionObservers: RendererSessionObservationRegistry,
  shutdownSignal: AbortSignal,
): void {
  void runtimeReady.catch(() => undefined);
  // requestId → caller observation; accepted owner operations retain their own lifetime.
  const inflightRequests = new Map<string | symbol, InflightHostApiRequest>();
  shutdownSignal.addEventListener('abort', () => {
    for (const request of inflightRequests.values()) request.controller.abort();
  }, { once: true });

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
    const stagedAttachmentIds = sessionSendStagedAttachmentIds(request?.body, normalizedPath, method);
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
      const dependency = getHostApiRequestDependency(method, routeUrl.pathname, 'ipc');
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
      const pluginCall = explicitTimeout === undefined && method === 'POST' && routeUrl.pathname === '/api/app-plugins/call';
      const admission = explicitTimeout === undefined && method === 'POST' && ASYNC_ADMISSION_PATHS.has(routeUrl.pathname);
      const unboundedWait = admission || pluginCall;
      const slowSearch = (method === 'PUT' && routeUrl.pathname === '/api/search/config')
        || (method === 'POST' && (routeUrl.pathname === '/api/search/prepare' || routeUrl.pathname === '/api/search/restart'));

      const controller = new AbortController();
      const pendingRequest: InflightHostApiRequest = { controller, failureCode: 'UNAVAILABLE' };
      inflightRequest = pendingRequest;
      const inflightKey = requestId || Symbol();
      inflightRequests.set(inflightKey, inflightRequest);
      if (shutdownSignal.aborted) controller.abort();
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
      if (unboundedWait || slowSearch) event.sender.once('destroyed', senderClosed);
      try {
        if ((unboundedWait || slowSearch) && event.sender.isDestroyed()) senderClosed();
        trace('ready.start');
        startupStage = 'ready';
        traceStartup('ready.start');
        await waitOrAbort(dependency === 'runtime' ? runtimeReady : Promise.resolve(), controller.signal);
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
        let body: string | undefined;
        if (request?.body !== undefined && request.body !== null && method !== 'GET' && method !== 'HEAD') {
          body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
          if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
        }
        if (body !== undefined) body = toUSVString(body);
        const normalizedHeaders = Object.fromEntries(new Headers(headers).entries());
        let bytes: Buffer | undefined;
        const readBytes = async (maximum?: number): Promise<Uint8Array> => {
          bytes ??= Buffer.from(body ?? '', 'utf8');
          if (maximum !== undefined && (Number(normalizedHeaders['content-length']) > maximum || bytes.length > maximum)) {
            throw new HostApiBodyTooLarge();
          }
          return bytes;
        };
        const executionRequest: HostApiRequest = {
          method,
          headers: normalizedHeaders,
          signal: controller.signal,
          sessionPage: sessionObservers.isCurrent(sessionPage) ? sessionPage : undefined,
          readBytes,
          readJson: async <T>() => parseJsonText<T>(body ?? ''),
        };

        trace('fetch.request');
        startupStage = 'fetch';
        traceStartup('fetch.request');
        const contentType = normalizedHeaders['content-type'] ?? '';
        const hasBody = body !== undefined && body.length > 0;
        const contentTypeAllowed = method === 'GET' || method === 'HEAD' || !hasBody || contentType.includes('application/json');
        if (unboundedWait) {
          clearTimeout(timer);
          remainingMs -= performance.now() - startedAt;
          waitingForAdmission = true;
          if (remainingMs <= 0) expire();
        }
        controller.signal.throwIfAborted();
        const response = await waitOrAbort(contentTypeAllowed
          ? dispatch(executionRequest, routeUrl)
          : Promise.resolve(jsonResult(415, { success: false, error: 'Content-Type must be application/json' })), controller.signal);
        if (!response) throw new Error('Host API request is unavailable.');
        if (waitingForAdmission) timer = setTimeout(expire, Math.max(0, remainingMs));
        const responseOk = response.status >= 200 && response.status < 300;

        trace('fetch.headers', () => ({ status: response.status }));
        startupStatus = response.status;
        traceStartup('fetch.headers', () => ({ status: startupStatus }));
        startupStage = null;
        if (response.kind === 'json') {
          trace('body.start', () => ({ outcome: 'json', status: response.status }));
          startupStage = 'body';
          traceStartup('body.start', () => ({ outcome: 'json', status: startupStatus }));
          let json: unknown;
          try {
            json = JSON.parse([204, 205, 304].includes(response.status) ? '' : response.serializedBody ?? '');
          } catch (error) {
            if (error instanceof SyntaxError) pendingRequest.failureCode = 'INVALID_RESPONSE';
            throw error;
          }
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
              ok: responseOk,
              json,
            },
          };
        }

        trace('body.start', () => ({ outcome: 'text', status: response.status }));
        startupStage = 'body';
        traceStartup('body.start', () => ({ outcome: 'text', status: startupStatus }));
        const text = [204, 205, 304].includes(response.status) ? '' : new TextDecoder().decode(response.body);
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
            ok: responseOk,
            text,
          },
        };
      } finally {
        clearTimeout(timer);
        if (unboundedWait || slowSearch) event.sender.removeListener('destroyed', senderClosed);
        inflightRequests.delete(inflightKey);
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
      await releaseSessionSendStagedAttachments(stagedAttachmentIds);
    }
  });
}
