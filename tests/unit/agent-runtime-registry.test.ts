import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeRegistry } from '../../runtime-host/application/agent-runtime/contracts/agent-runtime-registry';
import { OpenClawRuntimeAdapter } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-adapter';
import { createTestAcpClientConnector } from './helpers/acp-test-connector';
import { agentScope, connectorRuntimeEndpoint, nativeRuntimeEndpoint, runtimeInstanceScope } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
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
    const transport = registry.resolveTransportForEndpoint(openClawEndpointRef(), 'default');

    expect(transport).toBeTruthy();
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      id: 'openclaw-local',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
    }), { gateway: nativeGateway });
    expect(registry.getProtocol('openclaw-v4')).toBe(adapter.protocol);
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
});
