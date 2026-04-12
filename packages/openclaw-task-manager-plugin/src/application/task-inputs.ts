import type { TaskStatus } from '../domain/task-status.js'
import type { TaskCreateInput, TaskUpdateInput } from '../infrastructure/task-store.js'
import { asRecord, toNonEmptyString } from '../shared/params.js'
import { parseAgentIdFromSessionKey } from './task-store-context.js'

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
  }
}

export function toTaskUpdateInput(params: InputRecord): TaskUpdateInput {
  const metadata = toMetadata(params.metadata)
  return {
    taskId: toNonEmptyString(params.taskId, 'taskId'),
    ...(typeof params.status === 'string' ? { status: params.status as TaskStatus } : {}),
    ...(typeof params.subject === 'string' ? { subject: params.subject } : {}),
    ...(typeof params.description === 'string' ? { description: params.description } : {}),
    ...(typeof params.activeForm === 'string' || params.activeForm === null
      ? { activeForm: params.activeForm as string | null }
      : {}),
    ...(typeof params.owner === 'string' || params.owner === null
      ? { owner: params.owner as string | null }
      : {}),
    ...(Array.isArray(params.addBlockedBy) ? { addBlockedBy: params.addBlockedBy as string[] } : {}),
    ...(Array.isArray(params.addBlocks) ? { addBlocks: params.addBlocks as string[] } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

export function resolveClaimOwner(input: {
  owner?: unknown
  sessionKey?: string
}): string {
  if (typeof input.owner === 'string' && input.owner.trim().length > 0) {
    return input.owner.trim()
  }
  return parseAgentIdFromSessionKey(input.sessionKey)
}
