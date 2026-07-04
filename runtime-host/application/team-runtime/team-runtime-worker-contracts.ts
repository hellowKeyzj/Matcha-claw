import type { ApplicationResponseOf } from '../common/application-response';
import type { RuntimeScope } from '../agent-runtime/contracts/runtime-address';
import type { TeamRuntimeOperationId } from './team-runtime-operation-id';
import type { TeamAgentMaterializationSpec, RemoveTeamAgentsInput } from './ports/team-agent-materialization-port';
import type {
  AbortTeamRoleSessionInput,
  DeleteTeamRoleSessionInput,
  EnsureTeamRoleSessionInput,
  PromptTeamRoleSessionInput,
  ReadTeamRoleSessionWindowInput,
} from './ports/team-role-session-port';
import type { DeleteTeamManagedAgentsJobPayload } from './team-runtime-jobs';

export interface TeamRuntimeWorkerConfig {
  readonly runtimeDataRootDir: string;
  readonly shardCount?: number;
}

export type TeamRuntimeWorkerRequest = {
  readonly type: 'team-runtime.invoke';
  readonly requestId: string;
  readonly operationId: TeamRuntimeOperationId;
  readonly params: unknown;
  readonly scope?: RuntimeScope;
};

export type TeamRuntimeWorkerCloseRequest = {
  readonly type: 'team-runtime.close';
  readonly requestId: string;
};

export type TeamRuntimeWorkerResponse =
  | {
      readonly type: 'team-runtime.result';
      readonly requestId: string;
      readonly ok: true;
      readonly response: ApplicationResponseOf;
    }
  | {
      readonly type: 'team-runtime.result';
      readonly requestId: string;
      readonly ok: false;
      readonly error: TeamRuntimeWorkerError;
    };

export interface TeamRuntimeWorkerError {
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
}

export type TeamRuntimeHostRequest =
  | {
      readonly type: 'host.roleSession.ensure';
      readonly requestId: string;
      readonly input: EnsureTeamRoleSessionInput;
    }
  | {
      readonly type: 'host.roleSession.prompt';
      readonly requestId: string;
      readonly input: PromptTeamRoleSessionInput;
    }
  | {
      readonly type: 'host.roleSession.abort';
      readonly requestId: string;
      readonly input: AbortTeamRoleSessionInput;
    }
  | {
      readonly type: 'host.roleSession.delete';
      readonly requestId: string;
      readonly input: DeleteTeamRoleSessionInput;
    }
  | {
      readonly type: 'host.roleSession.readWindow';
      readonly requestId: string;
      readonly input: ReadTeamRoleSessionWindowInput;
    }
  | {
      readonly type: 'host.agentMaterialization.materialize';
      readonly requestId: string;
      readonly input: TeamAgentMaterializationSpec;
    }
  | {
      readonly type: 'host.agentMaterialization.remove';
      readonly requestId: string;
      readonly input: RemoveTeamAgentsInput;
    }
  | {
      readonly type: 'host.job.deleteManagedAgents';
      readonly requestId: string;
      readonly input: DeleteTeamManagedAgentsJobPayload;
    }
  | {
      readonly type: 'host.skillCatalog.snapshot';
      readonly requestId: string;
      readonly input: Record<string, never>;
    };

export type TeamRuntimeHostResponse =
  | {
      readonly type: 'host.result';
      readonly requestId: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly type: 'host.result';
      readonly requestId: string;
      readonly ok: false;
      readonly error: TeamRuntimeWorkerError;
    };

export type TeamRuntimeMainToWorkerMessage = TeamRuntimeWorkerRequest | TeamRuntimeWorkerCloseRequest | TeamRuntimeHostResponse;
export type TeamRuntimeWorkerToMainMessage = TeamRuntimeWorkerResponse | TeamRuntimeHostRequest;
