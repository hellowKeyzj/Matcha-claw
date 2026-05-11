import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelRoutes } from '../../runtime-host/api/routes/channel-routes';
import { ChannelService } from '../../runtime-host/application/channels/service';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

const clock = {
  nowMs: () => 1234,
  nowIso: () => '1970-01-01T00:00:01.234Z',
  toIsoString: (ms: number) => new Date(ms).toISOString(),
};

function createDeps() {
  const deps = {
    openclawBridge: {
      channelsStatus: vi.fn(async () => ({ status: 'ok' })),
      channelsConnect: vi.fn(async () => ({ success: true })),
      channelsDisconnect: vi.fn(async () => ({ success: true })),
      channelsRequestQr: vi.fn(async () => ({ qrCode: 'qr-code', sessionId: 'session-1' })),
    },
    listConfiguredChannels: vi.fn(async () => []),
    validateChannelConfig: vi.fn(async () => ({ valid: true, errors: [], warnings: [] })),
    validateChannelCredentials: vi.fn(async () => ({ valid: true, errors: [], warnings: [] })),
    requestParentShellAction: vi.fn(async () => ({ success: true, status: 200, data: { success: true } })),
    mapParentTransportResponse: vi.fn((upstream: unknown) => ({ status: 200, data: upstream })),
    submitActivateDirectChannel: vi.fn(() => ({
      success: true,
      job: {
        id: 'job-activate',
        type: 'channels.activateDirect',
        status: 'queued',
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
      },
    })),
    submitRefreshSnapshot: vi.fn(() => ({
      success: true,
      job: {
        id: 'job-refresh',
        type: 'channels.refreshSnapshot',
        status: 'queued',
        queuedAt: 0,
        attempts: 0,
        maxAttempts: 1,
      },
    })),
    submitSetChannelEnabled: vi.fn(() => ({
      success: true,
      job: {
        id: 'job-enabled',
        type: 'channels.setEnabled',
        status: 'queued',
        queuedAt: 2,
        attempts: 0,
        maxAttempts: 1,
      },
    })),
    submitDeleteChannelConfig: vi.fn(() => ({
      success: true,
      job: {
        id: 'job-delete',
        type: 'channels.deleteConfig',
        status: 'queued',
        queuedAt: 3,
        attempts: 0,
        maxAttempts: 1,
      },
    })),
    saveChannelConfig: vi.fn(async () => {}),
    setChannelEnabled: vi.fn(async () => {}),
    getChannelFormValues: vi.fn(async () => ({})),
    deleteChannelConfig: vi.fn(async () => {}),
    startLoginSession: vi.fn(async (input: { channelType: string; accountId?: string }) => ({
      queued: true as const,
      sessionKey: input.accountId || input.channelType,
    })),
    cancelLoginSession: vi.fn(async () => {}),
  };
  return {
    ...deps,
    routeDeps: {
      channelService: new ChannelService({
        gateway: deps.openclawBridge,
        channelConfig: {
          listConfiguredChannels: deps.listConfiguredChannels,
          validateChannelConfig: deps.validateChannelConfig,
          validateChannelCredentials: deps.validateChannelCredentials,
          saveChannelConfig: deps.saveChannelConfig,
          setChannelEnabled: deps.setChannelEnabled,
          getChannelFormValues: deps.getChannelFormValues,
          deleteChannelConfig: deps.deleteChannelConfig,
        },
        parentShell: {
          request: deps.requestParentShellAction,
          mapResponse: deps.mapParentTransportResponse,
        },
        loginSessions: {
          start: deps.startLoginSession,
          cancel: deps.cancelLoginSession,
        },
        jobs: {
          submitRefreshSnapshot: deps.submitRefreshSnapshot,
          submitActivateDirectChannel: deps.submitActivateDirectChannel,
          submitSetChannelEnabled: deps.submitSetChannelEnabled,
          submitDeleteChannelConfig: deps.submitDeleteChannelConfig,
        },
        clock,
      }),
    },
  };
}

