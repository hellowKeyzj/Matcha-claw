import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeRegistry } from '../../runtime-host/application/agent-runtime/contracts/agent-runtime-registry';
import { OpenClawRuntimeAdapter } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-adapter';
import { OpenClawRuntimeTransport } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-transport';
import { createTestAcpClientConnector } from './helpers/acp-test-connector';
import { agentScope, connectorRuntimeEndpoint, nativeRuntimeEndpoint, runtimeInstanceScope } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import { createRuntimeSessionContext } from '../../runtime-host/application/agent-runtime/contracts/runtime-session-context';
import type { RuntimeProtocolConnector, RuntimeSessionTransport } from '../../runtime-host/application/agent-runtime/contracts/runtime-endpoint-types';

const testProtocol: RuntimeProtocolConnector['protocol'] = {
  protocolId: 'test-protocol',
  eventAdapter: {
    canTranslate: () => false,
    translate: () => [],
  },
  replayAdapter: {
    replayTranscript: () => [],
  },
  identityPolicy: {
    buildMessageId: () => 'message-id',
  },
};

function openClawEndpointRef() {
  return nativeRuntimeEndpoint({
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  });
}

function connectorEndpointRef(connectorId: string, endpointId = 'shared-endpoint') {
  return connectorRuntimeEndpoint({
    protocolId: 'test-protocol',
    connectorId,
    endpointId,
  });
}

function createConnector(connectorId: string, transport: RuntimeSessionTransport): RuntimeProtocolConnector {
  return {
    connectorId,
    protocol: testProtocol,
    endpoints: [{
      id: 'shared-endpoint',
      protocolId: 'test-protocol',
      displayName: connectorId,
      agentIds: ['default'],
      defaultAgentId: 'default',
      capabilities: {
        chat: true,
        streaming: false,
        tools: false,
        approvals: false,
        replay: false,
        modelSelection: false,
      },
    }],
    capabilities: [],
    connect: () => transport,
  };
}

async function connectSharedEndpoint(registry: AgentRuntimeRegistry, connectorId: string): Promise<void> {
  await registry.connectRuntimeEndpoint({
    protocolId: 'test-protocol',
    connectorId,
    endpointId: 'shared-endpoint',
  });
}

async function connectAcpEndpoint(registry: AgentRuntimeRegistry, endpointId: string): Promise<void> {
  await registry.connectRuntimeEndpoint({
    protocolId: 'acp',
    connectorId: 'acp',
    endpointId,
  });
}

