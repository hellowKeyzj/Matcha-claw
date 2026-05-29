import type { RuntimeProviderProfile } from '../runtime-provider-types';
import { OPENCLAW_RUNTIME_PROTOCOL_ID, OPENCLAW_RUNTIME_PROVIDER_ID } from '../runtime-provider-types';

export const openClawRuntimeProviderProfile: RuntimeProviderProfile = {
  id: OPENCLAW_RUNTIME_PROVIDER_ID,
  protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
  displayName: 'OpenClaw',
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
    legacyPrefix: 'agent:',
  },
};
