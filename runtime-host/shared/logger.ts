const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export interface RuntimeHostLogger {
  readonly debug: (message: string, ...args: unknown[]) => void;
  readonly info: (message: string, ...args: unknown[]) => void;
  readonly warn: (message: string, ...args: unknown[]) => void;
  readonly error: (message: string, ...args: unknown[]) => void;
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
  message: string,
  args: unknown[],
): void {
  const timestamp = new Date().toISOString();
  const normalizedMessage = serializeLogValue(message);
  const normalizedArgs = args
    .map((value) => serializeLogValue(value))
    .filter((value) => value.length > 0)
    .join(' ');
  const suffix = normalizedArgs ? ` ${normalizedArgs}` : '';
  const formatted = `[${timestamp}] [${level.padEnd(5)}] [runtime-host:${scope}] ${normalizedMessage}${suffix}`;

  if (level === 'DEBUG') {
    console.debug(formatted);
    return;
  }
  if (level === 'INFO') {
    console.info(formatted);
    return;
  }
  if (level === 'WARN') {
    console.warn(formatted);
    return;
  }
  console.error(formatted);
}

export function createRuntimeLogger(scope: string): RuntimeHostLogger {
  return {
    debug: (message, ...args) => writeLog('DEBUG', scope, message, args),
    info: (message, ...args) => writeLog('INFO', scope, message, args),
    warn: (message, ...args) => writeLog('WARN', scope, message, args),
    error: (message, ...args) => writeLog('ERROR', scope, message, args),
  };
}

export const runtimeLogger = createRuntimeLogger('core');
