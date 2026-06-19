import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayConnectionStatePayload } from '../../runtime-host/openclaw-bridge';

const gatewayClient = vi.hoisted(() => ({
  inspectGatewayControlReadiness: vi.fn(),
  readGatewayCapabilities: vi.fn(),
  readGatewayConnectionState: vi.fn(),
}));
const createGatewayClientMock = vi.hoisted(() => vi.fn());

vi.mock('../../runtime-host/openclaw-bridge', () => ({
  createGatewayClient: createGatewayClientMock,
}));

function connected(transportEpoch: number): GatewayConnectionStatePayload {
  return {
    state: 'connected',
    portReachable: true,
    gatewayReady: false,
    transportEpoch,
    diagnostics: {
      consecutiveHeartbeatMisses: 0,
      consecutiveRpcFailures: 0,
    },
    updatedAt: transportEpoch,
  };
}

describe('runtime host gateway event bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queues gateway notifications until the session runtime is available', async () => {
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const emitParentGatewayEvent = vi.fn(async () => undefined);
    const endpointControlState = {
      updateRuntimeEndpointControlState: vi.fn(() => ({
        connection: null,
        readiness: null,
        capabilities: null,
        updatedAt: null,
      })),
    };
    const runtime = {
      consumeEndpointConversationEvent: vi.fn(async () => []),
      consumeEndpointNotification: vi.fn(() => [{ type: 'approval' }]),
    };
    let currentRuntime: typeof runtime | null = null;
    const { createRuntimeHostGatewayClient } = await import('../../runtime-host/application/adapters/openclaw/gateway/openclaw-gateway-event-bridge');

    createRuntimeHostGatewayClient({
      parentTransport: {
        requestParentShellAction: vi.fn(async () => ({ success: true, status: 200, data: {} })),
        emitParentGatewayEvent,
      },
      dispatchRoute: vi.fn(async () => ({ status: 200, data: {} })),
      getSessionRuntime: () => currentRuntime,
      endpointControlState,
      runtimeHostEndpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'test-runtime',
        runtimeInstanceId: 'local',
      },
      runtimeHostDataDir: process.cwd(),
      gatewayPort: 12345,
      readGatewayToken: vi.fn(async () => 'token'),
      platform: process.platform,
      clock: { nowMs: () => 1 },
      idGenerator: { randomId: () => 'id-1', randomHex: () => '00' },
      identityRepository: {} as never,
      deviceCrypto: {} as never,
      scheduler: { schedule: vi.fn(() => ({ cancel: vi.fn() })) },
      tcpProbe: {} as never,
    });

    const options = createGatewayClientMock.mock.calls[0]?.[0];
    options.onGatewayNotification({ method: 'exec.approval.requested', params: { id: 'approval-1' } });
    options.onGatewayNotification({ method: 'exec.approval.requested', params: { id: 'approval-2' } });
    expect(runtime.consumeEndpointNotification).not.toHaveBeenCalled();

    currentRuntime = runtime;
    options.onGatewayConversationEvent({ type: 'usage', event: { sessionKey: 'agent:main:main' } });
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.consumeEndpointNotification.mock.calls.map((call) => call[0])).toEqual([
      {
        kind: 'native-runtime',
        runtimeAdapterId: 'test-runtime',
        runtimeInstanceId: 'local',
      },
      {
        kind: 'native-runtime',
        runtimeAdapterId: 'test-runtime',
        runtimeInstanceId: 'local',
      },
    ]);
    expect(runtime.consumeEndpointNotification.mock.calls.map((call) => call[1])).toEqual([
      { method: 'exec.approval.requested', params: { id: 'approval-1' } },
      { method: 'exec.approval.requested', params: { id: 'approval-2' } },
    ]);
    expect(runtime.consumeEndpointConversationEvent).toHaveBeenCalledWith({
      kind: 'native-runtime',
      runtimeAdapterId: 'test-runtime',
      runtimeInstanceId: 'local',
    }, {
      type: 'usage',
      event: { sessionKey: 'agent:main:main' },
      sessionIdentity: {
        endpoint: {
          kind: 'native-runtime',
          runtimeAdapterId: 'test-runtime',
          runtimeInstanceId: 'local',
        },
        agentId: 'main',
        sessionKey: 'agent:main:main',
      },
    });
    expect(emitParentGatewayEvent).toHaveBeenCalledWith('session:update', { type: 'approval' });
  });

  it('flushes pending conversation events in session order when the session runtime becomes available', async () => {
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const emitParentGatewayEvent = vi.fn(async () => undefined);
    const endpointControlState = {
      updateRuntimeEndpointControlState: vi.fn(() => ({
        connection: null,
        readiness: null,
        capabilities: null,
        updatedAt: null,
      })),
    };
    const consumedEvents: string[] = [];
    const runtime = {
      consumeEndpointConversationEvent: vi.fn(async (_endpoint, payload: { event?: { sessionKey?: string; seq?: number } }) => {
        consumedEvents.push(`conversation:${String(payload.event?.seq ?? 0)}`);
        return [{ sessionKey: payload.event?.sessionKey, seq: payload.event?.seq }];
      }),
      consumeEndpointNotification: vi.fn(() => {
        consumedEvents.push('notification:approval');
        return [{ type: 'approval' }];
      }),
    };
    let currentRuntime: typeof runtime | null = null;
    const { createRuntimeHostGatewayClient } = await import('../../runtime-host/application/adapters/openclaw/gateway/openclaw-gateway-event-bridge');

    createRuntimeHostGatewayClient({
      parentTransport: {
        requestParentShellAction: vi.fn(async () => ({ success: true, status: 200, data: {} })),
        emitParentGatewayEvent,
      },
      dispatchRoute: vi.fn(async () => ({ status: 200, data: {} })),
      getSessionRuntime: () => currentRuntime,
      endpointControlState,
      runtimeHostEndpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'test-runtime',
        runtimeInstanceId: 'local',
      },
      runtimeHostDataDir: process.cwd(),
      gatewayPort: 12345,
      readGatewayToken: vi.fn(async () => 'token'),
      platform: process.platform,
      clock: { nowMs: () => 1 },
      idGenerator: { randomId: () => 'id-1', randomHex: () => '00' },
      identityRepository: {} as never,
      deviceCrypto: {} as never,
      scheduler: { schedule: vi.fn(() => ({ cancel: vi.fn() })) },
      tcpProbe: {} as never,
    });

    const options = createGatewayClientMock.mock.calls[0]?.[0];
    options.onGatewayConversationEvent({ type: 'usage', event: { sessionKey: 'agent:main:main', seq: 1 } });
    options.onGatewayConversationEvent({ type: 'usage', event: { sessionKey: 'agent:main:main', seq: 2 } });
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.consumeEndpointConversationEvent).not.toHaveBeenCalled();

    currentRuntime = runtime;
    options.onGatewayNotification({ method: 'exec.approval.requested', params: { id: 'approval-1' } });

    await vi.waitFor(() => {
      expect(consumedEvents).toEqual([
        'conversation:1',
        'conversation:2',
        'notification:approval',
      ]);
    });
    expect(runtime.consumeEndpointConversationEvent.mock.calls.map((call) => call[1])).toEqual([
      {
        type: 'usage',
        event: { sessionKey: 'agent:main:main', seq: 1 },
        sessionIdentity: {
          endpoint: {
            kind: 'native-runtime',
            runtimeAdapterId: 'test-runtime',
            runtimeInstanceId: 'local',
          },
          agentId: 'main',
          sessionKey: 'agent:main:main',
        },
      },
      {
        type: 'usage',
        event: { sessionKey: 'agent:main:main', seq: 2 },
        sessionIdentity: {
          endpoint: {
            kind: 'native-runtime',
            runtimeAdapterId: 'test-runtime',
            runtimeInstanceId: 'local',
          },
          agentId: 'main',
          sessionKey: 'agent:main:main',
        },
      },
    ]);
  });

  it('routes raw OpenClaw chat events through endpoint ingress with SessionIdentity', async () => {
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const emitParentGatewayEvent = vi.fn(async () => undefined);
    const endpointControlState = {
      updateRuntimeEndpointControlState: vi.fn(() => ({
        connection: null,
        readiness: null,
        capabilities: null,
        updatedAt: null,
      })),
    };
    const runtime = {
      consumeEndpointConversationEvent: vi.fn(async () => [{
        sessionUpdate: 'session_item',
        sessionKey: 'agent:main:main',
        item: { kind: 'assistant-turn', text: '你好，主人' },
      }]),
      consumeEndpointNotification: vi.fn(() => []),
    };
    const { createRuntimeHostGatewayClient } = await import('../../runtime-host/application/adapters/openclaw/gateway/openclaw-gateway-event-bridge');

    createRuntimeHostGatewayClient({
      parentTransport: {
        requestParentShellAction: vi.fn(async () => ({ success: true, status: 200, data: {} })),
        emitParentGatewayEvent,
      },
      dispatchRoute: vi.fn(async () => ({ status: 200, data: {} })),
      getSessionRuntime: () => runtime,
      endpointControlState,
      runtimeHostEndpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'test-runtime',
        runtimeInstanceId: 'local',
      },
      runtimeHostDataDir: process.cwd(),
      gatewayPort: 12345,
      readGatewayToken: vi.fn(async () => 'token'),
      platform: process.platform,
      clock: { nowMs: () => 1 },
      idGenerator: { randomId: () => 'id-1', randomHex: () => '00' },
      identityRepository: {} as never,
      deviceCrypto: {} as never,
      scheduler: { schedule: vi.fn(() => ({ cancel: vi.fn() })) },
      tcpProbe: {} as never,
    });

    const options = createGatewayClientMock.mock.calls[0]?.[0];
    const event = {
      type: 'chat.message' as const,
      event: {
        state: 'final',
        sessionKey: 'agent:main:main',
        runId: 'run-final',
        seq: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: '你好，主人' }] },
      },
    };
    options.onGatewayConversationEvent(event);

    await vi.waitFor(() => {
      expect(runtime.consumeEndpointConversationEvent).toHaveBeenCalledWith({
        kind: 'native-runtime',
        runtimeAdapterId: 'test-runtime',
        runtimeInstanceId: 'local',
      }, {
        ...event,
        sessionIdentity: {
          endpoint: {
            kind: 'native-runtime',
            runtimeAdapterId: 'test-runtime',
            runtimeInstanceId: 'local',
          },
          agentId: 'main',
          sessionKey: 'agent:main:main',
        },
      });
    });
    expect(emitParentGatewayEvent).toHaveBeenCalledWith('session:update', {
      sessionUpdate: 'session_item',
      sessionKey: 'agent:main:main',
      item: { kind: 'assistant-turn', text: '你好，主人' },
    });
  });

  it('serializes gateway conversation events per session without blocking other sessions', async () => {
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const emitParentGatewayEvent = vi.fn(async () => undefined);
    const endpointControlState = {
      updateRuntimeEndpointControlState: vi.fn(() => ({
        connection: null,
        readiness: null,
        capabilities: null,
        updatedAt: null,
      })),
    };
    const processed: string[] = [];
    let releaseFirstMain: () => void = () => undefined;
    const runtime = {
      consumeEndpointConversationEvent: vi.fn(async (_endpoint, payload: { event?: { sessionKey?: string; seq?: number } }) => {
        const sessionKey = payload.event?.sessionKey ?? 'unknown';
        const seq = payload.event?.seq ?? 0;
        processed.push(`start:${sessionKey}:${seq}`);
        if (sessionKey === 'agent:main:main' && seq === 1) {
          await new Promise<void>((resolve) => { releaseFirstMain = resolve; });
        }
        processed.push(`end:${sessionKey}:${seq}`);
        return [{ sessionKey, seq }];
      }),
      consumeEndpointNotification: vi.fn(() => []),
    };
    const { createRuntimeHostGatewayClient } = await import('../../runtime-host/application/adapters/openclaw/gateway/openclaw-gateway-event-bridge');

    createRuntimeHostGatewayClient({
      parentTransport: {
        requestParentShellAction: vi.fn(async () => ({ success: true, status: 200, data: {} })),
        emitParentGatewayEvent,
      },
      dispatchRoute: vi.fn(async () => ({ status: 200, data: {} })),
      getSessionRuntime: () => runtime,
      endpointControlState,
      runtimeHostEndpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'test-runtime',
        runtimeInstanceId: 'local',
      },
      runtimeHostDataDir: process.cwd(),
      gatewayPort: 12345,
      readGatewayToken: vi.fn(async () => 'token'),
      platform: process.platform,
      clock: { nowMs: () => 1 },
      idGenerator: { randomId: () => 'id-1', randomHex: () => '00' },
      identityRepository: {} as never,
      deviceCrypto: {} as never,
      scheduler: { schedule: vi.fn(() => ({ cancel: vi.fn() })) },
      tcpProbe: {} as never,
    });

    const options = createGatewayClientMock.mock.calls[0]?.[0];
    options.onGatewayConversationEvent({ type: 'usage', event: { sessionKey: 'agent:main:main', seq: 1 } });
    options.onGatewayConversationEvent({ type: 'usage', event: { sessionKey: 'agent:main:main', seq: 2 } });
    options.onGatewayConversationEvent({ type: 'usage', event: { sessionKey: 'agent:test:main', seq: 1 } });
    await Promise.resolve();
    await Promise.resolve();

    expect(processed).toEqual([
      'start:agent:main:main:1',
      'start:agent:test:main:1',
      'end:agent:test:main:1',
    ]);

    releaseFirstMain();
    await vi.waitFor(() => {
      expect(emitParentGatewayEvent).toHaveBeenCalledWith('session:update', { sessionKey: 'agent:main:main', seq: 2 });
    });

    expect(processed).toEqual([
      'start:agent:main:main:1',
      'start:agent:test:main:1',
      'end:agent:test:main:1',
      'end:agent:main:main:1',
      'start:agent:main:main:2',
      'end:agent:main:main:2',
    ]);
  });

  it('ignores stale readiness results from superseded transport epochs', async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    gatewayClient.inspectGatewayControlReadiness
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({
        ready: true,
        phase: 'ready',
        requiredMethods: ['status'],
        missingMethods: [],
        retryable: false,
        capabilities: { methods: ['status'], updatedAt: 2 },
      });
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const endpointControlState = {
      updateRuntimeEndpointControlState: vi.fn(() => ({
        connection: null,
        readiness: null,
        capabilities: null,
        updatedAt: null,
      })),
    };
    const runtime = {
      consumeEndpointConversationEvent: vi.fn(async () => []),
      consumeEndpointNotification: vi.fn(() => []),
    };
    const { createRuntimeHostGatewayClient } = await import('../../runtime-host/application/adapters/openclaw/gateway/openclaw-gateway-event-bridge');

    createRuntimeHostGatewayClient({
      parentTransport: {
        requestParentShellAction: vi.fn(async () => ({ success: true, status: 200, data: {} })),
        emitParentGatewayEvent: vi.fn(async () => undefined),
      },
      dispatchRoute: vi.fn(async () => ({ status: 200, data: {} })),
      getSessionRuntime: () => runtime,
      endpointControlState,
      runtimeHostEndpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'test-runtime',
        runtimeInstanceId: 'local',
      },
      runtimeHostDataDir: process.cwd(),
      gatewayPort: 12345,
      readGatewayToken: vi.fn(async () => 'token'),
      platform: process.platform,
      clock: { nowMs: () => 1 },
      idGenerator: { randomId: () => 'id-1', randomHex: () => '00' },
      identityRepository: {} as never,
      deviceCrypto: {} as never,
      scheduler: { schedule: vi.fn(() => ({ cancel: vi.fn() })) },
      tcpProbe: {} as never,
    });

    const onGatewayConnectionState = createGatewayClientMock.mock.calls[0]?.[0].onGatewayConnectionState;

    onGatewayConnectionState(connected(1));
    onGatewayConnectionState(connected(2));
    resolveFirst({
      ready: true,
      phase: 'ready',
      requiredMethods: ['status'],
      missingMethods: [],
      retryable: false,
      capabilities: { methods: ['stale'], updatedAt: 1 },
    });
    await Promise.resolve();
    await Promise.resolve();

    const readinessUpdates = endpointControlState.updateRuntimeEndpointControlState.mock.calls
      .map((call) => call[0])
      .filter((input) => input.readiness);
    expect(readinessUpdates).toHaveLength(1);
    expect(readinessUpdates[0]).toMatchObject({
      readiness: expect.objectContaining({ capabilities: { methods: ['status'], updatedAt: 2 } }),
      capabilities: { methods: ['status'], updatedAt: 2 },
    });
  });

  it('stores readiness capabilities on the runtime endpoint instead of emitting session updates', async () => {
    const capabilities = {
      methods: ['status', 'config.get', 'agents.list', 'skills.status', 'system-presence'],
      updatedAt: 123,
    };
    gatewayClient.inspectGatewayControlReadiness.mockResolvedValue({
      ready: true,
      phase: 'ready',
      requiredMethods: capabilities.methods,
      missingMethods: [],
      retryable: false,
      capabilities,
    });
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const emitParentGatewayEvent = vi.fn(async () => undefined);
    const endpointControlState = {
      updateRuntimeEndpointControlState: vi.fn(() => ({
        connection: null,
        readiness: null,
        capabilities: null,
        updatedAt: null,
      })),
    };
    const runtime = {
      consumeEndpointConversationEvent: vi.fn(async () => []),
      consumeEndpointNotification: vi.fn(() => []),
    };
    const { createRuntimeHostGatewayClient } = await import('../../runtime-host/application/adapters/openclaw/gateway/openclaw-gateway-event-bridge');

    createRuntimeHostGatewayClient({
      parentTransport: {
        requestParentShellAction: vi.fn(async () => ({ success: true, status: 200, data: {} })),
        emitParentGatewayEvent,
      },
      dispatchRoute: vi.fn(async () => ({ status: 200, data: {} })),
      getSessionRuntime: () => runtime,
      endpointControlState,
      runtimeHostEndpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'test-runtime',
        runtimeInstanceId: 'local',
      },
      runtimeHostDataDir: process.cwd(),
      gatewayPort: 12345,
      readGatewayToken: vi.fn(async () => 'token'),
      platform: process.platform,
      clock: { nowMs: () => 1 },
      idGenerator: { randomId: () => 'id-1', randomHex: () => '00' },
      identityRepository: {} as never,
      deviceCrypto: {} as never,
      scheduler: { schedule: vi.fn(() => ({ cancel: vi.fn() })) },
      tcpProbe: {} as never,
    });

    const onGatewayConnectionState = createGatewayClientMock.mock.calls[0]?.[0].onGatewayConnectionState;
    const payload = connected(1);
    onGatewayConnectionState(payload);
    await Promise.resolve();
    await Promise.resolve();

    expect(gatewayClient.inspectGatewayControlReadiness).toHaveBeenCalledTimes(1);
    expect(gatewayClient.readGatewayCapabilities).not.toHaveBeenCalled();
    expect(endpointControlState.updateRuntimeEndpointControlState).toHaveBeenCalledWith({
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'test-runtime',
        runtimeInstanceId: 'local',
      },
      connection: payload,
      updatedAt: payload.updatedAt,
    });
    expect(endpointControlState.updateRuntimeEndpointControlState).toHaveBeenCalledWith({
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'test-runtime',
        runtimeInstanceId: 'local',
      },
      readiness: expect.objectContaining({ capabilities }),
      capabilities,
      updatedAt: 1,
    });
    expect(emitParentGatewayEvent.mock.calls.some((call) => call[0] === 'session:update')).toBe(false);
  });
});
