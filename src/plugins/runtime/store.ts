/**
 * Gateway State Store
 * Uses Host API + SSE for lifecycle/status. Domain runtime calls live behind runtime-host application routes.
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { isTraceEnabled } from '@/lib/trace-logger';
import { waitForCall } from '@/lib/call-log-await';
import { decodeCallReceipt } from '@/types/call-log/receipt';
import { runGatewayRepair, type GatewayRepairOutcome } from '@/lib/gateway-repair';
import { subscribeHostEvent } from '@/lib/host-events';
import type { GatewayStatus } from '@/types/gateway';
import { isGatewayOperational, isGatewayPreparing } from '@/lib/gateway-status';
import type { GatewayTransportIssue } from '@/types/session/runtime-state';

let gatewayInitPromise: Promise<void> | null = null;
let runtimeHostObservationRevision = 0;

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

function preparingRuntimeHostSnapshot(): RuntimeHostStatusSnapshot {
  return {
    status: 'starting',
    updatedAt: Date.now(),
  };
}

const GATEWAY_STATUS_UNAVAILABLE = 'Gateway status is unavailable.';
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
  lifecycleOperation: 'restart' | 'repair' | null;
  repairOutcome: GatewayRepairOutcome | null;
  repair: () => Promise<void>;
  refreshRuntimeHostStatus: () => Promise<void>;
  checkHealth: () => Promise<GatewayHealth>;
  setStatus: (status: GatewayStatus) => void;
  clearError: () => void;
}

async function fetchGatewayStatusSnapshot(): Promise<GatewayStatus> {
  try {
    const status = await hostApiFetch<GatewayStatus>('/api/gateway/status');
    if (isTraceEnabled()) console.info(JSON.stringify({
      prefix: STARTUP_TRACE_PREFIX,
      ...gatewayStartupTraceSummary('gateway-store', 'gateway-status-snapshot-success', status),
    }));
    return status;
  } catch (error) {
    console.warn(JSON.stringify({
      prefix: STARTUP_TRACE_PREFIX,
      ...gatewayStartupTraceSummary('gateway-store', 'gateway-status-snapshot-failed', null),
      ...summarizeStartupTraceError(error),
    }));
    throw error;
  }
}

async function runGatewayLifecycle(operation: 'start' | 'stop' | 'restart'): Promise<string | null> {
  const receipt = decodeCallReceipt(await hostApiFetch<unknown>(`/api/gateway/${operation}`, { method: 'POST' }));
  const call = await waitForCall(receipt, 'runtime-control');
  const { detail } = call;
  if (call.command !== `lifecycle.${operation}`
    || detail.endpoint?.kind !== 'native-runtime'
    || detail.endpoint.runtimeAdapterId !== 'openclaw'
    || detail.endpoint.runtimeInstanceId !== 'local') {
    throw new Error(`Gateway ${operation} call does not match the requested operation and OpenClaw local endpoint`);
  }
  const settled = operation === 'stop'
    ? detail.lifecycle === 'idle' || detail.lifecycle === 'shutDown'
    : detail.lifecycle === 'running';
  if (call.status === 'succeeded' && detail.result === 'succeeded'
    && settled && detail.error === null && detail.failure === null) {
    return null;
  }
  let outcome = 'outcome is unknown. Check Gateway status before retrying';
  if (detail.lifecycle === 'waitingToRestart') {
    outcome = 'was deferred; completion is unknown. Check Gateway status before retrying';
  } else if (call.status !== 'unknown' && detail.result !== 'unknown') {
    if (call.status === 'rejected') {
      outcome = 'was rejected. Check runtime availability before retrying';
    } else if (detail.result === 'unsupported' || detail.error === 'unsupported') {
      outcome = 'is unsupported';
    } else if (detail.result === 'unavailable' || detail.error === 'unavailable') {
      outcome = 'is unavailable. Check runtime availability before retrying';
    } else if (call.status === 'failed' || detail.result === 'failed' || detail.error === 'commandFailed') {
      outcome = 'failed. Check runtime diagnostics before retrying';
    }
  }
  const diagnostics = [detail.lifecycle, detail.failure, detail.startupDiagnostic, detail.error]
    .filter((value) => value !== null).join(', ');
  return `Gateway ${operation} ${outcome}${diagnostics ? ` (${diagnostics})` : ''}`;
}

async function fetchRuntimeHostStatusSnapshot(): Promise<RuntimeHostStatusSnapshot> {
  return await hostApiFetch<RuntimeHostStatusSnapshot>('/api/runtime-host/status');
}

function isGatewayStatusObservationUnavailable(status: GatewayStatus): boolean {
  return status.processState === 'error'
    && status.gatewayReady === false
    && status.healthSummary === 'unresponsive'
    && status.transportState === 'disconnected'
    && status.portReachable === false
    && status.error === GATEWAY_STATUS_UNAVAILABLE;
}

function isCurrentGatewayStatus(current: GatewayStatus, incoming: GatewayStatus): boolean {
  if (isGatewayStatusObservationUnavailable(incoming)) {
    return false;
  }
  if (incoming.updatedAt > current.updatedAt) {
    return true;
  }
  if (incoming.updatedAt !== current.updatedAt) {
    return false;
  }
  return isGatewayPreparing(current, true) && isGatewayOperational(incoming);
}

export const useGatewayStore = create<GatewayState>((set, get) => ({
  status: {
    processState: 'control_connecting',
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
  lifecycleOperation: null,
  repairOutcome: null,

  init: async () => {
    if (get().isInitialized) return;
    if (gatewayInitPromise) {
      await gatewayInitPromise;
      return;
    }

    gatewayInitPromise = (async () => {
      const runtimeHostSnapshotRevision = runtimeHostObservationRevision;
      try {
        const [statusResult, runtimeHostResult] = await Promise.allSettled([
          fetchGatewayStatusSnapshot(),
          fetchRuntimeHostStatusSnapshot(),
        ]);
        const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
        const runtimeHost = runtimeHostResult.status === 'fulfilled'
          ? runtimeHostResult.value
          : preparingRuntimeHostSnapshot();
        set((state) => ({
          ...(status && isCurrentGatewayStatus(state.status, status) ? { status } : {}),
          ...(runtimeHostSnapshotRevision === runtimeHostObservationRevision
            ? { runtimeHost: applyRuntimeHostSnapshot(runtimeHost, state.runtimeHost) }
            : {}),
          isInitialized: true,
          lastError: statusResult.status === 'rejected' ? String(statusResult.reason) : null,
        }));

      } catch (error) {
        set((state) => ({
          lastError: String(error),
          runtimeHost: applyRuntimeHostSnapshot(preparingRuntimeHostSnapshot(), state.runtimeHost),
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
      const error = await runGatewayLifecycle('start');
      if (error) {
        set({ lastError: error });
        return;
      }
      const status = await fetchGatewayStatusSnapshot();
      set((state) => (isCurrentGatewayStatus(state.status, status) ? { status } : {}));
    } catch (error) {
      set({ lastError: String(error) });
    }
  },

  stop: async () => {
    try {
      set({ lastError: null });
      const error = await runGatewayLifecycle('stop');
      if (error) {
        set({ lastError: error });
        return;
      }
      const status = await fetchGatewayStatusSnapshot();
      set((state) => (isCurrentGatewayStatus(state.status, status) ? { status } : {}));
    } catch (error) {
      set({ lastError: String(error) });
    }
  },

  restart: async () => {
    if (get().lifecycleOperation) return;
    set({ lifecycleOperation: 'restart', lastError: null });
    try {
      const error = await runGatewayLifecycle('restart');
      if (error) {
        set({ lastError: error });
        return;
      }
      const status = await fetchGatewayStatusSnapshot();
      set((state) => (isCurrentGatewayStatus(state.status, status) ? { status } : {}));
    } catch (error) {
      set({ lastError: String(error) });
    } finally {
      set({ lifecycleOperation: null });
    }
  },

  repair: async () => {
    if (get().lifecycleOperation) return;
    set({ lifecycleOperation: 'repair', repairOutcome: null });
    try {
      set({ repairOutcome: await runGatewayRepair() });
    } finally {
      set({ lifecycleOperation: null });
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

export function subscribeGatewayState(): () => void {
  const set = useGatewayStore.setState;
  const get = useGatewayStore.getState;
  const unsubscribers: Array<() => void> = [];
  unsubscribers.push(subscribeHostEvent<GatewayStatus>('gateway:status', (payload) => {
    if (isTraceEnabled()) console.info(JSON.stringify({
      prefix: STARTUP_TRACE_PREFIX,
      ...gatewayStartupTraceSummary('gateway-store', 'gateway-status-event', payload),
    }));
    const current = get().status;
    if (!isCurrentGatewayStatus(current, payload)) return;
    set({ status: payload });
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
    runtimeHostObservationRevision += 1;
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
    runtimeHostObservationRevision += 1;
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
    runtimeHostObservationRevision += 1;
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
  return () => { for (const unsubscribe of unsubscribers.reverse()) unsubscribe(); };
}
