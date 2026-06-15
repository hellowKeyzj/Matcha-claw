export type TeamDispatchQueueItemStatus = 'pending' | 'dispatched' | 'failed' | 'cancelled'

export interface TeamDispatchQueueEntry {
  queueItemId: string
  runId: string
  toRoleId: string
  taskId?: string
  prompt: string
  status: TeamDispatchQueueItemStatus
  idempotencyKey: string
  createdAt: number
  dispatchedAt?: number
  failureReason?: string
}

export type TeamDispatchQueueItem = TeamDispatchQueueEntry

export function buildTaskSessionKey(agentId: string, taskId: string): string {
  return `agent:${agentId}:task:${taskId}`
}

export function buildRoleSessionKey(agentId: string): string {
  return `agent:${agentId}:main`
}
