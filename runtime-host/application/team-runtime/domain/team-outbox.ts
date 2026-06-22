import type { TeamInboundEnvelope } from './team-envelope';

export type TeamOutboxRecordStatus = 'pending' | 'claimed' | 'acked';

export interface TeamOutboxRecord {
  readonly recordId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly idempotencyKey: string;
  readonly envelope: TeamInboundEnvelope;
  readonly status: TeamOutboxRecordStatus;
  readonly claimedBy?: string;
  readonly claimExpiresAt?: number;
  readonly ackedAt?: number;
  readonly createdAt: number;
}

export interface TeamDirtyRun {
  readonly runId: string;
  readonly latestSequence: number;
  readonly pendingCount?: number;
}
