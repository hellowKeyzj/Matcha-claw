import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostChannelsFetchSnapshotMock = vi.fn();
const hostChannelsDeleteConfigMock = vi.fn();
const hostChannelsConnectMock = vi.fn();
const hostChannelsDisconnectMock = vi.fn();
const hostChannelsRequestQrCodeMock = vi.fn();

vi.mock('../../src/lib/channel-runtime', () => ({
  hostChannelsFetchSnapshot: (...args: unknown[]) => hostChannelsFetchSnapshotMock(...args),
  hostChannelsDeleteConfig: (...args: unknown[]) => hostChannelsDeleteConfigMock(...args),
  hostChannelsConnect: (...args: unknown[]) => hostChannelsConnectMock(...args),
  hostChannelsDisconnect: (...args: unknown[]) => hostChannelsDisconnectMock(...args),
  hostChannelsRequestQrCode: (...args: unknown[]) => hostChannelsRequestQrCodeMock(...args),
}));

function buildSnapshot(channelId: string, accountId = 'main') {
  return {
    success: true,
    snapshot: {
      channelOrder: [channelId],
      channels: { [channelId]: { configured: true } },
      channelAccounts: { [channelId]: [{ accountId, connected: true, name: accountId }] },
      channelDefaultAccountId: { [channelId]: accountId },
    },
  };
}

