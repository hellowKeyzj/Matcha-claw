import { create } from 'zustand';
import { hostRuntimeEndpointsList } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import { buildRuntimeEndpointKey } from '../types/desktop/runtime-address';
import type { RuntimeEndpointSummary } from '@/types/runtime-topology';

const RUNTIME_ENDPOINT_DIRECTORY_PENDING_MESSAGE = 'runtime endpoint directory is unavailable';
const RUNTIME_ENDPOINT_DIRECTORY_PENDING_PROXY_CODES = new Set(['TIMEOUT', 'ABORTED', 'UNAVAILABLE']);
const RUNTIME_ENDPOINT_EVENT_REFRESH_DELAY_MS = 120;
const STARTUP_TRACE_PREFIX = '[startup-trace]';

type RuntimeEndpointCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

type RuntimeReadinessEvent = Readonly<{
  ready?: unknown;
  processState?: unknown;
  status?: unknown;
  hostLifecycle?: unknown;
  runtimeLifecycle?: unknown;
}>;

interface RuntimeEndpointsState {
  status: RuntimeEndpointCatalogStatus;
  error: string | null;
  endpoints: RuntimeEndpointSummary[];
  hasLoadedOnce: boolean;
  revision: number;
  changedRuntimeScopeKeys: string[];
  revisionByRuntimeScopeKey: Record<string, number>;
  refresh: () => Promise<void>;
  init: () => void;
}

let runtimeEndpointLoadSequence = 0;
let runtimeEndpointRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let runtimeEndpointEventUnsubscribers: Array<() => void> | null = null;

function summarizeRuntimeEndpointTrace(endpoint: RuntimeEndpointSummary | null | undefined) {
  if (!endpoint) return null;
  return {
    id: endpoint.id,
    runtimeAdapterId: endpoint.runtimeAdapterId,
    runtimeInstanceId: endpoint.runtimeInstanceId,
    lifecyclePhase: endpoint.lifecycle.phase,
    lifecycleReady: endpoint.lifecycle.ready,
    lifecycleConnected: endpoint.lifecycle.connected,
    readinessPhase: endpoint.controlState.readiness?.phase,
    readinessReady: endpoint.controlState.readiness?.ready,
    readinessRetryable: endpoint.controlState.readiness?.retryable,
    connectionState: endpoint.controlState.connection?.state,
  };
}

function summarizeRuntimeReadinessTraceEvent(payload: unknown) {
  const event = asRuntimeReadinessEvent(payload);
  return event ? {
    ready: event.ready,
    processState: event.processState,
    status: event.status,
    hostLifecycle: event.hostLifecycle,
    runtimeLifecycle: event.runtimeLifecycle,
  } : null;
}

