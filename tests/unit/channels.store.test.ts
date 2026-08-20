import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostChannelsFetchCatalogMock = vi.fn();
const hostChannelsFetchStatusMock = vi.fn();
const hostChannelsConfigureMock = vi.fn();
const hostChannelsConnectMock = vi.fn();
const hostChannelsDisconnectMock = vi.fn();
const hostChannelsLogoutMock = vi.fn();
const hostChannelsDeleteConfigMock = vi.fn();

vi.mock('../../src/lib/channel-runtime', () => ({
  hostChannelsFetchCatalog: (...args: unknown[]) => hostChannelsFetchCatalogMock(...args),
  hostChannelsFetchStatus: (...args: unknown[]) => hostChannelsFetchStatusMock(...args),
  hostChannelsConfigure: (...args: unknown[]) => hostChannelsConfigureMock(...args),
  hostChannelsConnect: (...args: unknown[]) => hostChannelsConnectMock(...args),
  hostChannelsDisconnect: (...args: unknown[]) => hostChannelsDisconnectMock(...args),
  hostChannelsLogout: (...args: unknown[]) => hostChannelsLogoutMock(...args),
  hostChannelsDeleteConfig: (...args: unknown[]) => hostChannelsDeleteConfigMock(...args),
}));

function status(accounts: Array<{
  channel: string;
  accountId: string;
  connection: 'connected' | 'disconnected' | 'unknown';
}>) {
  return { accounts };
}

function catalog(entries: Array<{
  id: string;
  label: string;
  detailLabel?: string;
  systemImage?: string;
  configured: boolean;
}>) {
  return { entries };
}

