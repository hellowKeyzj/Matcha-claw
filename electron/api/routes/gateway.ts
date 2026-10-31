import { traceDebug } from '../../utils/trace-logger';
import { RuntimeHostControlError } from '../../main/runtime-host-delivery/control';
import type { RuntimeHostApiContext, RuntimeHostTransportContext } from '../context';
import { unavailableGatewayStatus } from '../../main/runtime-host-delivery/status';
import { jsonResult, type HostApiRequest, type HostApiResponse, type HostApiRouteResult } from '../execution';

const GATEWAY_CONTROL_UI_UNAVAILABLE = 'Gateway control UI URL is unavailable';

type GatewayApiContext = RuntimeHostApiContext & RuntimeHostTransportContext<'runtimeControlTransport'>;

export async function handleGatewayRoutes(
  req: HostApiRequest,
  url: URL,
  ctx: GatewayApiContext,
): Promise<HostApiRouteResult> {
  if (url.pathname === '/api/gateway/status' && req.method === 'GET') {
    const status = await ctx.runtimeStatus.readGateway()
      .then((projection) => projection ?? unavailableGatewayStatus());
    traceDebug(() => ['[startup-trace]', {
      source: 'api.gateway',
      phase: 'gateway-status-response',
      detail: 'sending /api/gateway/status summary',
      processState: status.processState,
      gatewayReady: status.gatewayReady,
      healthSummary: status.healthSummary,
      transportState: status.transportState,
      portReachable: status.portReachable,
    }]);
    return jsonResult(200, status);
  }

  if (url.pathname === '/api/gateway/health' && req.method === 'GET') {
    const status = await ctx.runtimeStatus.readGateway()
      .then((projection) => projection ?? unavailableGatewayStatus());
    return jsonResult(200, {
      ok: status.healthSummary !== 'unresponsive',
      status: status.healthSummary,
      detail: status.gatewayReady ? undefined : 'gateway control channel not ready',
      portReachable: status.portReachable,
      connectionState: status.transportState,
      lastError: status.lastError,
      updatedAt: status.updatedAt,
    });
  }

  if (url.pathname === '/api/gateway/start' && req.method === 'POST') {
    return handleLifecycleMutation(ctx, 'start');
  }

  if (url.pathname === '/api/gateway/stop' && req.method === 'POST') {
    return handleLifecycleMutation(ctx, 'stop');
  }

  if (url.pathname === '/api/gateway/restart' && req.method === 'POST') {
    return handleLifecycleMutation(ctx, 'restart');
  }

  if (url.pathname === '/api/gateway/repair' && req.method === 'POST') {
    return handleLifecycleMutation(ctx, 'repair');
  }

  if (url.pathname === '/api/gateway/repair' && req.method === 'GET') {
    try {
      const response = await ctx.runtimeHostTransports.runtimeControlTransport.repairStatus();
      if (response.status === 200) {
        return jsonResult(200, response.body.result);
      } else {
        return jsonResult(503, { success: false, error: 'Gateway repair status is unavailable' });
      }
    } catch {
      return jsonResult(503, { success: false, error: 'Gateway repair status is unavailable' });
    }
  }

  if (url.pathname === '/api/gateway/control-ui' && req.method === 'GET') {
    try {
      const response = await ctx.runtimeHostTransports.runtimeControlTransport.controlUiUrl();
      const controlUi = response.status === 200 ? readControlUiResult(response.body) : null;
      if (!controlUi) {
        return jsonResult(503, { success: false, error: GATEWAY_CONTROL_UI_UNAVAILABLE });
      }
      return jsonResult(200, { success: true, ...controlUi });
    } catch {
      return jsonResult(503, { success: false, error: GATEWAY_CONTROL_UI_UNAVAILABLE });
    }
  }

  return undefined;
}

async function handleLifecycleMutation(
  ctx: GatewayApiContext,
  operation: 'start' | 'stop' | 'restart' | 'repair',
): Promise<HostApiResponse> {
  try {
    const transport = ctx.runtimeHostTransports.runtimeControlTransport;
    const response = await transport[
      operation === 'start' ? 'lifecycleStart' : operation === 'stop' ? 'lifecycleStop' : operation === 'repair' ? 'lifecycleRepair' : 'lifecycleRestart'
    ]();
    if (response.status === 202) {
      return jsonResult(202, response.body);
    } else {
      return sendLifecycleFailure(operation, undefined, response.status);
    }
  } catch (error) {
    return sendLifecycleFailure(operation, error, undefined);
  }
}

function sendLifecycleFailure(
  operation: 'start' | 'stop' | 'restart' | 'repair',
  error: unknown,
  status: number | undefined,
): HostApiResponse {
  if (status === 409) {
    return jsonResult(409, { success: false, error: `Gateway ${operation} is busy` });
  }
  const unknown = status === 503
    || error instanceof RuntimeHostControlError && error.delivery === 'unknown-delivery';
  const unavailable = status === 400 || status === 401 || status === 422;
  return jsonResult(unknown || unavailable ? 503 : 500, {
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
