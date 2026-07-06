import type { TeamNodePromptDeliveryRecord } from '../domain/team-node-prompt-delivery';
import type { TeamRoleSessionBinding } from '../domain/team-run';

export type TeamNodePromptDeliveryStatus = 'delivered' | 'failed';

export interface TeamNodePromptDeliveryInput {
  readonly delivery: TeamNodePromptDeliveryRecord;
  readonly binding: TeamRoleSessionBinding;
  readonly idempotencyKey: string;
}

export interface TeamNodePromptDeliveryResult {
  readonly deliveryRecordId: string;
  readonly status: TeamNodePromptDeliveryStatus;
  readonly reason?: string;
  readonly deliveredAt?: number;
  readonly promptRunId?: string;
}

export interface TeamNodePromptDeliveryPort {
  deliver(input: TeamNodePromptDeliveryInput): Promise<TeamNodePromptDeliveryResult>;
}
