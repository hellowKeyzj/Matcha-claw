export interface TeamMessage {
  messageId: string
  runId: string
  fromRoleId: string
  toRoleId: string
  summary: string
  body: string
  idempotencyKey: string
  createdAt: number
  dispatchedAt?: number
}
