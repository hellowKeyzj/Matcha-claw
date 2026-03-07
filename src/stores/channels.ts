/**
 * Channels State Store
 * Manages messaging channel state
 */
import { create } from 'zustand';
import type { Channel, ChannelType } from '../types/channel';

interface AddChannelParams {
  type: ChannelType;
  name: string;
  token?: string;
}

interface ChannelsState {
  channels: Channel[];
  loading: boolean;
  error: string | null;

  // Actions
  fetchChannels: () => Promise<void>;
  addChannel: (params: AddChannelParams) => Promise<Channel>;
  deleteChannel: (channelId: string) => Promise<void>;
  connectChannel: (channelId: string) => Promise<void>;
  disconnectChannel: (channelId: string) => Promise<void>;
  requestQrCode: (channelType: ChannelType) => Promise<{ qrCode: string; sessionId: string }>;
  setChannels: (channels: Channel[]) => void;
  updateChannel: (channelId: string, updates: Partial<Channel>) => void;
  clearError: () => void;
}

interface ChannelsStatusResponse {
  channelOrder?: string[];
  channels?: Record<string, unknown>;
  channelAccounts?: Record<string, Array<{
    accountId?: string;
    configured?: boolean;
    connected?: boolean;
    running?: boolean;
    lastError?: string;
    name?: string;
    linked?: boolean;
    lastConnectedAt?: number | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
  }>>;
  channelDefaultAccountId?: Record<string, string>;
}

interface GatewayRpcResult {
  success: boolean;
  result?: ChannelsStatusResponse;
  error?: string;
}

const QUICK_STATUS_TIMEOUT_MS = 2500;
const PROBE_STATUS_TIMEOUT_MS = 6000;

function parseChannelsStatus(data: ChannelsStatusResponse): Channel[] {
  const channels: Channel[] = [];
  const channelOrder = data.channelOrder || Object.keys(data.channels || {});

  for (const channelId of channelOrder) {
    const summary = (data.channels as Record<string, unknown> | undefined)?.[channelId] as Record<string, unknown> | undefined;
    const configured =
      typeof summary?.configured === 'boolean'
        ? summary.configured
        : typeof (summary as { running?: boolean })?.running === 'boolean'
          ? true
          : false;
    if (!configured) continue;

    const accounts = data.channelAccounts?.[channelId] || [];
    const defaultAccountId = data.channelDefaultAccountId?.[channelId];
    const primaryAccount =
      (defaultAccountId ? accounts.find((a) => a.accountId === defaultAccountId) : undefined) ||
      accounts.find((a) => a.connected === true || a.linked === true) ||
      accounts[0];

    let status: Channel['status'] = 'disconnected';
    const now = Date.now();
    const RECENT_MS = 10 * 60 * 1000;
    const hasRecentActivity = (a: { lastInboundAt?: number | null; lastOutboundAt?: number | null; lastConnectedAt?: number | null }) =>
      (typeof a.lastInboundAt === 'number' && now - a.lastInboundAt < RECENT_MS) ||
      (typeof a.lastOutboundAt === 'number' && now - a.lastOutboundAt < RECENT_MS) ||
      (typeof a.lastConnectedAt === 'number' && now - a.lastConnectedAt < RECENT_MS);
    const anyConnected = accounts.some((a) => a.connected === true || a.linked === true || hasRecentActivity(a));
    const anyRunning = accounts.some((a) => a.running === true);
    const summaryError =
      typeof (summary as { error?: string })?.error === 'string'
        ? (summary as { error?: string }).error
        : typeof (summary as { lastError?: string })?.lastError === 'string'
          ? (summary as { lastError?: string }).lastError
          : undefined;
    const anyError =
      accounts.some((a) => typeof a.lastError === 'string' && a.lastError) || Boolean(summaryError);

    if (anyConnected) {
      status = 'connected';
    } else if (anyRunning && !anyError) {
      status = 'connected';
    } else if (anyError) {
      status = 'error';
    } else if (anyRunning) {
      status = 'connecting';
    }

    channels.push({
      id: `${channelId}-${primaryAccount?.accountId || 'default'}`,
      type: channelId as ChannelType,
      name: primaryAccount?.name || channelId,
      status,
      accountId: primaryAccount?.accountId,
      error:
        (typeof primaryAccount?.lastError === 'string' ? primaryAccount.lastError : undefined) ||
        (typeof summaryError === 'string' ? summaryError : undefined),
    });
  }

  return channels;
}

