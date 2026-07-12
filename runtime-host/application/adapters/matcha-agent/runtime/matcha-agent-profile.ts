import type { RuntimeEndpointProfile } from '../../../agent-runtime/contracts/runtime-endpoint-types';
import {
  MATCHA_AGENT_RUNTIME_ENDPOINT_ID,
  MATCHA_AGENT_RUNTIME_INSTANCE_ID,
  MATCHA_AGENT_RUNTIME_PROTOCOL_ID,
} from './matcha-agent-runtime-identity';

export const matchaAgentRuntimeEndpointProfile: RuntimeEndpointProfile = {
  id: MATCHA_AGENT_RUNTIME_ENDPOINT_ID,
  protocolId: MATCHA_AGENT_RUNTIME_PROTOCOL_ID,
  runtimeInstanceId: MATCHA_AGENT_RUNTIME_INSTANCE_ID,
  displayName: 'Matcha Agent',
  agentIds: ['matcha'],
  defaultAgentId: 'matcha',
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
    namespace: 'matcha-agent',
  },
  keying: {
    namespace: 'matcha-agent',
  },
  externalSessionList: true,
  externalSessionTranscript: true,
};
