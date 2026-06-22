import type {
  TeamIngressAckInput,
  TeamIngressAckResult,
  TeamIngressPort,
  TeamIngressPullInput,
  TeamIngressPullResult,
} from '../../../ports/team-ingress-port';
import type { SqliteTeamOutboxStore } from './sqlite-team-outbox-store';

export class SqliteTeamIngressAdapter implements TeamIngressPort {
  constructor(private readonly outboxStore: Pick<SqliteTeamOutboxStore, 'pull' | 'ack'>) {}

  async pull(input: TeamIngressPullInput): Promise<TeamIngressPullResult> {
    return await this.outboxStore.pull(input);
  }

  async ack(input: TeamIngressAckInput): Promise<TeamIngressAckResult> {
    return await this.outboxStore.ack(input);
  }
}
