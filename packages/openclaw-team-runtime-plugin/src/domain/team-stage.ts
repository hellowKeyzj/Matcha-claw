export type TeamStageStatus = 'pending' | 'running' | 'waiting_for_user' | 'passed' | 'failed' | 'skipped' | 'cancelled'

export interface TeamStage {
  runId: string
  stageId: string
  title: string
  executor: string
  roleId?: string
  gateType?: string
  status: TeamStageStatus
  attempt: number
  maxAttempts: number
  inputArtifactIds: string[]
  outputArtifactIds: string[]
  createdAt: number
  updatedAt: number
}