describe('channels store', () => {
  beforeEach(() => {
    vi.resetModules();
    hostChannelsFetchCatalogMock.mockReset();
    hostChannelsFetchStatusMock.mockReset();
    hostChannelsConfigureMock.mockReset();
    hostChannelsConnectMock.mockReset();
    hostChannelsDisconnectMock.mockReset();
    hostChannelsLogoutMock.mockReset();
    hostChannelsDeleteConfigMock.mockReset();
  });

  it('loads the closed account status DTO without inferring status from native fields', async () => {
    hostChannelsFetchStatusMock.mockResolvedValue(status([
      { channel: 'wecom', accountId: 'main', connection: 'connected' },
      { channel: 'wecom', accountId: 'backup', connection: 'unknown' },
    ]));

    const { useChannelsStore } = await import('../../src/stores/channels');
    await useChannelsStore.getState().fetchChannels();

    expect(useChannelsStore.getState()).toMatchObject({
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      error: null,
    });
    expect(useChannelsStore.getState().channels).toEqual([
      { id: 'wecom-main', type: 'wecom', name: 'WeCom', status: 'connected', accountId: 'main' },
      { id: 'wecom-backup', type: 'wecom', name: 'WeCom', status: 'unknown', accountId: 'backup' },
    ]);
  });

  it('keeps catalog entries independent when no configured accounts exist', async () => {
    hostChannelsFetchCatalogMock.mockResolvedValue(catalog([
      { id: 'wecom', label: 'WeCom', detailLabel: 'Enterprise messaging', configured: false },
    ]));
    hostChannelsFetchStatusMock.mockResolvedValue(status([]));

    const { useChannelsStore } = await import('../../src/stores/channels');
    await Promise.all([
      useChannelsStore.getState().fetchCatalog(),
      useChannelsStore.getState().fetchChannels(),
    ]);

    expect(useChannelsStore.getState().catalogEntries).toEqual([
      { id: 'wecom', label: 'WeCom', detailLabel: 'Enterprise messaging', configured: false },
    ]);
    expect(useChannelsStore.getState().channels).toEqual([]);
  });

  it('does not apply a silent-refresh freshness window', async () => {
    hostChannelsFetchStatusMock.mockResolvedValue(status([]));

    const { useChannelsStore } = await import('../../src/stores/channels');
    await useChannelsStore.getState().fetchChannels({ silent: true });
    await useChannelsStore.getState().fetchChannels({ silent: true });

    expect(hostChannelsFetchStatusMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the last observed accounts when a refresh fails', async () => {
    hostChannelsFetchStatusMock
      .mockResolvedValueOnce(status([{ channel: 'wecom', accountId: 'main', connection: 'connected' }]))
      .mockRejectedValueOnce(new Error('network down'));

    const { useChannelsStore } = await import('../../src/stores/channels');
    await useChannelsStore.getState().fetchChannels();
    await useChannelsStore.getState().fetchChannels();

    expect(useChannelsStore.getState().channels).toEqual([
      expect.objectContaining({ id: 'wecom-main', status: 'connected' }),
    ]);
    expect(useChannelsStore.getState().error).toBe('network down');
  });

  it('refreshes catalog and status only after confirmed configuration', async () => {
    hostChannelsConfigureMock.mockResolvedValue({ outcome: 'confirmed' });
    hostChannelsFetchCatalogMock.mockResolvedValue(catalog([
      { id: 'wecom', label: 'WeCom', configured: true },
    ]));
    hostChannelsFetchStatusMock.mockResolvedValue(status([
      { channel: 'wecom', accountId: 'main', connection: 'disconnected' },
    ]));

    const { useChannelsStore } = await import('../../src/stores/channels');
    await expect(useChannelsStore.getState().configureChannel('wecom', 'main', { enabled: true })).resolves.toBe('confirmed');

    expect(hostChannelsConfigureMock).toHaveBeenCalledWith({ channel: 'wecom', accountId: 'main', patch: { enabled: true } });
    expect(hostChannelsFetchCatalogMock).toHaveBeenCalledTimes(1);
    expect(hostChannelsFetchStatusMock).toHaveBeenCalledTimes(1);
    expect(useChannelsStore.getState().channels).toEqual([
      expect.objectContaining({ id: 'wecom-main', status: 'disconnected' }),
    ]);
  });

  it('does not optimistically insert an account when configuration outcome is unknown', async () => {
    hostChannelsConfigureMock.mockResolvedValue({ outcome: 'unknown' });

    const { useChannelsStore } = await import('../../src/stores/channels');
    useChannelsStore.getState().setChannels([
      { id: 'wecom-existing', type: 'wecom', name: 'WeCom', status: 'connected', accountId: 'existing' },
    ]);
    await expect(useChannelsStore.getState().configureChannel('wecom', 'main', { enabled: true })).resolves.toBe('unknown');

    expect(hostChannelsFetchCatalogMock).not.toHaveBeenCalled();
    expect(hostChannelsFetchStatusMock).not.toHaveBeenCalled();
    expect(useChannelsStore.getState().channels).toEqual([
      expect.objectContaining({ id: 'wecom-existing', accountId: 'existing' }),
    ]);
    expect(useChannelsStore.getState().error).toBe('Channel configuration outcome is unknown');
  });

  it('keeps logout separate and refreshes only after confirmed logout', async () => {
    hostChannelsLogoutMock.mockResolvedValue({ outcome: 'confirmed' });
    hostChannelsFetchCatalogMock.mockResolvedValue(catalog([{ id: 'whatsapp', label: 'WhatsApp', configured: true }]));
    hostChannelsFetchStatusMock.mockResolvedValue(status([{ channel: 'whatsapp', accountId: 'main', connection: 'disconnected' }]));

    const { useChannelsStore } = await import('../../src/stores/channels');
    useChannelsStore.getState().setChannels([{ id: 'whatsapp-main', type: 'whatsapp', name: 'WhatsApp', status: 'connected', accountId: 'main' }]);
    await expect(useChannelsStore.getState().logoutChannel('whatsapp-main')).resolves.toBe('confirmed');

    expect(hostChannelsLogoutMock).toHaveBeenCalledWith('whatsapp', 'main');
    expect(useChannelsStore.getState().channels[0]?.status).toBe('disconnected');
  });

  it('deletes only after confirmation, then refreshes catalog and observed status', async () => {
    hostChannelsDeleteConfigMock.mockResolvedValue({ outcome: 'confirmed' });
    hostChannelsFetchCatalogMock.mockResolvedValue(catalog([{ id: 'wecom', label: 'WeCom', configured: false }]));
    hostChannelsFetchStatusMock.mockResolvedValue(status([]));

    const { useChannelsStore } = await import('../../src/stores/channels');
    useChannelsStore.getState().setChannels([
      { id: 'wecom-main', type: 'wecom', name: 'WeCom', status: 'connected', accountId: 'main' },
    ]);
    await expect(useChannelsStore.getState().deleteChannel('wecom-main')).resolves.toBe('confirmed');

    expect(hostChannelsDeleteConfigMock).toHaveBeenCalledWith('wecom', 'main');
    expect(hostChannelsFetchCatalogMock).toHaveBeenCalledTimes(1);
    expect(hostChannelsFetchStatusMock).toHaveBeenCalledTimes(1);
    expect(useChannelsStore.getState().channels).toEqual([]);
  });

  it('retains observed state and surfaces deletion rejection or unknown outcomes', async () => {
    const { useChannelsStore } = await import('../../src/stores/channels');
    useChannelsStore.getState().setChannels([
      { id: 'wecom-main', type: 'wecom', name: 'WeCom', status: 'connected', accountId: 'main' },
    ]);
    hostChannelsDeleteConfigMock.mockResolvedValue({ outcome: 'target_rejected' });

    await expect(useChannelsStore.getState().deleteChannel('wecom-main')).resolves.toBe('target_rejected');
    expect(useChannelsStore.getState().channels).toHaveLength(1);
    expect(useChannelsStore.getState().error).toBe('Channel deletion was rejected');
    expect(hostChannelsFetchCatalogMock).not.toHaveBeenCalled();
    expect(hostChannelsFetchStatusMock).not.toHaveBeenCalled();

    hostChannelsDeleteConfigMock.mockResolvedValue({ outcome: 'unknown' });
    await expect(useChannelsStore.getState().deleteChannel('wecom-main')).resolves.toBe('unknown');
    expect(useChannelsStore.getState().channels).toHaveLength(1);
    expect(useChannelsStore.getState().error).toBe('Channel deletion outcome is unknown');
  });

  it('refreshes only after confirmed mutations and retains observed state otherwise', async () => {
    hostChannelsConnectMock.mockResolvedValue({ outcome: 'confirmed' });
    hostChannelsDisconnectMock.mockResolvedValue({ outcome: 'unknown' });
    hostChannelsFetchStatusMock
      .mockResolvedValueOnce(status([{ channel: 'wecom', accountId: 'main', connection: 'connected' }]))
      .mockResolvedValueOnce(status([{ channel: 'wecom', accountId: 'main', connection: 'connected' }]));

    const { useChannelsStore } = await import('../../src/stores/channels');
    useChannelsStore.getState().setChannels([
      { id: 'wecom-main', type: 'wecom', name: 'WeCom', status: 'disconnected', accountId: 'main' },
    ]);

    await useChannelsStore.getState().connectChannel('wecom-main');
    expect(hostChannelsConnectMock).toHaveBeenCalledWith('wecom', 'main');
    expect(useChannelsStore.getState().channels[0]?.status).toBe('connected');

    await useChannelsStore.getState().disconnectChannel('wecom-main');
    expect(hostChannelsDisconnectMock).toHaveBeenCalledWith('wecom', 'main');
    expect(useChannelsStore.getState().channels[0]).toMatchObject({
      status: 'connected',
    });
  });
});
