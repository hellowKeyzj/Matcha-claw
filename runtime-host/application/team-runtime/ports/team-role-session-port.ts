import type { SessionIdentity } from '../../agent-runtime/contracts/runtime-address';
import type { TeamRoleSessionBinding } from '../domain/team-run';

export interface EnsureTeamRoleSessionInput {
  readonly teamId?: string;
  readonly runId: string;
  readonly roleId: string;
  readonly agentId: string;
  readonly sessionIdentity: SessionIdentity;
}

export interface PromptTeamRoleSessionInput {
  readonly binding: TeamRoleSessionBinding;
  readonly message: string;
  readonly displayMessage?: string;
  readonly idempotencyKey: string;
  readonly deliver?: boolean;
}

export interface TeamRolePromptResult {
  readonly runId: string;
  readonly roleId: string;
  readonly sessionKey: string;
  readonly promptRunId: string;
}

export interface AbortTeamRoleSessionInput {
  readonly binding: TeamRoleSessionBinding;
  readonly runId?: string;
}

export interface DeleteTeamRoleSessionInput {
  readonly binding: TeamRoleSessionBinding;
}

export interface ReadTeamRoleSessionWindowInput {
  readonly binding: TeamRoleSessionBinding;
  readonly limit?: number;
}

export type TeamRoleSessionWindow =
  | {
      readonly resultType: 'available';
      readonly sessionKey: string;
      readonly items: readonly unknown[];
    }
  | {
      readonly resultType: 'pending_hydration';
      readonly sessionKey: string;
      readonly message: string;
    }
  | {
      readonly resultType: 'unavailable';
      readonly sessionKey: string;
      readonly message: string;
    };

export interface TeamRoleSessionPort {
  ensureRoleSession(input: EnsureTeamRoleSessionInput): Promise<TeamRoleSessionBinding>;
  promptRoleSession(input: PromptTeamRoleSessionInput): Promise<TeamRolePromptResult>;
  abortRoleSession(input: AbortTeamRoleSessionInput): Promise<void>;
  deleteRoleSession(input: DeleteTeamRoleSessionInput): Promise<void>;
  readRoleSessionWindow(input: ReadTeamRoleSessionWindowInput): Promise<TeamRoleSessionWindow>;
}
