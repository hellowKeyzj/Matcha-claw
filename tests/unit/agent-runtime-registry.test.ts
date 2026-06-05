import { describe, expect, it } from 'vitest';
import { AgentRuntimeRegistry } from '../../runtime-host/application/agent-runtime/contracts/agent-runtime-registry';
import { OpenClawRuntimeAdapter } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-adapter';
import { createTestAcpClientConnector } from './helpers/acp-test-connector';
import type { RuntimeEndpointProfile, RuntimeSessionTransport } from '../../runtime-host/application/agent-runtime/contracts/runtime-endpoint-types';

function createReadyAcpTransport(): RuntimeSessionTransport & { stop: () => void } {
  return {
    sendPrompt: async () => ({ success: true }),
    abortSession: async () => {},
    resolveApproval: async () => ({}),
    inspectReadiness: async () => ({ ready: true, phase: 'ready' }),
    stop: () => {},
  };
}

function createNotReadyAcpTransport(): RuntimeSessionTransport & { stop: () => void } {
  return {
    sendPrompt: async () => ({ success: false, error: 'not ready' }),
    abortSession: async () => {},
    resolveApproval: async () => ({}),
    inspectReadiness: async () => ({ ready: false, phase: 'unavailable', error: 'not ready' }),
    stop: () => {},
  };
}

function createRegistryWithAcpTransport(createTransport: (endpoint: RuntimeEndpointProfile) => RuntimeSessionTransport & { stop?: () => void }): AgentRuntimeRegistry {
  const nativeGateway = {
    chatSend: async () => ({ success: true }),
    gatewayRpc: async () => ({}),
  };
  const registry = new AgentRuntimeRegistry({ gateway: () => nativeGateway });
  registry.register({
    runtimeAdapters: [new OpenClawRuntimeAdapter()],
    protocolConnectors: [createTestAcpClientConnector({ createTransport })],
  });
  return registry;
}

function createRegistry(): AgentRuntimeRegistry {
  const nativeGateway = {
    chatSend: async () => ({ success: true }),
    gatewayRpc: async () => ({}),
  };
  const registry = new AgentRuntimeRegistry({ gateway: () => nativeGateway });
  registry.register({
    runtimeAdapters: [new OpenClawRuntimeAdapter()],
    protocolConnectors: [createTestAcpClientConnector()],
  });
  return registry;
}