function summarizeRuntimeEndpointTraceError(error: unknown): { errorName: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    message: message
      .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|private)\/)[^\s"'<>)]*/g, '[path]')
      .replace(/(token|authorization|password|secret|api[-_ ]?key)(["'\s:=]+)[^\s"',}]+/gi, '$1$2[redacted]')
      .slice(0, 200),
  };
}

function traceRuntimeEndpointStore(phase: string, payload: Record<string, unknown>): void {
  console.info(JSON.stringify({
    prefix: STARTUP_TRACE_PREFIX,
    source: 'runtime-endpoints-store',
    phase,
    atMs: Date.now(),
    ...payload,
  }));
}

export function supportsRuntimeEndpointCapabilityFamily(
  endpoint: RuntimeEndpointSummary,
  family: string,
): boolean {
  return endpoint.capabilityFamilies.some((capabilityFamily) => (
    capabilityFamily.family === family
    && capabilityFamily.availability === 'supported'
  ));
}

export function isSessionRuntimeEndpointCandidate(endpoint: RuntimeEndpointSummary): boolean {
  return endpoint.capabilities.chat
    && supportsRuntimeEndpointCapabilityFamily(endpoint, 'session')
    && endpoint.defaultAgentId.trim().length > 0;
}

export function isRuntimeEndpointReady(endpoint: RuntimeEndpointSummary): boolean {
  return endpoint.lifecycle.ready
    && endpoint.controlState.readiness?.ready === true;
}

export function isRuntimeEndpointStarting(endpoint: RuntimeEndpointSummary): boolean {
  const readiness = endpoint.controlState.readiness;
  return endpoint.lifecycle.phase === 'declared'
    || endpoint.lifecycle.phase === 'connecting'
    || endpoint.controlState.connection?.state === 'reconnecting'
    || readiness?.phase === 'starting'
    || readiness?.retryable === true
    || (endpoint.lifecycle.connected && !endpoint.lifecycle.ready);
}

export function isSessionRuntimeEndpointReady(endpoint: RuntimeEndpointSummary): boolean {
  return isSessionRuntimeEndpointCandidate(endpoint)
    && isRuntimeEndpointReady(endpoint);
}

export function isSessionRuntimeEndpointStarting(endpoint: RuntimeEndpointSummary): boolean {
  return isSessionRuntimeEndpointCandidate(endpoint)
    && isRuntimeEndpointStarting(endpoint);
}

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function isRuntimeEndpointDirectoryPending(error: unknown): boolean {
  const code = readErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return (code != null && RUNTIME_ENDPOINT_DIRECTORY_PENDING_PROXY_CODES.has(code))
    || message.toLowerCase().includes(RUNTIME_ENDPOINT_DIRECTORY_PENDING_MESSAGE);
}

export function runtimeEndpointBadgeVariant(endpoint: RuntimeEndpointSummary | null | undefined): 'success' | 'outline' | 'destructive' | 'secondary' {
  if (!endpoint) return 'secondary';
  if (isRuntimeEndpointReady(endpoint)) return 'success';
  if (isRuntimeEndpointStarting(endpoint)) return 'outline';
  if (endpoint.lifecycle.phase === 'unavailable' || endpoint.lifecycle.phase === 'disconnected') return 'destructive';
  return 'secondary';
}

export function runtimeEndpointStatusLabel(endpoint: RuntimeEndpointSummary | null | undefined): string {
  if (!endpoint) return 'unknown';
  if (isRuntimeEndpointReady(endpoint)) return 'running';
  if (isRuntimeEndpointStarting(endpoint)) return 'starting';
  return endpoint.lifecycle.phase;
}

function asRuntimeReadinessEvent(payload: unknown): RuntimeReadinessEvent | null {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as RuntimeReadinessEvent
    : null;
}

function isRuntimeEndpointRefreshEvent(payload: unknown): boolean {
  const event = asRuntimeReadinessEvent(payload);
  return event != null
    && (event.ready === true
      || event.processState === 'running'
      || event.status === 'running'
      || event.status === 'degraded'
      || event.hostLifecycle === 'running'
      || event.runtimeLifecycle === 'running');
}

function scheduleRuntimeEndpointRefresh(refresh: () => Promise<void>): void {
  if (runtimeEndpointRefreshTimer != null) {
    return;
  }
  runtimeEndpointRefreshTimer = setTimeout(() => {
    runtimeEndpointRefreshTimer = null;
    void refresh();
  }, RUNTIME_ENDPOINT_EVENT_REFRESH_DELAY_MS);
}

function runtimeEndpointScopeKey(endpoint: RuntimeEndpointSummary): string {
  return buildRuntimeEndpointKey(endpoint.endpointRef);
}

function runtimeEndpointFingerprint(endpoint: RuntimeEndpointSummary): string {
  return JSON.stringify(endpoint);
}

function runtimeEndpointFingerprintByScopeKey(endpoints: readonly RuntimeEndpointSummary[]): Map<string, string> {
  return new Map(endpoints.map((endpoint) => [runtimeEndpointScopeKey(endpoint), runtimeEndpointFingerprint(endpoint)]));
}

function changedRuntimeEndpointScopeKeys(
  previousEndpoints: readonly RuntimeEndpointSummary[],
  nextEndpoints: readonly RuntimeEndpointSummary[],
): string[] {
  const previous = runtimeEndpointFingerprintByScopeKey(previousEndpoints);
  const next = runtimeEndpointFingerprintByScopeKey(nextEndpoints);
  const changed = new Set<string>();
  for (const [scopeKey, fingerprint] of next) {
    if (previous.get(scopeKey) !== fingerprint) {
      changed.add(scopeKey);
    }
  }
  for (const scopeKey of previous.keys()) {
    if (!next.has(scopeKey)) {
      changed.add(scopeKey);
    }
  }
  return [...changed].sort();
}

function bumpRuntimeEndpointRevisions(
  previous: Record<string, number>,
  changedRuntimeScopeKeys: readonly string[],
): Record<string, number> {
  if (changedRuntimeScopeKeys.length === 0) {
    return previous;
  }
  const next = { ...previous };
  for (const scopeKey of changedRuntimeScopeKeys) {
    next[scopeKey] = (next[scopeKey] ?? 0) + 1;
  }
  return next;
}

export function findRuntimeEndpointByAdapter(
  endpoints: readonly RuntimeEndpointSummary[],
  runtimeAdapterId: string,
): RuntimeEndpointSummary | null {
  return endpoints.find((endpoint) => endpoint.runtimeAdapterId === runtimeAdapterId) ?? null;
}

export const useRuntimeEndpointsStore = create<RuntimeEndpointsState>((set, get) => ({
  status: 'idle',
  error: null,
  endpoints: [],
  hasLoadedOnce: false,
  revision: 0,
  changedRuntimeScopeKeys: [],
  revisionByRuntimeScopeKey: {},

  refresh: async () => {
    const requestSequence = runtimeEndpointLoadSequence + 1;
    const startedAtMs = Date.now();
    runtimeEndpointLoadSequence = requestSequence;
    traceRuntimeEndpointStore('runtime-endpoints-list-start', {
      sequence: requestSequence,
      hasLoadedOnce: get().hasLoadedOnce,
    });
    set((state) => ({
      status: state.hasLoadedOnce ? state.status : 'loading',
      error: null,
      changedRuntimeScopeKeys: [],
    }));
    try {
      const { endpoints } = await hostRuntimeEndpointsList();
      const durationMs = Date.now() - startedAtMs;
      traceRuntimeEndpointStore('runtime-endpoints-list-success', {
        sequence: requestSequence,
        durationMs,
        endpointCount: endpoints.length,
        openClaw: summarizeRuntimeEndpointTrace(findRuntimeEndpointByAdapter(endpoints, 'openclaw')),
        matchaAgent: summarizeRuntimeEndpointTrace(findRuntimeEndpointByAdapter(endpoints, 'matcha-agent')),
      });
      if (runtimeEndpointLoadSequence !== requestSequence) {
        traceRuntimeEndpointStore('runtime-endpoints-list-stale', {
          sequence: requestSequence,
          currentSequence: runtimeEndpointLoadSequence,
          durationMs,
        });
        return;
      }
      set((state) => {
        const changedRuntimeScopeKeys = changedRuntimeEndpointScopeKeys(state.endpoints, endpoints);
        return {
          status: 'ready',
          error: null,
          endpoints: [...endpoints],
          hasLoadedOnce: true,
          revision: changedRuntimeScopeKeys.length > 0 ? state.revision + 1 : state.revision,
          changedRuntimeScopeKeys,
          revisionByRuntimeScopeKey: bumpRuntimeEndpointRevisions(state.revisionByRuntimeScopeKey, changedRuntimeScopeKeys),
        };
      });
    } catch (error) {
      if (runtimeEndpointLoadSequence !== requestSequence) {
        traceRuntimeEndpointStore('runtime-endpoints-list-stale-error', {
          sequence: requestSequence,
          currentSequence: runtimeEndpointLoadSequence,
          durationMs: Date.now() - startedAtMs,
          ...summarizeRuntimeEndpointTraceError(error),
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const pending = isRuntimeEndpointDirectoryPending(error);
      traceRuntimeEndpointStore('runtime-endpoints-list-error', {
        sequence: requestSequence,
        durationMs: Date.now() - startedAtMs,
        pending,
        ...summarizeRuntimeEndpointTraceError(error),
      });
      set((state) => {
        const nextEndpoints = pending ? state.endpoints : [];
        const changedRuntimeScopeKeys = pending ? [] : changedRuntimeEndpointScopeKeys(state.endpoints, nextEndpoints);
        return {
          status: pending ? 'loading' : 'error',
          error: pending ? null : message,
          endpoints: nextEndpoints,
          hasLoadedOnce: state.hasLoadedOnce,
          revision: changedRuntimeScopeKeys.length > 0 ? state.revision + 1 : state.revision,
          changedRuntimeScopeKeys,
          revisionByRuntimeScopeKey: bumpRuntimeEndpointRevisions(state.revisionByRuntimeScopeKey, changedRuntimeScopeKeys),
        };
      });
    }
  },

  init: () => {
    if (runtimeEndpointEventUnsubscribers) {
      return;
    }
    const refresh = get().refresh;
    const handleRuntimeEvent = (payload: unknown) => {
      const refreshable = isRuntimeEndpointRefreshEvent(payload);
      traceRuntimeEndpointStore('runtime-endpoints-refresh-event', {
        refreshable,
        event: summarizeRuntimeReadinessTraceEvent(payload),
      });
      if (refreshable) {
        scheduleRuntimeEndpointRefresh(refresh);
      }
    };
    runtimeEndpointEventUnsubscribers = [
      subscribeHostEvent('matcha-agent:status', handleRuntimeEvent),
      subscribeHostEvent('gateway:status', handleRuntimeEvent),
      subscribeHostEvent('runtime-host:status', handleRuntimeEvent),
      subscribeHostEvent('runtime-host:restart', handleRuntimeEvent),
    ];
  },
}));
