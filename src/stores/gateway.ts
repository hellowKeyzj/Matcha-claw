/**
 * Gateway State Store
 * Uses Host API + SSE for lifecycle/status and a direct renderer WebSocket for runtime RPC.
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { subscribeHostEvent } from '@/lib/host-events';
import type { GatewayStatus } from '../types/gateway';

let gatewayInitPromise: Promise<void> | null = null;
let gatewayEventUnsubscribers: Array<() => void> | null = null;
let chatStoreModulePromise: Promise<typeof import('./chat')> | null = null;
let taskCenterStoreModulePromise: Promise<typeof import('./task-center-store')> | null = null;
let channelsStoreModulePromise: Promise<typeof import('./channels')> | null = null;
const TASK_NOTIFICATION_FLUSH_MS = 48;
const TASK_NOTIFICATION_COALESCE_LIMIT = 200;
let queuedTaskNotifications: Array<{ method?: string; params?: Record<string, unknown> }> = [];
let taskNotificationFlushTimer: ReturnType<typeof setTimeout> | null = null;

interface GatewayHealth {
  ok: boolean;
  error?: string;
  uptime?: number;
}

interface GatewayState {
  status: GatewayStatus;
  health: GatewayHealth | null;
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

function getChatStoreModule() {
  if (!chatStoreModulePromise) {
    chatStoreModulePromise = import('./chat');
  }
  return chatStoreModulePromise;
}

function syncPendingApprovalsFromChatStore(): void {
  getChatStoreModule()
    .then(({ useChatStore }) => {
      const state = useChatStore.getState() as { syncPendingApprovals?: () => Promise<void> };
      if (typeof state.syncPendingApprovals !== 'function') return;
      void state.syncPendingApprovals();
    })
    .catch(() => {});
}

function getTaskCenterStoreModule() {
  if (!taskCenterStoreModulePromise) {
    taskCenterStoreModulePromise = import('./task-center-store');
  }
  return taskCenterStoreModulePromise;
}

function getChannelsStoreModule() {
  if (!channelsStoreModulePromise) {
    channelsStoreModulePromise = import('./channels');
  }
  return channelsStoreModulePromise;
}

function coalesceTaskNotifications(
  notifications: Array<{ method?: string; params?: Record<string, unknown> }>,
): Array<{ method?: string; params?: Record<string, unknown> }> {
  const passthrough: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  const byTaskId = new Map<string, { method?: string; params?: Record<string, unknown> }>();

  for (const payload of notifications) {
    const method = payload.method;
    if (method !== 'task_progress_update' && method !== 'task_status_changed') {
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

async function flushTaskNotifications(): Promise<void> {
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

  try {
    const { useTaskCenterStore } = await getTaskCenterStoreModule();
    for (const payload of compacted) {
      useTaskCenterStore.getState().handleGatewayNotification(payload);
    }
  } catch {
    // ignore
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
    void flushTaskNotifications();
  }, TASK_NOTIFICATION_FLUSH_MS);
}

function handleGatewayNotification(notification: { method?: string; params?: Record<string, unknown> } | undefined): void {
  const payload = notification;
  if (!payload || !payload.params || typeof payload.params !== 'object') {
    return;
  }

  const extractApprovalPayload = (params: Record<string, unknown>): Record<string, unknown> => {
    const request = (params.request && typeof params.request === 'object')
      ? params.request as Record<string, unknown>
      : undefined;
    const data = (params.data && typeof params.data === 'object')
      ? params.data as Record<string, unknown>
      : undefined;
    const sessionKey = params.sessionKey ?? data?.sessionKey ?? request?.sessionKey;
    const runId = params.runId ?? data?.runId ?? request?.runId;
    const toolName = params.toolName ?? data?.toolName ?? request?.toolName;
    const createdAt = params.createdAt ?? data?.createdAt ?? request?.createdAt;
    const expiresAt = params.expiresAt ?? data?.expiresAt ?? request?.expiresAt;
    return {
      ...params,
      ...(request ? { request } : {}),
      ...(sessionKey != null ? { sessionKey } : {}),
      ...(runId != null ? { runId } : {}),
      ...(toolName != null ? { toolName } : {}),
      ...(createdAt != null ? { createdAt } : {}),
      ...(expiresAt != null ? { expiresAt } : {}),
    };
  };

  if (payload.method === 'exec.approval.requested') {
    getChatStoreModule()
      .then(({ useChatStore }) => {
        useChatStore.getState().handleApprovalRequested(extractApprovalPayload(payload.params!));
      })
      .catch(() => {});
    return;
  }

  if (payload.method === 'exec.approval.resolved') {
    getChatStoreModule()
      .then(({ useChatStore }) => {
        useChatStore.getState().handleApprovalResolved(extractApprovalPayload(payload.params!));
      })
      .catch(() => {});
    return;
  }

  if (typeof payload.method === 'string' && payload.method.startsWith('task_')) {
    enqueueTaskNotification(payload);
    return;
  }

  if (payload.method !== 'agent') {
    return;
  }

  const p = payload.params;
  const data = (p.data && typeof p.data === 'object') ? (p.data as Record<string, unknown>) : {};
  const phase = data.phase ?? p.phase;
  const hasChatData = (p.state ?? data.state) || (p.message ?? data.message);

  if (hasChatData) {
    const normalizedEvent: Record<string, unknown> = {
      ...data,
      runId: p.runId ?? data.runId,
      sessionKey: p.sessionKey ?? data.sessionKey,
      stream: p.stream ?? data.stream,
      seq: p.seq ?? data.seq,
      state: p.state ?? data.state,
      message: p.message ?? data.message,
    };
    getChatStoreModule()
      .then(({ useChatStore }) => {
        useChatStore.getState().handleChatEvent(normalizedEvent);
      })
      .catch(() => {});
  }

  const runId = p.runId ?? data.runId;
  const sessionKey = p.sessionKey ?? data.sessionKey;
  if (phase === 'started' && runId != null && sessionKey != null) {
    getChatStoreModule()
      .then(({ useChatStore }) => {
        const state = useChatStore.getState();
        const resolvedSessionKey = String(sessionKey);
        const shouldRefreshSessions =
          resolvedSessionKey !== state.currentSessionKey
          || !state.sessions.some((session) => session.key === resolvedSessionKey);
        if (shouldRefreshSessions) {
          void state.loadSessions();
        }

        state.handleChatEvent({
          state: 'started',
          runId,
          sessionKey: resolvedSessionKey,
        });
      })
      .catch(() => {});
  }

  if (phase === 'completed' || phase === 'done' || phase === 'finished' || phase === 'end') {
    getChatStoreModule()
      .then(({ useChatStore }) => {
        const state = useChatStore.getState();
        const resolvedSessionKey = sessionKey != null ? String(sessionKey) : null;
        const shouldRefreshSessions = resolvedSessionKey != null && (
          resolvedSessionKey !== state.currentSessionKey
          || !state.sessions.some((session) => session.key === resolvedSessionKey)
        );
        if (shouldRefreshSessions) {
          void state.loadSessions();
        }

        const matchesCurrentSession = resolvedSessionKey == null || resolvedSessionKey === state.currentSessionKey;
        const matchesActiveRun = runId != null && state.activeRunId != null && String(runId) === state.activeRunId;

        if (matchesCurrentSession || matchesActiveRun) {
          void state.loadHistory(true);
        }
        if ((matchesCurrentSession || matchesActiveRun) && state.sending) {
          useChatStore.setState({
            sending: false,
            activeRunId: null,
            pendingFinal: false,
            lastUserMessageAt: null,
          });
        }
      })
      .catch(() => {});
  }
}

function handleGatewayChatMessage(data: unknown): void {
  getChatStoreModule().then(({ useChatStore }) => {
    const chatData = data as Record<string, unknown>;
    const payload = ('message' in chatData && typeof chatData.message === 'object')
      ? chatData.message as Record<string, unknown>
      : chatData;

    if (payload.state) {
      useChatStore.getState().handleChatEvent(payload);
      return;
    }

    useChatStore.getState().handleChatEvent({
      state: 'final',
      message: payload,
      runId: chatData.runId ?? payload.runId,
    });
  }).catch(() => {});
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
        const status = await hostApiFetch<GatewayStatus>('/api/gateway/status');
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
          unsubscribers.push(subscribeHostEvent<{ method?: string; params?: Record<string, unknown> }>(
            'gateway:notification',
            (payload) => {
              handleGatewayNotification(payload);
            },
          ));
          unsubscribers.push(subscribeHostEvent('gateway:chat-message', (payload) => {
            handleGatewayChatMessage(payload);
          }));
          unsubscribers.push(subscribeHostEvent<{ channelId?: string; status?: string }>(
            'gateway:channel-status',
            (update) => {
              getChannelsStoreModule()
                .then(({ useChannelsStore }) => {
                  if (!update.channelId || !update.status) return;
                  const state = useChannelsStore.getState();
                  const channel = state.channels.find((item) => item.type === update.channelId);
                  if (channel) {
                    state.updateChannel(channel.id, { status: mapChannelStatus(update.status) });
                  }
                })
                .catch(() => {});
            },
          ));
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
      set({ status: { ...get().status, state: 'starting' }, lastError: null });
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/gateway/start', {
        method: 'POST',
      });
      if (!result.success) {
        set({
          status: { ...get().status, state: 'error', error: result.error },
          lastError: result.error || 'Failed to start Gateway',
        });
      }
    } catch (error) {
      set({
        status: { ...get().status, state: 'error', error: String(error) },
        lastError: String(error),
      });
    }
  },

  stop: async () => {
    try {
      await hostApiFetch('/api/gateway/stop', { method: 'POST' });
      set({ status: { ...get().status, state: 'stopped' }, lastError: null });
    } catch (error) {
      console.error('Failed to stop Gateway:', error);
      set({ lastError: String(error) });
    }
  },

  restart: async () => {
    try {
      set({ status: { ...get().status, state: 'starting' }, lastError: null });
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/gateway/restart', {
        method: 'POST',
      });
      if (!result.success) {
        set({
          status: { ...get().status, state: 'error', error: result.error },
          lastError: result.error || 'Failed to restart Gateway',
        });
      }
    } catch (error) {
      set({
        status: { ...get().status, state: 'error', error: String(error) },
        lastError: String(error),
      });
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
    const response = await invokeIpc<{
      success: boolean;
      result?: T;
      error?: string;
    }>('gateway:rpc', method, params, timeoutMs);
    if (!response.success) {
      throw new Error(response.error || `Gateway RPC failed: ${method}`);
    }
    return response.result as T;
  },

  setStatus: (status) => set({ status }),
  clearError: () => set({ lastError: null }),
}));
