import type { TeamAgentCommand, TeamAgentCommandLedgerRecord } from '../domain/team-command-ledger';

export interface AppendTeamAgentCommandInput {
  readonly command: TeamAgentCommand;
  readonly status: TeamAgentCommandLedgerRecord['status'];
  readonly rejectionReason?: string;
}

export interface TeamCommandLedgerPort {
  append(input: AppendTeamAgentCommandInput): Promise<TeamAgentCommandLedgerRecord>;
}
