import { buildRuntimeEndpointKey, type RuntimeEndpointRef, type SessionIdentity } from './runtime-address';
import {
  type RuntimeEndpointIdentity,
  type RuntimeEndpointId,
  type RuntimeProtocolId,
  type RuntimeSessionBinding,
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
  endpointSessionId: string;
  sessionBinding?: RuntimeSessionBinding;
}): RuntimeSessionContext {
  const endpointSessionId = input.endpointSessionId.trim();
  if (!endpointSessionId) {
    throw new Error('RuntimeSessionContext requires an explicit endpointSessionId.');
  }
  const sessionBinding = input.sessionBinding ?? {
    identity: input.identity,
    localSessionId: input.identity.sessionKey,
    protocolId: input.protocolId,
    runtimeEndpointId: input.runtimeEndpointId,
    endpointRef: input.identity.endpoint,
    endpointSessionId,
    agentId: input.identity.agentId,
  };
  return {
    identity: input.identity,
    localSessionId: sessionBinding.localSessionId,
    sessionKey: sessionBinding.localSessionId,
    protocolId: input.protocolId,
    runtimeEndpointId: input.runtimeEndpointId,
    endpoint: buildRuntimeEndpointIdentity(input.identity.endpoint),
    endpointRef: input.identity.endpoint,
    endpointSessionId: sessionBinding.endpointSessionId,
    agentId: input.identity.agentId,
    sessionBinding,
  };
}
