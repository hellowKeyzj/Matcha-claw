import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleChannelRoute } from '../../runtime-host/api/routes/channel-routes';

function createDeps() {
  return {
    openclawBridge: {
      channelsStatus: vi.fn(async () => ({ status: 'ok' })),
      channelsConnect: vi.fn(async () => ({ success: true })),
      channelsDisconnect: vi.fn(async () => ({ success: true })),
      channelsRequestQr: vi.fn(async () => ({ qrCode: 'qr-code', sessionId: 'session-1' })),
    },
    listConfiguredChannelsLocal: vi.fn(async () => []),
    validateChannelConfigLocal: vi.fn(async () => ({ valid: true, errors: [], warnings: [] })),
    validateChannelCredentialsLocal: vi.fn(async () => ({ valid: true, errors: [], warnings: [] })),
    requestParentShellAction: vi.fn(async () => ({ success: true, status: 200, data: { success: true } })),
    mapParentTransportResponse: vi.fn((upstream: unknown) => ({ status: 200, data: upstream })),
    saveChannelConfigLocal: vi.fn(async () => {}),
    setChannelEnabledLocal: vi.fn(async () => {}),
    getChannelFormValuesLocal: vi.fn(async () => ({})),
    deleteChannelConfigLocal: vi.fn(async () => {}),
  };
}

describe('runtime-host process channel routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('snapshot/connect/disconnect/request-qr 统一走 openclawBridge', async () => {
    const deps = createDeps();

    const snapshotResult = await handleChannelRoute(
      'GET',
      '/api/channels/snapshot',
      new URL('http://127.0.0.1/api/channels/snapshot'),
      undefined,
      deps,
    );
    const connectResult = await handleChannelRoute(
      'POST',
      '/api/channels/connect',
      new URL('http://127.0.0.1/api/channels/connect'),
      { channelId: 'wecom-main' },
      deps,
    );
    const disconnectResult = await handleChannelRoute(
      'POST',
      '/api/channels/disconnect',
      new URL('http://127.0.0.1/api/channels/disconnect'),
      { channelId: 'wecom-main' },
      deps,
    );
    const qrResult = await handleChannelRoute(
      'POST',
      '/api/channels/request-qr',
      new URL('http://127.0.0.1/api/channels/request-qr'),
      { channelType: 'whatsapp' },
      deps,
    );

    expect(deps.openclawBridge.channelsStatus).toHaveBeenCalledWith(true);
    expect(deps.openclawBridge.channelsConnect).toHaveBeenCalledWith('wecom-main');
    expect(deps.openclawBridge.channelsDisconnect).toHaveBeenCalledWith('wecom-main');
    expect(deps.openclawBridge.channelsRequestQr).toHaveBeenCalledWith('whatsapp');
    expect(snapshotResult).toEqual({ status: 200, data: { success: true, snapshot: { status: 'ok' } } });
    expect(connectResult).toEqual({ status: 200, data: { success: true } });
    expect(disconnectResult).toEqual({ status: 200, data: { success: true } });
    expect(qrResult).toEqual({ status: 200, data: { success: true, qrCode: 'qr-code', sessionId: 'session-1' } });
  });

  it('直接提交型渠道激活后会保存配置并触发 gateway_restart', async () => {
    const deps = createDeps();

    const result = await handleChannelRoute(
      'POST',
      '/api/channels/activate',
      new URL('http://127.0.0.1/api/channels/activate'),
      { channelType: 'wecom', config: { botId: 'bot-1', secret: 'secret-1' } },
      deps,
    );

    expect(deps.saveChannelConfigLocal).toHaveBeenCalledWith({
      channelType: 'wecom',
      config: { botId: 'bot-1', secret: 'secret-1' },
    });
    expect(deps.requestParentShellAction).toHaveBeenCalledWith('gateway_restart');
    expect(result).toEqual({ status: 200, data: { success: true } });
  });

  it('直接提交型渠道激活后若 gateway_restart 失败则接口直接失败', async () => {
    const deps = createDeps();
    deps.requestParentShellAction.mockResolvedValueOnce({
      success: false,
      status: 503,
      error: { code: 'gateway_restart_failed', message: 'gateway restart failed' },
    });

    const result = await handleChannelRoute(
      'POST',
      '/api/channels/activate',
      new URL('http://127.0.0.1/api/channels/activate'),
      { channelType: 'wecom', config: { botId: 'bot-1', secret: 'secret-1' } },
      deps,
    );

    expect(deps.saveChannelConfigLocal).toHaveBeenCalledOnce();
    expect(deps.requestParentShellAction).toHaveBeenCalledWith('gateway_restart');
    expect(result).toEqual({
      status: 503,
      data: { success: false, error: 'gateway restart failed' },
    });
  });

  it('登录会话型渠道激活时不会立即写配置或重启 gateway', async () => {
    const deps = createDeps();

    const result = await handleChannelRoute(
      'POST',
      '/api/channels/activate',
      new URL('http://127.0.0.1/api/channels/activate'),
      { channelType: 'openclaw-weixin', accountId: 'wx-main', config: { routeTag: 'prod' } },
      deps,
    );

    expect(deps.saveChannelConfigLocal).not.toHaveBeenCalled();
    expect(deps.requestParentShellAction).toHaveBeenCalledWith('channel_session_start', {
      channelType: 'openclaw-weixin',
      accountId: 'wx-main',
      config: { routeTag: 'prod' },
    });
    expect(result).toEqual({ status: 200, data: { success: true, status: 200, data: { success: true } } });
  });

  it('登录会话型渠道取消时走统一 session cancel', async () => {
    const deps = createDeps();

    const result = await handleChannelRoute(
      'POST',
      '/api/channels/session/cancel',
      new URL('http://127.0.0.1/api/channels/session/cancel'),
      { channelType: 'whatsapp' },
      deps,
    );

    expect(deps.requestParentShellAction).toHaveBeenCalledWith('channel_session_cancel', {
      channelType: 'whatsapp',
    });
    expect(result).toEqual({ status: 200, data: { success: true, status: 200, data: { success: true } } });
  });

  it('启用状态变更后会触发 gateway_restart', async () => {
    const deps = createDeps();

    const result = await handleChannelRoute(
      'PUT',
      '/api/channels/config/enabled',
      new URL('http://127.0.0.1/api/channels/config/enabled'),
      { channelType: 'wecom', enabled: false },
      deps,
    );

    expect(deps.setChannelEnabledLocal).toHaveBeenCalledWith('wecom', false);
    expect(deps.requestParentShellAction).toHaveBeenCalledWith('gateway_restart');
    expect(result).toEqual({ status: 200, data: { success: true } });
  });

  it('删除渠道配置后会触发 gateway_restart', async () => {
    const deps = createDeps();

    const result = await handleChannelRoute(
      'DELETE',
      '/api/channels/config/wecom',
      new URL('http://127.0.0.1/api/channels/config/wecom'),
      undefined,
      deps,
    );

    expect(deps.deleteChannelConfigLocal).toHaveBeenCalledWith('wecom');
    expect(deps.requestParentShellAction).toHaveBeenCalledWith('gateway_restart');
    expect(result).toEqual({ status: 200, data: { success: true } });
  });
});
