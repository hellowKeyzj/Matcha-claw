export interface TeamEvent {
  eventId: string
  runId: string
  revision: number
  type: string
  payload: Record<string, unknown>
  createdAt: number
}
