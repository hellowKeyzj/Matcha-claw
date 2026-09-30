import type { IncomingMessage, ServerResponse } from 'http';
import { RuntimeHostControlError } from '../../main/runtime-host-delivery/control';
import type { RuntimeHostApiContext, RuntimeHostTransportContext } from '../context';
import { readGatewayStatusProjection, unavailableGatewayStatus } from './app';
import { sendJson } from '../route-utils';

const GATEWAY_CONTROL_UI_UNAVAILABLE = 'Gateway control UI URL is unavailable';

type GatewayApiContext = RuntimeHostApiContext & RuntimeHostTransportContext<'runtimeControlTransport'>;

export async function handleGatewayRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: GatewayApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/gateway/status' && req.method === 'GET') {
    const status = await readGatewayStatusProjection(ctx.runtimeHost)
      .then((projection) => projection ?? unavailableGatewayStatus());
    console.info('[startup-trace]', {
      source: 'api.gateway',
      phase: 'gateway-status-response',
      detail: 'sending /api/gateway/status summary',
      processState: status.processState,
      gatewayReady: status.gatewayReady,
      healthSummary: status.healthSummary,
      transportState: status.transportState,
      portReachable: status.portReachable,
    });
    sendJson(res, 200, status);
    return true;
  }

  if (url.pathname === '/api/gateway/health' && req.method === 'GET') {
    const status = await readGatewayStatusProjection(ctx.runtimeHost)
      .then((projection) => projection ?? unavailableGatewayStatus());
    sendJson(res, 200, {
      ok: status.healthSummary !== 'unresponsive',
      status: status.healthSummary,
      detail: status.gatewayReady ? undefined : 'gateway control channel not ready',
      portReachable: status.portReachable,
      connectionState: status.transportState,
      lastError: status.lastError,
      updatedAt: status.updatedAt,
    });
    return true;
  }

  if (url.pathname === '/api/gateway/start' && req.method === 'POST') {
    await handleLifecycleMutation(ctx, res, 'start');
    return true;
  }

  if (url.pathname === '/api/gateway/stop' && req.method === 'POST') {
    await handleLifecycleMutation(ctx, res, 'stop');
    return true;
  }

  if (url.pathname === '/api/gateway/restart' && req.method === 'POST') {
    await handleLifecycleMutation(ctx, res, 'restart');
    return true;
  }

  if (url.pathname === '/api/gateway/control-ui' && req.method === 'GET') {
    try {
      const response = await ctx.runtimeHostTransports.runtimeControlTransport.controlUiUrl();
      const controlUi = response.status === 200 ? readControlUiResult(response.body) : null;
      if (!controlUi) {
        sendJson(res, 503, { success: false, error: GATEWAY_CONTROL_UI_UNAVAILABLE });
        return true;
      }
      sendJson(res, 200, { success: true, ...controlUi });
    } catch {
      sendJson(res, 503, { success: false, error: GATEWAY_CONTROL_UI_UNAVAILABLE });
    }
    return true;
  }

  return false;
}

async function handleLifecycleMutation(
  ctx: GatewayApiContext,
  res: ServerResponse,
  operation: 'start' | 'stop' | 'restart',
): Promise<void> {
  try {
    const transport = ctx.runtimeHostTransports.runtimeControlTransport;
    const response = await transport[
      operation === 'start' ? 'lifecycleStart' : operation === 'stop' ? 'lifecycleStop' : 'lifecycleRestart'
    ]();
    if (response.status === 202) {
      sendJson(res, 202, response.body);
    } else {
      sendLifecycleFailure(res, operation, undefined, response.status);
    }
  } catch (error) {
    sendLifecycleFailure(res, operation, error, undefined);
  }
}

function sendLifecycleFailure(
  res: ServerResponse,
  operation: 'start' | 'stop' | 'restart',
  error: unknown,
  status: number | undefined,
): void {
  const unknown = status === 503
    || error instanceof RuntimeHostControlError && error.delivery === 'unknown-delivery';
  const unavailable = status === 400 || status === 401 || status === 422;
  sendJson(res, unknown || unavailable ? 503 : 500, {
    success: false,
    error: `Gateway ${operation} ${unknown ? 'outcome is unknown' : unavailable ? 'is unavailable' : 'failed'}`,
  });
}

function readControlUiResult(
  body: unknown,
): { url: string; port: number } | null {
  if (!isRecord(body)) return null;
  const result = body.result;
  if (!isRecord(result) || !hasExactKeys(result, ['url']) || typeof result.url !== 'string') return null;

  let parsed: URL;
  try {
    parsed = new URL(result.url);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.search) {
    return null;
  }
  const port = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : parsed.protocol === 'https:' ? 443 : 80;
  if (!Number.isSafeInteger(port) || port <= 0) return null;
  return { url: parsed.toString(), port };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
