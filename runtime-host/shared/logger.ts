import { isTraceLogLevelEnabled, type TraceLogLevel } from './trace-log-level';

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export interface RuntimeHostLogger {
  readonly debug: (message: string, ...args: unknown[]) => void;
  readonly traceDebug?: (level: TraceLogLevel, message: string, ...args: unknown[]) => void;
  readonly info: (message: string, ...args: unknown[]) => void;
  readonly warn: (message: string, ...args: unknown[]) => void;
  readonly error: (message: string, ...args: unknown[]) => void;
}

export interface RuntimeLoggerClock {
  nowIso(): string;
}

export interface RuntimeLogSink {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function sanitizeLogFragment(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' | ');
}

function serializeLogValue(value: unknown): string {
  if (value instanceof Error) {
    const message = sanitizeLogFragment(value.message || 'Error');
    const stack = typeof value.stack === 'string' ? sanitizeLogFragment(value.stack) : '';
    return stack ? `${message} ${stack}` : message;
  }

  if (typeof value === 'string') {
    return sanitizeLogFragment(value);
  }

  if (typeof value === 'object' && value !== null) {
    try {
      return sanitizeLogFragment(JSON.stringify(value));
    } catch {
      return sanitizeLogFragment(String(value));
    }
  }

  return sanitizeLogFragment(String(value));
}

function writeLog(
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
  scope: string,
  clock: RuntimeLoggerClock,
  sink: RuntimeLogSink,
  message: string,
  args: unknown[],
): void {
  const timestamp = clock.nowIso();
  const normalizedMessage = serializeLogValue(message);
  const normalizedArgs = args
    .map((value) => serializeLogValue(value))
    .filter((value) => value.length > 0)
    .join(' ');
  const suffix = normalizedArgs ? ` ${normalizedArgs}` : '';
  const formatted = `[${timestamp}] [${level.padEnd(5)}] [runtime-host:${scope}] ${normalizedMessage}${suffix}`;

  if (level === 'DEBUG') {
    sink.debug(formatted);
    return;
  }
  if (level === 'INFO') {
    sink.info(formatted);
    return;
  }
  if (level === 'WARN') {
    sink.warn(formatted);
    return;
  }
  sink.error(formatted);
}

export function createRuntimeLogger(scope: string, clock: RuntimeLoggerClock, sink: RuntimeLogSink): RuntimeHostLogger {
  return {
    debug: (message, ...args) => writeLog('DEBUG', scope, clock, sink, message, args),
    traceDebug: (level, message, ...args) => {
      if (isTraceLogLevelEnabled(process.env.MATCHACLAW_TRACE_LOG_LEVEL, level)) {
        writeLog('DEBUG', scope, clock, sink, message, args);
      }
    },
    info: (message, ...args) => writeLog('INFO', scope, clock, sink, message, args),
    warn: (message, ...args) => writeLog('WARN', scope, clock, sink, message, args),
    error: (message, ...args) => writeLog('ERROR', scope, clock, sink, message, args),
  };
}
