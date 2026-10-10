import { logger, type DebugMessage } from './logger';

export function isTraceEnabled(): boolean {
  return process.env.MATCHACLAW_TRACE === '1';
}

export function traceDebug(message: DebugMessage, ...args: unknown[]): void {
  if (!isTraceEnabled()) return;
  logger.debug(message, ...args);
}
