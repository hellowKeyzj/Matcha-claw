import type { RuntimeEndpointProfile } from '../../../agent-runtime/contracts/runtime-endpoint-types';
import { OPENCLAW_RUNTIME_PROTOCOL_ID, OPENCLAW_RUNTIME_ENDPOINT_ID, OPENCLAW_RUNTIME_INSTANCE_ID } from './openclaw-runtime-identity';

export const openClawRuntimeEndpointProfile: RuntimeEndpointProfile = {
  id: OPENCLAW_RUNTIME_ENDPOINT_ID,
  protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
  runtimeInstanceId: OPENCLAW_RUNTIME_INSTANCE_ID,
  displayName: 'OpenClaw',
  agentIds: ['default'],
  acceptsDynamicAgents: true,
  capabilities: {
    chat: true,
    streaming: true,
    tools: true,
    approvals: true,
    replay: true,
    modelSelection: true,
  },
  storage: {
    namespace: 'agent',
  },
  keying: {
    namespace: 'agent',
  },
};
