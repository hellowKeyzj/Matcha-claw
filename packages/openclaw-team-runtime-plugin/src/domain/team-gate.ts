export interface TeamGateFailureItem {
  code: string
  message: string
}

export interface TeamGateResult {
  gateId: string
  runId: string
  stageId: string
  artifactId: string
  gateType: string
  verdict: string
  passed: boolean
  failureItems: TeamGateFailureItem[]
  idempotencyKey: string
  createdAt: number
}
