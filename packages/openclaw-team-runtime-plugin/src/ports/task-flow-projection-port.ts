import type { TeamRun } from '../domain/team-run.js'
import type { TeamDispatchTaskRecord } from '../domain/team-workflow.js'

export interface TeamTaskFlowProjectionInput {
  run: TeamRun
  dispatchTasks: TeamDispatchTaskRecord[]
  reason: string
}

export interface TeamTaskUpdateProjectionInput {
  run: TeamRun
  taskId: string
  roleId: string
  status: 'in_progress' | 'waiting' | 'blocked'
  summary: string
  detail?: string
  progress?: number
  metadata?: Record<string, unknown>
}

export interface TaskFlowProjectionPort {
  projectTeamRun(input: TeamTaskFlowProjectionInput): Promise<void>
  projectTaskUpdate(input: TeamTaskUpdateProjectionInput): Promise<void>
}
