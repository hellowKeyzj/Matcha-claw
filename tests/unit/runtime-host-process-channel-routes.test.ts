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
});

