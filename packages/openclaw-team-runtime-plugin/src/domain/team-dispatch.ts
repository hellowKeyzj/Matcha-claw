export interface TeamDispatchEnvelope {
  dispatchId: string
  runId: string
  stageId: string
  roleId: string
  promptRef: string
  inputArtifactIds: string[]
  kickbackIds: string[]
  idempotencyKey: string
  createdAt: number
}