export const useChannelsStore = create<ChannelsState>((set, get) => ({
  channels: [],
  loading: false,
  error: null,

  fetchChannels: async () => {
    set({ loading: true, error: null });
    try {
      const quickResult = await window.electron.ipcRenderer.invoke(
        'gateway:rpc',
        'channels.status',
        { probe: false },
        QUICK_STATUS_TIMEOUT_MS
      ) as GatewayRpcResult;

      if (quickResult.success && quickResult.result) {
        set({ channels: parseChannelsStatus(quickResult.result), loading: false });
      } else {
        set((state) => ({ channels: state.channels, loading: false }));
      }

      // 后台探测刷新，避免首屏被慢探测阻塞。
      void (async () => {
        try {
          const probeResult = await window.electron.ipcRenderer.invoke(
            'gateway:rpc',
            'channels.status',
            { probe: true },
            PROBE_STATUS_TIMEOUT_MS
          ) as GatewayRpcResult;

          if (probeResult.success && probeResult.result) {
            set({ channels: parseChannelsStatus(probeResult.result), error: null });
          }
        } catch {
          // ignore background probe failure
        }
      })();
    } catch {
      // Gateway 不可用时保留现有列表，避免全屏长时间加载感。
      set((state) => ({ channels: state.channels, loading: false }));
    }
  },

  addChannel: async (params) => {
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'gateway:rpc',
        'channels.add',
        params
      ) as { success: boolean; result?: Channel; error?: string };

      if (result.success && result.result) {
        set((state) => ({
          channels: [...state.channels, result.result!],
        }));
        return result.result;
      } else {
        // If gateway is not available, create a local channel for now
        const newChannel: Channel = {
          id: `local-${Date.now()}`,
          type: params.type,
          name: params.name,
          status: 'disconnected',
        };
        set((state) => ({
          channels: [...state.channels, newChannel],
        }));
        return newChannel;
      }
    } catch {
      // Create local channel if gateway unavailable
      const newChannel: Channel = {
        id: `local-${Date.now()}`,
        type: params.type,
        name: params.name,
        status: 'disconnected',
      };
      set((state) => ({
        channels: [...state.channels, newChannel],
      }));
      return newChannel;
    }
  },

  deleteChannel: async (channelId) => {
    // Extract channel type from the channelId (format: "channelType-accountId")
    const channelType = channelId.split('-')[0];

    try {
      // Delete the channel configuration from openclaw.json
      await window.electron.ipcRenderer.invoke('channel:deleteConfig', channelType);
    } catch (error) {
      console.error('Failed to delete channel config:', error);
    }

    try {
      await window.electron.ipcRenderer.invoke(
        'gateway:rpc',
        'channels.delete',
        { channelId: channelType }
      );
    } catch (error) {
      // Continue with local deletion even if gateway fails
      console.error('Failed to delete channel from gateway:', error);
    }

    // Remove from local state
    set((state) => ({
      channels: state.channels.filter((c) => c.id !== channelId),
    }));
  },

  connectChannel: async (channelId) => {
    const { updateChannel } = get();
    updateChannel(channelId, { status: 'connecting', error: undefined });

    try {
      const result = await window.electron.ipcRenderer.invoke(
        'gateway:rpc',
        'channels.connect',
        { channelId }
      ) as { success: boolean; error?: string };

      if (result.success) {
        updateChannel(channelId, { status: 'connected' });
      } else {
        updateChannel(channelId, { status: 'error', error: result.error });
      }
    } catch (error) {
      updateChannel(channelId, { status: 'error', error: String(error) });
    }
  },

  disconnectChannel: async (channelId) => {
    const { updateChannel } = get();

    try {
      await window.electron.ipcRenderer.invoke(
        'gateway:rpc',
        'channels.disconnect',
        { channelId }
      );
    } catch (error) {
      console.error('Failed to disconnect channel:', error);
    }

    updateChannel(channelId, { status: 'disconnected', error: undefined });
  },

  requestQrCode: async (channelType) => {
    const result = await window.electron.ipcRenderer.invoke(
      'gateway:rpc',
      'channels.requestQr',
      { type: channelType }
    ) as { success: boolean; result?: { qrCode: string; sessionId: string }; error?: string };

    if (result.success && result.result) {
      return result.result;
    }

    throw new Error(result.error || 'Failed to request QR code');
  },

  setChannels: (channels) => set({ channels }),

  updateChannel: (channelId, updates) => {
    set((state) => ({
      channels: state.channels.map((channel) =>
        channel.id === channelId ? { ...channel, ...updates } : channel
      ),
    }));
  },

  clearError: () => set({ error: null }),
}));
