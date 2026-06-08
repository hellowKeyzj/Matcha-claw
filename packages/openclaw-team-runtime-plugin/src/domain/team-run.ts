export type TeamRunStatus =
  | 'created'
  | 'provisioning'
  | 'waiting_for_user'
  | 'running'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface TeamRun {
  runId: string
  packageName: string
  packageVersion: string
  sourcePath: string
  status: TeamRunStatus
  currentStageId?: string
  revision: number
  createdAt: number
  updatedAt: number
}
