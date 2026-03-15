/**
 * Channels State Store
 * Manages messaging channel state
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { useGatewayStore } from './gateway';
import type { Channel, ChannelType } from '../types/channel';

interface AddChannelParams {
  type: ChannelType;
  name: string;
  token?: string;
}

interface FetchChannelsOptions {
  silent?: boolean;
}

interface ChannelsState {
  channels: Channel[];
  loading: boolean;
  error: string | null;

  // Actions
  fetchChannels: (options?: FetchChannelsOptions) => Promise<void>;
  addChannel: (params: AddChannelParams) => Promise<Channel>;
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
        const data = await useGatewayStore.getState().rpc<{
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
        }>('channels.status', { probe: true });
        if (data) {
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
            const primaryAccount =
              (defaultAccountId ? accounts.find((a) => a.accountId === defaultAccountId) : undefined) ||
              accounts.find((a) => a.connected === true || a.linked === true) ||
              accounts[0];

            // Map gateway status to our status format
            let status: Channel['status'] = 'disconnected';
            const nowAtStatusEval = Date.now();
            const RECENT_MS = 10 * 60 * 1000;
            const hasRecentActivity = (a: { lastInboundAt?: number | null; lastOutboundAt?: number | null; lastConnectedAt?: number | null }) =>
              (typeof a.lastInboundAt === 'number' && nowAtStatusEval - a.lastInboundAt < RECENT_MS) ||
              (typeof a.lastOutboundAt === 'number' && nowAtStatusEval - a.lastOutboundAt < RECENT_MS) ||
              (typeof a.lastConnectedAt === 'number' && nowAtStatusEval - a.lastConnectedAt < RECENT_MS);
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

  addChannel: async (params) => {
    try {
      const result = await useGatewayStore.getState().rpc<Channel>('channels.add', params);

      if (result) {
        set((state) => ({
          channels: [...state.channels, result],
        }));
        return result;
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
      await hostApiFetch(`/api/channels/config/${encodeURIComponent(channelType)}`, {
        method: 'DELETE',
      });
    } catch (error) {
      console.error('Failed to delete channel config:', error);
    }

    try {
      await useGatewayStore.getState().rpc('channels.delete', { channelId: channelType });
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
      await useGatewayStore.getState().rpc('channels.connect', { channelId });
      updateChannel(channelId, { status: 'connected' });
    } catch (error) {
      updateChannel(channelId, { status: 'error', error: String(error) });
    }
  },

  disconnectChannel: async (channelId) => {
    const { updateChannel } = get();

    try {
      await useGatewayStore.getState().rpc('channels.disconnect', { channelId });
    } catch (error) {
      console.error('Failed to disconnect channel:', error);
    }

    updateChannel(channelId, { status: 'disconnected', error: undefined });
  },

  requestQrCode: async (channelType) => {
    return await useGatewayStore.getState().rpc<{ qrCode: string; sessionId: string }>(
      'channels.requestQr',
      { type: channelType },
    );
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
