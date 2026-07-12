import type { RuntimeEndpointProfile } from '../../contracts/runtime-endpoint-types';
import { ACP_CLIENT_CONNECTOR_ID, ACP_PROTOCOL_ID } from './acp-identity';

export const claudeCodeAcpEndpointTemplate: RuntimeEndpointProfile = {
  id: 'claude-code',
  protocolId: ACP_PROTOCOL_ID,
  connectorId: ACP_CLIENT_CONNECTOR_ID,
  displayName: 'Claude Code',
  agentIds: ['default'],
  defaultAgentId: 'default',
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

export const hermesAcpEndpointTemplate: RuntimeEndpointProfile = {
  id: 'hermes',
  protocolId: ACP_PROTOCOL_ID,
  connectorId: ACP_CLIENT_CONNECTOR_ID,
  displayName: 'Hermes',
  agentIds: ['default'],
  defaultAgentId: 'default',
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

export const acpEndpointTemplates = [
  claudeCodeAcpEndpointTemplate,
  hermesAcpEndpointTemplate,
];
