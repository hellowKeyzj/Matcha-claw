/**
 * Gateway State Store
 * Uses Host API + SSE for lifecycle/status and a direct renderer WebSocket for runtime RPC.
 */
import { create } from 'zustand';
import { hostApiFetch, hostGatewayRpc } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import type { GatewayStatus } from '../types/gateway';
import {
  normalizeGatewayNotificationEvent,
  type ChatDomainEvent,
  type ChatRuntimeDomainEvent,
} from './chat/event-normalizer';
import { subscribeChatConversationEvents } from './chat/transport-adapter';
import { useChatStore } from './chat';
import { readSessionsFromState } from './chat/session-helpers';
import { getSessionRuntime } from './chat/store-state-helpers';
import { useTaskCenterStore } from './task-center-store';
import { useChannelsStore } from './channels';

let gatewayInitPromise: Promise<void> | null = null;
let gatewayEventUnsubscribers: Array<() => void> | null = null;
const TASK_NOTIFICATION_FLUSH_MS = 48;
const TASK_NOTIFICATION_COALESCE_LIMIT = 200;
let queuedTaskNotifications: Array<{ method?: string; params?: Record<string, unknown> }> = [];
let taskNotificationFlushTimer: ReturnType<typeof setTimeout> | null = null;

interface GatewayHealth {
  ok: boolean;
  status?: string;
  detail?: string;
  portReachable?: boolean;
  connectionState?: 'connected' | 'reconnecting' | 'disconnected' | string;
  lastError?: string;
  updatedAt?: number;
  error?: string;
  uptime?: number;
}

type RuntimeHostObservedStatus =
  | 'unknown'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'error'
  | 'stopped';

type GatewayConnectionObservedStatus =
  | 'unknown'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

interface RuntimeHostObservedState {
  lifecycle: RuntimeHostObservedStatus;
  hostLifecycle?: string;
  runtimeLifecycle?: string;
  pid?: number;
  activePluginCount?: number;
  enabledPluginIds?: string[];
  error?: string;
  gatewayConnectionState?: GatewayConnectionObservedStatus;
  gatewayConnectionReason?: string;
  gatewayConnectionUpdatedAt?: number;
  restartCount: number;
  lastRestartAt?: number;
  updatedAt?: number;
}

interface GatewayState {
  status: GatewayStatus;
  health: GatewayHealth | null;
  runtimeHost: RuntimeHostObservedState;
  isInitialized: boolean;
  lastError: string | null;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  checkHealth: () => Promise<GatewayHealth>;
  rpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  setStatus: (status: GatewayStatus) => void;
  clearError: () => void;
}

async function fetchGatewayStatusSnapshot(): Promise<GatewayStatus> {
  return await hostApiFetch<GatewayStatus>('/api/gateway/status');
}

function syncPendingApprovalsFromChatStore(): void {
  try {
    const state = useChatStore.getState() as { syncPendingApprovals?: () => Promise<void> };
    if (typeof state.syncPendingApprovals !== 'function') return;
    void state.syncPendingApprovals();
  } catch {
    // ignore
  }
}

function coalesceTaskNotifications(
  notifications: Array<{ method?: string; params?: Record<string, unknown> }>,
): Array<{ method?: string; params?: Record<string, unknown> }> {
  const passthrough: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  const byTaskId = new Map<string, { method?: string; params?: Record<string, unknown> }>();

  for (const payload of notifications) {
    const method = payload.method;
    const isTaskNotification = typeof method === 'string'
      && (method.startsWith('task_') || method.startsWith('task_manager.'));
    if (!isTaskNotification) {
      passthrough.push(payload);
      continue;
    }
    const params = payload.params;
    const task = (params?.task && typeof params.task === 'object')
      ? params.task as { id?: unknown }
      : undefined;
    const taskId = typeof task?.id === 'string'
      ? task.id
      : (typeof params?.taskId === 'string' ? params.taskId : '');
    if (!taskId) {
      passthrough.push(payload);
      continue;
    }
    byTaskId.set(taskId, payload);
  }

  return [...passthrough, ...byTaskId.values()];
}

