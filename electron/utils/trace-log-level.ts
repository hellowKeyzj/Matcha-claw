export type TraceLogLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const MAX_TRACE_LOG_LEVEL = 7;
const ENABLE_ALL_VALUES = new Set(['true', 'yes', 'on', 'all', '*', 'debug']);
const DISABLE_VALUES = new Set(['', '0', 'false', 'no', 'off']);

export function resolveTraceLogLevel(rawValue: string | undefined): number {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (DISABLE_VALUES.has(normalized)) {
    return 0;
  }
  if (ENABLE_ALL_VALUES.has(normalized)) {
    return MAX_TRACE_LOG_LEVEL;
  }
  const level = Number.parseInt(normalized, 10);
  if (!Number.isFinite(level) || level < 0) {
    return 0;
  }
  return Math.min(level, MAX_TRACE_LOG_LEVEL);
}

export function isTraceLogLevelEnabled(rawValue: string | undefined, level: TraceLogLevel): boolean {
  return resolveTraceLogLevel(rawValue) >= level;
}
