import { buildRuntimeEndpointKey, type RuntimeEndpointRef, type SessionIdentity } from './runtime-address';
import {
  type RuntimeEndpointIdentity,
  type RuntimeEndpointId,
  type RuntimeProtocolId,
  type RuntimeSessionContext,
} from './runtime-endpoint-types';

function buildRuntimeEndpointIdentity(endpoint: RuntimeEndpointRef): RuntimeEndpointIdentity {
  if (endpoint.kind === 'protocol-connector') {
    return {
      scopeKey: buildRuntimeEndpointKey(endpoint),
      protocolId: endpoint.protocolId,
      connectorId: endpoint.connectorId,
      endpointId: endpoint.endpointId,
    };
  }
  return {
    scopeKey: buildRuntimeEndpointKey(endpoint),
    runtimeAdapterId: endpoint.runtimeAdapterId,
    runtimeInstanceId: endpoint.runtimeInstanceId,
  };
}

export function createRuntimeSessionContext(input: {
  identity: SessionIdentity;
  protocolId: RuntimeProtocolId;
  runtimeEndpointId: RuntimeEndpointId;
  endpointSessionId?: string;
}): RuntimeSessionContext {
  return {
    identity: input.identity,
    sessionKey: input.identity.sessionKey,
    protocolId: input.protocolId,
    runtimeEndpointId: input.runtimeEndpointId,
    endpoint: buildRuntimeEndpointIdentity(input.identity.endpoint),
    endpointRef: input.identity.endpoint,
    ...(input.endpointSessionId ? { endpointSessionId: input.endpointSessionId } : {}),
    agentId: input.identity.agentId,
  };
}
