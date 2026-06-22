export interface TeamEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly causationId: string;
  readonly idempotencyKey: string;
  readonly createdAt: number;
}