function flushTaskNotifications(): void {
  if (taskNotificationFlushTimer) {
    clearTimeout(taskNotificationFlushTimer);
    taskNotificationFlushTimer = null;
  }
  if (queuedTaskNotifications.length === 0) {
    return;
  }
  const pending = queuedTaskNotifications;
  queuedTaskNotifications = [];
  const compacted = coalesceTaskNotifications(pending);

  for (const payload of compacted) {
    try {
      useTaskCenterStore.getState().handleGatewayNotification(payload);
    } catch {
      // ignore
    }
  }
}

function enqueueTaskNotification(payload: { method?: string; params?: Record<string, unknown> }): void {
  queuedTaskNotifications.push(payload);
  if (queuedTaskNotifications.length > TASK_NOTIFICATION_COALESCE_LIMIT) {
    queuedTaskNotifications.splice(
      0,
      queuedTaskNotifications.length - TASK_NOTIFICATION_COALESCE_LIMIT,
    );
  }
  if (taskNotificationFlushTimer) {
    return;
  }
  taskNotificationFlushTimer = setTimeout(() => {
    flushTaskNotifications();
  }, TASK_NOTIFICATION_FLUSH_MS);
}

function handleGatewayNotification(notification: { method?: string; params?: Record<string, unknown> } | undefined): void {
  const payload = notification;
  if (!payload || !payload.params || typeof payload.params !== 'object') {
    return;
  }

  const domainEvent = normalizeGatewayNotificationEvent(payload);
  if (domainEvent) {
    handleChatDomainEvent(domainEvent);
    return;
  }

  if (
    typeof payload.method === 'string'
    && (payload.method.startsWith('task_') || payload.method.startsWith('task_manager.'))
  ) {
    enqueueTaskNotification(payload);
  }
}

function maybeRefreshChatSessionsFromRuntimeEvent(
  state: ReturnType<typeof useChatStore.getState>,
  event: ChatRuntimeDomainEvent,
): void {
  if (event.source !== 'run.phase') {
    return;
  }
  if (event.phase !== 'started' && event.phase !== 'final' && event.phase !== 'error' && event.phase !== 'aborted') {
    return;
  }
  if (!event.sessionKey) {
    return;
  }
  const shouldRefreshSessions =
    event.sessionKey !== state.currentSessionKey
    || !readSessionsFromState(state).some((session) => session.key === event.sessionKey);
  if (!shouldRefreshSessions) {
    return;
  }
  void state.loadSessions();
}

function maybeRefreshChatHistoryFromRuntimeEvent(
  state: ReturnType<typeof useChatStore.getState>,
  event: ChatRuntimeDomainEvent,
): void {
  if (event.source !== 'run.phase') {
    return;
  }
  if (event.phase !== 'error' && event.phase !== 'aborted') {
    return;
  }
  const matchesCurrentSession = event.sessionKey == null || event.sessionKey === state.currentSessionKey;
  const currentRuntime = getSessionRuntime(state, state.currentSessionKey);
  const matchesActiveRun = (
    event.runId != null
    && currentRuntime.activeRunId != null
    && event.runId === currentRuntime.activeRunId
  );
  if (!matchesCurrentSession && !matchesActiveRun && event.sessionKey != null) {
    return;
  }
  void state.loadHistory({
    sessionKey: state.currentSessionKey,
    mode: 'quiet',
    scope: 'foreground',
    reason: 'gateway_runtime_phase_refresh',
  });
}

