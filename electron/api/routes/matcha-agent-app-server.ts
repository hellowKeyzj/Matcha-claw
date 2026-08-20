import type { IncomingMessage, ServerResponse } from 'http';
import type { RuntimeHostControlOutcome } from '../../main/runtime-host-delivery/control';
import { RuntimeHostControlError } from '../../main/runtime-host-delivery/control';
import type { RuntimeHostApiContext } from '../context';
import { sendJson } from '../route-utils';

const STATUS_UNAVAILABLE = 'Matcha Agent app server status is unavailable';
const RESTART_UNAVAILABLE = 'Matcha Agent app server restart failed';
const RESTART_UNKNOWN = 'Matcha Agent app server restart outcome is unknown';

type MatchaLifecycle =
  | 'unavailable'
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'waitingToRestart'
  | 'failed'
  | 'shutDown';

export async function handleMatchaAgentAppServerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RuntimeHostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/matcha-agent/app-server/status' && req.method === 'GET') {
    try {
      const outcome = await ctx.runtimeHost.command({ name: 'matcha.lifecycle.status' });
      const status = readMatchaStatus(outcome);
      if (!status) {
        sendJson(res, 503, { success: false, error: STATUS_UNAVAILABLE });
        return true;
      }
      sendJson(res, 200, status);
    } catch {
      sendJson(res, 503, { success: false, error: STATUS_UNAVAILABLE });
    }
    return true;
  }

  if (url.pathname === '/api/matcha-agent/app-server/restart' && req.method === 'POST') {
    try {
      const outcome = await ctx.runtimeHost.command({ name: 'matcha.lifecycle.restart' });
      if (outcome.kind === 'timed-out') {
        sendJson(res, 503, { success: false, error: RESTART_UNKNOWN });
        return true;
      }
      if (!readMatchaLifecycle(outcome)) {
        sendJson(res, 500, { success: false, error: RESTART_UNAVAILABLE });
        return true;
      }
      sendJson(res, 200, { success: true });
    } catch (error) {
      const unknown = error instanceof RuntimeHostControlError
        && error.delivery === 'unknown-delivery';
      sendJson(res, unknown ? 503 : 500, {
        success: false,
        error: unknown ? RESTART_UNKNOWN : RESTART_UNAVAILABLE,
      });
    }
    return true;
  }

  return false;
}

function readMatchaStatus(outcome: RuntimeHostControlOutcome): {
  processState: MatchaLifecycle;
  port: number | null;
  pid: number | null;
  ready: boolean;
  lastError: string | null;
  updatedAt: number;
} | null {
  if (outcome.kind !== 'succeeded' || !isRecord(outcome.result)) return null;
  const result = outcome.result.result;
  if (!isRecord(result)
    || !isMatchaLifecycle(result.lifecycle)
    || typeof result.ready !== 'boolean'
    || !isSafeNonNegativeInteger(result.observedAtMs)
    || (result.failure !== undefined && typeof result.failure !== 'string')
    || (result.startupDiagnostic !== undefined && typeof result.startupDiagnostic !== 'string')
    || Object.keys(result).some((key) => !['lifecycle', 'ready', 'observedAtMs', 'failure', 'startupDiagnostic'].includes(key))) {
    return null;
  }
  return {
    processState: result.lifecycle,
    port: null,
    pid: null,
    ready: result.ready,
    lastError: readSafeStatusError(result),
    updatedAt: result.observedAtMs,
  };
}

function readSafeStatusError(result: Record<string, unknown>): string | null {
  const failure = typeof result.failure === 'string' ? result.failure : null;
  const startupDiagnostic = typeof result.startupDiagnostic === 'string' ? result.startupDiagnostic : null;
  return startupDiagnostic ?? failure;
}

function readMatchaLifecycle(outcome: RuntimeHostControlOutcome): MatchaLifecycle | null {
  if (outcome.kind !== 'succeeded' || !isRecord(outcome.result)) return null;
  const result = outcome.result.result;
  if (!isRecord(result)
    || Object.keys(result).length !== 1
    || !Object.hasOwn(result, 'lifecycle')
    || !isMatchaLifecycle(result.lifecycle)) {
    return null;
  }
  return result.lifecycle;
}

function isMatchaLifecycle(value: unknown): value is MatchaLifecycle {
  return value === 'unavailable'
    || value === 'idle'
    || value === 'starting'
    || value === 'running'
    || value === 'stopping'
    || value === 'waitingToRestart'
    || value === 'failed'
    || value === 'shutDown';
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
