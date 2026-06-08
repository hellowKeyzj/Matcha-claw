import type { TeamGateFailureItem } from './team-gate.js'

export interface TeamKickback {
  kickbackId: string
  runId: string
  stageId: string
  gateId: string
  failureItems: TeamGateFailureItem[]
  idempotencyKey: string
  createdAt: number
}
