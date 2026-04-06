import { ipcMain } from 'electron';
import { GatewayManager } from '../../gateway/manager';
import { getSetting } from '../../services/settings/settings-store';
import { proxyAwareFetch } from '../../utils/proxy-fetch';
import type { RuntimeHostManager } from '../runtime-host-manager';

export function registerGatewayHandlers(
  gatewayManager: GatewayManager,
  runtimeHost?: RuntimeHostManager,
): void {
  type GatewayHttpProxyRequest = {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  };

  ipcMain.handle('gateway:status', async () => {
    const gatewayStatus = gatewayManager.getStatus();
    if (!runtimeHost) {
      return gatewayStatus;
    }
    try {
      const response = await runtimeHost.request<{
        status?: string;
        detail?: string;
      }>('GET', '/api/platform/runtime/health');
      if (typeof response.data?.status !== 'string') {
        return gatewayStatus;
      }
      return {
        ...gatewayStatus,
        platformHealth: {
          status: response.data.status,
          ...(typeof response.data?.detail === 'string' ? { detail: response.data.detail } : {}),
        },
      };
    } catch {
      return gatewayStatus;
    }
  });

  ipcMain.handle('gateway:rpc', async (_, method: string, params?: unknown, timeoutMs?: number) => {
    if (!runtimeHost) {
      return { success: false, error: 'Runtime Host unavailable' };
    }
    if (!method || typeof method !== 'string') {
      return { success: false, error: 'method is required' };
    }
    try {
      const response = await runtimeHost.request<{
        success?: boolean;
        result?: unknown;
        error?: string;
      }>('POST', '/api/gateway/rpc', {
        method,
        ...(params !== undefined ? { params } : {}),
        ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
      });
      return response.data;
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('gateway:httpProxy', async (_, request: GatewayHttpProxyRequest) => {
    try {
      const status = gatewayManager.getStatus();
      const port = status.port || 18789;
      const path = request?.path && request.path.startsWith('/') ? request.path : '/';
      const method = (request?.method || 'GET').toUpperCase();
      const timeoutMs =
        typeof request?.timeoutMs === 'number' && request.timeoutMs > 0
          ? request.timeoutMs
          : 15000;

      const token = await getSetting('gatewayToken');
      const headers: Record<string, string> = {
        ...(request?.headers ?? {}),
      };
      if (!headers.Authorization && !headers.authorization && token) {
        headers.Authorization = `Bearer ${token}`;
      }

      let body: string | undefined;
      if (request?.body !== undefined && request?.body !== null) {
        body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await proxyAwareFetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

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
        error: {
          message: String(error),
        },
      };
    }
  });

  ipcMain.handle('gateway:getControlUiUrl', async () => {
    try {
      const status = gatewayManager.getStatus();
      const token = await getSetting('gatewayToken');
      const port = status.port || 18789;
      const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
      return { success: true, url, port, token };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}