describe('runtime endpoint registry', () => {
  it('registers connector profiles without publishing connector runtime endpoints', () => {
    const registry = createRegistry();

    expect(registry.getEndpoint('openclaw-local').protocolId).toBe('openclaw-v4');
    expect(() => registry.getEndpoint('claude-code')).toThrow('Runtime endpoint not registered: claude-code');
    expect(() => registry.getEndpoint('hermes')).toThrow('Runtime endpoint not registered: hermes');
    expect(registry.listRuntimeAdapters().map((adapter) => adapter.runtimeAdapterId)).toEqual(['openclaw']);
    expect(registry.listProtocolConnectors().map((connector) => connector.connectorId)).toEqual(['acp']);
    expect(registry.snapshotTopology().connectors[0]?.endpointIds).toEqual(['claude-code', 'hermes']);
  });

  it('requires explicit runtime metadata instead of defaulting to OpenClaw', () => {
    const registry = createRegistry();

    expect(() => registry.resolveSessionContext('agent:main:main')).toThrow(
      'Runtime session context requires explicit runtime address metadata: agent:main:main',
    );
    expect(() => registry.resolveSessionContext('agent:main:main', {
      protocolId: 'openclaw-v4',
      runtimeEndpointId: 'openclaw-local',
    })).toThrow(
      'Runtime session context requires explicit runtime address metadata: agent:main:main',
    );
  });

  it('resolves approval notification adapters from runtime addresses', () => {
    const registry = createRegistry();

    expect(registry.resolveApprovalNotificationsForAddress({
      kind: 'native-runtime',
      capabilityId: 'session.prompt',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
      agentId: 'main',
    })).not.toBeNull();
    expect(() => registry.resolveApprovalNotificationsForAddress({
      kind: 'protocol-connector',
      capabilityId: 'session.prompt',
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
      agentId: 'default',
    })).toThrow('Connector runtime endpoint not registered: acp:acp:claude-code');
  });

  it('summarizes only callable endpoint addresses from registered capabilities', () => {
    const registry = createRegistry();

    const openClawEndpoint = registry.snapshotTopology().endpoints.find((endpoint) => endpoint.id === 'openclaw-local');
    const claudeCodeEndpoint = registry.snapshotTopology().endpoints.find((endpoint) => endpoint.id === 'claude-code');

    expect(openClawEndpoint?.capabilityAddresses.map((address) => address.capabilityId).sort()).toEqual([
      'agent.run',
      'integration.channel',
      'license.runtime',
      'model.provider',
      'multi-agent.task',
      'platform.runtime',
      'plugin.runtime',
      'runtime.host',
      'scheduler.cron',
      'security.runtime',
      'session.approval',
      'session.management',
      'session.modelSelection',
      'session.prompt',
      'settings.runtime',
      'skill.management',
      'subagent.management',
      'task.control',
      'team.coordination',
      'tool.invoke',
      'workspace.file',
    ]);
    expect(openClawEndpoint?.capabilityAddresses.every((address) => address.kind === 'native-runtime')).toBe(true);
    expect(openClawEndpoint?.acceptsDynamicAgents).toBe(true);
    expect(claudeCodeEndpoint).toBeUndefined();
    expect(registry.listCapabilities().some((descriptor) => descriptor.address.kind === 'protocol-connector')).toBe(false);
  });

  it('publishes connector runtime endpoints and capabilities only while connected and ready', async () => {
    const registry = createRegistryWithAcpTransport(() => createReadyAcpTransport());

    await expect(registry.connectRuntimeEndpoint({
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    })).resolves.toEqual({ ready: true, phase: 'ready' });

    const claudeCodeEndpoint = registry.snapshotTopology().endpoints.find((endpoint) => endpoint.id === 'claude-code');
    expect(claudeCodeEndpoint?.capabilityAddresses.map((address) => address.capabilityId).sort()).toEqual([
      'agent.run',
      'session.approval',
      'session.management',
      'session.prompt',
      'tool.invoke',
    ]);
    expect(claudeCodeEndpoint?.capabilityAddresses.every((address) => (
      address.kind === 'protocol-connector'
      && address.protocolId === 'acp'
      && address.connectorId === 'acp'
      && address.endpointId === 'claude-code'
    ))).toBe(true);

    const readiness = registry.disconnectRuntimeEndpoint({
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    });

    expect(readiness).toEqual({ ready: false, phase: 'disconnected' });
    expect(registry.snapshotTopology().endpoints.find((endpoint) => endpoint.id === 'claude-code')).toBeUndefined();
    expect(registry.listCapabilities().some((descriptor) => descriptor.address.kind === 'protocol-connector')).toBe(false);
  });

  it('does not publish connector runtime endpoints when connect readiness fails', async () => {
    const registry = createRegistryWithAcpTransport(() => createNotReadyAcpTransport());

    await expect(registry.connectRuntimeEndpoint({
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    })).resolves.toEqual({ ready: false, phase: 'unavailable', error: 'not ready' });

    expect(registry.snapshotTopology().endpoints.find((endpoint) => endpoint.id === 'claude-code')).toBeUndefined();
    expect(registry.listCapabilities().some((descriptor) => descriptor.address.kind === 'protocol-connector')).toBe(false);
  });

  it('stores runtime addresses on explicit session contexts', async () => {
    const registry = createRegistryWithAcpTransport(() => createReadyAcpTransport());
    await registry.connectRuntimeEndpoint({
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    });

    expect(registry.resolveSessionContext('agent:main:main', {
      protocolId: 'openclaw-v4',
      runtimeEndpointId: 'openclaw-local',
      endpointSessionId: 'agent:main:main',
      agentId: 'main',
      address: {
        kind: 'native-runtime',
        capabilityId: 'session.prompt',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        agentId: 'main',
        sessionKey: 'agent:main:main',
      },
    })).toMatchObject({
      sessionKey: 'agent:main:main',
      protocolId: 'openclaw-v4',
      runtimeEndpointId: 'openclaw-local',
      endpointSessionId: 'agent:main:main',
      agentId: 'main',
      endpoint: {
        scopeKey: 'session.prompt:native-runtime:openclaw:local:main:model-provider:',
        capabilityId: 'session.prompt',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        agentId: 'main',
      },
      address: {
        kind: 'native-runtime',
        capabilityId: 'session.prompt',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        agentId: 'main',
        sessionKey: 'agent:main:main',
      },
    });

    const mainContext = registry.rememberSessionAddress('main', {
      kind: 'native-runtime',
      capabilityId: 'session.prompt',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
      agentId: 'main',
    });
    const browserContext = registry.rememberSessionAddress('main', {
      kind: 'native-runtime',
      capabilityId: 'session.prompt',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
      agentId: 'browser',
    });

    expect(mainContext).not.toBe(browserContext);
    expect(registry.resolveSessionContext('main', { address: mainContext.address })).toBe(mainContext);
    expect(registry.resolveSessionContext('main', { address: browserContext.address })).toBe(browserContext);
    expect(() => registry.resolveSessionContext('main')).toThrow('Runtime session context requires explicit runtime address metadata: main');

    expect(registry.resolveSessionContext('claude-code:session:1', {
      protocolId: 'acp',
      runtimeEndpointId: 'claude-code',
      endpointSessionId: 'session:1',
      agentId: 'default',
      address: {
        kind: 'protocol-connector',
        capabilityId: 'session.prompt',
        protocolId: 'acp',
        connectorId: 'acp',
        endpointId: 'claude-code',
        agentId: 'default',
        sessionKey: 'claude-code:session:1',
      },
    })).toMatchObject({
      endpoint: {
        scopeKey: 'session.prompt:protocol-connector:acp:acp:claude-code:default:model-provider:',
        capabilityId: 'session.prompt',
        protocolId: 'acp',
        connectorId: 'acp',
        endpointId: 'claude-code',
        agentId: 'default',
      },
      address: {
        kind: 'protocol-connector',
        capabilityId: 'session.prompt',
        protocolId: 'acp',
        connectorId: 'acp',
        endpointId: 'claude-code',
        agentId: 'default',
        sessionKey: 'claude-code:session:1',
      },
    });
  });
});
