export interface TeamNotificationInput {
  readonly runId: string;
  readonly subject: string;
  readonly message: string;
  readonly idempotencyKey: string;
}

export interface TeamNotificationResult {
  readonly delivered: boolean;
  readonly reason?: string;
}

export interface TeamNotificationPort {
  notify(input: TeamNotificationInput): Promise<TeamNotificationResult>;
}
