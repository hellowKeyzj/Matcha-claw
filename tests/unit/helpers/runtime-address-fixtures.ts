import type { RuntimeEndpointRef, SessionIdentity } from '../../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { RuntimeSessionContext } from '../../../runtime-host/application/agent-runtime/contracts/runtime-endpoint-types';
import { OPENCLAW_RUNTIME_ADAPTER_ID, OPENCLAW_RUNTIME_PROTOCOL_ID, OPENCLAW_RUNTIME_ENDPOINT_ID, OPENCLAW_RUNTIME_INSTANCE_ID } from '../../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-identity';

export const openClawTestRuntimeEndpoint: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
  runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
};

export const openClawTestRuntimeIdentity = {
  protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
  runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
  eventIdPrefix: OPENCLAW_RUNTIME_PROTOCOL_ID,
};

export function createOpenClawTestSessionIdentity(
  sessionKey = 'agent:main:main',
  agentId = 'default',
): SessionIdentity {
  return {
    endpoint: openClawTestRuntimeEndpoint,
    agentId,
    sessionKey,
  };
}

export function createOpenClawTestRuntimeContext(
  sessionKey = 'agent:main:main',
  agentId = 'default',
): RuntimeSessionContext {
  const identity = createOpenClawTestSessionIdentity(sessionKey, agentId);
  return {
    identity,
    sessionKey,
    protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
    runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
    endpoint: {
      scopeKey: 'native:openclaw:openclaw:default',
      protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
      runtimeAdapterId: OPENCLAW_RUNTIME_ADAPTER_ID,
      runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
    },
    endpointRef: openClawTestRuntimeEndpoint,
    endpointSessionId: sessionKey,
    agentId,
  };
}
