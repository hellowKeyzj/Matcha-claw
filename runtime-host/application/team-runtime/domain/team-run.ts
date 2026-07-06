import type { RuntimeEndpointRef, SessionIdentity } from '../../agent-runtime/contracts/runtime-address';

export type TeamRunStatus =
  | 'created'
  | 'provisioning'
  | 'waiting_for_user'
  | 'running'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TeamRun {
  readonly teamId?: string;
  readonly runId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly sourcePath: string;
  readonly status: TeamRunStatus;
  readonly currentWorkflowTaskId?: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TeamRunRuntimeBinding {
  readonly runId: string;
  readonly endpoint: RuntimeEndpointRef;
  readonly leader: TeamRoleSessionBinding;
  readonly roles: readonly TeamRoleSessionBinding[];
}

export interface TeamRoleSessionBinding {
  readonly teamId?: string;
  readonly runId: string;
  readonly roleId: string;
  readonly agentId: string;
  readonly endpointRef: RuntimeEndpointRef;
  readonly localSessionId: string;
  readonly endpointSessionId: string;
  readonly sessionIdentity: SessionIdentity;
}
