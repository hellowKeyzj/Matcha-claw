import type { RuntimeEndpointRef, SessionIdentity } from '../../agent-runtime/contracts/runtime-address';
import type { TeamRoleSessionBinding } from '../domain/team-run';

export interface EnsureTeamRoleSessionInput {
  readonly teamId?: string;
  readonly runId: string;
  readonly roleId: string;
  readonly agentId: string;
  readonly endpointRef: RuntimeEndpointRef;
  readonly localSessionId: string;
  readonly endpointSessionId: string;
  readonly sessionIdentity?: SessionIdentity;
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
  readonly localSessionId: string;
  readonly promptRunId: string;
}

export interface AbortTeamRoleSessionInput {
  readonly binding: TeamRoleSessionBinding;
  readonly runId?: string;
}

export interface DeleteTeamRoleSessionInput {
  readonly binding: TeamRoleSessionBinding;
}

export interface RememberTeamRoleSessionBindingInput {
  readonly binding: TeamRoleSessionBinding;
}

export interface ReadTeamRoleSessionWindowInput {
  readonly binding: TeamRoleSessionBinding;
  readonly limit?: number;
}

export type TeamRoleSessionWindow =
  | {
      readonly resultType: 'available';
      readonly localSessionId: string;
      readonly items: readonly unknown[];
    }
  | {
      readonly resultType: 'pending_hydration';
      readonly localSessionId: string;
      readonly message: string;
    }
  | {
      readonly resultType: 'unavailable';
      readonly localSessionId: string;
      readonly message: string;
    };

export interface TeamRoleSessionPort {
  ensureRoleSession(input: EnsureTeamRoleSessionInput): Promise<TeamRoleSessionBinding>;
  rememberRoleSessionBinding(input: RememberTeamRoleSessionBindingInput): Promise<void>;
  promptRoleSession(input: PromptTeamRoleSessionInput): Promise<TeamRolePromptResult>;
  abortRoleSession(input: AbortTeamRoleSessionInput): Promise<void>;
  deleteRoleSession(input: DeleteTeamRoleSessionInput): Promise<void>;
  readRoleSessionWindow(input: ReadTeamRoleSessionWindowInput): Promise<TeamRoleSessionWindow>;
}
