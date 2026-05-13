import type { TaskStatus } from '../domain/task-status.js'
import { isTaskStatus } from '../domain/task-status.js'
import type { TaskCreateInput, TaskUpdateInput } from '../infrastructure/session-task-store.js'
import { TaskStoreError } from '../shared/errors.js'
import { toNonEmptyString } from '../shared/params.js'

type InputRecord = Record<string, unknown>

const UPDATE_FIELDS = [
  'status',
  'subject',
  'description',
  'activeForm',
  'owner',
  'addBlockedBy',
  'addBlocks',
  'metadata',
] as const

function hasOwn(params: InputRecord, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(params, field)
}

function optionalNonEmptyString(params: InputRecord, field: string): string | undefined {
  if (!hasOwn(params, field)) {
    return undefined
  }
  const value = params[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TaskStoreError('invalid_params', `${field} must be a non-empty string when provided`)
  }
  return value.trim()
}

function optionalMetadata(params: InputRecord): Record<string, unknown> | undefined {
  if (!hasOwn(params, 'metadata')) {
    return undefined
  }
  const value = params.metadata
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskStoreError('invalid_params', 'metadata must be an object')
  }
  return value as Record<string, unknown>
}

function optionalStatus(params: InputRecord): TaskStatus | undefined {
  if (!hasOwn(params, 'status')) {
    return undefined
  }
  if (!isTaskStatus(params.status)) {
    throw new TaskStoreError('invalid_params', 'status must be one of: pending, in_progress, completed, deleted')
  }
  return params.status
}

function optionalStringList(params: InputRecord, field: 'addBlockedBy' | 'addBlocks'): string[] | undefined {
  if (!hasOwn(params, field)) {
    return undefined
  }
  const value = params[field]
  if (!Array.isArray(value)) {
    throw new TaskStoreError('invalid_params', `${field} must be an array of task IDs`)
  }

  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new TaskStoreError('invalid_params', `${field} must contain only non-empty strings`)
    }
    const trimmed = item.trim()
    if (!seen.has(trimmed)) {
      seen.add(trimmed)
      result.push(trimmed)
    }
  }
  return result
}

export function parseTaskCreateInput(params: InputRecord): TaskCreateInput {
  const metadata = optionalMetadata(params)
  const activeForm = optionalNonEmptyString(params, 'activeForm')
  const owner = optionalNonEmptyString(params, 'owner')
  return {
    subject: toNonEmptyString(params.subject, 'subject'),
    description: toNonEmptyString(params.description, 'description'),
    ...(activeForm ? { activeForm } : {}),
    ...(metadata ? { metadata } : {}),
    ...(owner ? { owner } : {}),
  }
}

export function parseTaskUpdateInput(params: InputRecord): TaskUpdateInput {
  const taskId = toNonEmptyString(params.taskId, 'taskId')

  if (!UPDATE_FIELDS.some(field => hasOwn(params, field))) {
    throw new TaskStoreError('invalid_params', 'TaskUpdate requires at least one field to update')
  }

  const status = optionalStatus(params)
  const subject = optionalNonEmptyString(params, 'subject')
  const description = optionalNonEmptyString(params, 'description')
  const activeForm = optionalNonEmptyString(params, 'activeForm')
  const owner = optionalNonEmptyString(params, 'owner')
  const addBlockedBy = optionalStringList(params, 'addBlockedBy')
  const addBlocks = optionalStringList(params, 'addBlocks')
  const metadata = optionalMetadata(params)

  return {
    taskId,
    ...(status ? { status } : {}),
    ...(subject ? { subject } : {}),
    ...(description ? { description } : {}),
    ...(activeForm ? { activeForm } : {}),
    ...(owner ? { owner } : {}),
    ...(addBlockedBy ? { addBlockedBy } : {}),
    ...(addBlocks ? { addBlocks } : {}),
    ...(metadata ? { metadata } : {}),
  }
}
