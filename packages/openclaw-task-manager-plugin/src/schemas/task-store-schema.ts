import type { TaskItem } from '../domain/task-item.js'
import { isTaskStatus } from '../domain/task-status.js'
import { normalizeStringList } from '../shared/params.js'

export const taskListParameters = {
  type: 'object',
  description: 'List persisted tasks and the session todo list. No parameters.',
  additionalProperties: false,
  properties: {},
} as const

export const taskGetParameters = {
  type: 'object',
  description: 'Get one persisted task by ID.',
  additionalProperties: false,
  required: ['taskId'],
  properties: {
    taskId: { type: 'string', description: 'Required. The ID of the task to retrieve.' },
  },
} as const

export const todoGetParameters = {
  type: 'object',
  description: 'Get the current session todo list. No parameters.',
  additionalProperties: false,
  properties: {},
} as const

export const taskOutputParameters = {
  type: 'object',
  description: 'Get current output for a background task by ID.',
  additionalProperties: false,
  required: ['taskId'],
  properties: {
    taskId: { type: 'string', description: 'Required. The ID of the background task.' },
  },
} as const

export const taskStopParameters = {
  type: 'object',
  description: 'Stop a background task by ID.',
  additionalProperties: false,
  required: ['taskId'],
  properties: {
    taskId: { type: 'string', description: 'Required. The ID of the background task to stop.' },
  },
} as const

export const todoItemParameters = {
  type: 'object',
  description: 'One todo item in the replacement todo list.',
  additionalProperties: false,
  required: ['content', 'status'],
  properties: {
    id: { type: 'string', description: 'Optional stable todo ID.' },
    content: { type: 'string', description: 'Required. Todo text shown to the user.' },
    activeForm: { type: 'string', description: 'Optional. Present-progress label shown while in_progress.' },
    status: {
      type: 'string',
      enum: ['pending', 'in_progress', 'completed'],
      description: 'Required. Todo status: pending, in_progress, or completed.',
    },
    owner: { type: 'string', description: 'Optional owner name or agent id.' },
  },
} as const

export const todoWriteParameters = {
  type: 'object',
  description: 'Replace the current session todo list. newTodos is required. Pass newTodos: [] to explicitly clear the list.',
  additionalProperties: false,
  required: ['newTodos'],
  properties: {
    newTodos: {
      type: 'array',
      description: 'Required. Complete replacement list after the update. Example: {"newTodos":[{"content":"Analyze page structure","status":"pending"},{"content":"Implement task state","status":"in_progress"}]}. Use newTodos: [] only when clearing all todos.',
      items: todoItemParameters,
    },
  },
} as const

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

export function normalizeTaskRecord(raw: unknown): TaskItem | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const row = raw as Record<string, unknown>
  const id = asTrimmedString(row.id)
  const subject = asTrimmedString(row.subject)
  const description = asTrimmedString(row.description)
  const createdAt = asTimestamp(row.createdAt)
  const updatedAt = asTimestamp(row.updatedAt)

  if (!id || !subject || !description || !createdAt || !updatedAt || !isTaskStatus(row.status)) {
    return null
  }

  const normalized: TaskItem = {
    id,
    subject,
    description,
    status: row.status,
    blockedBy: normalizeStringList(row.blockedBy),
    blocks: normalizeStringList(row.blocks),
    createdAt,
    updatedAt,
  }

  const activeForm = asTrimmedString(row.activeForm)
  const owner = asTrimmedString(row.owner)
  const metadata = asMetadata(row.metadata)

  if (activeForm) {
    normalized.activeForm = activeForm
  }
  if (owner) {
    normalized.owner = owner
  }
  if (metadata) {
    normalized.metadata = metadata
  }

  return normalized
}
