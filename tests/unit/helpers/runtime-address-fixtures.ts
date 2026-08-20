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
