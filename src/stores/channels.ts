/**
 * Channels State Store
 * Manages messaging channel state
 */
import { create } from 'zustand';
import {
  channelErrorCode,
  logChannelTrace,
  hostChannelsConnect,
  hostChannelsDeleteConfig,
  hostChannelsDisconnect,
  hostChannelsFetchSnapshot,
  hostChannelsProbe,
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
  snapshotReady: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  mutating: boolean;
  mutatingByChannelId: Record<string, number>;
  error: string | null;

  // Actions
  fetchChannels: (options?: FetchChannelsOptions) => Promise<void>;
  probeChannels: () => Promise<void>;
  deleteChannel: (channelId: string, options?: { traceId?: string }) => Promise<boolean>;
  connectChannel: (channelId: string) => Promise<void>;
  disconnectChannel: (channelId: string) => Promise<void>;
  setChannels: (channels: Channel[]) => void;
  updateChannel: (channelId: string, updates: Partial<Channel>) => void;
  clearError: () => void;
}

const CHANNELS_SILENT_REFRESH_MIN_GAP_MS = 1200;
const CHANNELS_SNAPSHOT_NOT_READY_RETRY_MS = 1200;
let inflightChannelsFetchPromise: Promise<void> | null = null;
let channelsLastFetchAtMs = 0;
let channelsSnapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;

function clearChannelsSnapshotRetry(): void {
  if (channelsSnapshotRetryTimer) {
    clearTimeout(channelsSnapshotRetryTimer);
    channelsSnapshotRetryTimer = null;
  }
}

function scheduleChannelsSnapshotRetry(fetchChannels: () => Promise<void>): void {
  if (channelsSnapshotRetryTimer) {
    return;
  }
  channelsSnapshotRetryTimer = setTimeout(() => {
    channelsSnapshotRetryTimer = null;
    void fetchChannels();
  }, CHANNELS_SNAPSHOT_NOT_READY_RETRY_MS);
}

function hasMutatingChannels(mutatingByChannelId: Record<string, number>): boolean {
  return Object.keys(mutatingByChannelId).length > 0;
}

function incrementMutatingChannel(
  mutatingByChannelId: Record<string, number>,
  channelId: string,
): Record<string, number> {
  const current = mutatingByChannelId[channelId] ?? 0;
  return {
    ...mutatingByChannelId,
    [channelId]: current + 1,
  };
}

