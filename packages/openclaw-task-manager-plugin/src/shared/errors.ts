export type TaskStoreErrorCode =
  | 'invalid_params'
  | 'task_not_found'
  | 'already_claimed'
  | 'blocked'
  | 'invalid_transition'
  | 'store_unavailable'

export class TaskStoreError extends Error {
  constructor(
    public readonly code: TaskStoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TaskStoreError'
  }
}

export type TaskStoreErrorPayload = {
  code: string
  message: string
  statusCode: number
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function mapTaskStoreError(error: unknown): TaskStoreErrorPayload {
  if (error instanceof TaskStoreError) {
    switch (error.code) {
      case 'invalid_params':
        return { code: error.code, message: error.message, statusCode: 400 }
      case 'task_not_found':
        return { code: error.code, message: error.message, statusCode: 404 }
      case 'already_claimed':
      case 'blocked':
      case 'invalid_transition':
        return { code: error.code, message: error.message, statusCode: 409 }
      case 'store_unavailable':
      default:
        return { code: error.code, message: error.message, statusCode: 500 }
    }
  }

  return {
    code: 'internal_error',
    message: toErrorMessage(error),
    statusCode: 500,
  }
}