describe('channels store', () => {
  beforeEach(() => {
    vi.resetModules();
    hostChannelsFetchSnapshotMock.mockReset();
    hostChannelsDeleteConfigMock.mockReset();
    hostChannelsConnectMock.mockReset();
    hostChannelsDisconnectMock.mockReset();
    hostChannelsRequestQrCodeMock.mockReset();
  });

  it('首次无快照时进入 initialLoading，成功后写入快照', async () => {
    let resolveFetch: ((value: ReturnType<typeof buildSnapshot>) => void) | null = null;
    hostChannelsFetchSnapshotMock.mockReturnValue(
      new Promise<ReturnType<typeof buildSnapshot>>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { useChannelsStore } = await import('../../src/stores/channels');
    const fetchPromise = useChannelsStore.getState().fetchChannels();

    expect(useChannelsStore.getState().snapshotReady).toBe(false);
    expect(useChannelsStore.getState().initialLoading).toBe(true);
    expect(useChannelsStore.getState().refreshing).toBe(false);

    resolveFetch?.(buildSnapshot('wecom'));
    await fetchPromise;

    const state = useChannelsStore.getState();
    expect(state.snapshotReady).toBe(true);
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.error).toBeNull();
    expect(state.channels).toEqual([
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

  it('已有快照时刷新失败保留旧数据，不回退空白', async () => {
    hostChannelsFetchSnapshotMock.mockResolvedValueOnce(buildSnapshot('wecom'));

    const { useChannelsStore } = await import('../../src/stores/channels');
    await useChannelsStore.getState().fetchChannels();

    hostChannelsFetchSnapshotMock.mockRejectedValueOnce(new Error('network down'));
    const refreshPromise = useChannelsStore.getState().fetchChannels();
    expect(useChannelsStore.getState().refreshing).toBe(true);
    expect(useChannelsStore.getState().initialLoading).toBe(false);

    await refreshPromise;

    const state = useChannelsStore.getState();
    expect(state.snapshotReady).toBe(true);
    expect(state.refreshing).toBe(false);
    expect(state.channels).toEqual([
      expect.objectContaining({
        id: 'wecom-main',
        type: 'wecom',
        status: 'connected',
      }),
    ]);
    expect(state.error).toBe('network down');
  });

  it('fetchChannels 并发请求会单飞去重', async () => {
    let resolveFetch: ((value: ReturnType<typeof buildSnapshot>) => void) | null = null;
    hostChannelsFetchSnapshotMock.mockReturnValue(
      new Promise<ReturnType<typeof buildSnapshot>>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { useChannelsStore } = await import('../../src/stores/channels');
    const first = useChannelsStore.getState().fetchChannels();
    const second = useChannelsStore.getState().fetchChannels();

    expect(hostChannelsFetchSnapshotMock).toHaveBeenCalledTimes(1);

    resolveFetch?.(buildSnapshot('wecom'));
    await Promise.all([first, second]);
  });

  it('deleteChannel 会维护 mutatingByChannelId 生命周期', async () => {
    let resolveDelete: (() => void) | null = null;
    hostChannelsDeleteConfigMock.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );

    const { useChannelsStore } = await import('../../src/stores/channels');
    useChannelsStore.getState().setChannels([
      { id: 'wecom-main', type: 'wecom', name: 'main', status: 'connected' },
    ]);

    const deletePromise = useChannelsStore.getState().deleteChannel('wecom-main');
    expect(useChannelsStore.getState().mutating).toBe(true);
    expect(useChannelsStore.getState().mutatingByChannelId['wecom-main']).toBe(1);

    resolveDelete?.();
    await deletePromise;

    const state = useChannelsStore.getState();
    expect(hostChannelsDeleteConfigMock).toHaveBeenCalledWith('wecom');
    expect(state.mutating).toBe(false);
    expect(state.mutatingByChannelId['wecom-main']).toBeUndefined();
    expect(state.channels).toEqual([]);
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

  it('connectChannel 会维护 mutatingByChannelId 生命周期', async () => {
    let resolveConnect: (() => void) | null = null;
    hostChannelsConnectMock.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveConnect = resolve;
      }),
    );

    const { useChannelsStore } = await import('../../src/stores/channels');
    useChannelsStore.getState().setChannels([
      { id: 'wecom-main', type: 'wecom', name: 'main', status: 'disconnected' },
    ]);

    const connectPromise = useChannelsStore.getState().connectChannel('wecom-main');
    expect(useChannelsStore.getState().mutating).toBe(true);
    expect(useChannelsStore.getState().mutatingByChannelId['wecom-main']).toBe(1);
    expect(useChannelsStore.getState().channels[0]?.status).toBe('connecting');

    resolveConnect?.();
    await connectPromise;

    const state = useChannelsStore.getState();
    expect(state.mutating).toBe(false);
    expect(state.mutatingByChannelId['wecom-main']).toBeUndefined();
    expect(state.channels[0]?.status).toBe('connected');
  });

  it('disconnectChannel 会维护 mutatingByChannelId 生命周期', async () => {
    let resolveDisconnect: (() => void) | null = null;
    hostChannelsDisconnectMock.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveDisconnect = resolve;
      }),
    );

    const { useChannelsStore } = await import('../../src/stores/channels');
    useChannelsStore.getState().setChannels([
      { id: 'wecom-main', type: 'wecom', name: 'main', status: 'connected' },
    ]);

    const disconnectPromise = useChannelsStore.getState().disconnectChannel('wecom-main');
    expect(useChannelsStore.getState().mutating).toBe(true);
    expect(useChannelsStore.getState().mutatingByChannelId['wecom-main']).toBe(1);

    resolveDisconnect?.();
    await disconnectPromise;

    const state = useChannelsStore.getState();
    expect(state.mutating).toBe(false);
    expect(state.mutatingByChannelId['wecom-main']).toBeUndefined();
    expect(state.channels[0]?.status).toBe('disconnected');
  });

  it('requestQrCode 通过 channel runtime helper 执行', async () => {
    const { useChannelsStore } = await import('../../src/stores/channels');

    hostChannelsRequestQrCodeMock.mockResolvedValue({ success: true, qrCode: 'qr', sessionId: 's-1' });

    const qr = await useChannelsStore.getState().requestQrCode('whatsapp');

    expect(hostChannelsRequestQrCodeMock).toHaveBeenCalledWith('whatsapp');
    expect(qr).toEqual({ qrCode: 'qr', sessionId: 's-1' });
  });
});
