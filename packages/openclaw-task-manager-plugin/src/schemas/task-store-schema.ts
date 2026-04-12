import type { TaskItem } from '../domain/task-item.js'
import { isTaskStatus } from '../domain/task-status.js'
import { normalizeStringList } from '../shared/params.js'

export const taskListParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskListId: { type: 'string' },
  },
} as const

export const taskGetParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId'],
  properties: {
    taskListId: { type: 'string' },
    taskId: { type: 'string' },
  },
} as const

export const taskClaimParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId'],
  properties: {
    taskListId: { type: 'string' },
    taskId: { type: 'string' },
    owner: { type: 'string' },
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
