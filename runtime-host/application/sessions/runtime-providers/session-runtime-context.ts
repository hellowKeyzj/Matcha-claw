import {
  OPENCLAW_RUNTIME_PROTOCOL_ID,
  OPENCLAW_RUNTIME_PROVIDER_ID,
  type RuntimeProviderId,
  type RuntimeProtocolId,
  type RuntimeSessionContext,
} from './runtime-provider-types';

function readAgentIdFromLegacyOpenClawKey(sessionKey: string): string | undefined {
  const matched = sessionKey.match(/^agent:([^:]+):/i);
  return matched?.[1];
}

export function createOpenClawRuntimeSessionContext(sessionKey: string): RuntimeSessionContext {
  return {
    sessionKey,
    protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
    runtimeProviderId: OPENCLAW_RUNTIME_PROVIDER_ID,
    providerSessionId: sessionKey,
    ...(readAgentIdFromLegacyOpenClawKey(sessionKey) ? { agentId: readAgentIdFromLegacyOpenClawKey(sessionKey) } : {}),
  };
}

export function createRuntimeSessionContext(input: {
  sessionKey: string;
  protocolId: RuntimeProtocolId;
  runtimeProviderId: RuntimeProviderId;
  providerSessionId?: string;
  agentId?: string;
}): RuntimeSessionContext {
  return {
    sessionKey: input.sessionKey,
    protocolId: input.protocolId,
    runtimeProviderId: input.runtimeProviderId,
    ...(input.providerSessionId ? { providerSessionId: input.providerSessionId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
  };
}
