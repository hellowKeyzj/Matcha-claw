import { create } from 'zustand';
import { hostRuntimeEndpointsList } from '@/lib/host-api';
import { isTraceEnabled } from '@/lib/trace-logger';
import { subscribeHostEvent } from '@/lib/host-events';
import { agentScope, buildRuntimeEndpointKey, runtimeEndpointsEqual, type AgentScope, type RuntimeEndpointRef } from '../types/desktop/runtime-address';
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
  managementEndpoint: RuntimeEndpointRef | null;
  selectManagementEndpoint: (endpoint: RuntimeEndpointRef) => void;
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
    && supportsRuntimeEndpointCapabilityFamily(endpoint, 'session');
}

export function supportsSessionChat(endpoint: RuntimeEndpointSummary, agentId: string): boolean {
  if (!isSessionRuntimeEndpointCandidate(endpoint) || !agentId) return false;
  const agent = endpoint.agents.find((entry) => entry.agentId === agentId);
  return agent ? agent.capabilities.chat === true : endpoint.acceptsDynamicAgents;
}

export function supportsSessionGoal(endpoints: readonly RuntimeEndpointSummary[], endpoint: RuntimeEndpointRef | null, agentId: string): boolean {
  const runtime = endpoint ? endpoints.find((entry) => runtimeEndpointsEqual(entry.endpointRef, endpoint)) : undefined;
  if (!runtime?.capabilities.supportsGoal || !agentId
    || runtime.endpointRef.kind !== 'native-runtime' || runtime.endpointRef.runtimeAdapterId !== 'openclaw') return false;
  const agent = runtime.agents.find((agent) => agent.agentId === agentId);
  return agent ? agent.capabilities.supportsGoal : runtime.acceptsDynamicAgents;
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
    && (typeof event.ready === 'boolean'
      || typeof event.processState === 'string'
      || typeof event.status === 'string'
      || typeof event.hostLifecycle === 'string'
      || typeof event.runtimeLifecycle === 'string');
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

export function selectManagementRuntime(state: RuntimeEndpointsState): RuntimeEndpointSummary | null {
  const endpoint = state.managementEndpoint;
  if (endpoint) {
    const selected = state.endpoints.find((entry) => runtimeEndpointsEqual(entry.endpointRef, endpoint));
    if (selected) return selected;
  }
  const ready = state.endpoints.filter(isRuntimeEndpointReady);
  if (ready.length > 0) return findRuntimeEndpointByAdapter(ready, 'openclaw') ?? ready[0];
  const starting = state.endpoints.filter(isRuntimeEndpointStarting);
  return findRuntimeEndpointByAdapter(starting, 'openclaw') ?? starting[0]
    ?? findRuntimeEndpointByAdapter(state.endpoints, 'openclaw') ?? state.endpoints[0] ?? null;
}

let managementEndpoint: RuntimeEndpointRef | null = null;

export function selectManagementEndpoint(state: RuntimeEndpointsState): RuntimeEndpointRef | null {
  const endpoint = selectManagementRuntime(state)?.endpointRef ?? null;
  if (!managementEndpoint || !endpoint || !runtimeEndpointsEqual(managementEndpoint, endpoint)) managementEndpoint = endpoint;
  return managementEndpoint;
}

let managementAgentRuntime: RuntimeEndpointSummary | null = null;
let managementAgentScope: AgentScope | null = null;

export function selectManagementAgentScope(state: RuntimeEndpointsState): AgentScope | null {
  const runtime = selectManagementRuntime(state);
  if (managementAgentRuntime !== runtime) {
    managementAgentRuntime = runtime;
    const agent = runtime?.agents.find((entry) => entry.agentId === runtime.defaultAgentId)
      ?? runtime?.agents[0];
    const endpoint = selectManagementEndpoint(state);
    if (!endpoint || !agent) managementAgentScope = null;
    else if (!managementAgentScope || managementAgentScope.agentId !== agent.agentId
      || !runtimeEndpointsEqual(managementAgentScope.endpoint, endpoint)) {
      managementAgentScope = agentScope(endpoint, agent.agentId);
    }
  }
  return managementAgentScope;
}

export const useRuntimeEndpointsStore = create<RuntimeEndpointsState>((set, get) => ({
  status: 'idle',
  error: null,
  endpoints: [],
  hasLoadedOnce: false,
  revision: 0,
  changedRuntimeScopeKeys: [],
  revisionByRuntimeScopeKey: {},
  managementEndpoint: null,
  selectManagementEndpoint: (endpoint) => {
    const state = get();
    const target = state.endpoints.find((entry) => runtimeEndpointsEqual(entry.endpointRef, endpoint));
    if (!target || (state.managementEndpoint && runtimeEndpointsEqual(state.managementEndpoint, target.endpointRef))) return;
    set({ managementEndpoint: target.endpointRef });
  },

  refresh: async () => {
    const requestSequence = runtimeEndpointLoadSequence + 1;
    const startedAtMs = isTraceEnabled() ? Date.now() : 0;
    runtimeEndpointLoadSequence = requestSequence;
    if (isTraceEnabled()) traceRuntimeEndpointStore('runtime-endpoints-list-start', {
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
      const durationMs = isTraceEnabled() ? Date.now() - startedAtMs : 0;
      if (isTraceEnabled()) traceRuntimeEndpointStore('runtime-endpoints-list-success', {
        sequence: requestSequence,
        durationMs,
        endpointCount: endpoints.length,
        openClaw: summarizeRuntimeEndpointTrace(findRuntimeEndpointByAdapter(endpoints, 'openclaw')),
        matchaAgent: summarizeRuntimeEndpointTrace(findRuntimeEndpointByAdapter(endpoints, 'matcha-agent')),
      });
      if (runtimeEndpointLoadSequence !== requestSequence) {
        if (isTraceEnabled()) traceRuntimeEndpointStore('runtime-endpoints-list-stale', {
          sequence: requestSequence,
          currentSequence: runtimeEndpointLoadSequence,
          durationMs,
        });
        return;
      }
      set((state) => {
        const changedRuntimeScopeKeys = changedRuntimeEndpointScopeKeys(state.endpoints, endpoints);
        const managementRuntime = selectManagementRuntime({ ...state, endpoints });
        return {
          managementEndpoint: state.managementEndpoint
            ?? (managementRuntime && isRuntimeEndpointReady(managementRuntime) ? managementRuntime.endpointRef : null),
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
        if (isTraceEnabled()) traceRuntimeEndpointStore('runtime-endpoints-list-stale-error', {
          sequence: requestSequence,
          currentSequence: runtimeEndpointLoadSequence,
          durationMs: Date.now() - startedAtMs,
          ...summarizeRuntimeEndpointTraceError(error),
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const pending = isRuntimeEndpointDirectoryPending(error);
      if (isTraceEnabled()) traceRuntimeEndpointStore('runtime-endpoints-list-error', {
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
      if (isTraceEnabled()) traceRuntimeEndpointStore('runtime-endpoints-refresh-event', {
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
