import type { IncomingMessage, ServerResponse } from 'http';
import { PORTS } from '../../utils/config';
import { buildOpenClawControlUiUrl } from '../../utils/openclaw-control-ui';
import { buildPublicGatewayStatus } from '../../main/process-runtime/openclaw-gateway/public-status';
import type { GatewayApiContext } from '../context';
import { sendJson } from '../route-utils';

async function recoverRuntimeHostGatewayConnection(ctx: GatewayApiContext): Promise<void> {
  const result = await ctx.runtimeHost.request<{ success?: boolean; error?: string }>(
    'POST',
    '/api/gateway/recover',
    { reason: 'gateway-restart', timeoutMs: 15_000 },
    { timeoutMs: 20_000 },
  );
  if (result.status < 200 || result.status >= 300 || result.data?.success !== true) {
    throw new Error(result.data?.error ?? 'Runtime-host gateway recovery failed');
  }
}

async function readPlatformHealth(ctx: GatewayApiContext): Promise<{
  state: 'connected' | 'reconnecting' | 'disconnected';
  portReachable: boolean;
  gatewayReady: boolean;
  healthSummary: 'healthy' | 'degraded' | 'unresponsive';
  diagnostics: {
    lastAliveAt?: number;
    lastRpcSuccessAt?: number;
    lastRpcFailureAt?: number;
    lastRpcFailureMethod?: string;
    lastHeartbeatTimeoutAt?: number;
    consecutiveHeartbeatMisses: number;
    lastSocketCloseAt?: number;
    lastSocketCloseCode?: number;
    consecutiveRpcFailures: number;
  };
  lastError?: string;
  updatedAt: number;
} | null> {
  try {
    return await ctx.runtimeHost.readGatewayStatus();
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
  if (url.pathname === '/api/gateway/status' && req.method === 'GET') {
    const status = ctx.gatewayManager.getStatus();
    const platformHealth = await readPlatformHealth(ctx);
    sendJson(res, 200, buildPublicGatewayStatus(status, platformHealth));
    return true;
  }

  if (url.pathname === '/api/gateway/health' && req.method === 'GET') {
    const health = buildPublicGatewayStatus(
      ctx.gatewayManager.getStatus(),
      await readPlatformHealth(ctx),
    );
    sendJson(res, 200, {
      ok: health.healthSummary !== 'unresponsive',
      status: health.healthSummary,
      detail: health.gatewayReady ? undefined : 'gateway control channel not ready',
      portReachable: health.portReachable,
      connectionState: health.transportState,
      lastError: health.lastError,
      updatedAt: health.updatedAt,
    });
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
      const restart = await ctx.gatewayManager.restart();
      if (restart.status === 'restarted') {
        await recoverRuntimeHostGatewayConnection(ctx);
      }
      sendJson(res, 200, restart.status === 'deferred'
        ? { success: true, deferred: true }
        : { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/control-ui' && req.method === 'GET') {
    try {
      const status = ctx.gatewayManager.getStatus();
      const port = status.port || PORTS.OPENCLAW_GATEWAY;
      const urlValue = buildOpenClawControlUiUrl(port, '');
      sendJson(res, 200, { success: true, url: urlValue, port });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
