export type TeamNodePromptDeliveryKind = 'node.prompt';

export type TeamNodePromptDeliveryStatus = 'pending' | 'delivering' | 'delivered' | 'retry_scheduled' | 'failed' | 'cancelled';

export interface TeamNodePromptDeliveryRecord {
  readonly deliveryRecordId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly nodeExecutionId: string;
  readonly taskId: string;
  readonly roleId: string;
  readonly toAgentId: string;
  readonly sessionKey: string;
  readonly kind: TeamNodePromptDeliveryKind;
  readonly title: string;
  readonly prompt: string;
  readonly displayMessage?: string;
  readonly status: TeamNodePromptDeliveryStatus;
  readonly idempotencyKey: string;
  readonly causationId: string;
  readonly createdAt: number;
  readonly updatedAt?: number;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly nextRetryAt?: number;
  readonly lastError?: string;
  readonly deliveringAt?: number;
  readonly deliveredAt?: number;
}
