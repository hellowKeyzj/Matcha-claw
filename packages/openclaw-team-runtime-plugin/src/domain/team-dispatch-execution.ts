export type TeamDispatchExecutionStatus = 'claimed' | 'queued' | 'completed' | 'failed' | 'stale' | 'cancelled'

export interface TeamDispatchExecutionRecord {
  executionRecordId: string
  runId: string
  dispatchId: string
  stageId: string
  roleId: string
  executionId?: string
  childSessionKey?: string
  spawnMode?: 'run' | 'session'
  status: TeamDispatchExecutionStatus
  statusReason?: string
  staleAt?: number
  idempotencyKey: string
  createdAt: number
}
