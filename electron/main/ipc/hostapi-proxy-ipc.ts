import { ipcMain } from 'electron';
import { isHostApiRequestAllowed } from '../../api/route-boundary';
import { proxyAwareFetch } from '../../utils/proxy-fetch';
import { getHostApiBaseUrl, getHostApiToken } from '../../api/server';
import { handleE2EHostApiFetch } from '@electron/e2e-fixture-loader';
import { SESSION_TRACE_HEADER } from '../runtime-host-delivery/transport/sessions/trace';

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
    typeof value === 'string' && !['authorization', 'proxy-authorization'].includes(name.toLowerCase())
  )));
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === name);
}

export function registerHostApiProxyHandlers(): void {
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

  ipcMain.handle('hostapi:fetch', async (_, request: HostApiFetchRequest) => {
    const e2eMock = await handleE2EHostApiFetch(request);
    if (e2eMock) {
      return e2eMock;
    }
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    const normalizedPath = normalizeHostApiProxyPath(request?.path);
    const method = (request?.method || 'GET').toUpperCase();
    let inflightRequest: InflightHostApiRequest | null = null;
    try {
      const routeUrl = new URL(normalizedPath, 'http://127.0.0.1');
      if (!isHostApiRequestAllowed(method, routeUrl.pathname)) {
        throw new Error(`hostapi route is not available: ${method} ${routeUrl.pathname}`);
      }
      const timeoutMs =
        typeof request?.timeoutMs === 'number' && request.timeoutMs > 0
          ? request.timeoutMs
          : DEFAULT_HOST_API_TIMEOUT_MS;

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
      let body: string | undefined;
      if (request?.body !== undefined && request.body !== null && method !== 'GET' && method !== 'HEAD') {
        body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
        if (!hasHeader(headers, 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      }

      const controller = new AbortController();
      inflightRequest = { controller, failureCode: 'UNAVAILABLE' };
      if (requestId) {
        inflightRequests.set(requestId, inflightRequest);
      }
      const timer = setTimeout(() => {
        inflightRequest.failureCode = 'TIMEOUT';
        controller.abort();
      }, timeoutMs);
      let response: Awaited<ReturnType<typeof proxyAwareFetch>>;
      try {
        response = await proxyAwareFetch(`${getHostApiBaseUrl()}${normalizedPath}`, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        if (requestId) {
          inflightRequests.delete(requestId);
        }
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json')) {
        const json = await response.json();
        return {
          ok: true,
          data: {
            status: response.status,
            ok: response.ok,
            json,
          },
        };
      }

      const text = await response.text();
      return {
        ok: true,
        data: {
          status: response.status,
          ok: response.ok,
          text,
        },
      };
    } catch {
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
