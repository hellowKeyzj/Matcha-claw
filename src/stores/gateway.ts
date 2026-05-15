/**
 * Gateway State Store
 * Uses Host API + SSE for lifecycle/status. Domain runtime calls live behind runtime-host application routes.
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import type { SessionUpdateEvent, TaskSnapshotEvent } from '../../runtime-host/shared/session-adapter-types';
import type { GatewayStatus } from '../types/gateway';
import {
  normalizeGatewayNotificationEvent,
  type ChatDomainEvent,
} from './chat/event-normalizer';
import { useChatStore } from './chat';
import { useTaskSnapshotStore } from './chat/task-snapshot-store';
import { useChannelsStore } from './channels';
import { isGatewayOperational } from '@/lib/gateway-status';
import type { GatewayTransportIssue } from '../../runtime-host/shared/gateway-error';
import { isTaskSnapshotToolMethod } from '../../runtime-host/shared/task-tool-contract';

let gatewayInitPromise: Promise<void> | null = null;
let gatewayEventUnsubscribers: Array<() => void> | null = null;
let gatewayReconcileTimer: ReturnType<typeof setInterval> | null = null;
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

interface GatewayErrorEventPayload {
  message?: string;
  issue?: GatewayTransportIssue;
}

type RuntimeHostObservedStatus =
  | 'unknown'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'degraded'
  | 'error'
  | 'stopped';

interface RuntimeHostObservedState {
  lifecycle: RuntimeHostObservedStatus;
  hostLifecycle?: string;
  runtimeLifecycle?: string;
  pid?: number;
  activePluginCount?: number;
  enabledPluginIds?: string[];
  error?: string;
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
    if (!isTaskNotificationMethod(payload.method)) {
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

function isTaskNotificationMethod(method: unknown): method is string {
  return isTaskSnapshotToolMethod(method) || method === 'TaskSnapshot';
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
      useTaskSnapshotStore.getState().reportTaskCenterNotification(
        payload,
        useChatStore.getState().currentSessionKey,
      );
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

  if (isTaskNotificationMethod(payload.method)) {
    enqueueTaskNotification(payload);
  }
}

function handleChatDomainEvent(event: ChatDomainEvent): void {
  try {
    const state = useChatStore.getState();
    if (event.kind === 'chat.approval.requested') {
      state.handleApprovalRequested(event.payload);
      return;
    }
    state.handleApprovalResolved(event.payload);
  } catch {
    // ignore
  }
}

function handleSessionUpdateEvent(event: SessionUpdateEvent): void {
  try {
    useChatStore.getState().handleSessionUpdateEvent(event);
  } catch {
    // ignore
  }
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
    processState: 'stopped',
    port: 18789,
    gatewayReady: false,
    healthSummary: 'unresponsive',
    transportState: 'disconnected',
    portReachable: false,
    diagnostics: {
      consecutiveHeartbeatMisses: 0,
      consecutiveRpcFailures: 0,
    },
    updatedAt: Date.now(),
  },
  health: null,
  runtimeHost: {
    lifecycle: 'unknown',
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
            const prevOperational = isGatewayOperational(get().status);
            set({ status: payload });
            if (isGatewayOperational(payload) && !prevOperational) {
              syncPendingApprovalsFromChatStore();
            }
          }));
          unsubscribers.push(subscribeHostEvent<GatewayErrorEventPayload>('gateway:error', (payload) => {
            set((state) => ({
              lastError: payload.issue?.message || payload.message || 'Gateway error',
              status: {
                ...state.status,
                ...(payload.issue?.message
                  ? { lastError: payload.issue.message }
                  : (payload.message ? { lastError: payload.message } : {})),
                ...(payload.issue ? { lastIssue: payload.issue } : {}),
              },
            }));
          }));
          unsubscribers.push(subscribeHostEvent<{ method?: string; params?: Record<string, unknown> }>(
            'gateway:notification',
            (payload) => {
              handleGatewayNotification(payload);
            },
          ));
          unsubscribers.push(subscribeHostEvent<SessionUpdateEvent>('session:update', (payload) => {
            handleSessionUpdateEvent(payload);
          }));
          unsubscribers.push(subscribeHostEvent<TaskSnapshotEvent>(
            'task:snapshot',
            (payload) => {
              useTaskSnapshotStore.getState().reportTaskCenterSnapshot(payload);
            },
          ));
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
                error: payload.status === 'running' || payload.status === 'restarting' || payload.status === 'starting'
                  ? undefined
                  : payload.error,
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
            status?: RuntimeHostObservedStatus;
            recoveredAt?: number;
          }>('runtime-host:restart', (payload) => {
            set((state) => ({
              runtimeHost: {
                ...state.runtimeHost,
                lifecycle: payload.status ?? 'running',
                pid: payload.pid ?? state.runtimeHost.pid,
                error: undefined,
                restartCount: state.runtimeHost.restartCount + 1,
                lastRestartAt: payload.recoveredAt ?? Date.now(),
                updatedAt: payload.recoveredAt ?? Date.now(),
              },
            }));
          }));
          if (gatewayReconcileTimer !== null) {
            clearInterval(gatewayReconcileTimer);
          }
          gatewayReconcileTimer = setInterval(() => {
            void fetchGatewayStatusSnapshot()
              .then((latest) => {
                const current = get().status;
                if (
                  latest.processState !== current.processState
                  || latest.transportState !== current.transportState
                  || latest.healthSummary !== current.healthSummary
                  || latest.gatewayReady !== current.gatewayReady
                  || latest.updatedAt !== current.updatedAt
                ) {
                  set({ status: latest });
                }
              })
              .catch(() => {});
          }, 30_000);
          gatewayEventUnsubscribers = unsubscribers;
        }
        if (isGatewayOperational(status)) {
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

  setStatus: (status) => set({ status }),
  clearError: () => set({ lastError: null }),
}));
