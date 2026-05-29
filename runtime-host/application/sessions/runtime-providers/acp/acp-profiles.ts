import type { RuntimeProviderProfile } from '../runtime-provider-types';
import { ACP_RUNTIME_PROTOCOL_ID } from '../runtime-provider-types';

export const claudeCodeAcpRuntimeProviderProfile: RuntimeProviderProfile = {
  id: 'claude-code',
  protocolId: ACP_RUNTIME_PROTOCOL_ID,
  displayName: 'Claude Code',
  capabilities: {
    chat: true,
    streaming: true,
    tools: true,
    approvals: true,
    replay: true,
    modelSelection: false,
  },
  launcher: {
    command: 'npx',
    args: ['--yes', '@zed-industries/claude-code-acp@latest'],
  },
  storage: {
    namespace: 'claude-code',
  },
  keying: {
    namespace: 'claude-code',
  },
};

export const hermesAcpRuntimeProviderProfile: RuntimeProviderProfile = {
  id: 'hermes',
  protocolId: ACP_RUNTIME_PROTOCOL_ID,
  displayName: 'Hermes',
  capabilities: {
    chat: true,
    streaming: true,
    tools: true,
    approvals: true,
    replay: true,
    modelSelection: false,
  },
  launcher: {
    command: 'hermes',
    args: ['acp'],
  },
  storage: {
    namespace: 'hermes',
  },
  keying: {
    namespace: 'hermes',
  },
};

export const acpRuntimeProviderProfiles = [
  claudeCodeAcpRuntimeProviderProfile,
  hermesAcpRuntimeProviderProfile,
];
