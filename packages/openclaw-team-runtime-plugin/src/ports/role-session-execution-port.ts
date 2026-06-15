import type { TeamDispatchEnvelope } from '../domain/team-dispatch.js'
import type { TeamDispatchExecutionRecord } from '../domain/team-dispatch-execution.js'
import type { TeamRoleBinding } from '../domain/team-role.js'

export interface TeamLeaderExecutionInput {
  runId: string
  dispatch: TeamDispatchEnvelope
  role: TeamRoleBinding
  prompt: string
}

export interface TeamRoleExecutionInput {
  runId: string
  taskId: string
  dispatch: TeamDispatchEnvelope
  role: TeamRoleBinding
  prompt: string
}

export interface TeamMessageDeliveryInput {
  agentId: string
  taskId?: string
  body: string
  idempotencyKey: string
}

export interface TeamDispatchExecutionResult {
  executionId: string
  status: 'queued'
  roleId: string
  dispatchId: string
  childSessionKey?: string
  spawnMode?: 'run' | 'session'
}

export interface TeamRunSessionCancellationInput {
  runId: string
  executions: TeamDispatchExecutionRecord[]
  reason: string
}

export interface RoleSessionExecutionPort {
  executeLeader(input: TeamLeaderExecutionInput): Promise<TeamDispatchExecutionResult>
  executeRole(input: TeamRoleExecutionInput): Promise<TeamDispatchExecutionResult>
  sendMessage(input: TeamMessageDeliveryInput): Promise<{ sessionKey: string; runId: string }>
  cancelRunSessions(input: TeamRunSessionCancellationInput): Promise<void>
}
