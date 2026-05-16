import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../electron/services/providers/oauth/browser-oauth-manager', () => ({
  browserOAuthManager: new EventEmitter(),
}));

vi.mock('../../electron/services/providers/oauth/device-oauth-manager', () => ({
  deviceOAuthManager: new EventEmitter(),
}));

class FakeGatewayManager extends EventEmitter {
  private status: { processState: 'stopped' | 'starting' | 'control_connecting' | 'running' | 'error' | 'reconnecting'; port: number };

  constructor() {
    super();
    this.status = { processState: 'stopped', port: 18789 };
  }

  getStatus() {
    return this.status;
  }
}

describe('host event bridge runtime-host lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('会透传 runtime-host status/error/restart 事件到 host event 通道', async () => {
    const gatewayManager = new FakeGatewayManager();
    let gatewayEventHandler: ((eventName: string, payload: unknown) => void) | null = null;

    let runtimeState = {
      lifecycle: 'running' as const,
      runtimeLifecycle: 'running' as const,
      pid: 1111,
      activePluginCount: 2,
    };
    let runtimeHealth = {
      ok: true,
      lifecycle: 'running' as const,
      activePluginCount: 2,
      degradedPlugins: [] as string[],
    };

    const runtimeHostManager = {
      getState: vi.fn(() => runtimeState),
      checkHealth: vi.fn(async () => runtimeHealth),
      readGatewayStatus: vi.fn(async () => ({
        state: 'connected',
        portReachable: true,
        gatewayReady: true,
        healthSummary: 'healthy',
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 123,
      })),
      emitGatewayEvent: vi.fn(),
      onGatewayEvent: vi.fn((handler: (eventName: string, payload: unknown) => void) => {
        gatewayEventHandler = handler;
        return () => {
          gatewayEventHandler = null;
        };
      }),
      emitRuntimeJobEvent: vi.fn(),
      onRuntimeJobEvent: vi.fn(() => () => {}),
    };
    const eventBus = { emit: vi.fn() };
    const send = vi.fn();
    const mainWindow = { webContents: { send } };

    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');

    registerHostEventBridge({
      gatewayManager: gatewayManager as never,
      runtimeHostManager: runtimeHostManager as never,
      hostEventBus: eventBus as never,
      getMainWindow: () => mainWindow as never,
    });

    await vi.runOnlyPendingTimersAsync();

    expect(eventBus.emit).toHaveBeenCalledWith(
      'runtime-host:status',
      expect.objectContaining({
        status: 'running',
        pid: 1111,
      }),
    );

    runtimeState = {
      ...runtimeState,
      pid: 2222,
    };
    await vi.advanceTimersByTimeAsync(1600);

    expect(eventBus.emit).toHaveBeenCalledWith(
      'runtime-host:restart',
      expect.objectContaining({
        previousPid: 1111,
        pid: 2222,
        status: 'running',
      }),
    );

    runtimeHealth = {
      ...runtimeHealth,
      ok: false,
      lifecycle: 'error',
      degradedPlugins: ['security-core'],
      error: 'runtime-host child health check failed',
    } as never;
    await vi.advanceTimersByTimeAsync(1600);

    expect(eventBus.emit).toHaveBeenCalledWith(
      'runtime-host:error',
      expect.objectContaining({
        status: 'degraded',
        message: 'runtime-host child health check failed',
      }),
    );

    expect(send).toHaveBeenCalledWith(
      'host:event',
      expect.objectContaining({
        eventName: 'runtime-host:status',
      }),
    );

    gatewayEventHandler?.('gateway:notification', {
      method: 'agent',
      params: { runId: 'run-1' },
    });
    gatewayEventHandler?.('session:update', {
      sessionUpdate: 'session_info_update',
      phase: 'started',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      laneKey: 'main',
    });

    expect(eventBus.emit).toHaveBeenCalledWith(
      'gateway:notification',
      expect.objectContaining({
        method: 'agent',
      }),
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      'session:update',
      expect.objectContaining({
        sessionUpdate: 'session_info_update',
        phase: 'started',
      }),
    );

    gatewayEventHandler?.('task:snapshot', {
      sessionKey: 'agent:main:main',
      tasks: [],
      todos: [{ content: '同步 todo', status: 'completed' }],
      source: 'todo',
    });

    expect(eventBus.emit).toHaveBeenCalledWith(
      'task:snapshot',
      expect.objectContaining({
        sessionKey: 'agent:main:main',
        source: 'todo',
      }),
    );
    expect(send).toHaveBeenCalledWith(
      'host:event',
      expect.objectContaining({
        eventName: 'task:snapshot',
      }),
    );

    gatewayEventHandler?.('gateway:channel-status', {
      eventName: 'channel:weixin-qr',
      payload: { qrDataUrl: 'data:image/png;base64,abc' },
      updatedAt: 1234,
    });

    expect(eventBus.emit).toHaveBeenCalledWith(
      'gateway:channel-status',
      expect.objectContaining({
        eventName: 'channel:weixin-qr',
      }),
    );
    expect(eventBus.emit).not.toHaveBeenCalledWith('channel:weixin-qr', expect.anything());
  });

  it('Gateway 状态变化只发布宿主可见状态，不触发业务同步', async () => {
    const gatewayManager = new FakeGatewayManager();
    const emitGatewayEvent = vi.fn();
    const runtimeHostManager = {
      getState: vi.fn(() => ({
        lifecycle: 'running',
        runtimeLifecycle: 'running',
        activePluginCount: 0,
      })),
      checkHealth: vi.fn(async () => ({
        ok: true,
        lifecycle: 'running',
        activePluginCount: 0,
        degradedPlugins: [],
      })),
      readGatewayStatus: vi.fn(async () => null),
      emitGatewayEvent,
      onGatewayEvent: vi.fn(() => () => {}),
      emitRuntimeJobEvent: vi.fn(),
      onRuntimeJobEvent: vi.fn(() => () => {}),
    };

    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');
    registerHostEventBridge({
      gatewayManager: gatewayManager as never,
      runtimeHostManager: runtimeHostManager as never,
      hostEventBus: { emit: vi.fn() } as never,
      getMainWindow: () => null,
    });

    gatewayManager['status'] = { processState: 'running', port: 18789 };
    gatewayManager.emit('status', gatewayManager.getStatus());

    expect(emitGatewayEvent).not.toHaveBeenCalled();
  });

  it('runtime-host 重启期间不会把临时 transport health 失败发成错误事件', async () => {
    const gatewayManager = new FakeGatewayManager();
    let runtimeState = {
      lifecycle: 'restarting' as const,
      runtimeLifecycle: 'restarting' as const,
      pid: 1111,
      activePluginCount: 2,
    };
    let runtimeHealth = {
      ok: false,
      lifecycle: 'error' as const,
      activePluginCount: 0,
      degradedPlugins: [] as string[],
      error: 'Runtime-host transport health failed: fetch failed',
    };
    const runtimeHostManager = {
      getState: vi.fn(() => runtimeState),
      checkHealth: vi.fn(async () => runtimeHealth),
      readGatewayStatus: vi.fn(async () => null),
      emitGatewayEvent: vi.fn(),
      onGatewayEvent: vi.fn(() => () => {}),
      emitRuntimeJobEvent: vi.fn(),
      onRuntimeJobEvent: vi.fn(() => () => {}),
    };
    const eventBus = { emit: vi.fn() };
    const mainWindow = { webContents: { send: vi.fn() } };

    const { registerHostEventBridge } = await import('../../electron/main/host-event-bridge');
    registerHostEventBridge({
      gatewayManager: gatewayManager as never,
      runtimeHostManager: runtimeHostManager as never,
      hostEventBus: eventBus as never,
      getMainWindow: () => mainWindow as never,
    });

    await vi.runOnlyPendingTimersAsync();

    expect(eventBus.emit).toHaveBeenCalledWith(
      'runtime-host:status',
      expect.objectContaining({
        status: 'restarting',
      }),
    );
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      'runtime-host:error',
      expect.anything(),
    );

    runtimeState = {
      ...runtimeState,
      lifecycle: 'running',
      runtimeLifecycle: 'running',
      pid: 2222,
    };
    runtimeHealth = {
      ok: true,
      lifecycle: 'running',
      activePluginCount: 2,
      degradedPlugins: [],
    };
    await vi.advanceTimersByTimeAsync(1600);

    expect(eventBus.emit).toHaveBeenCalledWith(
      'runtime-host:restart',
      expect.objectContaining({
        previousPid: 1111,
        pid: 2222,
        status: 'running',
      }),
    );
  });
});
