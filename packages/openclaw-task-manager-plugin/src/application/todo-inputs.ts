import type { TodoItem } from '../domain/task-item.js'
import type { TodoStatus } from '../domain/task-status.js'
import { TaskStoreError } from '../shared/errors.js'

type TodoWriteInput = {
  newTodos: TodoItem[]
}

function readTodoStatus(value: unknown, field: string): TodoStatus {
  if (value === 'pending' || value === 'in_progress' || value === 'completed') {
    return value
  }
  throw new TaskStoreError('invalid_params', `${field} must be one of: pending, in_progress, completed`)
}

function optionalNonEmptyString(item: Record<string, unknown>, field: string, path: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(item, field)) {
    return undefined
  }
  const value = item[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TaskStoreError('invalid_params', `${path}.${field} must be a non-empty string when provided`)
  }
  return value.trim()
}

function parseTodoItem(value: unknown, index: number): TodoItem {
  const path = `newTodos[${index}]`
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskStoreError('invalid_params', `${path} must be an object`)
  }

  const item = value as Record<string, unknown>
  if (typeof item.content !== 'string' || item.content.trim().length === 0) {
    throw new TaskStoreError('invalid_params', `${path}.content is required`)
  }
  if (!Object.prototype.hasOwnProperty.call(item, 'status')) {
    throw new TaskStoreError('invalid_params', `${path}.status is required`)
  }

  const id = optionalNonEmptyString(item, 'id', path)
  const activeForm = optionalNonEmptyString(item, 'activeForm', path)
  const owner = optionalNonEmptyString(item, 'owner', path)

  return {
    ...(id ? { id } : {}),
    content: item.content.trim(),
    ...(activeForm ? { activeForm } : {}),
    status: readTodoStatus(item.status, `${path}.status`),
    ...(owner ? { owner } : {}),
  }
}

function parseTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) {
    throw new TaskStoreError('invalid_params', 'newTodos must be an array')
  }
  return value.map(parseTodoItem)
}

export function parseTodoWriteInput(params: Record<string, unknown>): TodoWriteInput {
  if (!Object.prototype.hasOwnProperty.call(params, 'newTodos')) {
    throw new TaskStoreError('invalid_params', 'newTodos is required')
  }
  return {
    newTodos: parseTodoItems(params.newTodos),
  }
}
