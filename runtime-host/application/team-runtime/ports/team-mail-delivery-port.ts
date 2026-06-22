import type { TeamMail } from '../domain/team-mail';
import type { TeamRoleSessionBinding } from '../domain/team-run';

export type TeamMailDeliveryStatus = 'delivered' | 'failed';

export interface TeamMailDeliveryInput {
  readonly mail: TeamMail;
  readonly binding: TeamRoleSessionBinding;
  readonly idempotencyKey: string;
}

export interface TeamMailDeliveryResult {
  readonly mailId: string;
  readonly status: TeamMailDeliveryStatus;
  readonly reason?: string;
  readonly deliveredAt?: number;
}

export interface TeamMailDeliveryPort {
  deliver(input: TeamMailDeliveryInput): Promise<TeamMailDeliveryResult>;
}
