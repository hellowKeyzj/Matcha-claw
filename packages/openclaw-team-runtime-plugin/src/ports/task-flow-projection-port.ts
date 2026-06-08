import type { TeamRun } from '../domain/team-run.js'
import type { TeamStage } from '../domain/team-stage.js'

export interface TeamTaskFlowProjectionInput {
  run: TeamRun
  stages: TeamStage[]
  reason: string
}

export interface TeamTaskUpdateProjectionInput {
  run: TeamRun
  stage: TeamStage
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
