import type { RuntimeEndpointRef } from '../../../agent-runtime/contracts/runtime-address';
import { OPENCLAW_RUNTIME_ADAPTER_ID, OPENCLAW_RUNTIME_INSTANCE_ID } from '../../../adapters/openclaw/runtime/openclaw-runtime-identity';
import type { GatewayRpcPort } from '../../../gateway/gateway-runtime-port';
import type { TeamRoleSessionBinding } from '../../domain/team-run';
import type { TeamRoleEndpointSessionMaterializationPort } from '../../ports/team-role-session-materialization-port';

const OPENCLAW_SESSION_CREATE_METHOD = 'sessions.create';
const OPENCLAW_SESSION_CREATE_TIMEOUT_MS = 10_000;

export class OpenClawTeamRoleSessionMaterializationAdapter implements TeamRoleEndpointSessionMaterializationPort {
  constructor(private readonly deps: {
    readonly gateway: Pick<GatewayRpcPort, 'gatewayRpc'>;
  }) {}

  async materializeEndpointSession(binding: TeamRoleSessionBinding): Promise<void> {
    if (!isOpenClawRuntimeEndpoint(binding.sessionIdentity.endpoint)) {
      return;
    }
    await this.deps.gateway.gatewayRpc(OPENCLAW_SESSION_CREATE_METHOD, {
      key: binding.sessionKey,
      agentId: binding.agentId,
    }, OPENCLAW_SESSION_CREATE_TIMEOUT_MS);
  }
}

function isOpenClawRuntimeEndpoint(endpoint: RuntimeEndpointRef): boolean {
  return endpoint.kind === 'native-runtime'
    && endpoint.runtimeAdapterId === OPENCLAW_RUNTIME_ADAPTER_ID
    && endpoint.runtimeInstanceId === OPENCLAW_RUNTIME_INSTANCE_ID;
}
