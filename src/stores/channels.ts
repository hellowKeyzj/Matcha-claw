/**
 * Channels State Store
 * Manages messaging channel state
 */
import { create } from 'zustand';
import {
  hostChannelsConnect,
  hostChannelsDeleteConfig,
  hostChannelsDisconnect,
  hostChannelsFetchSnapshot,
  hostChannelsRequestQrCode,
} from '@/lib/channel-runtime';
import {
  isChannelRuntimeConnected,
  pickChannelRuntimeStatus,
  type ChannelRuntimeAccountSnapshot,
  type ChannelRuntimeSummarySnapshot,
} from '@/lib/channel-status';
import { CHANNEL_NAMES, type Channel, type ChannelType } from '../types/channel';

interface FetchChannelsOptions {
  silent?: boolean;
}

interface ChannelsState {
  channels: Channel[];
  loading: boolean;
  error: string | null;

  // Actions
  fetchChannels: (options?: FetchChannelsOptions) => Promise<void>;
  deleteChannel: (channelId: string) => Promise<void>;
  connectChannel: (channelId: string) => Promise<void>;
  disconnectChannel: (channelId: string) => Promise<void>;
  requestQrCode: (channelType: ChannelType) => Promise<{ qrCode: string; sessionId: string }>;
  setChannels: (channels: Channel[]) => void;
  updateChannel: (channelId: string, updates: Partial<Channel>) => void;
  clearError: () => void;
}

const CHANNELS_SILENT_REFRESH_MIN_GAP_MS = 1200;
let channelsSilentInflightFetch: Promise<void> | null = null;
let channelsLastFetchAtMs = 0;

function areChannelsEquivalent(left: Channel[], right: Channel[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.id !== b.id
      || a.type !== b.type
      || a.name !== b.name
      || a.status !== b.status
      || (a.accountId ?? null) !== (b.accountId ?? null)
      || (a.error ?? null) !== (b.error ?? null)
    ) {
      return false;
    }
  }
  return true;
}

export const useChannelsStore = create<ChannelsState>((set, get) => ({
  channels: [],
  loading: false,
  error: null,

  fetchChannels: async (options) => {
    const silent = options?.silent === true;
    const now = Date.now();
    if (silent && get().channels.length > 0 && now - channelsLastFetchAtMs < CHANNELS_SILENT_REFRESH_MIN_GAP_MS) {
      return;
    }
    if (silent && channelsSilentInflightFetch) {
      await channelsSilentInflightFetch;
      return;
    }

    if (!silent) {
      set({ loading: true, error: null });
    }
    const runFetch = async () => {
      try {
        const result = await hostChannelsFetchSnapshot();
        const data = result.snapshot as {
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
              lastProbeAt?: number | null;
              probe?: {
                ok?: boolean;
              } | null;
            }>>;
            channelDefaultAccountId?: Record<string, string>;
        } | undefined;
        if (result.success && data) {
          const channels: Channel[] = [];

          // Parse the complex channels.status response into simple Channel objects
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
            const summarySignal = summary as ChannelRuntimeSummarySnapshot | undefined;
            const primaryAccount =
              (defaultAccountId ? accounts.find((a) => a.accountId === defaultAccountId) : undefined) ||
              accounts.find((a) => isChannelRuntimeConnected(a as ChannelRuntimeAccountSnapshot)) ||
              accounts[0];

            const status: Channel['status'] = pickChannelRuntimeStatus(accounts, summarySignal);
            const summaryError =
              typeof summarySignal?.error === 'string'
                ? summarySignal.error
                : typeof summarySignal?.lastError === 'string'
                  ? summarySignal.lastError
                  : undefined;

            channels.push({
              id: `${channelId}-${primaryAccount?.accountId || 'default'}`,
              type: channelId as ChannelType,
              name: primaryAccount?.name || CHANNEL_NAMES[channelId as ChannelType] || channelId,
              status,
              accountId: primaryAccount?.accountId,
              error:
                (typeof primaryAccount?.lastError === 'string' ? primaryAccount.lastError : undefined) ||
                (typeof summaryError === 'string' ? summaryError : undefined),
            });
          }

          channelsLastFetchAtMs = Date.now();
          if (silent) {
            set((state) => (
              areChannelsEquivalent(state.channels, channels)
                ? state
                : { ...state, channels }
            ));
          } else {
            set((state) => {
              const unchanged = areChannelsEquivalent(state.channels, channels);
              return unchanged
                ? { ...state, loading: false, error: null }
                : { ...state, channels, loading: false, error: null };
            });
          }
        } else {
          // Gateway not available - try to show channels from local config
          if (!silent) {
            set({ channels: [], loading: false });
          }
        }
      } catch {
        // Gateway not connected, show empty
        if (!silent) {
          set({ channels: [], loading: false });
        }
      }
    };

    if (silent) {
      channelsSilentInflightFetch = runFetch().finally(() => {
        channelsSilentInflightFetch = null;
      });
      await channelsSilentInflightFetch;
      return;
    }

    await runFetch();
  },

  deleteChannel: async (channelId) => {
    const channelTypeFromState = get().channels.find((channel) => channel.id === channelId)?.type;
    const placeholderMatch = channelId.match(/^(.*)-default$/);
    const channelType = channelTypeFromState ?? (placeholderMatch?.[1] as ChannelType | undefined);
    if (!channelType) {
      set((state) => ({
        channels: state.channels.filter((c) => c.id !== channelId),
      }));
      return;
    }

    try {
      await hostChannelsDeleteConfig(channelType);
    } catch (error) {
      console.error('Failed to delete channel config:', error);
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
      await hostChannelsConnect(channelId);
      updateChannel(channelId, { status: 'connected' });
    } catch (error) {
      updateChannel(channelId, { status: 'error', error: String(error) });
    }
  },

  disconnectChannel: async (channelId) => {
    const { updateChannel } = get();

    try {
      await hostChannelsDisconnect(channelId);
    } catch (error) {
      console.error('Failed to disconnect channel:', error);
    }

    updateChannel(channelId, { status: 'disconnected', error: undefined });
  },

  requestQrCode: async (channelType) => {
    const result = await hostChannelsRequestQrCode(channelType);
    return {
      qrCode: result.qrCode || '',
      sessionId: result.sessionId || '',
    };
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
