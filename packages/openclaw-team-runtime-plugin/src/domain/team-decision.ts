export type TeamDecisionType = 'retry' | 'proceed_degraded' | 'abort'

export interface TeamDecision {
  decisionId: string
  runId: string
  stageId: string
  decision: TeamDecisionType
  note?: string
  idempotencyKey: string
  createdAt: number
}
