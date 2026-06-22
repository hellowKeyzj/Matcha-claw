export type TeamMailKind =
  | 'task.assignment'
  | 'message.note'
  | 'message.question'
  | 'message.kickback';

export type TeamMailStatus = 'pending' | 'delivering' | 'delivered' | 'retry_scheduled' | 'failed' | 'cancelled';

export type TeamMailRelatedEntity =
  | { readonly kind: 'run'; readonly id: string }
  | { readonly kind: 'task'; readonly id: string }
  | { readonly kind: 'message'; readonly id: string }
  | { readonly kind: 'artifact'; readonly id: string }
  | { readonly kind: 'gate'; readonly id: string }
  | { readonly kind: 'dispatch'; readonly id: string };

export interface TeamMail {
  readonly mailId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly kind: TeamMailKind;
  readonly toAgentId: string;
  readonly fromAgentId?: string;
  readonly subject: string;
  readonly body?: string;
  readonly bodyRef?: string;
  readonly payloadRef?: string;
  readonly relatedEntity: TeamMailRelatedEntity;
  readonly status: TeamMailStatus;
  readonly idempotencyKey: string;
  readonly causationId: string;
  readonly createdAt: number;
  readonly updatedAt?: number;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly required?: boolean;
  readonly nextRetryAt?: number;
  readonly lastError?: string;
  readonly deliveringAt?: number;
  readonly deliveredAt?: number;
}
