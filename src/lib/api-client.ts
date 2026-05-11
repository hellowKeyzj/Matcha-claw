import { trackUiEvent } from './telemetry';
import {
  AppError,
  type AppErrorCode,
  normalizeAppError,
} from './error-model';
export { AppError } from './error-model';

const SLOW_REQUEST_THRESHOLD_MS = 800;

function shouldLogApiRequests(): boolean {
  try {
    return import.meta.env.DEV || window.localStorage.getItem('clawx:api-log') === '1';
  } catch {
    return !!import.meta.env.DEV;
  }
}

function logApiAttempt(entry: {
  requestId: string;
  channel: string;
  durationMs: number;
  ok: boolean;
  error?: unknown;
}): void {
  if (!shouldLogApiRequests()) return;
  const base = `[api-client] id=${entry.requestId} channel=${entry.channel} transport=ipc durationMs=${entry.durationMs}`;
  if (entry.ok) {
    console.info(`${base} result=ok`);
  } else {
    console.warn(`${base} result=error`, entry.error);
  }
}

export function initializeDefaultTransports(): void {
  // Renderer backend calls intentionally have one transport: Electron IPC.
}

export function toUserMessage(error: unknown): string {
  const appError = error instanceof AppError ? error : normalizeAppError(error);

  switch (appError.code) {
    case 'AUTH_INVALID':
      return 'Authentication failed. Check API key or login session and retry.';
    case 'TIMEOUT':
      return 'Request timed out. Please retry.';
    case 'RATE_LIMIT':
      return 'Too many requests. Please wait and try again.';
    case 'PERMISSION':
      return 'Permission denied. Check your configuration and retry.';
    case 'CHANNEL_UNAVAILABLE':
      return 'Service channel unavailable. Retry after restarting the app or gateway.';
    case 'NETWORK':
      return 'Network error. Please verify connectivity and retry.';
    case 'CONFIG':
      return 'Configuration is invalid. Please review settings.';
    case 'GATEWAY':
      return 'Gateway is unavailable. Start or restart the gateway and retry.';
    default:
      return appError.message || 'Unexpected error occurred.';
  }
}

export async function invokeApi<T>(channel: string, ...args: unknown[]): Promise<T> {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const value = await window.electron.ipcRenderer.invoke(channel, ...args) as T;
    const durationMs = Date.now() - startedAt;
    logApiAttempt({
      requestId,
      channel,
      durationMs,
      ok: true,
    });
    if (durationMs >= SLOW_REQUEST_THRESHOLD_MS) {
      trackUiEvent('api.request', {
        requestId,
        channel,
        transport: 'ipc',
        durationMs,
      });
    }
    return value;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logApiAttempt({
      requestId,
      channel,
      durationMs,
      ok: false,
      error: err,
    });
    trackUiEvent('api.request_error', {
      requestId,
      channel,
      transport: 'ipc',
      durationMs,
      message: err instanceof Error ? err.message : String(err),
    });
    throw normalizeAppError(err, {
      requestId,
      channel,
      transport: 'ipc',
      durationMs,
    });
  }
}

export async function invokeIpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invokeApi<T>(channel, ...args);
}

export async function invokeIpcWithRetry<T>(
  channel: string,
  args: unknown[] = [],
  retries = 1,
  retryable: AppErrorCode[] = ['TIMEOUT', 'NETWORK'],
): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i <= retries; i += 1) {
    try {
      return await invokeApi<T>(channel, ...args);
    } catch (err) {
      lastError = err;
      if (!(err instanceof AppError) || !retryable.includes(err.code) || i === retries) {
        throw err;
      }
    }
  }

  throw normalizeAppError(lastError);
}
