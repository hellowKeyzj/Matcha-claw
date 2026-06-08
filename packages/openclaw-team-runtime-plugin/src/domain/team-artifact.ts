export interface TeamArtifact {
  artifactId: string
  runId: string
  stageId: string
  roleId: string
  kind: string
  title: string
  contentRef: string
  summary?: string
  idempotencyKey: string
  createdAt: number
}
