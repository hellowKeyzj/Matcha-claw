import type { ClassifiedError } from '../protocol/types.js'

export function classifyWorkerError(
  error: unknown,
  fallbackType: ClassifiedError['type'] = 'internal',
): ClassifiedError {
  if (isAbortLikeError(error)) {
    return {
      type: 'aborted',
      message: errorToMessage(error, 'Operation was aborted'),
      retryable: false,
    }
  }

  return {
    type: fallbackType,
    message: errorToMessage(error, 'Worker operation failed'),
    retryable: fallbackType === 'network' || fallbackType === 'worker',
  }
}

export function errorToMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message
  }
  if (typeof error === 'string' && error.trim() !== '') {
    return error
  }
  if (hasMessage(error)) {
    return error.message
  }
  return fallback
}

function hasMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.trim() !== ''
  )
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.name === 'APIUserAbortError'
  }
  return false
}
