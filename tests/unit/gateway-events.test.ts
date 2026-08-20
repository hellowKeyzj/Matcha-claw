import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayStatus } from '@/types/gateway';

const hostApiFetchMock = vi.hoisted(() => vi.fn());
const subscribeHostEventMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: (...args: unknown[]) => subscribeHostEventMock(...args),
}));

function createGatewayStatus(overrides: Partial<GatewayStatus> = {}): GatewayStatus {
  return {
    processState: 'stopped',
    port: 18789,
    gatewayReady: false,
    healthSummary: 'unresponsive',
    transportState: 'disconnected',
    portReachable: false,
    diagnostics: {
      consecutiveHeartbeatMisses: 0,
      consecutiveRpcFailures: 0,
    },
    updatedAt: 1,
    ...overrides,
  };
}

describe('gateway store host event wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    hostApiFetchMock.mockResolvedValue(createGatewayStatus());
  });

  it('subscribes to gateway and runtime-host projections on initialization', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/gateway/status');
    expect([...handlers.keys()].sort()).toEqual([
      'gateway:channel-status',
      'gateway:error',
      'gateway:status',
      'runtime-host:error',
      'runtime-host:restart',
      'runtime-host:status',
      'session.delta',
      'task:snapshot',
    ]);
  });

  it('projects gateway:status events as the complete gateway snapshot', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    const gatewayStatus = handlers.get('gateway:status');
    expect(gatewayStatus).toEqual(expect.any(Function));

    const disconnected = createGatewayStatus({
      processState: 'running',
      lastError: 'socket closed',
      diagnostics: {
        consecutiveHeartbeatMisses: 1,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 2,
    });
    gatewayStatus!(disconnected);
    expect(useGatewayStore.getState().status).toEqual(disconnected);

    const recovered = createGatewayStatus({
      processState: 'running',
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
      updatedAt: 3,
    });
    gatewayStatus!(recovered);
    expect(useGatewayStore.getState().status).toEqual(recovered);
    expect(useGatewayStore.getState().status).not.toHaveProperty('lastError');
  });

  it('keeps the newer gateway event when the initial snapshot resolves late', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });
    hostApiFetchMock.mockImplementation((path: string) => Promise.resolve(path === '/api/gateway/status'
      ? createGatewayStatus({ processState: 'starting', updatedAt: 2 })
      : { status: 'running', updatedAt: 2 }));

    const { useGatewayStore } = await import('@/stores/gateway');
    const init = useGatewayStore.getState().init();
    handlers.get('gateway:status')!(createGatewayStatus({
      processState: 'running',
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
      updatedAt: 3,
    }));
    await init;

    expect(useGatewayStore.getState().status).toMatchObject({
      processState: 'running',
      gatewayReady: true,
      updatedAt: 3,
    });
  });

  it('projects runtime-host lifecycle and error events using their current payload contract', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    const runtimeHostStatus = handlers.get('runtime-host:status');
    const runtimeHostError = handlers.get('runtime-host:error');
    expect(runtimeHostStatus).toEqual(expect.any(Function));
    expect(runtimeHostError).toEqual(expect.any(Function));

    runtimeHostStatus!({
      status: 'running',
      hostLifecycle: 'ready',
      runtimeLifecycle: 'starting',
      pid: 4321,
      activePluginCount: 2,
      enabledPluginIds: ['plugin-a', 'plugin-b'],
      error: 'stale transport error',
      updatedAt: 1001,
    });
    expect(useGatewayStore.getState().runtimeHost).toMatchObject({
      lifecycle: 'running',
      hostLifecycle: 'ready',
      runtimeLifecycle: 'starting',
      pid: 4321,
      activePluginCount: 2,
      enabledPluginIds: ['plugin-a', 'plugin-b'],
      error: undefined,
      updatedAt: 1001,
    });

    runtimeHostError!({
      status: 'error',
      message: 'Runtime Host is unavailable.',
      updatedAt: 1002,
    });
    expect(useGatewayStore.getState().runtimeHost).toMatchObject({
      lifecycle: 'error',
      error: 'Runtime Host is unavailable.',
      updatedAt: 1002,
    });
  });
});
