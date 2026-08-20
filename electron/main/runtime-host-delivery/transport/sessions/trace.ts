const SESSION_TRACE_PREFIX = 'session-trace';
export const SESSION_TRACE_HEADER = 'X-MatchaClaw-Session-Trace';

type TracePayload = Record<string, unknown>;

export function isSessionTraceEnabled(): boolean {
  return process.env.MATCHACLAW_SESSION_TRACE === '1';
}

export function logSessionTrace(stage: string, traceId: string | null | undefined, payload: TracePayload = {}): void {
  if (!traceId || !isSessionTraceEnabled()) {
    return;
  }
  console.info(JSON.stringify({
    prefix: SESSION_TRACE_PREFIX,
    source: 'electron-main',
    traceId,
    stage,
    at: Date.now(),
    ...payload,
  }));
}

export function traceHeader(traceId: string | null | undefined): Record<string, string> {
  return traceId ? { [SESSION_TRACE_HEADER]: traceId } : {};
}

export function readTraceHeader(headers: Record<string, string | string[] | undefined>): string | null {
  const value = headers[SESSION_TRACE_HEADER.toLowerCase()] ?? headers[SESSION_TRACE_HEADER];
  const traceId = Array.isArray(value) ? value[0] : value;
  return typeof traceId === 'string' && traceId.length > 0 && traceId.length <= 256
    ? traceId
    : null;
}

export function summarizeIdentifier(value: string | null | undefined): { present: boolean; length: number } {
  return value ? { present: true, length: value.length } : { present: false, length: 0 };
}
