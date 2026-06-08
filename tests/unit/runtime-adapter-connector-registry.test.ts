import { describe, expect, it } from 'vitest';
import { AgentRuntimeRegistry } from '../../runtime-host/application/agent-runtime/contracts/agent-runtime-registry';
import { OpenClawRuntimeAdapter } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-adapter';
import { createTestAcpClientConnector } from './helpers/acp-test-connector';
import { buildRuntimeEndpointKey, connectorRuntimeEndpoint, nativeRuntimeEndpoint, runtimeInstanceScope, sessionScope } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { RuntimeEndpointProfile, RuntimeSessionTransport } from '../../runtime-host/application/agent-runtime/contracts/runtime-endpoint-types';

function openClawEndpointRef() {
  return nativeRuntimeEndpoint({
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  });
}

function claudeCodeEndpointRef() {
  return connectorRuntimeEndpoint({
    protocolId: 'acp',
    connectorId: 'acp',
    endpointId: 'claude-code',
  });
}

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

  it('requires remembered SessionIdentity metadata for session context resolution', () => {
    const registry = createRegistry();

    expect(() => registry.resolveSessionContext({
      endpoint: openClawEndpointRef(),
      agentId: 'main',
      sessionKey: 'agent:main:main',
    })).toThrow('Runtime session context requires explicit session identity metadata: agent:main:main');
  });

  it('resolves approval notification adapters from runtime endpoints', () => {
    const registry = createRegistry();

    expect(registry.resolveApprovalNotificationsForEndpoint(openClawEndpointRef())).not.toBeNull();
    expect(() => registry.resolveApprovalNotificationsForEndpoint(claudeCodeEndpointRef()))
      .toThrow('Connector runtime endpoint not registered: acp:acp:claude-code');
  });

  it('summarizes only callable endpoint scopes from registered capabilities', () => {
    const registry = createRegistry();

    const openClawEndpoint = registry.snapshotTopology().endpoints.find((endpoint) => endpoint.id === 'openclaw-local');
    const claudeCodeEndpoint = registry.snapshotTopology().endpoints.find((endpoint) => endpoint.id === 'claude-code');

    expect(openClawEndpoint?.capabilitySummaries.map((summary) => summary.id).sort()).toEqual([
      'agent.run',
      'integration.channel',
      'model.provider',
      'platform.runtime',
      'plugin.runtime',
      'runtime.host',
      'scheduler.cron',
      'security.runtime',
      'session.management',
      'session.prompt',
      'skill.management',
      'subagent.management',
      'task.control',
      'team.runtime',
      'tool.invoke',
      'workspace.file',
    ]);
    expect(openClawEndpoint?.capabilitySummaries.every((summary) => (
      ('endpoint' in summary.scope && summary.scope.endpoint.kind === 'native-runtime')
      || (summary.scope.kind === 'session' && summary.scope.identity.endpoint.kind === 'native-runtime')
    ))).toBe(true);
    expect(openClawEndpoint?.acceptsDynamicAgents).toBe(true);
    expect(claudeCodeEndpoint).toBeUndefined();
    expect(registry.listCapabilities().some((descriptor) => descriptor.scope.kind === 'app')).toBe(true);
    expect(registry.listCapabilities().some((descriptor) => descriptor.scope.kind === 'protocol-connector')).toBe(false);
  });

  it('publishes connector runtime endpoints and capabilities only while connected and ready', async () => {
    const registry = createRegistryWithAcpTransport(() => createReadyAcpTransport());

    await expect(registry.connectRuntimeEndpoint({
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    })).resolves.toEqual({ ready: true, phase: 'ready' });

    const claudeCodeEndpoint = registry.snapshotTopology().endpoints.find((endpoint) => endpoint.id === 'claude-code');
    expect(claudeCodeEndpoint?.capabilitySummaries.map((summary) => summary.id).sort()).toEqual([
      'agent.run',
      'session.management',
      'session.prompt',
      'tool.invoke',
    ]);
    expect(claudeCodeEndpoint?.capabilitySummaries.every((summary) => (
      'endpoint' in summary.scope
      && summary.scope.endpoint.kind === 'protocol-connector'
      && summary.scope.endpoint.protocolId === 'acp'
      && summary.scope.endpoint.connectorId === 'acp'
      && summary.scope.endpoint.endpointId === 'claude-code'
    ))).toBe(true);

    const readiness = registry.disconnectRuntimeEndpoint({
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    });

    expect(readiness).toEqual({ ready: false, phase: 'disconnected' });
    expect(registry.snapshotTopology().endpoints.find((endpoint) => endpoint.id === 'claude-code')).toBeUndefined();
    expect(registry.listCapabilities().some((descriptor) => (
      descriptor.scope.kind !== 'app'
      && 'endpoint' in descriptor.scope
      && descriptor.scope.endpoint.kind === 'protocol-connector'
    ))).toBe(false);
  });

  it('does not publish connector runtime endpoints when connect readiness fails', async () => {
    const registry = createRegistryWithAcpTransport(() => createNotReadyAcpTransport());

    await expect(registry.connectRuntimeEndpoint({
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    })).resolves.toEqual({ ready: false, phase: 'unavailable', error: 'not ready' });

    expect(registry.snapshotTopology().endpoints.find((endpoint) => endpoint.id === 'claude-code')).toBeUndefined();
    expect(registry.listCapabilities().some((descriptor) => (
      descriptor.scope.kind !== 'app'
      && 'endpoint' in descriptor.scope
      && descriptor.scope.endpoint.kind === 'protocol-connector'
    ))).toBe(false);
  });

  it('stores session identities on explicit session contexts', async () => {
    const registry = createRegistryWithAcpTransport(() => createReadyAcpTransport());
    await registry.connectRuntimeEndpoint({
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    });

    const mainIdentity = {
      endpoint: openClawEndpointRef(),
      agentId: 'main',
      sessionKey: 'main',
    };
    const browserIdentity = {
      endpoint: openClawEndpointRef(),
      agentId: 'browser',
      sessionKey: 'main',
    };
    const claudeCodeIdentity = {
      endpoint: claudeCodeEndpointRef(),
      agentId: 'default',
      sessionKey: 'claude-code:session:1',
    };

    const mainContext = registry.rememberSessionIdentity(mainIdentity);
    const browserContext = registry.rememberSessionIdentity(browserIdentity);
    const claudeCodeContext = registry.rememberSessionIdentity(claudeCodeIdentity);

    expect(mainContext).toMatchObject({
      identity: mainIdentity,
      sessionKey: 'main',
      protocolId: 'openclaw-v4',
      runtimeEndpointId: 'openclaw-local',
      endpointSessionId: 'main',
      agentId: 'main',
      endpoint: {
        scopeKey: buildRuntimeEndpointKey(mainIdentity.endpoint),
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
      },
      endpointRef: mainIdentity.endpoint,
    });
    expect(claudeCodeContext).toMatchObject({
      identity: claudeCodeIdentity,
      protocolId: 'acp',
      runtimeEndpointId: 'claude-code',
      endpoint: {
        scopeKey: buildRuntimeEndpointKey(claudeCodeIdentity.endpoint),
        protocolId: 'acp',
        connectorId: 'acp',
        endpointId: 'claude-code',
      },
      endpointRef: claudeCodeIdentity.endpoint,
    });

    expect(mainContext).not.toBe(browserContext);
    expect(registry.resolveSessionContext(mainIdentity)).toBe(mainContext);
    expect(registry.resolveSessionContext(browserIdentity)).toBe(browserContext);
    expect(registry.resolveSessionContext(claudeCodeIdentity)).toBe(claudeCodeContext);
    expect(() => registry.resolveSessionContext({
      endpoint: openClawEndpointRef(),
      agentId: 'missing',
      sessionKey: 'main',
    })).toThrow('Runtime session context requires explicit session identity metadata: main');

    expect(registry.getCapability({
      id: 'session.prompt',
      scope: sessionScope(claudeCodeIdentity),
    }).scope).toEqual(sessionScope(claudeCodeIdentity));
    expect(registry.getCapability({
      id: 'session.management',
      scope: runtimeInstanceScope(openClawEndpointRef()),
    }).scope).toEqual(runtimeInstanceScope(openClawEndpointRef()));
    expect(registry.getCapability({
      id: 'runtime.host',
      scope: runtimeInstanceScope(openClawEndpointRef()),
    }).scope).toEqual(runtimeInstanceScope(openClawEndpointRef()));
  });
});
