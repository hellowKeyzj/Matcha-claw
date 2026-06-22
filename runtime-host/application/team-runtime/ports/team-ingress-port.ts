import type { TeamOutboxRecord } from '../domain/team-outbox';

export interface TeamIngressPullInput {
  readonly runId: string;
  readonly afterSequence: number;
  readonly limit: number;
  readonly consumerId: string;
  readonly leaseMs: number;
}

export interface TeamIngressPullResult {
  readonly runId: string;
  readonly records: readonly TeamOutboxRecord[];
  readonly hasMore: boolean;
}

export interface TeamIngressAckInput {
  readonly runId: string;
  readonly sequences: readonly number[];
  readonly consumerId: string;
}

export interface TeamIngressAckResult {
  readonly runId: string;
  readonly ackedSequences: readonly number[];
}

export interface TeamIngressPort {
  pull(input: TeamIngressPullInput): Promise<TeamIngressPullResult>;
  ack(input: TeamIngressAckInput): Promise<TeamIngressAckResult>;
}
