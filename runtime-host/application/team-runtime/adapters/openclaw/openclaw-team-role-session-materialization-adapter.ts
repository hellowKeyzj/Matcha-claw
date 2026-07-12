import type { RuntimeEndpointRef } from '../../../agent-runtime/contracts/runtime-address';
import { OPENCLAW_RUNTIME_ADAPTER_ID, OPENCLAW_RUNTIME_INSTANCE_ID } from '../../../adapters/openclaw/runtime/openclaw-runtime-identity';
import type { GatewayRpcPort } from '../../../gateway/gateway-runtime-port';
import type { TeamRoleSessionBinding } from '../../domain/team-run';
import type { TeamRoleEndpointSessionMaterializationPort } from '../../ports/team-role-session-materialization-port';

const OPENCLAW_SESSION_CREATE_METHOD = 'sessions.create';
const OPENCLAW_SESSION_DELETE_METHOD = 'sessions.delete';
const OPENCLAW_SESSION_CREATE_TIMEOUT_MS = 10_000;
const OPENCLAW_SESSION_DELETE_TIMEOUT_MS = 10_000;

function resolveOpenClawTeamRoleSessionKey(binding: TeamRoleSessionBinding): string {
  return `agent:${binding.agentId}:${binding.endpointSessionId}`;
}

export class OpenClawTeamRoleSessionMaterializationAdapter implements TeamRoleEndpointSessionMaterializationPort {
  constructor(private readonly deps: {
    readonly gateway: Pick<GatewayRpcPort, 'gatewayRpc'>;
  }) {}

  resolveEndpointSessionId(binding: TeamRoleSessionBinding): string {
    return isOpenClawRuntimeEndpoint(binding.endpointRef)
      ? resolveOpenClawTeamRoleSessionKey(binding)
      : binding.endpointSessionId;
  }

  async materializeEndpointSession(binding: TeamRoleSessionBinding): Promise<void> {
    if (!isOpenClawRuntimeEndpoint(binding.endpointRef)) {
      return;
    }
    await this.deps.gateway.gatewayRpc(OPENCLAW_SESSION_CREATE_METHOD, {
      key: this.resolveEndpointSessionId(binding),
      agentId: binding.agentId,
    }, OPENCLAW_SESSION_CREATE_TIMEOUT_MS);
  }

  async dematerializeEndpointSession(binding: TeamRoleSessionBinding): Promise<void> {
    if (!isOpenClawRuntimeEndpoint(binding.endpointRef)) {
      return;
    }
    await this.deps.gateway.gatewayRpc(OPENCLAW_SESSION_DELETE_METHOD, {
      key: this.resolveEndpointSessionId(binding),
    }, OPENCLAW_SESSION_DELETE_TIMEOUT_MS);
  }
}

function isOpenClawRuntimeEndpoint(endpoint: RuntimeEndpointRef): boolean {
  return endpoint.kind === 'native-runtime'
    && endpoint.runtimeAdapterId === OPENCLAW_RUNTIME_ADAPTER_ID
    && endpoint.runtimeInstanceId === OPENCLAW_RUNTIME_INSTANCE_ID;
}
