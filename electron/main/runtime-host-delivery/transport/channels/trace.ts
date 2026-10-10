import { isTraceEnabled, traceDebug } from '../../../../utils/trace-logger';
import { SESSION_TRACE_HEADER } from '../sessions/trace';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readChannelTrace(headers: Record<string, string | string[] | undefined>): string | undefined {
  const value = headers[SESSION_TRACE_HEADER.toLowerCase()] ?? headers[SESSION_TRACE_HEADER];
  return typeof value === 'string' && UUID.test(value) ? value : undefined;
}

export function channelTraceHeaders(traceId: string | undefined): Record<string, string> {
  return traceId && UUID.test(traceId) ? { [SESSION_TRACE_HEADER]: traceId } : {};
}

export function beginChannelTrace(phase: string | (() => string), traceId: string | undefined) {
  if (!isTraceEnabled() || !traceId || !UUID.test(traceId)) return;
  const startedAt = performance.now();
  const tracePhase = typeof phase === 'function' ? phase() : phase;
  traceDebug(() => `[startup-trace] ${JSON.stringify({ source: 'electron-main', traceId, phase: `${tracePhase}.start`, at: Date.now() })}`);
  return (status: number, body: unknown, errorCode?: 'UNAVAILABLE' | 'ABORTED' | 'TIMEOUT' | 'INVALID_RESPONSE') => {
    traceDebug(() => {
      const value = body !== null && typeof body === 'object' && 'outcome' in body ? body.outcome : undefined;
      const valid = body !== null && typeof body === 'object' && 'valid' in body ? body.valid : undefined;
      const outcome = typeof value === 'string' && ['confirmed', 'connected', 'progress', 'target_rejected', 'unknown', 'rejected', 'cancelled'].includes(value)
        ? value : typeof valid === 'boolean' ? valid ? 'valid' : 'invalid' : status === 200 ? 'delivered' : 'unknown';
      return `[startup-trace] ${JSON.stringify({ source: 'electron-main', traceId, phase: `${tracePhase}.end`, at: Date.now(), durationMs: Math.round(performance.now() - startedAt), status, outcome, ...(errorCode ? { errorCode } : {}) })}`;
    });
  };
}

export function channelTraceError(error: unknown): 'UNAVAILABLE' | 'ABORTED' | 'TIMEOUT' {
  if (error instanceof Error && error.name === 'AbortError') return 'ABORTED';
  if (error instanceof Error && error.name === 'TimeoutError') return 'TIMEOUT';
  return 'UNAVAILABLE';
}
