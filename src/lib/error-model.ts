export type AppErrorCode =
  | 'AUTH_INVALID'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'RATE_LIMIT'
  | 'PERMISSION'
  | 'CHANNEL_UNAVAILABLE'
  | 'UNAVAILABLE'
  | 'NETWORK'
  | 'CONFIG'
  | 'GATEWAY'
  | 'UNKNOWN';

export class AppError extends Error {
  code: AppErrorCode;
  cause?: unknown;
  details?: Record<string, unknown>;

  constructor(code: AppErrorCode, message: string, cause?: unknown, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.details = details;
  }
}

export function mapBackendErrorCode(code?: string): AppErrorCode {
  switch (code) {
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'ABORTED':
      return 'ABORTED';
    case 'UNAVAILABLE':
      return 'UNAVAILABLE';
    case 'PERMISSION':
      return 'PERMISSION';
    case 'GATEWAY':
      return 'GATEWAY';
    case 'VALIDATION':
      return 'CONFIG';
    case 'UNSUPPORTED':
      return 'CHANNEL_UNAVAILABLE';
    default:
      return 'UNKNOWN';
  }
}

function classifyMessage(message: string): AppErrorCode {
  const lower = message.toLowerCase();

  if (
    lower.includes('invalid ipc channel')
    || lower.includes('no handler registered')
    || lower.includes('window is not defined')
    || lower.includes('unsupported')
  ) {
    return 'CHANNEL_UNAVAILABLE';
  }
  if (
    lower.includes('invalid authentication')
    || lower.includes('unauthorized')
    || lower.includes('auth failed')
    || lower.includes('401')
  ) {
    return 'AUTH_INVALID';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'TIMEOUT';
  }
  if (lower.includes('abort')) {
    return 'ABORTED';
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return 'RATE_LIMIT';
  }
  if (
    lower.includes('permission')
    || lower.includes('forbidden')
    || lower.includes('denied')
    || lower.includes('403')
  ) {
    return 'PERMISSION';
  }
  if (
    lower.includes('network')
    || lower.includes('fetch')
    || lower.includes('econnrefused')
    || lower.includes('econnreset')
    || lower.includes('enotfound')
  ) {
    return 'NETWORK';
  }
  if (lower.includes('gateway')) {
    return 'GATEWAY';
  }
  if (lower.includes('config') || lower.includes('invalid') || lower.includes('validation') || lower.includes('400')) {
    return 'CONFIG';
  }

  return 'UNKNOWN';
}

function getStructuredErrorCode(err: unknown): AppErrorCode | null {
  if (!err || typeof err !== 'object' || !('code' in err)) {
    return null;
  }
  const code = mapBackendErrorCode((err as { code?: unknown }).code as string | undefined);
  return code === 'UNKNOWN' ? null : code;
}

export function normalizeAppError(err: unknown, details?: Record<string, unknown>): AppError {
  if (err instanceof AppError) {
    return new AppError(err.code, err.message, err.cause ?? err, { ...(err.details ?? {}), ...(details ?? {}) });
  }

  const message = err instanceof Error ? err.message : String(err);
  return new AppError(getStructuredErrorCode(err) ?? classifyMessage(message), message, err, details);
}

