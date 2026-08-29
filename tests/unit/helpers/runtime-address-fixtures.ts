import type { RuntimeEndpointRef, SessionIdentity } from '../../../electron/desktop-contract/runtime-address';

export const openClawTestRuntimeEndpoint: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'default',
};

export const openClawTestRuntimeIdentity = {
  protocolId: 'openclaw',
  runtimeEndpointId: 'openclaw-default',
  eventIdPrefix: 'openclaw',
};

function readAgentIdFromSessionKey(sessionKey: string): string {
  return sessionKey.split(':')[1] || 'main';
}

export function createOpenClawTestSessionIdentity(
  sessionKey = 'agent:main:main',
  agentId = readAgentIdFromSessionKey(sessionKey),
): SessionIdentity {
  return {
    endpoint: openClawTestRuntimeEndpoint,
    agentId,
    sessionKey,
  };
}
