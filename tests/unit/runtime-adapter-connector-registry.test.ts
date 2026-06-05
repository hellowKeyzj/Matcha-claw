import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeRegistry } from '../../runtime-host/application/agent-runtime/contracts/agent-runtime-registry';
import { OpenClawRuntimeAdapter } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-adapter';
import { createTestAcpClientConnector } from './helpers/acp-test-connector';
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
    const transport = registry.resolveTransportForAddress({
      kind: 'native-runtime',
      capabilityId: 'session.prompt',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
      agentId: 'default',
    });

    expect(transport).toBeTruthy();
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      id: 'openclaw-local',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
    }), { gateway: nativeGateway });
    expect(registry.getProtocol('openclaw-v4')).toBe(adapter.protocol);
  });

  it('routes connector runtime transport through the protocol connector', () => {
    const registry = new AgentRuntimeRegistry();
    const connector = createTestAcpClientConnector();
    const transport = {
      sendPrompt: vi.fn(),
      abortSession: vi.fn(),
      resolveApproval: vi.fn(),
    };
    const connect = vi.spyOn(connector, 'connect').mockReturnValue(transport);
    registry.register({ protocolConnectors: [connector] });

    expect(registry.resolveTransportForAddress({
      kind: 'protocol-connector',
      capabilityId: 'session.prompt',
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
      agentId: 'default',
    })).toBe(transport);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      id: 'claude-code',
      protocolId: 'acp',
      connectorId: 'acp',
    }));
    expect(registry.getProtocol('acp')).toBe(connector.protocol);
  });

  it('rejects connector addresses for agents not declared by the endpoint', () => {
    const registry = new AgentRuntimeRegistry();
    registry.register({
      protocolConnectors: [createConnector('first', {
        sendPrompt: vi.fn(),
        abortSession: vi.fn(),
        resolveApproval: vi.fn(),
      })],
    });

    expect(() => registry.resolveTransportForAddress({
      kind: 'protocol-connector',
      capabilityId: 'session.prompt',
      protocolId: 'test-protocol',
      connectorId: 'first',
      endpointId: 'shared-endpoint',
      agentId: 'reviewer',
    })).toThrow('Runtime endpoint agent not registered: shared-endpoint:reviewer');
  });

  it('resolves capability descriptors for native runtime dynamic agents without pre-registering every agent', () => {
    const registry = new AgentRuntimeRegistry();
    registry.register({
      runtimeAdapters: [new OpenClawRuntimeAdapter()],
    });

    expect(registry.getCapability({
      id: 'session.management',
      address: {
        kind: 'native-runtime',
        capabilityId: 'session.management',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        agentId: 'foo',
      },
    })).toMatchObject({
      id: 'session.management',
      targetAgentIds: ['foo'],
      address: expect.objectContaining({
        agentId: 'foo',
        capabilityId: 'session.management',
      }),
    });
  });

  it('allows a connector endpoint to expose multiple explicit agents', () => {
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

    expect(registry.resolveTransportForAddress({
      kind: 'protocol-connector',
      capabilityId: 'session.prompt',
      protocolId: 'test-protocol',
      connectorId: 'multi-agent',
      endpointId: 'shared-endpoint',
      agentId: 'reviewer',
    })).toBe(transport);
  });

  it('refreshes connector endpoint agents and capabilities from connection discovery', async () => {
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

    const reviewerApprovalAddress = {
      kind: 'protocol-connector' as const,
      capabilityId: 'session.approval',
      protocolId: 'test-protocol',
      connectorId: 'discovering',
      endpointId: 'shared-endpoint',
      agentId: 'reviewer',
    };
    expect(registry.getCapability({
      id: 'session.approval',
      address: reviewerApprovalAddress,
    }).address).toEqual(reviewerApprovalAddress);
    expect(registry.snapshotTopology().endpoints.find((endpoint) => endpoint.connectorId === 'discovering')).toMatchObject({
      agentIds: ['default', 'reviewer'],
      capabilities: expect.objectContaining({ approvals: true, tools: true }),
      capabilityAddresses: expect.arrayContaining([reviewerApprovalAddress]),
    });
  });

  it('routes Claude Code and Hermes ACP endpoints through isolated transports and capability addresses', () => {
    const registry = new AgentRuntimeRegistry();
    const connector = createTestAcpClientConnector();
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
    const connect = vi.spyOn(connector, 'connect').mockImplementation((endpoint) => {
      if (endpoint.id === 'claude-code') {
        return claudeTransport;
      }
      if (endpoint.id === 'hermes') {
        return hermesTransport;
      }
      throw new Error(`unexpected endpoint: ${endpoint.id}`);
    });
    registry.register({ protocolConnectors: [connector] });

    const claudeAddress = {
      kind: 'protocol-connector' as const,
      capabilityId: 'session.prompt',
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
      agentId: 'default',
    };
    const hermesAddress = {
      ...claudeAddress,
      endpointId: 'hermes',
    };

    expect(registry.resolveTransportForAddress(claudeAddress)).toBe(claudeTransport);
    expect(registry.resolveTransportForAddress(hermesAddress)).toBe(hermesTransport);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude-code', connectorId: 'acp' }));
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ id: 'hermes', connectorId: 'acp' }));
    expect(registry.getCapability({ id: 'session.prompt', address: claudeAddress }).address).toEqual(claudeAddress);
    expect(registry.getCapability({ id: 'session.prompt', address: hermesAddress }).address).toEqual(hermesAddress);
  });

  it('allows different connectors to expose the same endpoint id without transport cross-talk', () => {
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

    expect(registry.resolveTransportForAddress({
      kind: 'protocol-connector',
      capabilityId: 'session.prompt',
      protocolId: 'test-protocol',
      connectorId: 'first',
      endpointId: 'shared-endpoint',
      agentId: 'default',
    })).toBe(firstTransport);
    expect(registry.resolveTransportForAddress({
      kind: 'protocol-connector',
      capabilityId: 'session.prompt',
      protocolId: 'test-protocol',
      connectorId: 'second',
      endpointId: 'shared-endpoint',
      agentId: 'default',
    })).toBe(secondTransport);
    expect(() => registry.getEndpoint('shared-endpoint')).toThrow('Runtime endpoint id is ambiguous: shared-endpoint');
    expect(registry.resolveApprovalNotificationsForAddress({
      kind: 'protocol-connector',
      capabilityId: 'session.prompt',
      protocolId: 'test-protocol',
      connectorId: 'first',
      endpointId: 'shared-endpoint',
      agentId: 'default',
    })).toBeNull();
  });

  it('stores gateway control state on the addressed runtime endpoint topology', () => {
    const registry = new AgentRuntimeRegistry();
    registry.register({
      runtimeAdapters: [new OpenClawRuntimeAdapter()],
      protocolConnectors: [createConnector('test-connector', {
        sendPrompt: vi.fn(),
        abortSession: vi.fn(),
        resolveApproval: vi.fn(),
      })],
    });

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
      address: {
        kind: 'native-runtime',
        capabilityId: 'runtime.host',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        agentId: 'agent:main:main',
      },
      connection,
      updatedAt: connection.updatedAt,
    });
    registry.updateRuntimeEndpointControlState({
      address: {
        kind: 'protocol-connector',
        capabilityId: 'runtime.host',
        protocolId: 'test-protocol',
        connectorId: 'test-connector',
        endpointId: 'shared-endpoint',
        agentId: 'default',
      },
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
