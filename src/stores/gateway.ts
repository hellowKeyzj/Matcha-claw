/**
 * Gateway State Store
 * Uses Host API + SSE for lifecycle/status and a direct renderer WebSocket for runtime RPC.
 */
import { create } from 'zustand';
import { hostApiFetch, hostGatewayRpc } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import type { GatewayStatus } from '../types/gateway';
import { useChatStore } from './chat';
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
  pluginExecutionEnabled?: boolean;
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

type GatewayConversationRunPhase = 'started' | 'completed' | 'error' | 'aborted';

type GatewayConversationEvent =
  | {
    type: 'chat.message';
    event: Record<string, unknown>;
  }
  | {
    type: 'run.phase';
    phase: GatewayConversationRunPhase;
    runId?: string;
    sessionKey?: string;
  };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeRunPhase(phaseRaw: unknown): GatewayConversationRunPhase | null {
  const phase = typeof phaseRaw === 'string' ? phaseRaw.trim().toLowerCase() : '';
  if (!phase) {
    return null;
  }
  if (phase === 'started' || phase === 'start') {
    return 'started';
  }
  if (phase === 'completed' || phase === 'done' || phase === 'finished' || phase === 'end') {
    return 'completed';
  }
  if (phase === 'error' || phase === 'failed') {
    return 'error';
  }
  if (phase === 'aborted' || phase === 'abort' || phase === 'cancelled' || phase === 'canceled') {
    return 'aborted';
  }
  return null;
}

function parseStructuredGatewayChatEvent(data: unknown): Record<string, unknown> | null {
  const candidate = asRecord(data);
  if (!candidate) {
    return null;
  }
  const rawState = typeof candidate.state === 'string' ? candidate.state.trim().toLowerCase() : '';
  if (!rawState) {
    return null;
  }
  const state = (rawState === 'completed' || rawState === 'done' || rawState === 'finished' || rawState === 'end')
    ? 'final'
    : rawState;
  if (!state) {
    return null;
  }

  const rawMessage = candidate.message;
  if (rawMessage !== undefined && (typeof rawMessage !== 'object' || rawMessage == null || Array.isArray(rawMessage))) {
    return null;
  }

  const runId = typeof candidate.runId === 'string' ? candidate.runId.trim() : '';
  const sessionKey = typeof candidate.sessionKey === 'string' ? candidate.sessionKey.trim() : '';

  return {
    ...candidate,
    state,
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function parseGatewayConversationEvent(payload: unknown): GatewayConversationEvent | null {
  const input = asRecord(payload);
  if (!input) {
    return null;
  }
  if (input.type === 'chat.message') {
    const event = parseStructuredGatewayChatEvent(input.event);
    if (!event) {
      return null;
    }
    return {
      type: 'chat.message',
      event,
    };
  }
  if (input.type === 'run.phase') {
    const phase = normalizeRunPhase(input.phase);
    if (!phase) {
      return null;
    }
    const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
    const sessionKey = typeof input.sessionKey === 'string' ? input.sessionKey.trim() : '';
    return {
      type: 'run.phase',
      phase,
      ...(runId ? { runId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
    };
  }
  return null;
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
    try {
      useChatStore.getState().handleApprovalRequested(extractApprovalPayload(payload.params!));
    } catch {
      // ignore
    }
    return;
  }

  if (payload.method === 'exec.approval.resolved') {
    try {
      useChatStore.getState().handleApprovalResolved(extractApprovalPayload(payload.params!));
    } catch {
      // ignore
    }
    return;
  }

  if (
    typeof payload.method === 'string'
    && (payload.method.startsWith('task_') || payload.method.startsWith('task_manager.'))
  ) {
    enqueueTaskNotification(payload);
  }
}

function handleGatewayRunPhaseEvent(event: {
  phase: GatewayConversationRunPhase;
  runId?: string;
  sessionKey?: string;
}): void {
  const runId = event.runId;
  const sessionKey = event.sessionKey;
  if (event.phase === 'started' && runId != null && sessionKey != null) {
    try {
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
    } catch {
      // ignore
    }
    return;
  }

  if (event.phase === 'completed' || event.phase === 'error' || event.phase === 'aborted') {
    try {
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
          error: null,
        });
      }
    } catch {
      // ignore
    }
  }
}

function handleGatewayConversationEvent(payload: unknown): void {
  try {
    const event = parseGatewayConversationEvent(payload);
    if (!event) {
      return;
    }
    if (event.type === 'run.phase') {
      handleGatewayRunPhaseEvent(event);
      return;
    }
    const chatState = useChatStore.getState();
    chatState.handleChatEvent(event.event);
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
            reason?: string;
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
                  gatewayConnectionReason: payload.reason,
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
          unsubscribers.push(subscribeHostEvent('gateway:conversation-event', (payload) => {
            handleGatewayConversationEvent(payload);
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
            pluginExecutionEnabled?: boolean;
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
                pluginExecutionEnabled: payload.pluginExecutionEnabled,
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
