import type { IncomingMessage, ServerResponse } from 'http';
import {
  MATCHA_AGENT_RUNTIME_ENDPOINT,
  type RuntimeLifecycleResponse,
  type RuntimeStateProjection,
} from '../../main/runtime-host-delivery/transport/runtime-control';
import type { RuntimeHostTransportContext } from '../context';
import { sendJson } from '../route-utils';

const STATUS_UNAVAILABLE = 'Matcha Agent app server status is unavailable';
const RESTART_UNAVAILABLE = 'Matcha Agent app server restart failed';
const RESTART_UNKNOWN = 'Matcha Agent app server restart outcome is unknown';
const STARTUP_TRACE_PREFIX = '[startup-trace]';

function summarizeMatchaStatusTrace(status: {
  processState: MatchaLifecycle;
  port: number | null;
  pid: number | null;
  ready: boolean;
  lastError: string | null;
  updatedAt: number;
} | null) {
  if (!status) return null;
  return {
    processState: status.processState,
    ready: status.ready,
    port: status.port,
    pid: status.pid,
    observedAtMs: status.updatedAt,
    hasLastError: Boolean(status.lastError),
  };
}

function traceMatchaStatusRoute(phase: string, payload: Record<string, unknown>): void {
  console.info(STARTUP_TRACE_PREFIX, {
    source: 'api.matcha-agent',
    phase,
    atMs: Date.now(),
    ...payload,
  });
}

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
  ctx: RuntimeHostTransportContext<'runtimeControlTransport'>,
): Promise<boolean> {
  if (url.pathname === '/api/matcha-agent/app-server/status' && req.method === 'GET') {
    const startedAtMs = Date.now();
    traceMatchaStatusRoute('matcha-agent-status-request-start', {});
    try {
      const response = await ctx.runtimeHostTransports.runtimeControlTransport.lifecycleStatus(MATCHA_AGENT_RUNTIME_ENDPOINT);
      const status = response.status === 200 ? readMatchaStatus(response.body) : null;
      if (!status) {
        traceMatchaStatusRoute('matcha-agent-status-unavailable', {
          durationMs: Date.now() - startedAtMs,
        });
        sendJson(res, 503, { success: false, error: STATUS_UNAVAILABLE });
        return true;
      }
      traceMatchaStatusRoute('matcha-agent-status-response', {
        durationMs: Date.now() - startedAtMs,
        ...(summarizeMatchaStatusTrace(status) ?? {}),
      });
      sendJson(res, 200, status);
    } catch (error) {
      traceMatchaStatusRoute('matcha-agent-status-error', {
        durationMs: Date.now() - startedAtMs,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      sendJson(res, 503, { success: false, error: STATUS_UNAVAILABLE });
    }
    return true;
  }

  if (url.pathname === '/api/matcha-agent/app-server/restart' && req.method === 'POST') {
    try {
      const response = await ctx.runtimeHostTransports.runtimeControlTransport.lifecycleRestart(MATCHA_AGENT_RUNTIME_ENDPOINT);
      if (response.status === 503) {
        sendJson(res, 503, { success: false, error: RESTART_UNKNOWN });
        return true;
      }
      if (response.status !== 200 || !readMatchaLifecycle(response.body)) {
        sendJson(res, 500, { success: false, error: RESTART_UNAVAILABLE });
        return true;
      }
      sendJson(res, 200, { success: true });
    } catch {
      sendJson(res, 500, {
        success: false,
        error: RESTART_UNAVAILABLE,
      });
    }
    return true;
  }

  return false;
}

function readMatchaStatus(body: RuntimeLifecycleResponse): {
  processState: MatchaLifecycle;
  port: number | null;
  pid: number | null;
  ready: boolean;
  lastError: string | null;
  updatedAt: number;
} | null {
  const result = body.result;
  if (!isRecord(result)
    || !isMatchaLifecycle(result.lifecycle)
    || (result.failure !== undefined && typeof result.failure !== 'string')
    || (result.startupDiagnostic !== undefined && typeof result.startupDiagnostic !== 'string')
    || Object.keys(result).some((key) => !['lifecycle', 'failure', 'startupDiagnostic'].includes(key))) {
    return null;
  }
  return {
    processState: result.lifecycle,
    port: null,
    pid: null,
    ready: result.lifecycle === 'running',
    lastError: readSafeStatusError(result),
    updatedAt: Date.now(),
  };
}

function readSafeStatusError(result: RuntimeStateProjection): string | null {
  const failure = typeof result.failure === 'string' ? result.failure : null;
  const startupDiagnostic = typeof result.startupDiagnostic === 'string' ? result.startupDiagnostic : null;
  return startupDiagnostic ?? failure;
}

function readMatchaLifecycle(body: RuntimeLifecycleResponse): MatchaLifecycle | null {
  const result = body.result;
  if (!isRecord(result)
    || !isMatchaLifecycle(result.lifecycle)
    || (result.failure !== undefined && typeof result.failure !== 'string')
    || (result.startupDiagnostic !== undefined && typeof result.startupDiagnostic !== 'string')
    || Object.keys(result).some((key) => !['lifecycle', 'failure', 'startupDiagnostic'].includes(key))) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
