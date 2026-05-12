import type { TaskStatus } from '../domain/task-status.js'
import type { TaskCreateInput, TaskUpdateInput } from '../infrastructure/session-task-store.js'
import { asRecord, toNonEmptyString } from '../shared/params.js'

type InputRecord = Record<string, unknown>

function toMetadata(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value)
}

export function toTaskCreateInput(params: InputRecord): TaskCreateInput {
  const metadata = toMetadata(params.metadata)
  return {
    subject: toNonEmptyString(params.subject, 'subject'),
    description: toNonEmptyString(params.description, 'description'),
    ...(typeof params.activeForm === 'string' && params.activeForm.trim().length > 0
      ? { activeForm: params.activeForm.trim() }
      : {}),
    ...(metadata ? { metadata } : {}),
    ...(typeof params.owner === 'string' && params.owner.trim().length > 0
      ? { owner: params.owner.trim() }
      : {}),
  }
}

export function toTaskUpdateInput(params: InputRecord): TaskUpdateInput {
  const metadata = toMetadata(params.metadata)
  return {
    taskId: toNonEmptyString(params.taskId, 'taskId'),
    ...(typeof params.status === 'string' ? { status: params.status as TaskStatus } : {}),
    ...(typeof params.subject === 'string' ? { subject: params.subject } : {}),
    ...(typeof params.description === 'string' ? { description: params.description } : {}),
    ...(typeof params.activeForm === 'string'
      ? { activeForm: params.activeForm }
      : {}),
    ...(typeof params.owner === 'string'
      ? { owner: params.owner }
      : {}),
    ...(Array.isArray(params.addBlockedBy) ? { addBlockedBy: params.addBlockedBy as string[] } : {}),
    ...(Array.isArray(params.addBlocks) ? { addBlocks: params.addBlocks as string[] } : {}),
    ...(metadata ? { metadata } : {}),
  }
}
