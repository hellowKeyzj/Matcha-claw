export type TeamApprovalStatus = 'pending' | 'approved' | 'denied' | 'aborted'

export interface TeamApproval {
  approvalId: string
  runId: string
  stageId: string
  roleId: string
  reason: string
  requestedAction: string
  risk: string
  status: TeamApprovalStatus
  note?: string
  idempotencyKey: string
  createdAt: number
  resolvedAt?: number
}
