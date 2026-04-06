import type { IncomingMessage, ServerResponse } from 'http';
import { PORTS } from '../../utils/config';
import { getSetting } from '../../services/settings/settings-store';
import type { GatewayApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

async function readPlatformHealth(ctx: GatewayApiContext): Promise<{
  status: string;
  detail?: string;
} | null> {
  try {
    const result = await ctx.runtimeHost.request<{
      success?: boolean;
      status?: string;
      detail?: string;
    }>('GET', '/api/platform/runtime/health');
    const status = typeof result.data?.status === 'string' ? result.data.status : null;
    if (!status) {
      return null;
    }
    return {
      status,
      ...(typeof result.data?.detail === 'string' ? { detail: result.data.detail } : {}),
    };
  } catch {
    return null;
  }
}

export async function handleGatewayRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: GatewayApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/app/gateway-info' && req.method === 'GET') {
    const status = ctx.gatewayManager.getStatus();
    const token = await getSetting('gatewayToken');
    const port = status.port || PORTS.OPENCLAW_GATEWAY;
    sendJson(res, 200, {
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      token,
      port,
    });
    return true;
  }

  if (url.pathname === '/api/gateway/status' && req.method === 'GET') {
    const status = ctx.gatewayManager.getStatus();
    const platformHealth = await readPlatformHealth(ctx);
    if (platformHealth) {
      sendJson(res, 200, { ...status, platformHealth });
      return true;
    }
    sendJson(res, 200, status);
    return true;
  }

  if (url.pathname === '/api/gateway/health' && req.method === 'GET') {
    const health = await readPlatformHealth(ctx);
    if (health) {
      sendJson(res, 200, {
        ok: health.status === 'running',
        status: health.status,
        detail: health.detail,
      });
      return true;
    }
    const gatewayHealth = await ctx.gatewayManager.checkHealth();
    sendJson(res, 200, gatewayHealth);
    return true;
  }

  if (url.pathname === '/api/gateway/start' && req.method === 'POST') {
    try {
      await ctx.gatewayManager.start();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/stop' && req.method === 'POST') {
    try {
      await ctx.gatewayManager.stop();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/restart' && req.method === 'POST') {
    try {
      await ctx.gatewayManager.restart();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/control-ui' && req.method === 'GET') {
    try {
      const status = ctx.gatewayManager.getStatus();
      const token = await getSetting('gatewayToken');
      const port = status.port || PORTS.OPENCLAW_GATEWAY;
      const urlValue = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
      sendJson(res, 200, { success: true, url: urlValue, token, port });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/rpc' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        method?: string;
        params?: unknown;
        timeoutMs?: number;
      }>(req);
      if (!body.method || typeof body.method !== 'string') {
        sendJson(res, 400, { success: false, error: 'method is required' });
        return true;
      }
      const result = await ctx.runtimeHost.request<{
        success?: boolean;
        result?: unknown;
        error?: string;
      }>('POST', '/api/gateway/rpc', {
        method: body.method,
        ...(body.params !== undefined ? { params: body.params } : {}),
        ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
      });
      sendJson(res, result.status, result.data);
    } catch (error) {
      sendJson(res, 200, { success: false, error: String(error) });
    }
    return true;
  }
  return false;
}
