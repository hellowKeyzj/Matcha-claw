import type { TeamDispatchEnvelope } from '../domain/team-dispatch.js'
import type { TeamDispatchExecutionRecord } from '../domain/team-dispatch-execution.js'
import type { TeamRoleBinding } from '../domain/team-role.js'

export interface TeamDispatchExecutionInput {
  runId: string
  dispatch: TeamDispatchEnvelope
  role: TeamRoleBinding
  prompt: string
}

export interface TeamDispatchExecutionResult {
  executionId: string
  status: 'queued'
  roleId: string
  dispatchId: string
  childSessionKey?: string
  spawnMode?: 'run' | 'session'
}

export interface TeamDispatchCancellationResult {
  executionRecordId: string
  executionId?: string
  childSessionKey?: string
  cancelled: boolean
  reason?: string
}

export interface RoleSessionExecutionPort {
  executeDispatch(input: TeamDispatchExecutionInput): Promise<TeamDispatchExecutionResult>
  cancelDispatchExecution(input: { execution: TeamDispatchExecutionRecord; reason: string }): Promise<TeamDispatchCancellationResult>
}