function decrementMutatingChannel(
  mutatingByChannelId: Record<string, number>,
  channelId: string,
): Record<string, number> {
  const current = mutatingByChannelId[channelId] ?? 0;
  if (current <= 1) {
    const next = { ...mutatingByChannelId };
    delete next[channelId];
    return next;
  }
  return {
    ...mutatingByChannelId,
    [channelId]: current - 1,
  };
}

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
  snapshotReady: false,
  initialLoading: false,
  refreshing: false,
  mutating: false,
  mutatingByChannelId: {},
  error: null,

  fetchChannels: async (options) => {
    const silent = options?.silent === true;
    const now = Date.now();
    const hasSnapshot = get().snapshotReady;
    if (silent && hasSnapshot && now - channelsLastFetchAtMs < CHANNELS_SILENT_REFRESH_MIN_GAP_MS) {
      return;
    }
    if (inflightChannelsFetchPromise) {
      await inflightChannelsFetchPromise;
      return;
    }

    if (!hasSnapshot) {
      set({ initialLoading: true, refreshing: false, error: null });
    } else if (!silent) {
      set({ refreshing: true, initialLoading: false, error: null });
    }

    const runFetch = (async () => {
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
        if (result.success && result.ready === false) {
          set((state) => ({
            ...state,
            snapshotReady: state.snapshotReady,
            initialLoading: !state.snapshotReady,
            refreshing: true,
            error: null,
          }));
          scheduleChannelsSnapshotRetry(() => get().fetchChannels({ silent: true }));
          return;
        }

        if (result.success && data) {
          clearChannelsSnapshotRetry();
          const channels: Channel[] = [];

          // Parse the complex channels.status response into simple Channel objects
          const channelOrder = data.channelOrder || Object.keys(data.channels || {});
          for (const channelId of channelOrder) {
            const summary = (data.channels as Record<string, unknown> | undefined)?.[channelId] as Record<string, unknown> | undefined;
            const configured = summary?.configured === true;
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
          set((state) => {
            const unchanged = areChannelsEquivalent(state.channels, channels);
            if (unchanged) {
              if (state.snapshotReady && state.error === null && !state.initialLoading && !state.refreshing) {
                return state;
              }
              return {
                ...state,
                snapshotReady: true,
                initialLoading: false,
                refreshing: false,
                error: null,
              };
            }
            return {
              ...state,
              channels,
              snapshotReady: true,
              initialLoading: false,
              refreshing: false,
              error: null,
            };
          });
        } else {
          // Gateway not available - keep stale channels and surface refresh error.
          const shouldSurfaceError = !silent || !hasSnapshot;
          set((state) => ({
            ...state,
            initialLoading: false,
            refreshing: false,
            error: shouldSurfaceError ? 'Failed to load channel snapshot' : state.error,
          }));
        }
      } catch (error) {
        // Gateway not connected, keep stale channels and surface refresh error.
        const shouldSurfaceError = !silent || !hasSnapshot;
        set((state) => ({
          ...state,
          initialLoading: false,
          refreshing: false,
          error: shouldSurfaceError
            ? (error instanceof Error ? error.message : 'Failed to load channel snapshot')
            : state.error,
        }));
      }
    })();

    inflightChannelsFetchPromise = runFetch;
    try {
      await runFetch;
    } finally {
      if (inflightChannelsFetchPromise === runFetch) {
        inflightChannelsFetchPromise = null;
      }
    }
  },

  probeChannels: async () => {
    set({ refreshing: true, error: null });
    try {
      await hostChannelsProbe();
    } catch (error) {
      set((state) => ({
        ...state,
        error: error instanceof Error ? error.message : 'Failed to probe channels',
      }));
    } finally {
      set({ refreshing: false });
    }
    await get().fetchChannels({ silent: true });
  },

  deleteChannel: async (channelId, options) => {
    const traceId = options?.traceId ?? crypto.randomUUID();
    const startedAt = Date.now();
    logChannelTrace('delete.store.start', traceId);
    set((state) => {
      const next = incrementMutatingChannel(state.mutatingByChannelId, channelId);
      return {
        mutatingByChannelId: next,
        mutating: true,
      };
    });
    const channel = get().channels.find((item) => item.id === channelId);
    const channelTypeFromState = channel?.type;
    const placeholderMatch = channelId.match(/^(.*)-default$/);
    const channelType = channelTypeFromState ?? (placeholderMatch?.[1] as ChannelType | undefined);
    if (!channelType) {
      logChannelTrace('delete.store.end', traceId, { outcome: 'noop', durationMs: Date.now() - startedAt });
      set((state) => {
        const next = decrementMutatingChannel(state.mutatingByChannelId, channelId);
        return {
          mutatingByChannelId: next,
          mutating: hasMutatingChannels(next),
        };
      });
      return false;
    }

    let outcome: 'confirmed' | 'target_rejected' | 'unknown' | 'error' | undefined;
    try {
      logChannelTrace('delete.config.start', traceId, { accountPresent: Boolean(channel?.accountId) });
      const result = await hostChannelsDeleteConfig(channelType, channel?.accountId, { traceId });
      outcome = ['confirmed', 'target_rejected'].includes(result.outcome) ? result.outcome : 'unknown';
      logChannelTrace('delete.config.end', traceId, { outcome, durationMs: Date.now() - startedAt });
      if (result.outcome !== 'confirmed') {
        const error = `Channel deletion outcome was ${result.outcome}`;
        set((state) => ({
          channels: state.channels.map((item) => item.id === channelId ? { ...item, error } : item),
        }));
        return false;
      }
      set((state) => ({
        channels: state.channels.filter((item) => item.id !== channelId),
      }));
      await get().fetchChannels();
      return true;
    } catch (error) {
      outcome = 'error';
      logChannelTrace('delete.config.end', traceId, { outcome, errorCode: channelErrorCode(error), durationMs: Date.now() - startedAt });
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({
        channels: state.channels.map((item) => item.id === channelId ? { ...item, error: message } : item),
      }));
      return false;
    } finally {
      logChannelTrace('delete.store.end', traceId, { outcome, durationMs: Date.now() - startedAt });
      set((state) => {
        const next = decrementMutatingChannel(state.mutatingByChannelId, channelId);
        return {
          mutatingByChannelId: next,
          mutating: hasMutatingChannels(next),
        };
      });
    }
  },

  connectChannel: async (channelId) => {
    set((state) => {
      const next = incrementMutatingChannel(state.mutatingByChannelId, channelId);
      return {
        mutatingByChannelId: next,
        mutating: true,
      };
    });
    const channel = get().channels.find((item) => item.id === channelId);
    const { updateChannel } = get();
    if (!channel) {
      set((state) => {
        const next = decrementMutatingChannel(state.mutatingByChannelId, channelId);
        return {
          mutatingByChannelId: next,
          mutating: hasMutatingChannels(next),
        };
      });
      return;
    }
    try {
      const result = await hostChannelsConnect(channel.type, channel.accountId);
      if (result.success) {
        updateChannel(channelId, { status: 'connected', error: undefined });
      } else {
        updateChannel(channelId, { error: 'Channel connection was not confirmed' });
      }
    } catch (error) {
      updateChannel(channelId, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      set((state) => {
        const next = decrementMutatingChannel(state.mutatingByChannelId, channelId);
        return {
          mutatingByChannelId: next,
          mutating: hasMutatingChannels(next),
        };
      });
    }
  },

  disconnectChannel: async (channelId) => {
    set((state) => {
      const next = incrementMutatingChannel(state.mutatingByChannelId, channelId);
      return {
        mutatingByChannelId: next,
        mutating: true,
      };
    });
    const channel = get().channels.find((item) => item.id === channelId);
    const { updateChannel } = get();
    if (!channel) {
      set((state) => {
        const next = decrementMutatingChannel(state.mutatingByChannelId, channelId);
        return {
          mutatingByChannelId: next,
          mutating: hasMutatingChannels(next),
        };
      });
      return;
    }

    try {
      const result = await hostChannelsDisconnect(channel.type, channel.accountId);
      if (result.success) {
        updateChannel(channelId, { status: 'disconnected', error: undefined });
      } else {
        updateChannel(channelId, { error: 'Channel disconnection was not confirmed' });
      }
    } catch (error) {
      updateChannel(channelId, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      set((state) => {
        const next = decrementMutatingChannel(state.mutatingByChannelId, channelId);
        return {
          mutatingByChannelId: next,
          mutating: hasMutatingChannels(next),
        };
      });
    }
  },

  setChannels: (channels) => set({ channels, snapshotReady: true }),

  updateChannel: (channelId, updates) => {
    set((state) => ({
      channels: state.channels.map((channel) =>
        channel.id === channelId ? { ...channel, ...updates } : channel
      ),
    }));
  },

  clearError: () => set({ error: null }),
}));
