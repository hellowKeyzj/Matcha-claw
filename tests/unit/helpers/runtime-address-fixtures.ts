import type { RuntimeAddress } from '../../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { RuntimeSessionContext } from '../../../runtime-host/application/agent-runtime/contracts/runtime-endpoint-types';
import { OPENCLAW_RUNTIME_ADAPTER_ID, OPENCLAW_RUNTIME_PROTOCOL_ID, OPENCLAW_RUNTIME_ENDPOINT_ID, OPENCLAW_RUNTIME_INSTANCE_ID } from '../../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-identity';

export const openClawTestRuntimeIdentity = {
  protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
  runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
  eventIdPrefix: OPENCLAW_RUNTIME_PROTOCOL_ID,
};

export function createOpenClawTestRuntimeAddress(
  sessionKey = 'agent:main:main',
  agentId = 'default',
): RuntimeAddress {
  return {
    kind: 'native-runtime',
    capabilityId: 'session.prompt',
    runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
    runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
    agentId,
    sessionKey,
  };
}

export function createOpenClawTestRuntimeContext(
  sessionKey = 'agent:main:main',
  agentId = 'default',
): RuntimeSessionContext {
  return {
    sessionKey,
    protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
    runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
    endpointSessionId: sessionKey,
    agentId,
    address: createOpenClawTestRuntimeAddress(sessionKey, agentId),
  };
}