function handleChatDomainEvent(event: ChatDomainEvent): void {
  try {
    const state = useChatStore.getState();
    if (event.kind === 'chat.runtime') {
      maybeRefreshChatSessionsFromRuntimeEvent(state, event);
      maybeRefreshChatHistoryFromRuntimeEvent(state, event);
      state.handleChatEvent(event.event);
      return;
    }
    if (event.kind === 'chat.approval.requested') {
      state.handleApprovalRequested(event.payload);
      return;
    }
    state.handleApprovalResolved(event.payload);
  } catch {
    // ignore
  }
}

function handleGatewayConversationEvent(event: ChatRuntimeDomainEvent): void {
  handleChatDomainEvent(event);
}

function mapChannelStatus(status: string): 'connected' | 'connecting' | 'disconnected' | 'error' {
  switch (status) {
    case 'connected':
    case 'running':
      return 'connected';
    case 'connecting':
    case 'starting':
      return 'connecting';
    case 'error':
    case 'failed':
      return 'error';
    default:
      return 'disconnected';
  }
}

export const useGatewayStore = create<GatewayState>((set, get) => ({
  status: {
    state: 'stopped',
    port: 18789,
  },
  health: null,
  runtimeHost: {
    lifecycle: 'unknown',
    gatewayConnectionState: 'unknown',
    restartCount: 0,
  },
  isInitialized: false,
  lastError: null,

  init: async () => {
    if (get().isInitialized) return;
    if (gatewayInitPromise) {
      await gatewayInitPromise;
      return;
    }

    gatewayInitPromise = (async () => {
      try {
        const status = await fetchGatewayStatusSnapshot();
        set({ status, isInitialized: true });

        if (!gatewayEventUnsubscribers) {
          const unsubscribers: Array<() => void> = [];
          unsubscribers.push(subscribeHostEvent<GatewayStatus>('gateway:status', (payload) => {
            const prevState = get().status.state;
            set({ status: payload });
            if (payload.state === 'running' && prevState !== 'running') {
              syncPendingApprovalsFromChatStore();
            }
          }));
          unsubscribers.push(subscribeHostEvent<{ message?: string }>('gateway:error', (payload) => {
            set({ lastError: payload.message || 'Gateway error' });
          }));
          unsubscribers.push(subscribeHostEvent<{
            state?: GatewayConnectionObservedStatus;
            portReachable?: boolean;
            lastError?: string;
            updatedAt?: number;
          }>('gateway:connection', (payload) => {
            set((state) => {
              const connectionState = payload.state ?? state.runtimeHost.gatewayConnectionState ?? 'unknown';
              const lifecycle = (() => {
                if (connectionState === 'disconnected' && state.runtimeHost.lifecycle === 'running') {
                  return 'degraded';
                }
                if (connectionState === 'connected' && state.runtimeHost.lifecycle === 'degraded') {
                  return 'running';
                }
                return state.runtimeHost.lifecycle;
              })();
              return {
                runtimeHost: {
                  ...state.runtimeHost,
                  lifecycle,
                  gatewayConnectionState: connectionState,
                  gatewayConnectionReason: payload.lastError,
                  gatewayConnectionUpdatedAt: payload.updatedAt ?? Date.now(),
                  updatedAt: payload.updatedAt ?? Date.now(),
                },
              };
            });
          }));
          unsubscribers.push(subscribeHostEvent<{ method?: string; params?: Record<string, unknown> }>(
            'gateway:notification',
            (payload) => {
              handleGatewayNotification(payload);
            },
          ));
          unsubscribers.push(subscribeChatConversationEvents((event) => {
            handleGatewayConversationEvent(event);
          }));
          unsubscribers.push(subscribeHostEvent<{ channelId?: string; status?: string }>(
            'gateway:channel-status',
            (update) => {
              if (!update.channelId || !update.status) return;
              const state = useChannelsStore.getState();
              const channel = state.channels.find((item) => item.type === update.channelId);
              if (channel) {
                state.updateChannel(channel.id, { status: mapChannelStatus(update.status) });
              }
            },
          ));
          unsubscribers.push(subscribeHostEvent<{
            status: RuntimeHostObservedStatus;
            hostLifecycle?: string;
            runtimeLifecycle?: string;
            pid?: number;
            activePluginCount?: number;
            enabledPluginIds?: string[];
            error?: string;
            updatedAt?: number;
          }>('runtime-host:status', (payload) => {
            set((state) => ({
              runtimeHost: {
                ...state.runtimeHost,
                lifecycle: payload.status ?? 'unknown',
                hostLifecycle: payload.hostLifecycle,
                runtimeLifecycle: payload.runtimeLifecycle,
                pid: payload.pid,
                activePluginCount: payload.activePluginCount,
                enabledPluginIds: payload.enabledPluginIds ?? state.runtimeHost.enabledPluginIds,
                error: payload.error,
                updatedAt: payload.updatedAt ?? Date.now(),
              },
            }));
          }));
          unsubscribers.push(subscribeHostEvent<{
            status?: RuntimeHostObservedStatus;
            message?: string;
            updatedAt?: number;
          }>('runtime-host:error', (payload) => {
            set((state) => ({
              runtimeHost: {
                ...state.runtimeHost,
                lifecycle: payload.status ?? state.runtimeHost.lifecycle,
                error: payload.message || state.runtimeHost.error,
                updatedAt: payload.updatedAt ?? Date.now(),
              },
            }));
          }));
          unsubscribers.push(subscribeHostEvent<{
            previousPid?: number;
            pid?: number;
            recoveredAt?: number;
          }>('runtime-host:restart', (payload) => {
            set((state) => ({
              runtimeHost: {
                ...state.runtimeHost,
                pid: payload.pid ?? state.runtimeHost.pid,
                restartCount: state.runtimeHost.restartCount + 1,
                lastRestartAt: payload.recoveredAt ?? Date.now(),
                updatedAt: payload.recoveredAt ?? Date.now(),
              },
            }));
          }));
          gatewayEventUnsubscribers = unsubscribers;
        }
        if (status.state === 'running') {
          syncPendingApprovalsFromChatStore();
        }
      } catch (error) {
        console.error('Failed to initialize Gateway:', error);
        set({ lastError: String(error) });
      } finally {
        gatewayInitPromise = null;
      }
    })();

    await gatewayInitPromise;
  },

  start: async () => {
    try {
      set({ lastError: null });
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/gateway/start', {
        method: 'POST',
      });
      if (!result.success) {
        set({ lastError: result.error || 'Failed to start Gateway' });
        return;
      }
      const status = await fetchGatewayStatusSnapshot();
      set({ status });
    } catch (error) {
      set({ lastError: String(error) });
    }
  },

  stop: async () => {
    try {
      set({ lastError: null });
      await hostApiFetch('/api/gateway/stop', { method: 'POST' });
      const status = await fetchGatewayStatusSnapshot();
      set({ status });
    } catch (error) {
      console.error('Failed to stop Gateway:', error);
      set({ lastError: String(error) });
    }
  },

  restart: async () => {
    try {
      set({ lastError: null });
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/gateway/restart', {
        method: 'POST',
      });
      if (!result.success) {
        set({ lastError: result.error || 'Failed to restart Gateway' });
        return;
      }
      const status = await fetchGatewayStatusSnapshot();
      set({ status });
    } catch (error) {
      set({ lastError: String(error) });
    }
  },

  checkHealth: async () => {
    try {
      const result = await hostApiFetch<GatewayHealth>('/api/gateway/health');
      set({ health: result });
      return result;
    } catch (error) {
      const health: GatewayHealth = { ok: false, error: String(error) };
      set({ health });
      return health;
    }
  },

  rpc: async <T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> => {
    return await hostGatewayRpc<T>(method, params, timeoutMs);
  },

  setStatus: (status) => set({ status }),
  clearError: () => set({ lastError: null }),
}));
