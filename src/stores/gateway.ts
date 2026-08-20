/**
 * Gateway State Store
 * Uses Host API + SSE for lifecycle/status. Domain runtime calls live behind runtime-host application routes.
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import type { TaskSnapshotEvent } from '../types/session/task-snapshot';
import { decodeSessionDelta } from '../types/session/snapshot';
import type { GatewayStatus } from '../types/gateway';
import { applySessionDelta } from './chat/store-state-helpers';
import { useChatStore } from './chat';
import { useTaskSnapshotStore } from './chat/task-snapshot-store';
import { useChannelsStore } from './channels';
import { isGatewayOperational, isGatewayPreparing } from '@/lib/gateway-status';
import { decodeGatewayChannelStatusUpdates } from '@/lib/channel-status';
import type { GatewayTransportIssue } from '../types/session/runtime-state';
import {
  createSessionTraceId,
  logSessionTrace,
  summarizeIdentifier,
} from '@/lib/session-trace';

let gatewayInitPromise: Promise<void> | null = null;
let gatewayEventUnsubscribers: Array<() => void> | null = null;

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
  | 'stopping'
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

interface RuntimeHostStatusSnapshot {
  status: RuntimeHostObservedStatus;
  hostLifecycle?: string;
  runtimeLifecycle?: string;
  pid?: number;
  activePluginCount?: number;
  enabledPluginIds?: string[];
  error?: string;
  updatedAt?: number;
}

function applyRuntimeHostSnapshot(
  snapshot: RuntimeHostStatusSnapshot,
  previous: RuntimeHostObservedState,
): RuntimeHostObservedState {
  return {
    lifecycle: snapshot.status,
    hostLifecycle: snapshot.hostLifecycle,
    runtimeLifecycle: snapshot.runtimeLifecycle,
    pid: snapshot.pid,
    activePluginCount: snapshot.activePluginCount,
    enabledPluginIds: snapshot.enabledPluginIds ?? previous.enabledPluginIds,
    error: snapshot.status === 'running' || snapshot.status === 'restarting' || snapshot.status === 'starting' || snapshot.status === 'stopping'
      ? undefined
      : snapshot.error,
    restartCount: previous.restartCount,
    lastRestartAt: previous.lastRestartAt,
    updatedAt: snapshot.updatedAt ?? Date.now(),
  };
}

function unavailableRuntimeHostSnapshot(): RuntimeHostStatusSnapshot {
  return {
    status: 'error',
    error: 'Runtime Host status is unavailable.',
    updatedAt: Date.now(),
  };
}

const STARTUP_TRACE_PREFIX = '[startup-trace]';
const STARTUP_TRACE_MESSAGE_LIMIT = 200;

function sanitizeStartupTraceMessage(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|private)\/)[^\s"'<>)]*/g, '[path]')
    .replace(/(token|authorization|password|secret|api[-_ ]?key)(["'\s:=]+)[^\s"',}]+/gi, '$1$2[redacted]')
    .slice(0, STARTUP_TRACE_MESSAGE_LIMIT);
}

function summarizeStartupTraceError(error: unknown): { errorName: string; message: string } {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    message: sanitizeStartupTraceMessage(error instanceof Error ? error.message : String(error)),
  };
}

function gatewayStartupTraceSummary(source: string, phase: string, status: GatewayStatus | null) {
  return {
    source,
    phase,
    processState: status?.processState,
    gatewayReady: status?.gatewayReady,
    healthSummary: status?.healthSummary,
    transportState: status?.transportState,
  };
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
  refreshRuntimeHostStatus: () => Promise<void>;
  checkHealth: () => Promise<GatewayHealth>;
  setStatus: (status: GatewayStatus) => void;
  clearError: () => void;
}

async function fetchGatewayStatusSnapshot(): Promise<GatewayStatus> {
  try {
    const status = await hostApiFetch<GatewayStatus>('/api/gateway/status');
    console.info(JSON.stringify({
      prefix: STARTUP_TRACE_PREFIX,
      ...gatewayStartupTraceSummary('gateway-store', 'gateway-status-snapshot-success', status),
    }));
    return status;
  } catch (error) {
    console.warn(STARTUP_TRACE_PREFIX, {
      ...gatewayStartupTraceSummary('gateway-store', 'gateway-status-snapshot-failed', null),
      ...summarizeStartupTraceError(error),
    });
    throw error;
  }
}

async function fetchRuntimeHostStatusSnapshot(): Promise<RuntimeHostStatusSnapshot> {
  return await hostApiFetch<RuntimeHostStatusSnapshot>('/api/runtime-host/status');
}

function isCurrentGatewayStatus(current: GatewayStatus, incoming: GatewayStatus): boolean {
  if (incoming.updatedAt > current.updatedAt) {
    return true;
  }
  if (incoming.updatedAt !== current.updatedAt) {
    return false;
  }
  return isGatewayPreparing(current, true) && isGatewayOperational(incoming);
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
    updatedAt: 0,
  },
  health: null,
  runtimeHost: {
    lifecycle: 'starting',
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
        if (!gatewayEventUnsubscribers) {
          const unsubscribers: Array<() => void> = [];
          unsubscribers.push(subscribeHostEvent<GatewayStatus>('gateway:status', (payload) => {
            console.info(JSON.stringify({
              prefix: STARTUP_TRACE_PREFIX,
              ...gatewayStartupTraceSummary('gateway-store', 'gateway-status-event', payload),
            }));
            const current = get().status;
            if (!isCurrentGatewayStatus(current, payload)) return;
            const prevOperational = isGatewayOperational(current);
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
          unsubscribers.push(subscribeHostEvent<unknown>('session.delta', (payload) => {
            const traceId = createSessionTraceId('session.delta-boundary');
            logSessionTrace('session.delta.received', traceId, {
              payloadType: payload && typeof payload === 'object' ? 'object' : typeof payload,
            });
            let delta;
            try {
              delta = decodeSessionDelta(payload);
            } catch (error) {
              logSessionTrace('session.delta.decode', traceId, {
                decoded: false,
                errorName: error instanceof Error ? error.name : typeof error,
              });
              return;
            }
            const before = useChatStore.getState().loadedSessions[delta.sessionKey];
            logSessionTrace('session.delta.decode', traceId, {
              decoded: true,
              sessionKey: summarizeIdentifier(delta.sessionKey),
              epoch: delta.epoch,
              seq: delta.seq,
              cursor: delta.cursor,
              previousEpoch: before ? null : undefined,
              previousSeq: before ? null : undefined,
              previousCursor: before ? null : undefined,
              changeKinds: delta.changes.map((change) => change.kind),
              runtimePhase: before?.runtime.runPhase ?? null,
              activeRunId: summarizeIdentifier(before?.runtime.activeRunId),
            });
            const applyResult = applySessionDelta({
              set: useChatStore.setState,
              get: useChatStore.getState,
            }, delta);
            logSessionTrace('session.delta.apply', traceId, {
              status: applyResult.status,
              reason: 'reason' in applyResult ? applyResult.reason : null,
              sessionKey: summarizeIdentifier(delta.sessionKey),
              epoch: delta.epoch,
              seq: delta.seq,
              cursor: delta.cursor,
              changeKinds: delta.changes.map((change) => change.kind),
              runtimePhase: useChatStore.getState().loadedSessions[delta.sessionKey]?.runtime.runPhase ?? null,
              activeRunId: summarizeIdentifier(useChatStore.getState().loadedSessions[delta.sessionKey]?.runtime.activeRunId),
            });
          }));
          unsubscribers.push(subscribeHostEvent<TaskSnapshotEvent>(
            'task:snapshot',
            (payload) => {
              useTaskSnapshotStore.getState().reportTaskCenterSnapshot(payload);
            },
          ));
          unsubscribers.push(subscribeHostEvent<unknown>(
            'gateway:channel-status',
            (payload) => {
              const updates = decodeGatewayChannelStatusUpdates(payload);
              if (updates.length === 0) return;
              const state = useChannelsStore.getState();
              for (const update of updates) {
                const channel = state.channels.find((item) => item.type === update.channelId);
                if (channel) {
                  state.updateChannel(channel.id, { status: update.status });
                }
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
                error: payload.status === 'running' || payload.status === 'restarting' || payload.status === 'starting' || payload.status === 'stopping'
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
          gatewayEventUnsubscribers = unsubscribers;
        }
        const [statusResult, runtimeHostResult] = await Promise.allSettled([
          fetchGatewayStatusSnapshot(),
          fetchRuntimeHostStatusSnapshot(),
        ]);
        const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
        const runtimeHost = runtimeHostResult.status === 'fulfilled'
          ? runtimeHostResult.value
          : unavailableRuntimeHostSnapshot();
        set((state) => ({
          ...(status && isCurrentGatewayStatus(state.status, status) ? { status } : {}),
          runtimeHost: applyRuntimeHostSnapshot(runtimeHost, state.runtimeHost),
          isInitialized: true,
          lastError: statusResult.status === 'rejected' ? String(statusResult.reason) : null,
        }));

        if (status && isGatewayOperational(status)) {
          syncPendingApprovalsFromChatStore();
        }
      } catch (error) {
        set((state) => ({
          lastError: String(error),
          runtimeHost: applyRuntimeHostSnapshot(unavailableRuntimeHostSnapshot(), state.runtimeHost),
          isInitialized: true,
        }));
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

  refreshRuntimeHostStatus: async () => {
    const runtimeHost = await fetchRuntimeHostStatusSnapshot();
    set((state) => ({
      runtimeHost: applyRuntimeHostSnapshot(runtimeHost, state.runtimeHost),
    }));
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

export const useRuntimeHostStore = useGatewayStore;
