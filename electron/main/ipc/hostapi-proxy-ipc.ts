import { ipcMain } from 'electron';
import { isHostApiProxyAllowedRoute } from '../../api/route-boundary';
import { proxyAwareFetch } from '../../utils/proxy-fetch';
import { getPort } from '../../utils/config';
import { getHostApiBaseUrl, getHostApiToken } from '../../api/server';
import { handleE2EHostApiFetch } from '../e2e-fixture-loader';

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
const REQUEST_TIMEOUT_HEADER = 'x-matchaclaw-request-timeout-ms';

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

export function registerHostApiProxyHandlers(): void {
  // requestId → AbortController 注册表，让 renderer 通过 hostapi:abort 真正取消正在进行的 upstream fetch，
  // 避免页面切换后还白白等几秒再丢弃响应。
  const inflightControllers = new Map<string, AbortController>();

  ipcMain.handle('hostapi:token', () => getHostApiToken());
  ipcMain.handle('hostapi:base-url', () => getHostApiBaseUrl());

  ipcMain.handle('hostapi:abort', (_, request: HostApiAbortRequest) => {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    if (!requestId) {
      return { ok: false };
    }
    const controller = inflightControllers.get(requestId);
    if (!controller) {
      return { ok: false };
    }
    controller.abort();
    return { ok: true };
  });

  ipcMain.handle('hostapi:fetch', async (_, request: HostApiFetchRequest) => {
    const e2eMock = await handleE2EHostApiFetch(request);
    if (e2eMock) {
      return e2eMock;
    }
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    try {
      const port = getPort('MATCHACLAW_HOST_API');
      const normalizedPath = normalizeHostApiProxyPath(request?.path);
      const method = (request?.method || 'GET').toUpperCase();
      const routeUrl = new URL(normalizedPath, 'http://127.0.0.1');
      if (!isHostApiProxyAllowedRoute(method, routeUrl.pathname)) {
        throw new Error(`hostapi proxy route is not allowed: ${method} ${routeUrl.pathname}`);
      }
      const timeoutMs =
        typeof request?.timeoutMs === 'number' && request.timeoutMs > 0
          ? request.timeoutMs
          : DEFAULT_HOST_API_TIMEOUT_MS;

      const headers: Record<string, string> = { ...(request?.headers ?? {}) };
      headers.Authorization = `Bearer ${getHostApiToken()}`;
      headers[REQUEST_TIMEOUT_HEADER] = String(timeoutMs);
      let body: string | undefined;
      if (request?.body !== undefined && request.body !== null && method !== 'GET' && method !== 'HEAD') {
        body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }

      const controller = new AbortController();
      if (requestId) {
        inflightControllers.set(requestId, controller);
      }
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Awaited<ReturnType<typeof proxyAwareFetch>>;
      try {
        response = await proxyAwareFetch(`http://127.0.0.1:${port}${normalizedPath}`, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        if (requestId) {
          inflightControllers.delete(requestId);
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
    } catch (error) {
      return {
        ok: false,
        error: { message: String(error) },
      };
    }
  });
}
