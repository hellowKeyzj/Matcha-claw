const HISTORY_ABORT_ERROR_NAME = 'AbortError';

function createAbortReasonError(reason?: string): Error {
  const message = reason && reason.trim().length > 0
    ? reason
    : 'history_load_aborted';
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, HISTORY_ABORT_ERROR_NAME);
  }
  const error = new Error(message);
  error.name = HISTORY_ABORT_ERROR_NAME;
  return error;
}

export function createHistoryLoadAbortError(reason?: string): Error {
  return createAbortReasonError(reason);
}

export function isHistoryLoadAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const maybeError = error as { name?: string; code?: string };
  if (maybeError.name === HISTORY_ABORT_ERROR_NAME || maybeError.code === 'ERR_ABORTED') {
    return true;
  }
  return false;
}

export function throwIfHistoryLoadAborted(
  signal: AbortSignal,
  isAborted?: () => boolean,
): void {
  if (signal.aborted || isAborted?.()) {
    throw createAbortReasonError('history_load_aborted');
  }
}