describe('runtime adapter and connector registry', () => {
  it('routes native runtime transport through the runtime adapter', () => {
    const nativeGateway = {
      chatSend: async () => ({ success: true }),
      gatewayRpc: async () => ({}),
    };
    const registry = new AgentRuntimeRegistry({ gateway: () => nativeGateway });
    const adapter = new OpenClawRuntimeAdapter();
    registry.register({ runtimeAdapters: [adapter] });

    const createTransport = vi.spyOn(adapter, 'createTransport');
    const transport = registry.resolveTransportForEndpoint(openClawEndpointRef(), 'main');

    expect(transport).toBeTruthy();
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      id: 'openclaw-local',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
    }), { gateway: nativeGateway });
    expect(registry.getProtocol('openclaw-v4')).toBe(adapter.protocol);
  });

  it('preserves the R3 gateway payload while overriding OpenClaw endpoint identity', async () => {
    const chatSend = vi.fn(async () => ({ success: true }));
    const transport = new OpenClawRuntimeTransport({
      chatSend,
      gatewayRpc: async () => ({}),
    });
    const attachments = [{
      content: 'cmVwb3J0',
      mimeType: 'text/plain',
      fileName: 'report.txt',
    }];
    const context = createRuntimeSessionContext({
      identity: {
        endpoint: openClawEndpointRef(),
        agentId: 'main',
        sessionKey: 'local',
      },
      protocolId: 'openclaw-v4',
      runtimeEndpointId: 'openclaw-local',
      endpointSessionId: 'endpoint-session',
    });

    const result = await transport.sendPrompt({
      context,
      message: 'hello',
      runId: 'run-1',
      payload: {
        sessionKey: 'local',
        message: 'hello\n\n[media attached: /tmp/report.txt (text/plain) | /tmp/report.txt]',
        deliver: true,
        idempotencyKey: 'stale',
        attachments,
      },
    });

    expect(result).toMatchObject({ success: true });
    expect(chatSend).toHaveBeenCalledWith({
      sessionKey: 'endpoint-session',
      message: 'hello\n\n[media attached: /tmp/report.txt (text/plain) | /tmp/report.txt]',
      deliver: true,
      idempotencyKey: 'run-1',
      attachments,
    });
  });

  it('routes connector runtime transport through the protocol connector', async () => {
    const registry = new AgentRuntimeRegistry();
    const transport = {
      sendPrompt: vi.fn(),
      abortSession: vi.fn(),
      resolveApproval: vi.fn(),
    };
    const createTransport = vi.fn(() => transport);
    const connector = createTestAcpClientConnector({ createTransport });
    registry.register({ protocolConnectors: [connector] });
    await connectAcpEndpoint(registry, 'claude-code');

    expect(registry.resolveTransportForEndpoint(connectorRuntimeEndpoint({
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    }), 'default')).toBe(transport);
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      id: 'claude-code',
      protocolId: 'acp',
      connectorId: 'acp',
    }));
    expect(registry.getProtocol('acp')).toBe(connector.protocol);
  });

  it('rejects connector endpoint refs for agents not declared by the endpoint', async () => {
    const registry = new AgentRuntimeRegistry();
    registry.register({
      protocolConnectors: [createConnector('first', {
        sendPrompt: vi.fn(),
        abortSession: vi.fn(),
        resolveApproval: vi.fn(),
      })],
    });
    await connectSharedEndpoint(registry, 'first');

    expect(() => registry.resolveTransportForEndpoint(connectorEndpointRef('first'), 'reviewer'))
      .toThrow('Runtime endpoint agent not registered: shared-endpoint:reviewer');
  });

  it('resolves capability descriptors for native runtime dynamic agents without pre-registering every agent', () => {
    const registry = new AgentRuntimeRegistry();
    registry.register({
      runtimeAdapters: [new OpenClawRuntimeAdapter()],
    });

    const scope = agentScope(openClawEndpointRef(), 'foo');

    expect(registry.getCapability({
      id: 'session.prompt',
      scope,
    })).toMatchObject({
      id: 'session.prompt',
      targetAgentIds: ['foo'],
      scope,
    });
  });

  it('exposes sessions.list as a runtime endpoint capability', () => {
    const registry = new AgentRuntimeRegistry();
    registry.register({
      runtimeAdapters: [new OpenClawRuntimeAdapter()],
    });

    const scope = runtimeInstanceScope(openClawEndpointRef());

    expect(registry.getCapability({
      id: 'session.management',
      scope,
    })).toMatchObject({
      id: 'session.management',
      scope,
      targetKinds: ['runtime-endpoint'],
      operations: [expect.objectContaining({ id: 'sessions.list', targetKind: 'runtime-endpoint' })],
    });
    expect(() => registry.getCapability({
      id: 'session.management',
      scope: agentScope(openClawEndpointRef(), 'foo'),
    })).toThrow('Capability not registered');
  });

  it('allows a connector endpoint to expose multiple explicit agents', async () => {
    const registry = new AgentRuntimeRegistry();
    const transport = {
      sendPrompt: vi.fn(),
      abortSession: vi.fn(),
      resolveApproval: vi.fn(),
    };
    registry.register({
      protocolConnectors: [{
        ...createConnector('multi-agent', transport),
        endpoints: [{
          ...createConnector('multi-agent', transport).endpoints[0]!,
          agentIds: ['default', 'reviewer'],
        }],
      }],
    });
    await connectSharedEndpoint(registry, 'multi-agent');

    expect(registry.resolveTransportForEndpoint(connectorEndpointRef('multi-agent'), 'reviewer')).toBe(transport);
  });

  it('refreshes connector endpoint agents and capability summaries from connection discovery', async () => {
    const registry = new AgentRuntimeRegistry();
    const transport = {
      sendPrompt: vi.fn(),
      abortSession: vi.fn(),
      resolveApproval: vi.fn(),
      discoverEndpoint: vi.fn(async () => ({
        agentIds: ['default', 'reviewer'],
        capabilities: {
          chat: true,
          streaming: true,
          tools: true,
          approvals: true,
          replay: true,
          modelSelection: false,
        },
      })),
    };
    registry.register({
      protocolConnectors: [createConnector('discovering', transport)],
    });

    await registry.connectRuntimeEndpoint({
      protocolId: 'test-protocol',
      connectorId: 'discovering',
      endpointId: 'shared-endpoint',
    });

    const reviewerScope = agentScope(connectorEndpointRef('discovering'), 'reviewer');
    expect(registry.getCapability({
      id: 'session.prompt',
      scope: reviewerScope,
    }).scope).toEqual(reviewerScope);
    expect(registry.snapshotTopology().endpoints.find((endpoint) => endpoint.connectorId === 'discovering')).toMatchObject({
      agentIds: ['default', 'reviewer'],
      capabilities: expect.objectContaining({ approvals: true, tools: true }),
      capabilitySummaries: expect.arrayContaining([
        expect.objectContaining({
          id: 'session.prompt',
          scope: reviewerScope,
        }),
      ]),
    });
  });

  it('routes Claude Code and Hermes ACP endpoints through isolated transports and capability scopes', async () => {
    const registry = new AgentRuntimeRegistry();
    const claudeTransport = {
      sendPrompt: vi.fn(),
      abortSession: vi.fn(),
      resolveApproval: vi.fn(),
    };
    const hermesTransport = {
      sendPrompt: vi.fn(),
      abortSession: vi.fn(),
      resolveApproval: vi.fn(),
    };
    const createTransport = vi.fn((endpoint) => {
      if (endpoint.id === 'claude-code') {
        return claudeTransport;
      }
      if (endpoint.id === 'hermes') {
        return hermesTransport;
      }
      throw new Error(`unexpected endpoint: ${endpoint.id}`);
    });
    const connector = createTestAcpClientConnector({ createTransport });
    registry.register({ protocolConnectors: [connector] });
    await connectAcpEndpoint(registry, 'claude-code');
    await connectAcpEndpoint(registry, 'hermes');

    const claudeEndpoint = connectorRuntimeEndpoint({
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    });
    const hermesEndpoint = connectorRuntimeEndpoint({
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'hermes',
    });
    const claudeScope = agentScope(claudeEndpoint, 'default');
    const hermesScope = agentScope(hermesEndpoint, 'default');

    expect(registry.resolveTransportForEndpoint(claudeEndpoint, 'default')).toBe(claudeTransport);
    expect(registry.resolveTransportForEndpoint(hermesEndpoint, 'default')).toBe(hermesTransport);
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude-code', connectorId: 'acp' }));
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ id: 'hermes', connectorId: 'acp' }));
    expect(registry.getCapability({ id: 'session.prompt', scope: claudeScope }).scope).toEqual(claudeScope);
    expect(registry.getCapability({ id: 'session.prompt', scope: hermesScope }).scope).toEqual(hermesScope);
  });

  it('allows different connectors to expose the same endpoint id without transport cross-talk', async () => {
    const registry = new AgentRuntimeRegistry();
    const firstTransport = {
      sendPrompt: vi.fn(),
      abortSession: vi.fn(),
      resolveApproval: vi.fn(),
    };
    const secondTransport = {
      sendPrompt: vi.fn(),
      abortSession: vi.fn(),
      resolveApproval: vi.fn(),
    };

    registry.register({
      protocolConnectors: [
        createConnector('first', firstTransport),
        createConnector('second', secondTransport),
      ],
    });
    await connectSharedEndpoint(registry, 'first');
    await connectSharedEndpoint(registry, 'second');

    const firstEndpoint = connectorEndpointRef('first');
    const secondEndpoint = connectorEndpointRef('second');

    expect(registry.resolveTransportForEndpoint(firstEndpoint, 'default')).toBe(firstTransport);
    expect(registry.resolveTransportForEndpoint(secondEndpoint, 'default')).toBe(secondTransport);
    expect(() => registry.getEndpoint('shared-endpoint')).toThrow('Runtime endpoint id is ambiguous: shared-endpoint');
    expect(registry.resolveApprovalNotificationsForEndpoint(firstEndpoint)).toBeNull();
  });

  it('stores gateway control state on the referenced runtime endpoint topology', async () => {
    const registry = new AgentRuntimeRegistry();
    registry.register({
      runtimeAdapters: [new OpenClawRuntimeAdapter()],
      protocolConnectors: [createConnector('test-connector', {
        sendPrompt: vi.fn(),
        abortSession: vi.fn(),
        resolveApproval: vi.fn(),
      })],
    });
    await connectSharedEndpoint(registry, 'test-connector');

    const connection = {
      state: 'connected' as const,
      portReachable: true,
      gatewayReady: true,
      transportEpoch: 7,
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 1_700_000_000_001,
    };
    const readiness = {
      ready: true,
      phase: 'ready',
      requiredMethods: ['status'],
      missingMethods: [],
      retryable: false,
      capabilities: {
        methods: ['status'],
        updatedAt: 1_700_000_000_002,
      },
    };

    registry.updateRuntimeEndpointControlState({
      endpoint: openClawEndpointRef(),
      connection,
      updatedAt: connection.updatedAt,
    });
    registry.updateRuntimeEndpointControlState({
      endpoint: connectorEndpointRef('test-connector'),
      readiness,
      capabilities: readiness.capabilities,
      updatedAt: readiness.capabilities.updatedAt,
    });

    const topology = registry.snapshotTopology();
    expect(topology.endpoints.find((endpoint) => endpoint.id === 'openclaw-local')).toMatchObject({
      id: 'openclaw-local',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
      controlState: {
        connection,
        readiness: null,
        capabilities: null,
        updatedAt: connection.updatedAt,
      },
    });
    expect(topology.endpoints.find((endpoint) => endpoint.connectorId === 'test-connector')).toMatchObject({
      id: 'shared-endpoint',
      protocolId: 'test-protocol',
      connectorId: 'test-connector',
      controlState: {
        connection: null,
        readiness,
        capabilities: readiness.capabilities,
        updatedAt: readiness.capabilities.updatedAt,
      },
    });
  });

  it('projects OpenClaw starting readiness as connecting and terminal readiness failure as unavailable', () => {
    const registry = new AgentRuntimeRegistry();
    registry.register({ runtimeAdapters: [new OpenClawRuntimeAdapter()] });
    const endpoint = openClawEndpointRef();
    const connection = {
      state: 'connected' as const,
      portReachable: true,
      gatewayReady: false,
      transportEpoch: 7,
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 1,
    };

    registry.updateRuntimeEndpointControlState({
      endpoint,
      connection,
      readiness: {
        ready: false,
        phase: 'starting',
        requiredMethods: ['status'],
        missingMethods: [],
        retryable: true,
      },
      updatedAt: 1,
    });
    expect(registry.snapshotTopology().endpoints.find((candidate) => candidate.id === 'openclaw-local')?.lifecycle).toMatchObject({
      phase: 'connecting',
      connected: false,
      ready: false,
    });

    registry.updateRuntimeEndpointControlState({
      endpoint,
      readiness: {
        ready: false,
        phase: 'unavailable',
        requiredMethods: ['status'],
        missingMethods: [],
        retryable: false,
        error: 'Gateway control plane unavailable',
      },
      updatedAt: 2,
    });
    expect(registry.snapshotTopology().endpoints.find((candidate) => candidate.id === 'openclaw-local')?.lifecycle).toMatchObject({
      phase: 'unavailable',
      connected: false,
      ready: false,
      error: 'Gateway control plane unavailable',
    });
  });

  it('projects runtime directory endpoint profiles and runtime instances across ACP connector lifecycle', async () => {
    const registry = new AgentRuntimeRegistry();
    const acpTransport = {
      sendPrompt: vi.fn(),
      abortSession: vi.fn(),
      resolveApproval: vi.fn(),
      stop: vi.fn(),
    };
    registry.register({
      runtimeAdapters: [new OpenClawRuntimeAdapter()],
      protocolConnectors: [createTestAcpClientConnector({ createTransport: () => acpTransport })],
    });

    const openClawRef = openClawEndpointRef();
    const openClawSource = {
      kind: 'runtime-adapter',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
    };
    const claudeCodeRef = connectorRuntimeEndpoint({
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    });
    const hermesRef = connectorRuntimeEndpoint({
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'hermes',
    });
    const claudeCodeSource = {
      kind: 'protocol-connector',
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    };
    const hermesSource = {
      kind: 'protocol-connector',
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'hermes',
    };
    const localLocation = { kind: 'local' };
    const readyLifecycle = {
      phase: 'ready',
      connected: true,
      ready: true,
    };
    const declaredLifecycle = {
      phase: 'declared',
      connected: false,
      ready: false,
      updatedAt: null,
    };

    const declaredTopology = registry.snapshotTopology();

    expect(declaredTopology.directory.endpointProfiles.map((endpoint) => endpoint.id).sort()).toEqual([
      'claude-code',
      'hermes',
      'openclaw-local',
    ]);
    expect(declaredTopology.directory.endpointProfiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'openclaw-local',
        endpointRef: openClawRef,
        source: openClawSource,
        location: localLocation,
        lifecycle: { ...readyLifecycle, updatedAt: null },
        agentIds: ['main'],
        defaultAgentId: 'main',
        agents: [expect.objectContaining({ agentId: 'main', source: 'discovered' })],
      }),
      expect.objectContaining({
        id: 'claude-code',
        endpointRef: claudeCodeRef,
        source: claudeCodeSource,
        location: localLocation,
        lifecycle: declaredLifecycle,
        agents: [expect.objectContaining({ agentId: 'default', source: 'declared' })],
      }),
      expect.objectContaining({
        id: 'hermes',
        endpointRef: hermesRef,
        source: hermesSource,
        location: localLocation,
        lifecycle: declaredLifecycle,
        agents: [expect.objectContaining({ agentId: 'default', source: 'declared' })],
      }),
    ]));
    expect(declaredTopology.endpoints).toEqual([
      expect.objectContaining({
        id: 'openclaw-local',
        endpointRef: openClawRef,
        source: openClawSource,
        location: localLocation,
        lifecycle: { ...readyLifecycle, updatedAt: null },
        agentIds: ['main'],
        defaultAgentId: 'main',
        agents: [expect.objectContaining({ agentId: 'main', source: 'discovered' })],
      }),
    ]);
    expect(declaredTopology.adapterInstances).toEqual([
      expect.objectContaining({
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        endpointId: 'openclaw-local',
        endpointRef: openClawRef,
        source: openClawSource,
        location: localLocation,
        lifecycle: { ...readyLifecycle, updatedAt: null },
      }),
    ]);
    expect(declaredTopology.runtimeInstances).toEqual([
      expect.objectContaining({
        endpointId: 'openclaw-local',
        endpointRef: openClawRef,
        source: openClawSource,
        location: localLocation,
        lifecycle: { ...readyLifecycle, updatedAt: null },
        agentIds: ['main'],
        defaultAgentId: 'main',
      }),
    ]);
    expect(declaredTopology.directory.runtimeInstances).toEqual(declaredTopology.runtimeInstances);
    expect(declaredTopology.endpoints.find((endpoint) => endpoint.id === 'openclaw-local')?.agents.map((agent) => agent.agentId)).not.toContain('default');

    await connectAcpEndpoint(registry, 'claude-code');

    const connectedTopology = registry.snapshotTopology();

    expect(connectedTopology.endpoints.map((endpoint) => endpoint.id).sort()).toEqual([
      'claude-code',
      'openclaw-local',
    ]);
    expect(connectedTopology.endpoints.find((endpoint) => endpoint.id === 'openclaw-local')).toMatchObject({
      agentIds: ['main'],
      defaultAgentId: 'main',
      agents: [expect.objectContaining({ agentId: 'main', source: 'discovered' })],
    });
    expect(connectedTopology.endpoints.find((endpoint) => endpoint.id === 'openclaw-local')?.agents.map((agent) => agent.agentId)).not.toContain('default');
    expect(connectedTopology.endpoints.find((endpoint) => endpoint.id === 'claude-code')).toMatchObject({
      id: 'claude-code',
      endpointRef: claudeCodeRef,
      source: claudeCodeSource,
      location: localLocation,
      lifecycle: {
        ...readyLifecycle,
        updatedAt: expect.any(Number),
      },
      agents: [expect.objectContaining({ agentId: 'default', source: 'discovered' })],
    });
    expect(connectedTopology.directory.endpointProfiles.map((endpoint) => endpoint.id).sort()).toEqual([
      'claude-code',
      'hermes',
      'openclaw-local',
    ]);
    expect(connectedTopology.directory.endpointProfiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'openclaw-local',
        endpointRef: openClawRef,
        source: openClawSource,
        location: localLocation,
        lifecycle: { ...readyLifecycle, updatedAt: null },
        agentIds: ['main'],
        defaultAgentId: 'main',
        agents: [expect.objectContaining({ agentId: 'main', source: 'discovered' })],
      }),
      expect.objectContaining({
        id: 'claude-code',
        endpointRef: claudeCodeRef,
        source: claudeCodeSource,
        location: localLocation,
        lifecycle: {
          ...readyLifecycle,
          updatedAt: expect.any(Number),
        },
        agents: [expect.objectContaining({ agentId: 'default', source: 'discovered' })],
      }),
      expect.objectContaining({
        id: 'hermes',
        endpointRef: hermesRef,
        source: hermesSource,
        location: localLocation,
        lifecycle: declaredLifecycle,
        agents: [expect.objectContaining({ agentId: 'default', source: 'declared' })],
      }),
    ]));
    expect(connectedTopology.runtimeInstances).toEqual(expect.arrayContaining([
      expect.objectContaining({
        endpointId: 'claude-code',
        endpointRef: claudeCodeRef,
        source: claudeCodeSource,
        location: localLocation,
        lifecycle: {
          ...readyLifecycle,
          updatedAt: expect.any(Number),
        },
        agentIds: ['default'],
      }),
    ]));
    expect(connectedTopology.directory.runtimeInstances).toEqual(connectedTopology.runtimeInstances);

    registry.disconnectRuntimeEndpoint({
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    });

    const disconnectedTopology = registry.snapshotTopology();

    expect(acpTransport.stop).toHaveBeenCalledTimes(1);
    expect(disconnectedTopology.endpoints.map((endpoint) => endpoint.id)).toEqual(['openclaw-local']);
    expect(disconnectedTopology.runtimeInstances.map((instance) => instance.endpointId)).toEqual(['openclaw-local']);
    expect(disconnectedTopology.directory.runtimeInstances).toEqual(disconnectedTopology.runtimeInstances);
    expect(disconnectedTopology.directory.endpointProfiles.find((endpoint) => endpoint.id === 'claude-code')).toMatchObject({
      id: 'claude-code',
      endpointRef: claudeCodeRef,
      source: claudeCodeSource,
      location: localLocation,
      lifecycle: {
        phase: 'disconnected',
        connected: false,
        ready: false,
        updatedAt: expect.any(Number),
      },
      agents: [expect.objectContaining({ agentId: 'default', source: 'declared' })],
    });
  });
});
