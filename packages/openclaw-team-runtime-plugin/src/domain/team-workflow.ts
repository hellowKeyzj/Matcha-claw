export type TeamWorkflowPlanStatus = 'planned' | 'running' | 'completed' | 'failed' | 'cancelled'
export type TeamDispatchGroupStatus = 'queued' | 'completed' | 'failed' | 'cancelled'
export type TeamDispatchTaskStatus = 'queued' | 'completed' | 'failed' | 'cancelled' | 'stale'

export interface TeamWorkflowJoinPolicy {
  requireCompleted: boolean
  allowFailed: boolean
  retryLimit: number
}

export interface TeamWorkflowTaskPlan {
  taskId: string
  roleId: string
  title: string
  prompt: string
  dependsOnTaskIds: string[]
  outputArtifactKind?: string
}

export interface TeamWorkflowGroupPlan {
  groupId: string
  title: string
  taskIds: string[]
  join: TeamWorkflowJoinPolicy
}

export interface TeamRunWorkflowPlan {
  workflowPlanId: string
  runId: string
  title: string
  summary?: string
  status: TeamWorkflowPlanStatus
  groups: TeamWorkflowGroupPlan[]
  tasks: TeamWorkflowTaskPlan[]
  idempotencyKey: string
  createdAt: number
}

export interface TeamDispatchGroupRecord {
  dispatchGroupId: string
  runId: string
  workflowPlanId: string
  groupId: string
  taskIds: string[]
  status: TeamDispatchGroupStatus
  idempotencyKey: string
  createdAt: number
  completedAt?: number
}

export interface TeamDispatchTaskRecord {
  dispatchTaskId: string
  runId: string
  workflowPlanId: string
  dispatchGroupId: string
  groupId: string
  taskId: string
  roleId: string
  dispatchId: string
  status: TeamDispatchTaskStatus
  idempotencyKey: string
  createdAt: number
  attemptCount: number
  completedAt?: number
  artifactId?: string
  statusReason?: string
}
