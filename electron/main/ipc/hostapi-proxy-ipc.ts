import { ipcMain } from 'electron';
import { proxyAwareFetch } from '../../utils/proxy-fetch';
import { getPort } from '../../utils/config';

type HostApiFetchRequest = {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
};

export function registerHostApiProxyHandlers(): void {
  ipcMain.handle('hostapi:fetch', async (_, request: HostApiFetchRequest) => {
    try {
      const port = getPort('MATCHACLAW_HOST_API');
      const normalizedPath = request?.path
        ? (request.path.startsWith('/') ? request.path : `/${request.path}`)
        : '/';
      const method = (request?.method || 'GET').toUpperCase();
      const timeoutMs =
        typeof request?.timeoutMs === 'number' && request.timeoutMs > 0
          ? request.timeoutMs
          : 15000;

      const headers: Record<string, string> = { ...(request?.headers ?? {}) };
      let body: string | undefined;
      if (request?.body !== undefined && request.body !== null && method !== 'GET' && method !== 'HEAD') {
        body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }

      const controller = new AbortController();
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
