import { describe, expect, it } from 'vitest';
import { AgentRuntimeRegistry } from '../../runtime-host/application/agent-runtime/contracts/agent-runtime-registry';
import { buildRuntimeAddressScopedMessageId } from '../../runtime-host/application/agent-runtime/contracts/runtime-identity-contract';
import { OpenClawRuntimeAdapter } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-adapter';
import { createTestAcpClientConnector } from './helpers/acp-test-connector';

const openClawAddress = {
  kind: 'native-runtime' as const,
  capabilityId: 'session.prompt',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  agentId: 'main',
  sessionKey: 'agent:main:main',
};

const claudeCodeAddress = {
  kind: 'protocol-connector' as const,
  capabilityId: 'session.prompt',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointId: 'claude-code',
  agentId: 'default',
  sessionKey: 'claude-code:session:1',
};

function createRegistry(): AgentRuntimeRegistry {
  const registry = new AgentRuntimeRegistry({
    gateway: () => ({
      chatSend: async () => ({ success: true }),
      gatewayRpc: async () => ({}),
    }),
  });
  registry.register({
    runtimeAdapters: [new OpenClawRuntimeAdapter()],
    protocolConnectors: [createTestAcpClientConnector()],
  });
  return registry;
}

describe('runtime identity contract', () => {
  it('resolves native runtime identity from explicit endpoint metadata', () => {
    expect(createRegistry().resolveSessionIdentityForAddress(openClawAddress)).toEqual({
      protocolId: 'openclaw-v4',
      runtimeEndpointId: 'openclaw-local',
    });
  });

  it('requires registered endpoint metadata for native runtime addresses', () => {
    const registry = new AgentRuntimeRegistry();
    expect(() => registry.resolveSessionIdentityForAddress(openClawAddress)).toThrow(
      'Native runtime endpoint not registered: openclaw:local',
    );
  });

  it('resolves connector identity from protocol and endpoint without using connector as provider', () => {
    expect(createRegistry().resolveSessionIdentityForAddress(claudeCodeAddress)).toEqual({
      protocolId: 'acp',
      runtimeEndpointId: 'claude-code',
    });
  });

  it('builds message identity from explicit runtime address, run, and lane only', () => {
    expect(buildRuntimeAddressScopedMessageId({
      address: claudeCodeAddress,
      sessionKey: 'claude-code:session:1',
      runId: 'run-1',
      laneKey: 'agent-a',
      role: 'assistant',
      messageIndex: 2,
    })).toBe('session.prompt:protocol-connector:acp:acp:claude-code:default:model-provider::claude-code:session:1:run-1:agent-a:assistant:2');
  });

  it('rejects message identity without explicit run or lane', () => {
    expect(() => buildRuntimeAddressScopedMessageId({
      address: claudeCodeAddress,
      sessionKey: 'claude-code:session:1',
      runId: '',
      laneKey: 'agent-a',
      role: 'assistant',
      messageIndex: 2,
    })).toThrow('Runtime message identity requires runId');
    expect(() => buildRuntimeAddressScopedMessageId({
      address: claudeCodeAddress,
      sessionKey: 'claude-code:session:1',
      runId: 'run-1',
      laneKey: '',
      role: 'assistant',
      messageIndex: 2,
    })).toThrow('Runtime message identity requires laneKey');
  });
});
