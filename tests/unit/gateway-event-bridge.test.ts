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

describe('runtime host gateway event bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queues gateway notifications until the session runtime is available', async () => {
    createGatewayClientMock.mockReturnValue(gatewayClient);
    const emitParentGatewayEvent = vi.fn(async () => undefined);
    const runtime = {
      consumeGatewayConversationEvent: vi.fn(async () => []),
      consumeGatewayNotification: vi.fn(() => [{ type: 'approval' }]),
      consumeGatewayConnectionState: vi.fn(() => []),
      consumeGatewayControlReadiness: vi.fn(() => []),
      consumeGatewayCapabilities: vi.fn(() => []),
    };
    let currentRuntime: typeof runtime | null = null;
    const { createRuntimeHostGatewayClient } = await import('../../runtime-host/composition/gateway-event-bridge');

    createRuntimeHostGatewayClient({
      parentTransport: {
        requestParentShellAction: vi.fn(async () => ({ success: true, status: 200, data: {} })),
        emitParentGatewayEvent,
      },
      dispatchRoute: vi.fn(async () => ({ status: 200, data: {} })),
      getSessionRuntime: () => currentRuntime,
      runtimeHostDataDir: process.cwd(),
      gatewayPort: 12345,
      readGatewayToken: vi.fn(async () => 'token'),
      platform: process.platform,
      clock: { nowMs: () => 1 },
      idGenerator: { randomUUID: () => 'id-1' },
      identityRepository: {} as never,
      deviceCrypto: {} as never,
      scheduler: {} as never,
      tcpProbe: {} as never,
    });

    const options = createGatewayClientMock.mock.calls[0]?.[0];
    options.onGatewayNotification({ method: 'exec.approval.requested', params: { id: 'approval-1' } });
    expect(runtime.consumeGatewayNotification).not.toHaveBeenCalled();

    currentRuntime = runtime;
    options.onGatewayConversationEvent({ type: 'usage', event: { sessionKey: 'agent:main:main' } });
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.consumeGatewayNotification).toHaveBeenCalledWith({ method: 'exec.approval.requested', params: { id: 'approval-1' } });
    expect(emitParentGatewayEvent).toHaveBeenCalledWith('session:update', { type: 'approval' });
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
    const runtime = {
      consumeGatewayConversationEvent: vi.fn(async () => []),
      consumeGatewayNotification: vi.fn(() => []),
      consumeGatewayConnectionState: vi.fn(() => []),
      consumeGatewayControlReadiness: vi.fn(() => []),
      consumeGatewayCapabilities: vi.fn(() => []),
    };
    const { createRuntimeHostGatewayClient } = await import('../../runtime-host/composition/gateway-event-bridge');

    createRuntimeHostGatewayClient({
      parentTransport: {
        requestParentShellAction: vi.fn(async () => ({ success: true, status: 200, data: {} })),
        emitParentGatewayEvent: vi.fn(async () => undefined),
      },
      dispatchRoute: vi.fn(async () => ({ status: 200, data: {} })),
      getSessionRuntime: () => runtime,
      runtimeHostDataDir: process.cwd(),
      gatewayPort: 12345,
      readGatewayToken: vi.fn(async () => 'token'),
      platform: process.platform,
      clock: { nowMs: () => 1 },
      idGenerator: { randomUUID: () => 'id-1' },
      identityRepository: {} as never,
      deviceCrypto: {} as never,
      scheduler: {} as never,
      tcpProbe: {} as never,
    });

    const onGatewayConnectionState = createGatewayClientMock.mock.calls[0]?.[0].onGatewayConnectionState;
    const connected = (transportEpoch: number): GatewayConnectionStatePayload => ({
      state: 'connected',
      portReachable: true,
      gatewayReady: false,
      transportEpoch,
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: transportEpoch,
    });

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

    expect(runtime.consumeGatewayControlReadiness).toHaveBeenCalledTimes(1);
    expect(runtime.consumeGatewayControlReadiness).toHaveBeenCalledWith(expect.objectContaining({ capabilities: { methods: ['status'], updatedAt: 2 } }));
  });

  it('reuses readiness capabilities on connect instead of issuing a second capabilities probe', async () => {
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
    const runtime = {
      consumeGatewayConversationEvent: vi.fn(async () => []),
      consumeGatewayNotification: vi.fn(() => []),
      consumeGatewayConnectionState: vi.fn(() => []),
      consumeGatewayControlReadiness: vi.fn(() => [{ type: 'readiness' }]),
      consumeGatewayCapabilities: vi.fn(() => [{ type: 'capabilities' }]),
    };
    const { createRuntimeHostGatewayClient } = await import('../../runtime-host/composition/gateway-event-bridge');

    createRuntimeHostGatewayClient({
      parentTransport: {
        requestParentShellAction: vi.fn(async () => ({ success: true, status: 200, data: {} })),
        emitParentGatewayEvent,
      },
      dispatchRoute: vi.fn(async () => ({ status: 200, data: {} })),
      getSessionRuntime: () => runtime,
      runtimeHostDataDir: process.cwd(),
      gatewayPort: 12345,
      readGatewayToken: vi.fn(async () => 'token'),
      platform: process.platform,
      clock: { nowMs: () => 1 },
      idGenerator: { randomUUID: () => 'id-1' },
      identityRepository: {} as never,
      deviceCrypto: {} as never,
      scheduler: {} as never,
      tcpProbe: {} as never,
    });

    const onGatewayConnectionState = createGatewayClientMock.mock.calls[0]?.[0].onGatewayConnectionState;
    const payload: GatewayConnectionStatePayload = {
      state: 'connected',
      portReachable: true,
      gatewayReady: false,
      transportEpoch: 1,
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 1,
    };
    onGatewayConnectionState(payload);
    await Promise.resolve();
    await Promise.resolve();

    expect(gatewayClient.inspectGatewayControlReadiness).toHaveBeenCalledTimes(1);
    expect(gatewayClient.readGatewayCapabilities).not.toHaveBeenCalled();
    expect(runtime.consumeGatewayControlReadiness).toHaveBeenCalledWith(expect.objectContaining({ capabilities }));
    expect(runtime.consumeGatewayCapabilities).toHaveBeenCalledWith(capabilities);
    expect(emitParentGatewayEvent).toHaveBeenCalledWith('session:update', { type: 'readiness' });
    expect(emitParentGatewayEvent).toHaveBeenCalledWith('session:update', { type: 'capabilities' });
  });
});
