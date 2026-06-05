import { buildRuntimeAddressKey, type RuntimeAddress } from './runtime-address';
import {
  type RuntimeEndpointIdentity,
  type RuntimeEndpointId,
  type RuntimeProtocolId,
  type RuntimeSessionContext,
} from './runtime-endpoint-types';

function buildRuntimeEndpointIdentity(address: RuntimeAddress): RuntimeEndpointIdentity {
  if (address.kind === 'protocol-connector') {
    return {
      scopeKey: buildRuntimeAddressKey(address),
      capabilityId: address.capabilityId,
      protocolId: address.protocolId,
      connectorId: address.connectorId,
      endpointId: address.endpointId,
      agentId: address.agentId,
    };
  }
  return {
    scopeKey: buildRuntimeAddressKey(address),
    capabilityId: address.capabilityId,
    runtimeAdapterId: address.runtimeAdapterId,
    runtimeInstanceId: address.runtimeInstanceId,
    agentId: address.agentId,
  };
}

export function createRuntimeSessionContext(input: {
  sessionKey: string;
  protocolId: RuntimeProtocolId;
  runtimeEndpointId: RuntimeEndpointId;
  endpointSessionId?: string;
  agentId?: string;
  address: RuntimeAddress;
}): RuntimeSessionContext {
  const agentId = input.agentId || input.address.agentId;
  const address = {
    ...input.address,
    sessionKey: input.sessionKey,
  };
  return {
    sessionKey: input.sessionKey,
    protocolId: input.protocolId,
    runtimeEndpointId: input.runtimeEndpointId,
    endpoint: buildRuntimeEndpointIdentity(address),
    ...(input.endpointSessionId ? { endpointSessionId: input.endpointSessionId } : {}),
    agentId,
    address,
  };
}
