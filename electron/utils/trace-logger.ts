import { logger } from './logger';
import { isTraceLogLevelEnabled, type TraceLogLevel } from './trace-log-level';

export function traceDebug(level: TraceLogLevel, message: string, ...args: unknown[]): void {
  if (!isTraceLogLevelEnabled(process.env.MATCHACLAW_TRACE_LOG_LEVEL, level)) {
    return;
  }
  logger.debug(message, ...args);
}
