import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../electron/services/providers/oauth/browser-oauth-manager', () => ({
  browserOAuthManager: new EventEmitter(),
}));

vi.mock('../../electron/services/providers/oauth/device-oauth-manager', () => ({
  deviceOAuthManager: new EventEmitter(),
}));

vi.mock('../../electron/services/channels/whatsapp-login-manager', () => ({
  whatsAppLoginManager: new EventEmitter(),
}));

vi.mock('../../electron/services/channels/weixin-login-manager', () => ({
  weixinLoginManager: new EventEmitter(),
}));

class FakeGatewayManager extends EventEmitter {
  private status: { state: 'stopped' | 'starting' | 'running' | 'error' | 'reconnecting'; port: number };

  constructor() {
    super();
    this.status = { state: 'stopped', port: 18789 };
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
    const syncSecurityPolicyToGatewayIfRunning = vi.fn(async () => true);
    let gatewayEventHandler: ((eventName: string, payload: unknown) => void) | null = null;

    let runtimeState = {
      lifecycle: 'running' as const,
      runtimeLifecycle: 'running' as const,
      pid: 1111,
      activePluginCount: 2,
      pluginExecutionEnabled: true,
      enabledPluginIds: ['security-core'],
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
      syncSecurityPolicyToGatewayIfRunning,
      onGatewayEvent: vi.fn((handler: (eventName: string, payload: unknown) => void) => {
        gatewayEventHandler = handler;
        return () => {
          gatewayEventHandler = null;
        };
      }),
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
    gatewayEventHandler?.('gateway:connection', {
      state: 'connected',
      updatedAt: 123,
    });
    gatewayEventHandler?.('gateway:conversation-event', {
      type: 'run.phase',
      phase: 'started',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
    });

    expect(eventBus.emit).toHaveBeenCalledWith(
      'gateway:notification',
      expect.objectContaining({
        method: 'agent',
      }),
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      'gateway:connection',
      expect.objectContaining({
        state: 'connected',
      }),
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      'gateway:conversation-event',
      expect.objectContaining({
        type: 'run.phase',
        phase: 'started',
      }),
    );
  });
});
