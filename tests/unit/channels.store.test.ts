import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostChannelsFetchSnapshotMock = vi.hoisted(() => vi.fn());
const hostChannelsProbeMock = vi.hoisted(() => vi.fn());
const hostChannelsDeleteConfigMock = vi.hoisted(() => vi.fn());
const hostChannelsConnectMock = vi.hoisted(() => vi.fn());
const hostChannelsDisconnectMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/channel-runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/channel-runtime')>(),
  hostChannelsFetchSnapshot: (...args: unknown[]) => hostChannelsFetchSnapshotMock(...args),
  hostChannelsProbe: (...args: unknown[]) => hostChannelsProbeMock(...args),
  hostChannelsDeleteConfig: (...args: unknown[]) => hostChannelsDeleteConfigMock(...args),
  hostChannelsConnect: (...args: unknown[]) => hostChannelsConnectMock(...args),
  hostChannelsDisconnect: (...args: unknown[]) => hostChannelsDisconnectMock(...args),
}));

function snapshot(
  channels: Record<string, unknown>,
  channelAccounts: Record<string, unknown[]>,
  channelDefaultAccountId: Record<string, string> = {},
) {
  return {
    success: true,
    ready: true,
    snapshot: {
      channelOrder: Object.keys(channels),
      channels,
      channelAccounts,
      channelDefaultAccountId,
    },
  };
}

describe('channels store', () => {
  beforeEach(() => {
    vi.resetModules();
    hostChannelsFetchSnapshotMock.mockReset();
    hostChannelsProbeMock.mockReset();
    hostChannelsDeleteConfigMock.mockReset();
    hostChannelsConnectMock.mockReset();
    hostChannelsDisconnectMock.mockReset();
    hostChannelsFetchSnapshotMock.mockResolvedValue(snapshot({}, {}));
    hostChannelsProbeMock.mockRejectedValue(new Error('Channel probe is unavailable'));
    hostChannelsDeleteConfigMock.mockResolvedValue({ outcome: 'confirmed' });
    hostChannelsConnectMock.mockResolvedValue({ success: true });
    hostChannelsDisconnectMock.mockResolvedValue({ success: true });
  });

  it('loads configured accounts from the Host snapshot', async () => {
    hostChannelsFetchSnapshotMock.mockResolvedValue(snapshot(
      {
        wecom: { configured: true },
        feishu: { configured: false },
      },
      {
        wecom: [{ accountId: 'main', configured: true, connected: false, name: 'WeCom Main' }],
        feishu: [{ accountId: 'default', configured: false, connected: true, name: 'Feishu' }],
      },
      { wecom: 'main', feishu: 'default' },
    ));

    const { useChannelsStore } = await import('../../src/stores/channels');
    await useChannelsStore.getState().fetchChannels();

    expect(hostChannelsFetchSnapshotMock).toHaveBeenCalledTimes(1);
    expect(useChannelsStore.getState()).toMatchObject({
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      error: null,
    });
    expect(useChannelsStore.getState().channels).toEqual([
      expect.objectContaining({
        id: 'wecom-main',
        type: 'wecom',
        name: 'WeCom Main',
        status: 'disconnected',
        accountId: 'main',
      }),
    ]);
  });

  it('does not treat a missing configured identity as configured just because running is boolean', async () => {
    hostChannelsFetchSnapshotMock.mockResolvedValue(snapshot(
      { wecom: { running: false } },
      { wecom: [{ accountId: 'main', running: false, connected: false, name: 'WeCom Main' }] },
      { wecom: 'main' },
    ));

    const { useChannelsStore } = await import('../../src/stores/channels');
    await useChannelsStore.getState().fetchChannels();

    expect(useChannelsStore.getState().channels).toEqual([]);
  });

  it('removes a channel only after Host confirms delete-config', async () => {
    hostChannelsDeleteConfigMock.mockResolvedValue({ outcome: 'confirmed' });

    const { useChannelsStore } = await import('../../src/stores/channels');
    useChannelsStore.getState().setChannels([
      { id: 'wecom-main', type: 'wecom', name: 'WeCom', status: 'connected', accountId: 'main' },
    ]);
    await useChannelsStore.getState().deleteChannel('wecom-main');

    expect(hostChannelsDeleteConfigMock).toHaveBeenCalledWith('wecom', 'main', { traceId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) });
    expect(useChannelsStore.getState().channels).toEqual([]);
  });

  it.each([
    ['target_rejected'],
    ['unknown'],
  ] as const)('retains the channel and surfaces an item error when delete-config is %s', async (outcome) => {
    hostChannelsDeleteConfigMock.mockResolvedValue({ outcome });

    const { useChannelsStore } = await import('../../src/stores/channels');
    useChannelsStore.getState().setChannels([
      { id: 'wecom-main', type: 'wecom', name: 'WeCom', status: 'connected', accountId: 'main' },
    ]);
    await useChannelsStore.getState().deleteChannel('wecom-main');

    expect(hostChannelsDeleteConfigMock).toHaveBeenCalledWith('wecom', 'main', { traceId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) });
    expect(useChannelsStore.getState().channels).toEqual([
      expect.objectContaining({
        id: 'wecom-main',
        status: 'connected',
        error: `Channel deletion outcome was ${outcome}`,
      }),
    ]);
  });
});
