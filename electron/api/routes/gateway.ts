import type { IncomingMessage, ServerResponse } from 'http';
import type {
  RuntimeHostControlOutcome,
} from '../../main/runtime-host-delivery/control';
import { RuntimeHostControlError } from '../../main/runtime-host-delivery/control';
import type { RuntimeHostApiContext } from '../context';
import { readGatewayStatusProjection, unavailableGatewayStatus } from './app';
import { sendJson } from '../route-utils';

const GATEWAY_CONTROL_UI_UNAVAILABLE = 'Gateway control UI URL is unavailable';

type GatewayLifecycle =
  | 'unavailable'
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'waitingToRestart'
  | 'failed'
  | 'shutDown';

export async function handleGatewayRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RuntimeHostApiContext,
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
      const outcome = await ctx.runtimeHost.command({ name: 'openclaw.control-ui.url' });
      const controlUi = readControlUiResult(outcome);
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
  ctx: RuntimeHostApiContext,
  res: ServerResponse,
  operation: 'start' | 'stop' | 'restart',
): Promise<void> {
  try {
    const outcome = await ctx.runtimeHost.command({ name: `openclaw.lifecycle.${operation}` });
    const lifecycle = readGatewayLifecycle(outcome);
    if (!lifecycle) {
      sendLifecycleFailure(res, operation, undefined, outcome);
      return;
    }
    sendJson(res, 200, operation === 'restart' && lifecycle === 'waitingToRestart'
      ? { success: true, deferred: true }
      : { success: true });
  } catch (error) {
    sendLifecycleFailure(res, operation, error, undefined);
  }
}

function sendLifecycleFailure(
  res: ServerResponse,
  operation: 'start' | 'stop' | 'restart',
  error: unknown,
  outcome: RuntimeHostControlOutcome | undefined,
): void {
  const unknown = outcome?.kind === 'unknown'
    || outcome?.kind === 'timed-out'
    || error instanceof RuntimeHostControlError && error.delivery === 'unknown-delivery';
  const unavailable = outcome?.kind === 'rejected' && outcome.error.code === 'UNAVAILABLE';
  sendJson(res, unknown || unavailable ? 503 : 500, {
    success: false,
    error: `Gateway ${operation} ${unknown ? 'outcome is unknown' : unavailable ? 'is unavailable' : 'failed'}`,
  });
}

function readGatewayLifecycle(outcome: RuntimeHostControlOutcome): GatewayLifecycle | null {
  if (outcome.kind !== 'succeeded' || !isRecord(outcome.result)) return null;
  const result = outcome.result.result;
  if (!isRecord(result)
    || !hasRequiredKeys(result, ['lifecycle'])
    || !Object.keys(result).every((key) => ['lifecycle', 'failure', 'startupDiagnostic'].includes(key))
    || !isGatewayLifecycle(result.lifecycle)
    || (result.failure !== undefined && typeof result.failure !== 'string')
    || (result.startupDiagnostic !== undefined && typeof result.startupDiagnostic !== 'string')) {
    return null;
  }
  return result.lifecycle;
}

function readControlUiResult(
  outcome: RuntimeHostControlOutcome,
): { url: string; port: number } | null {
  if (outcome.kind !== 'succeeded' || !isRecord(outcome.result)) return null;
  const result = outcome.result.result;
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

function isGatewayLifecycle(value: unknown): value is GatewayLifecycle {
  return value === 'unavailable'
    || value === 'idle'
    || value === 'starting'
    || value === 'running'
    || value === 'stopping'
    || value === 'waitingToRestart'
    || value === 'failed'
    || value === 'shutDown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasRequiredKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}
