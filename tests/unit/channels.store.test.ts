import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostChannelsFetchSnapshotMock = vi.fn();
const hostChannelsConnectMock = vi.fn();
const hostChannelsDisconnectMock = vi.fn();
const hostChannelsRequestQrCodeMock = vi.fn();
const hostApiFetchMock = vi.fn();

vi.mock('../../src/lib/channel-runtime', () => ({
  hostChannelsFetchSnapshot: (...args: unknown[]) => hostChannelsFetchSnapshotMock(...args),
  hostChannelsConnect: (...args: unknown[]) => hostChannelsConnectMock(...args),
  hostChannelsDisconnect: (...args: unknown[]) => hostChannelsDisconnectMock(...args),
  hostChannelsRequestQrCode: (...args: unknown[]) => hostChannelsRequestQrCodeMock(...args),
}));

vi.mock('../../src/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

describe('channels store', () => {
  beforeEach(() => {
    vi.resetModules();
    hostChannelsFetchSnapshotMock.mockReset();
    hostChannelsConnectMock.mockReset();
    hostChannelsDisconnectMock.mockReset();
    hostChannelsRequestQrCodeMock.mockReset();
    hostApiFetchMock.mockReset();
  });

  it('fetchChannels 通过 channel runtime helper 读取 snapshot，而不是直连 gateway store', async () => {
    hostChannelsFetchSnapshotMock.mockResolvedValue({
      success: true,
      snapshot: {
        channelOrder: ['wecom'],
        channels: { wecom: { configured: true } },
        channelAccounts: { wecom: [{ accountId: 'main', connected: true, name: 'main' }] },
        channelDefaultAccountId: { wecom: 'main' },
      },
    });

    const { useChannelsStore } = await import('../../src/stores/channels');
    await useChannelsStore.getState().fetchChannels();

    expect(hostChannelsFetchSnapshotMock).toHaveBeenCalledTimes(1);
    expect(useChannelsStore.getState().channels).toEqual([
      {
        id: 'wecom-main',
        type: 'wecom',
        name: 'main',
        status: 'connected',
        accountId: 'main',
        error: undefined,
      },
    ]);
  });

  it('多账号场景下，存在健康账号时整体状态应保持 connected', async () => {
    hostChannelsFetchSnapshotMock.mockResolvedValue({
      success: true,
      snapshot: {
        channelOrder: ['telegram'],
        channels: { telegram: { configured: true } },
        channelAccounts: {
          telegram: [
            { accountId: 'default', running: true, connected: false, linked: false, name: 'default' },
            { accountId: 'backup', running: false, connected: false, linked: false, lastError: 'secondary failed', name: 'backup' },
          ],
        },
        channelDefaultAccountId: { telegram: 'default' },
      },
    });

    const { useChannelsStore } = await import('../../src/stores/channels');
    await useChannelsStore.getState().fetchChannels();

    expect(useChannelsStore.getState().channels).toEqual([
      expect.objectContaining({
        type: 'telegram',
        status: 'connected',
      }),
    ]);
  });

  it('账号 probe 成功时应识别为 connected', async () => {
    hostChannelsFetchSnapshotMock.mockResolvedValue({
      success: true,
      snapshot: {
        channelOrder: ['feishu'],
        channels: { feishu: { configured: true } },
        channelAccounts: {
          feishu: [{ accountId: 'default', running: false, connected: false, probe: { ok: true }, name: 'default' }],
        },
        channelDefaultAccountId: { feishu: 'default' },
      },
    });

    const { useChannelsStore } = await import('../../src/stores/channels');
    await useChannelsStore.getState().fetchChannels();

    expect(useChannelsStore.getState().channels).toEqual([
      expect.objectContaining({
        type: 'feishu',
        status: 'connected',
      }),
    ]);
  });

  it('connect/disconnect/requestQrCode 通过 channel runtime helper 执行', async () => {
    const { useChannelsStore } = await import('../../src/stores/channels');
    useChannelsStore.getState().setChannels([
      { id: 'wecom-main', type: 'wecom', name: 'main', status: 'disconnected' },
    ]);

    hostChannelsConnectMock.mockResolvedValue({ success: true });
    hostChannelsDisconnectMock.mockResolvedValue({ success: true });
    hostChannelsRequestQrCodeMock.mockResolvedValue({ success: true, qrCode: 'qr', sessionId: 's-1' });

    await useChannelsStore.getState().connectChannel('wecom-main');
    await useChannelsStore.getState().disconnectChannel('wecom-main');
    const qr = await useChannelsStore.getState().requestQrCode('whatsapp');

    expect(hostChannelsConnectMock).toHaveBeenCalledWith('wecom-main');
    expect(hostChannelsDisconnectMock).toHaveBeenCalledWith('wecom-main');
    expect(hostChannelsRequestQrCodeMock).toHaveBeenCalledWith('whatsapp');
    expect(qr).toEqual({ qrCode: 'qr', sessionId: 's-1' });
  });
});