describe('runtime-host process channel routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('snapshot 只返回本地快照并提交后台刷新任务', async () => {
    const deps = createDeps();

    const snapshotResult = await dispatchRuntimeRouteDefinition(channelRoutes, 
      'GET',
      '/api/channels/snapshot',
      new URL('http://127.0.0.1/api/channels/snapshot'),
      undefined,
      deps.routeDeps,
    );

    expect(deps.submitRefreshSnapshot).not.toHaveBeenCalled();
    expect(deps.openclawBridge.channelsStatus).toHaveBeenCalledTimes(1);
    expect(snapshotResult).toEqual({
      status: 200,
      data: {
        success: true,
        snapshot: null,
        ready: false,
        refreshing: true,
        updatedAt: null,
        error: null,
      },
    });
  });

  it('connect/disconnect/request-qr 统一走 openclawBridge 并刷新快照', async () => {
    const deps = createDeps();

    const connectResult = await dispatchRuntimeRouteDefinition(channelRoutes, 
      'POST',
      '/api/channels/connect',
      new URL('http://127.0.0.1/api/channels/connect'),
      { channelId: 'wecom-main' },
      deps.routeDeps,
    );
    const disconnectResult = await dispatchRuntimeRouteDefinition(channelRoutes, 
      'POST',
      '/api/channels/disconnect',
      new URL('http://127.0.0.1/api/channels/disconnect'),
      { channelId: 'wecom-main' },
      deps.routeDeps,
    );
    const qrResult = await dispatchRuntimeRouteDefinition(channelRoutes, 
      'POST',
      '/api/channels/request-qr',
      new URL('http://127.0.0.1/api/channels/request-qr'),
      { channelType: 'whatsapp' },
      deps.routeDeps,
    );

    expect(deps.openclawBridge.channelsStatus).toHaveBeenCalledTimes(3);
    expect(deps.openclawBridge.channelsConnect).toHaveBeenCalledWith('wecom-main');
    expect(deps.openclawBridge.channelsDisconnect).toHaveBeenCalledWith('wecom-main');
    expect(deps.openclawBridge.channelsRequestQr).toHaveBeenCalledWith('whatsapp');
    expect(connectResult).toEqual({ status: 200, data: { success: true } });
    expect(disconnectResult).toEqual({ status: 200, data: { success: true } });
    expect(qrResult).toEqual({ status: 200, data: { success: true, qrCode: 'qr-code', sessionId: 'session-1' } });
  });

  it('直接提交型渠道激活只提交后台任务', async () => {
    const deps = createDeps();

    const result = await dispatchRuntimeRouteDefinition(channelRoutes, 
      'POST',
      '/api/channels/activate',
      new URL('http://127.0.0.1/api/channels/activate'),
      { channelType: 'wecom', config: { botId: 'bot-1', secret: 'secret-1' } },
      deps.routeDeps,
    );

    expect(deps.submitActivateDirectChannel).toHaveBeenCalledWith({
      channelType: 'wecom',
      config: { botId: 'bot-1', secret: 'secret-1' },
    });
    expect(deps.saveChannelConfig).not.toHaveBeenCalled();
    expect(deps.requestParentShellAction).not.toHaveBeenCalledWith('gateway_restart');
    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: {
          id: 'job-activate',
          type: 'channels.activateDirect',
          status: 'queued',
          queuedAt: 1,
          attempts: 0,
          maxAttempts: 1,
        },
      },
    });
  });

  it('直接提交型渠道任务执行时才保存配置并触发 gateway_restart', async () => {
    const deps = createDeps();

    const result = await deps.routeDeps.channelService.activateDirect({
      channelType: 'wecom',
      config: { botId: 'bot-1', secret: 'secret-1' },
    });

    expect(deps.saveChannelConfig).toHaveBeenCalledOnce();
    expect(deps.requestParentShellAction).toHaveBeenCalledWith('gateway_restart');
    expect(result).toEqual({ status: 200, data: { success: true } });
  });

  it('登录会话型渠道激活时不会立即写配置或重启 gateway', async () => {
    const deps = createDeps();

    const result = await dispatchRuntimeRouteDefinition(channelRoutes, 
      'POST',
      '/api/channels/activate',
      new URL('http://127.0.0.1/api/channels/activate'),
      { channelType: 'openclaw-weixin', accountId: 'wx-main', config: { routeTag: 'prod' } },
      deps.routeDeps,
    );

    expect(deps.saveChannelConfig).not.toHaveBeenCalled();
    expect(deps.startLoginSession).toHaveBeenCalledWith({
      channelType: 'openclaw-weixin',
      accountId: 'wx-main',
      config: { routeTag: 'prod' },
    });
    expect(deps.requestParentShellAction).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 200, data: { success: true, queued: true, sessionKey: 'wx-main' } });
  });

  it('登录会话型渠道取消时走统一 session cancel', async () => {
    const deps = createDeps();

    const result = await dispatchRuntimeRouteDefinition(channelRoutes, 
      'POST',
      '/api/channels/session/cancel',
      new URL('http://127.0.0.1/api/channels/session/cancel'),
      { channelType: 'whatsapp' },
      deps.routeDeps,
    );

    expect(deps.cancelLoginSession).toHaveBeenCalledWith('whatsapp');
    expect(deps.requestParentShellAction).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 200, data: { success: true } });
  });

  it('启用状态变更只提交后台任务', async () => {
    const deps = createDeps();

    const result = await dispatchRuntimeRouteDefinition(channelRoutes, 
      'PUT',
      '/api/channels/config/enabled',
      new URL('http://127.0.0.1/api/channels/config/enabled'),
      { channelType: 'wecom', enabled: false },
      deps.routeDeps,
    );

    expect(deps.submitSetChannelEnabled).toHaveBeenCalledWith({ channelType: 'wecom', enabled: false });
    expect(deps.setChannelEnabled).not.toHaveBeenCalled();
    expect(deps.requestParentShellAction).not.toHaveBeenCalledWith('gateway_restart');
    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: {
          id: 'job-enabled',
          type: 'channels.setEnabled',
          status: 'queued',
          queuedAt: 2,
          attempts: 0,
          maxAttempts: 1,
        },
      },
    });
  });

  it('删除渠道配置只提交后台任务', async () => {
    const deps = createDeps();

    const result = await dispatchRuntimeRouteDefinition(channelRoutes, 
      'DELETE',
      '/api/channels/config/wecom',
      new URL('http://127.0.0.1/api/channels/config/wecom'),
      undefined,
      deps.routeDeps,
    );

    expect(deps.submitDeleteChannelConfig).toHaveBeenCalledWith({ channelType: 'wecom' });
    expect(deps.deleteChannelConfig).not.toHaveBeenCalled();
    expect(deps.requestParentShellAction).not.toHaveBeenCalledWith('gateway_restart');
    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: {
          id: 'job-delete',
          type: 'channels.deleteConfig',
          status: 'queued',
          queuedAt: 3,
          attempts: 0,
          maxAttempts: 1,
        },
      },
    });
  });
});
