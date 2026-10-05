/**
 * Chat State Store
 * Manages chat messages, sessions, streaming, and thinking state.
 * Communicates with runtime-host session APIs.
 */
import { create } from 'zustand';
import { createIdleResourceStatusState } from '@/lib/resource-state';
import { useComposerDraftStore } from '../composer-drafts';
import { hostSessionApprovals, hostSessionRename, hostSessionResolveApproval } from '@/lib/host-api';
import {
  isRuntimeEndpointDirectoryPending,
  isSessionRuntimeEndpointReady,
  isSessionRuntimeEndpointStarting,
  useRuntimeEndpointsStore,
} from '../runtime-endpoints';
import { executeStoreAbortRun } from './abort-handlers';
import {
  buildApprovalResolvedPatch,
  buildSyncPendingApprovalsPatch,
  groupApprovalsBySession,
} from './approval-handlers';
import { executeHistoryLoad } from './history-load-execution';
import { CHAT_HISTORY_FULL_LIMIT, CHAT_HISTORY_LOADING_TIMEOUT_MS } from './history-constants';
import { executeStoreSend } from './send-handlers';
import {
  executeCleanupEmptySession,
  executeDeleteSession,
  executeForgetAgentSessions,
  executeJumpViewportToLatest,
  executeLoadOlderViewportItems,
  executeLoadSessions,
  executeNewSession,
  executeNewSessionForScope,
  executeOpenAgentConversation,
  executeReconcileAgentSessionTombstones,
  executeOpenSessionIdentity,
  executeRenameSession,
  executeSelectSessionRuntimeEndpoint,
  executeSetViewportAnchorItemKey,
  executeSwitchSession,
} from './session-actions';
import { buildTaskBridgeState, normalizeTaskSessionKey } from './session-helpers';
import {
  EMPTY_SESSION_RUNTIME_GRAPH,
  buildCurrentConversationFromSessionRecord,
  buildSessionRuntimeGraph,
  createDraftCurrentConversation,
} from './session-runtime-graph';
import { createChatStoreKernel } from './store-kernel';
import {
  DEFAULT_SESSION_KEY,
  type ChatSessionRuntimeEndpointTarget,
  type ChatStoreState,
} from './types';
import { applySessionView, getSessionMeta, getSessionRuntime, patchSessionMeta } from './store-state-helpers';
import { observeChatSession, releaseChatSession } from '@/services/runtime/session-runtime';
import { buildRuntimeScopeKey, buildSessionIdentityRecordIndex, findSessionRecordKey, resolveSessionOperationTarget, sameRuntimeEndpointScope } from './session-identity';
import {
  buildSessionIdentityKey,
  assertSessionIdentity,
  type SessionIdentity,
  type AgentScope,
  type RuntimeEndpointRef,
} from '../../types/desktop/runtime-address';
import type { RuntimeEndpointSummary } from '../../types/runtime-topology';
import type { SessionView } from '../../types/session/snapshot';
import { finishChatRunTelemetry } from './telemetry';
import { buildRuntimeErrorDismissMarker } from './runtime-error-view';
import { isSessionTraceEnabled, logSessionTrace, summarizeError, summarizeIdentifier, summarizeSessionIdentity } from '@/lib/session-trace';

function isStaleApprovalResolveError(message: string): boolean {
  return /not found|expired|already resolved|unknown approval|invalid approval/i.test(message);
}

function readApprovalResolveOutcome(value: unknown): 'responded' | 'target_rejected' | 'unknown' | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const outcome = (value as { outcome?: unknown }).outcome;
  return outcome === 'responded' || outcome === 'target_rejected' || outcome === 'unknown'
    ? outcome
    : null;
}

function buildAgentScope(endpoint: RuntimeEndpointSummary, agentId: string): AgentScope | null {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return null;
  }
  return {
    kind: 'agent',
    endpoint: endpoint.endpointRef,
    agentId: normalizedAgentId,
  };
}

function readSessionPromptScopes(endpoint: RuntimeEndpointSummary): AgentScope[] {
  const agentIds = new Set([
    endpoint.defaultAgentId,
    ...endpoint.agentIds,
    ...endpoint.agents.map((agent) => agent.agentId),
  ]);
  return [...agentIds]
    .map((agentId) => buildAgentScope(endpoint, agentId))
    .filter((scope): scope is AgentScope => scope != null);
}

function readEndpointCatalogAgents(endpoint: RuntimeEndpointSummary) {
  const agentIds = new Set([
    endpoint.defaultAgentId,
    ...endpoint.agentIds,
    ...endpoint.agents.map((agent) => agent.agentId),
  ]);
  return [...agentIds]
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .map((id) => {
      const endpointAgent = endpoint.agents.find((agent) => agent.agentId === id);
      return {
        id,
        name: endpointAgent?.displayName?.trim() || id,
      };
    });
}

function buildAgentCatalog(endpoint: RuntimeEndpointSummary): ChatSessionRuntimeEndpointTarget['agentCatalog'] {
  const agents = readEndpointCatalogAgents(endpoint);
  return endpoint.capabilityFamilies.some((family) => (
    family.family === 'subagent'
    && family.availability === 'supported'
  ))
    ? { source: 'subagent-management', seedAgents: agents }
    : { source: 'runtime-endpoint', agents };
}

function buildDefaultSessionPromptScope(endpoint: RuntimeEndpointSummary): AgentScope | null {
  return buildAgentScope(endpoint, endpoint.defaultAgentId);
}

function sessionEndpointMeta(endpoint: RuntimeEndpointRef): { protocolId: string | null; runtimeEndpointId: string } {
  switch (endpoint.kind) {
    case 'native-runtime':
      return { protocolId: null, runtimeEndpointId: endpoint.runtimeInstanceId };
    default: {
      const connector = endpoint as RuntimeEndpointRef & {
        protocolId: string;
        endpointId: string;
      };
      return { protocolId: connector.protocolId, runtimeEndpointId: connector.endpointId };
    }
  }
}

function compareRuntimeEndpointTarget(left: ChatSessionRuntimeEndpointTarget, right: ChatSessionRuntimeEndpointTarget): number {
  return left.endpointId.localeCompare(right.endpointId)
    || left.defaultSessionPromptScope.agentId.localeCompare(right.defaultSessionPromptScope.agentId)
    || JSON.stringify(left.defaultSessionPromptScope).localeCompare(JSON.stringify(right.defaultSessionPromptScope));
}

function buildSessionRuntimeEndpointTargets(endpoints: RuntimeEndpointSummary[]): ChatSessionRuntimeEndpointTarget[] {
  return endpoints
    .filter(isSessionRuntimeEndpointReady)
    .map((endpoint) => {
      const sessionPromptScopes = readSessionPromptScopes(endpoint)
        .sort((left, right) => left.agentId.localeCompare(right.agentId) || JSON.stringify(left).localeCompare(JSON.stringify(right)));
      return {
        endpointId: endpoint.id,
        protocolId: endpoint.protocolId,
        endpoint: endpoint.endpointRef,
        runtimeAdapterId: endpoint.runtimeAdapterId,
        runtimeInstanceId: endpoint.runtimeInstanceId,
        connectorId: endpoint.connectorId,
        displayName: endpoint.displayName,
        agentIds: [...endpoint.agentIds],
        acceptsDynamicAgents: endpoint.acceptsDynamicAgents,
        agentCatalog: buildAgentCatalog(endpoint),
        sessionPromptScopes,
        defaultSessionPromptScope: buildDefaultSessionPromptScope(endpoint)!,
      };
    })
    .sort(compareRuntimeEndpointTarget);
}

function matchesCurrentSessionRuntime(
  target: ChatSessionRuntimeEndpointTarget,
  state: ChatStoreState,
): boolean {
  const endpoint = state.currentConversation?.endpoint
    ?? getSessionMeta(state, state.currentSessionKey).sessionIdentity?.endpoint;
  return Boolean(endpoint && sameRuntimeEndpointScope(target.endpoint, endpoint));
}

function selectDefaultSessionPromptScope(
  targets: ChatSessionRuntimeEndpointTarget[],
  state: ChatStoreState,
): AgentScope | null {
  if (targets.length === 0) {
    return null;
  }
  return targets.find((target) => matchesCurrentSessionRuntime(target, state))?.defaultSessionPromptScope
    ?? targets[0]!.defaultSessionPromptScope;
}

function syncSessionRuntimeProjectionAfterHistoryLoad(set: (partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState), replace?: false) => void, sessionKey: string): void {
  set((state) => {
    const sessionRuntimeGraph = buildSessionRuntimeGraph(state.sessionRuntimeCatalog, state.loadedSessions);
    const currentConversation = sessionKey === state.currentSessionKey && state.loadedSessions[sessionKey]
      ? buildCurrentConversationFromSessionRecord(state.loadedSessions[sessionKey]!)
      : state.currentConversation;
    return {
      sessionRuntimeGraph,
      currentConversation,
    };
  });
}

export const useChatStore = create<ChatStoreState>((set, get) => {
  const runtimeKernel = createChatStoreKernel(set);
  const { beginMutating, finishMutating, historyRuntime, sessionRunCache } = runtimeKernel;
  let sessionRuntimeBootstrapSequence = 0;
  const observations = new Map<string, {
    identity: SessionIdentity;
    leaseId: string;
    requestSequence: number;
    request?: Promise<SessionView | null>;
    historyTask?: Promise<void>;
    watermark?: { epoch: number; seq: number };
  }>();
  const releaseObservation = async (identity: SessionIdentity, leaseId: string) => {
    const key = buildSessionIdentityKey(identity);
    if (observations.get(key)?.leaseId === leaseId) observations.delete(key);
    await releaseChatSession({ sessionIdentity: identity, leaseId });
  };
  const observeHistory = (identity: SessionIdentity, options: { timeoutMs?: number; traceId?: string | null }) => {
    const observation = observations.get(buildSessionIdentityKey(identity));
    if (!observation) return Promise.resolve(null);
    if (observation.request) return observation.request;
    const key = buildSessionIdentityKey(identity);
    const recordKey = findSessionRecordKey(get(), identity);
    const generation = recordKey ? sessionRunCache.getSendGeneration(recordKey) : null;
    const requestSequence = ++observation.requestSequence;
    const startedAt = isSessionTraceEnabled() ? performance.now() : null;
    const task = (async () => {
      if (isSessionTraceEnabled()) logSessionTrace('session.observe.request', options.traceId, {
        identity: summarizeSessionIdentity(identity), leaseHash: summarizeIdentifier(observation.leaseId).hash,
        requestSequence, generation, limit: CHAT_HISTORY_FULL_LIMIT,
      });
      let result: Awaited<ReturnType<typeof observeChatSession>>;
      try {
        result = await observeChatSession({ sessionIdentity: identity, leaseId: observation.leaseId, limit: CHAT_HISTORY_FULL_LIMIT }, options);
      } catch (error) {
        if (isSessionTraceEnabled()) logSessionTrace('session.observe.error', options.traceId, {
          identity: summarizeSessionIdentity(identity), leaseHash: summarizeIdentifier(observation.leaseId).hash,
          requestSequence, requestElapsedMs: startedAt === null ? null : performance.now() - startedAt,
          current: observations.get(key) === observation, ...summarizeError(error),
        });
        throw error;
      }
      if ('outcome' in result || observations.get(key) !== observation) {
        if (isSessionTraceEnabled()) logSessionTrace('session.observe.drop', options.traceId, {
          identity: summarizeSessionIdentity(identity), leaseHash: summarizeIdentifier(observation.leaseId).hash,
          requestSequence, requestElapsedMs: startedAt === null ? null : performance.now() - startedAt,
          reason: 'outcome' in result ? 'observation-released' : 'observation-replaced',
        });
        if ('view' in result) await releaseChatSession({ sessionIdentity: identity, leaseId: observation.leaseId });
        return null;
      }
      if (isSessionTraceEnabled()) logSessionTrace('session.observe.response', options.traceId, {
        identity: summarizeSessionIdentity(identity), leaseHash: summarizeIdentifier(observation.leaseId).hash,
        requestSequence, requestElapsedMs: startedAt === null ? null : performance.now() - startedAt,
        epoch: result.view.epoch, seq: result.view.seq, cursor: result.view.cursor,
      });
      return result.view;
    })();
    observation.request = task;
    void task.finally(() => { if (observation.request === task) observation.request = undefined; }).catch(() => undefined);
    return task;
  };
  const refreshObservation = async (identity: SessionIdentity, leaseId: string, cause: 'observe' | 'resync' = 'observe', watermark?: { epoch: number; seq: number }) => {
    const tracing = isSessionTraceEnabled();
    let requestElapsedMs: number | null = null;
    const trace = (stage: string, extra: Record<string, unknown> = {}) => {
      if (isSessionTraceEnabled()) logSessionTrace(stage, 'session-observation-boundary', {
        identity: summarizeSessionIdentity(identity), leaseHash: summarizeIdentifier(leaseId).hash, cause, requestedWatermark: watermark ?? null, requestElapsedMs, ...extra,
      });
    };
    const identityKey = buildSessionIdentityKey(identity);
    const observation = observations.get(identityKey);
    if (!observation || observation.leaseId !== leaseId) { trace('session.observe.drop', { reason: 'lease-not-current' }); return; }
    const requestSequence = ++observation.requestSequence;
    const recordKey = findSessionRecordKey(get(), identity);
    if (!recordKey) { trace('session.observe.drop', { reason: 'record-not-found', requestSequence }); return; }
    const generation = sessionRunCache.getSendGeneration(recordKey);
    const recordIdentity = get().loadedSessions[recordKey]?.meta.sessionIdentity;
    const isCurrent = () => observations.get(identityKey) === observation
      && observation.requestSequence === requestSequence
      && get().loadedSessions[recordKey]?.meta.sessionIdentity === recordIdentity
      && sessionRunCache.getSendGeneration(recordKey) === generation;
    const dropReason = () => observations.get(identityKey) !== observation ? 'observation-replaced'
      : observation.requestSequence !== requestSequence ? 'request-superseded'
      : get().loadedSessions[recordKey]?.meta.sessionIdentity !== recordIdentity ? 'record-identity-changed' : 'send-generation-changed';
    if (isSessionTraceEnabled()) trace('session.observe.request', { requestSequence, generation, recordKey: summarizeIdentifier(recordKey) });
    const requestStartedAt = tracing ? performance.now() : 0;
    try {
      const observationResult = await observeChatSession({ sessionIdentity: identity, leaseId });
      requestElapsedMs = tracing ? performance.now() - requestStartedAt : null;
      if ('outcome' in observationResult) {
        trace('session.observe.drop', { requestSequence, generation, reason: 'observation-released' });
        return;
      }
      const { view } = observationResult;
      trace('session.observe.response', { requestSequence, generation, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
      if (observations.get(identityKey) !== observation) {
        trace('session.observe.drop', { requestSequence, reason: 'observation-replaced', epoch: view.epoch, seq: view.seq, cursor: view.cursor });
        await releaseChatSession({ sessionIdentity: identity, leaseId });
        return;
      }
      if (!isCurrent()) { trace('session.observe.drop', { requestSequence, reason: dropReason(), epoch: view.epoch, seq: view.seq, cursor: view.cursor }); return; }
      const applyStartedAt = tracing ? performance.now() : 0;
      const result = applySessionView({ set, get }, view);
      const applyElapsedMs = tracing ? performance.now() - applyStartedAt : null;
      if (isSessionTraceEnabled()) trace('session.observe.apply', { requestSequence, applyElapsedMs, status: result.status, reason: 'reason' in result ? summarizeIdentifier(result.reason) : null, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
      if ((result.status === 'applied' || result.status === 'duplicate')
        && view.items !== 'unknown' && view.items !== 'unavailable') {
        set((state) => ({ loadedSessions: patchSessionMeta(state, recordKey, { historyStatus: 'ready' }) }));
      }
    } catch (error) {
      if (tracing && requestElapsedMs === null) requestElapsedMs = performance.now() - requestStartedAt;
      if (isSessionTraceEnabled()) trace('session.observe.error', { requestSequence, current: isCurrent(), reason: isCurrent() ? null : dropReason(), ...summarizeError(error) });
      if (!isCurrent()) return;
      if (get().currentSessionKey === recordKey) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  };
  const sessionInput = {
    set,
    get,
    beginMutating,
    finishMutating,
    historyRuntime,
  } as const;

  return {
    currentSessionKey: '',
    currentConversation: null,
    lastSelectedSessionKeyByRuntimeScopeKey: {},
    sessionRuntimeGraph: EMPTY_SESSION_RUNTIME_GRAPH,
    sessionRuntimeCatalog: {
      status: 'idle',
      error: null,
      endpoints: [],
      defaultSessionPromptScope: null,
    },
    sessionCatalogLoadedAtByRuntimeScopeKey: {},
    sessionCatalogLoadedRevisionByRuntimeScopeKey: {},
    loadedSessions: {},
    sessionRecordKeyByIdentityKey: {},
    pendingApprovalsBySession: {},
    dismissedRuntimeErrorBySession: {},
    foregroundHistorySessionKey: null,
    sessionCatalogStatus: createIdleResourceStatusState(),
    mutating: false,
    error: null,
    showThinking: true,
    observeSession: (identity, leaseId = crypto.randomUUID()) => {
      observations.set(buildSessionIdentityKey(identity), { identity, leaseId, requestSequence: 0 });
      if (identity.endpoint.kind !== 'native-runtime' || identity.endpoint.runtimeAdapterId !== 'openclaw') return { leaseId, ready: refreshObservation(identity, leaseId) };
      const recordKey = findSessionRecordKey(get(), identity);
      return { leaseId, ready: recordKey ? get().loadHistory({
        sessionKey: recordKey,
        mode: getSessionMeta(get(), recordKey).historyStatus === 'ready' || get().loadedSessions[recordKey]?.items.length ? 'quiet' : 'active',
        scope: get().currentSessionKey === recordKey ? 'foreground' : 'background',
        reason: 'chat_init_cold_start',
      }) : Promise.resolve() };
    },
    releaseSession: releaseObservation,
    resyncSession: async (event) => {
      const drop = (reason: string) => { if (isSessionTraceEnabled()) logSessionTrace('session.resync.drop', 'session-resync-boundary', { reason }); };
      if (!event || typeof event !== 'object' || Array.isArray(event)) { drop('invalid-event-shape'); return; }
      const value = event as Record<string, unknown>;
      if (Object.keys(value).length !== 3
        || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1
        || !Number.isSafeInteger(value.seq) || (value.seq as number) < 0) { drop('invalid-watermark'); return; }
      try {
        assertSessionIdentity(value.identity);
      } catch {
        drop('invalid-identity');
        return;
      }
      const observation = observations.get(buildSessionIdentityKey(value.identity));
      if (isSessionTraceEnabled()) logSessionTrace('session.resync.request', 'session-resync-boundary', {
        identity: summarizeSessionIdentity(value.identity), epoch: value.epoch, seq: value.seq,
        accepted: !!observation, reason: observation ? null : 'no-active-observation',
      });
      if (observation?.identity.endpoint.kind === 'native-runtime' && observation.identity.endpoint.runtimeAdapterId === 'openclaw') {
        const key = buildSessionIdentityKey(observation.identity);
        const covered = () => observation.watermark && (observation.watermark.epoch > (value.epoch as number)
          || observation.watermark.epoch === value.epoch && observation.watermark.seq >= (value.seq as number));
        if (observations.get(key) !== observation || covered()) return;
        const recordKey = findSessionRecordKey(get(), observation.identity);
        if (!recordKey) return;
        // Let the existing history apply finish before a later frontier supersedes it.
        while (observation.historyTask) {
          await observation.historyTask;
          if (observations.get(key) !== observation || covered()) return;
        }
        if (observations.get(key) !== observation || covered()) return;
        await get().loadHistory({ sessionKey: recordKey, mode: 'quiet',
          scope: get().currentSessionKey === recordKey ? 'foreground' : 'background', reason: 'session_resync' });
      } else if (observation) await refreshObservation(observation.identity, observation.leaseId, 'resync', { epoch: value.epoch as number, seq: value.seq as number });
    },
    bootstrapSessionRuntime: async () => {
      const requestSequence = sessionRuntimeBootstrapSequence + 1;
      sessionRuntimeBootstrapSequence = requestSequence;
      set((state) => ({
        sessionRuntimeCatalog: {
          ...state.sessionRuntimeCatalog,
          status: state.sessionRuntimeCatalog.endpoints.length > 0 ? state.sessionRuntimeCatalog.status : 'loading',
          error: null,
        },
      }));
      try {
        useRuntimeEndpointsStore.getState().init();
        await useRuntimeEndpointsStore.getState().refresh();
        const { status, error, endpoints } = useRuntimeEndpointsStore.getState();
        if (sessionRuntimeBootstrapSequence !== requestSequence) {
          return;
        }
        const stateBeforeCatalogUpdate = get();
        const endpointSource = status === 'ready' ? endpoints : [];
        const targets = buildSessionRuntimeEndpointTargets(endpointSource);
        const defaultSessionPromptScope = selectDefaultSessionPromptScope(targets, stateBeforeCatalogUpdate);
        if (!defaultSessionPromptScope) {
          const starting = status === 'loading' || endpoints.some(isSessionRuntimeEndpointStarting);
          const message = status === 'error' && error
            ? error
            : starting
              ? 'Session runtime endpoint is starting'
              : 'No session runtime endpoint is available';
          set((state) => {
            const hasExistingConversation = state.currentConversation != null;
            const nextSessionRuntimeCatalog: ChatStoreState['sessionRuntimeCatalog'] = {
              status: starting ? 'loading' : 'error',
              error: starting ? null : message,
              endpoints: targets,
              defaultSessionPromptScope: null,
            };
            return {
              currentConversation: hasExistingConversation ? state.currentConversation : null,
              sessionRuntimeGraph: buildSessionRuntimeGraph(nextSessionRuntimeCatalog, state.loadedSessions),
              sessionRuntimeCatalog: nextSessionRuntimeCatalog,
              sessionCatalogStatus: createIdleResourceStatusState(),
              error: starting ? null : message,
            };
          });
          return;
        }
        if (sessionRuntimeBootstrapSequence !== requestSequence) {
          return;
        }
        set((state) => {
          const sessionRuntimeCatalog = {
            status: 'ready' as const,
            error: null,
            endpoints: targets,
            defaultSessionPromptScope,
          };
          const sessionRuntimeGraph = buildSessionRuntimeGraph(sessionRuntimeCatalog, state.loadedSessions);
          const currentConversation = state.currentSessionKey && state.loadedSessions[state.currentSessionKey]
            ? buildCurrentConversationFromSessionRecord(state.loadedSessions[state.currentSessionKey]!)
            : createDraftCurrentConversation(defaultSessionPromptScope.endpoint, defaultSessionPromptScope.agentId);
          return {
            currentConversation,
            sessionRuntimeGraph,
            sessionRuntimeCatalog,
          };
        });
      } catch (error) {
        if (sessionRuntimeBootstrapSequence !== requestSequence) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const pending = isRuntimeEndpointDirectoryPending(error);
        set((state) => ({
          sessionRuntimeCatalog: {
            ...state.sessionRuntimeCatalog,
            status: pending ? 'loading' : 'error',
            error: pending ? null : message,
          },
          sessionCatalogStatus: createIdleResourceStatusState(),
          error: pending ? null : message,
        }));
      }
    },
    loadSessions: () => executeLoadSessions(sessionInput),
    openAgentConversation: (agentId, endpoint) => {
      executeOpenAgentConversation(sessionInput, agentId, endpoint);
    },
    openSessionIdentity: (target) => {
      executeOpenSessionIdentity(sessionInput, target);
    },
    switchSession: (key, traceId) => {
      executeSwitchSession(sessionInput, key, traceId);
    },
    selectSessionRuntimeEndpoint: (endpoint) => {
      executeSelectSessionRuntimeEndpoint(sessionInput, endpoint);
    },
    newSession: async (agentId, traceId) => {
      await executeNewSession(sessionInput, agentId, traceId);
    },
    newSessionForScope: async (scope) => {
      await executeNewSessionForScope(sessionInput, scope);
    },
    deleteSession: (key) => executeDeleteSession(sessionInput, key),
    forgetAgentSessions: (agentId) => {
      executeForgetAgentSessions(sessionInput, agentId);
    },
    reconcileAgentSessionTombstones: (agentIds) => {
      executeReconcileAgentSessionTombstones(agentIds);
    },
    renameSession: (key, label) => executeRenameSession({
      ...sessionInput,
      renameSession: hostSessionRename,
    }, key, label),
    cleanupEmptySession: () => {
      executeCleanupEmptySession(sessionInput);
    },
    loadHistory: (request) => {
      const normalizedSessionKey = request.sessionKey.trim();
      if (!normalizedSessionKey) {
        return Promise.resolve();
      }
      const recordIdentity = get().loadedSessions[normalizedSessionKey]?.meta.sessionIdentity;
      const generation = sessionRunCache.getSendGeneration(normalizedSessionKey);
      const isOpenClaw = recordIdentity?.endpoint.kind === 'native-runtime' && recordIdentity.endpoint.runtimeAdapterId === 'openclaw';
      const observation = isOpenClaw ? observations.get(buildSessionIdentityKey(recordIdentity)) : undefined;
      if (isOpenClaw && !observation && request.reason === 'same_session_refresh') return Promise.resolve();
      if (observation?.historyTask) return observation.historyTask;
      const task = executeHistoryLoad({
        set,
        get,
        historyRuntime,
        loadingTimeoutMs: CHAT_HISTORY_LOADING_TIMEOUT_MS,
        ...(observation ? {
          observeHistory,
          isObservationCurrent: () => observations.get(buildSessionIdentityKey(recordIdentity!)) === observation
            && sessionRunCache.getSendGeneration(normalizedSessionKey) === generation,
          onObservedViewApplied: (view: SessionView) => {
            if (observations.get(buildSessionIdentityKey(view.identity)) === observation) observation.watermark = { epoch: view.epoch, seq: view.seq };
          },
        } : {}),
      }, {
        ...request,
        sessionKey: normalizedSessionKey,
      });
      if (observation) {
        observation.historyTask = task;
        void task.finally(() => { if (observation.historyTask === task) observation.historyTask = undefined; }).catch(() => undefined);
      }
      historyRuntime.setHistoryLoadInFlight(normalizedSessionKey, task);
      void task.then(
        () => {
          historyRuntime.clearHistoryLoadInFlight(normalizedSessionKey, task);
          if (get().loadedSessions[normalizedSessionKey]?.meta.sessionIdentity === recordIdentity) {
            syncSessionRuntimeProjectionAfterHistoryLoad(set, normalizedSessionKey);
          }
        },
        () => historyRuntime.clearHistoryLoadInFlight(normalizedSessionKey, task),
      );
      return task;
    },
    loadOlderViewportItems: (sessionKey) => executeLoadOlderViewportItems(sessionInput, sessionKey),
    jumpViewportToLatest: (sessionKey) => executeJumpViewportToLatest(sessionInput, sessionKey),
    setViewportAnchorItemKey: (itemKey, sessionKey) => {
      executeSetViewportAnchorItemKey(sessionInput, itemKey, sessionKey);
    },
    sendMessage: async (text, attachments, intent, operationId) => {
      const conversation = get().currentConversation;
      if (conversation?.kind === 'draft') {
        const draftKey = `${conversation.runtimeScopeKey}:agent:${conversation.agentId}:draft`;
        const mode = intent ? useComposerDraftStore.getState().modes[draftKey] : null;
        const created = await executeNewSession(sessionInput, undefined, undefined, mode ? { key: draftKey, modeId: mode.id } : undefined);
        const createdIdentity = created ? get().loadedSessions[created.sessionRecordKey]?.meta.sessionIdentity : null;
        if (!created || get().currentSessionKey !== created.sessionRecordKey || !createdIdentity
          || buildSessionIdentityKey(createdIdentity) !== buildSessionIdentityKey(created.sessionIdentity)) {
          return { accepted: false, reason: 'missing-session', error: 'Conversation changed or session creation failed',
            ...(intent && created ? { sessionRecordKey: created.sessionRecordKey } : {}) };
        }
      }
      if (!get().currentSessionKey) {
        const error = get().error ?? 'Session runtime is not ready';
        return { accepted: false, reason: 'missing-session', error };
      }
      const sessionRecordKey = get().currentSessionKey;
      const result = await executeStoreSend({
        set,
        get,
        sessionRunCache,
        beginMutating,
        finishMutating,
        text,
        attachments,
        intent,
        operationId,
      });
      return intent ? { ...result, sessionRecordKey } : result;
    },
    abortRun: async () => {
      await executeStoreAbortRun({
        set,
        get,
        sessionRunCache,
        onBeginMutating: beginMutating,
        onFinishMutating: finishMutating,
        onAbortedTelemetry: (sessionKey) => {
          finishChatRunTelemetry(sessionKey, 'aborted', { stage: 'abort_action' });
        },
      });
    },
    syncPendingApprovals: async (sessionKeyHint) => {
      try {
        const targetSessionKey = normalizeTaskSessionKey(sessionKeyHint, get().currentSessionKey);
        const target = resolveSessionOperationTarget(get(), targetSessionKey);
        if (!target.endpointSessionId) {
          return;
        }
        const payload = await hostSessionApprovals({
          sessionIdentity: target.sessionIdentity,
          endpointSessionId: target.endpointSessionId,
        });
        const stateAfterFetch = get();
        const targetRecordKey = findSessionRecordKey(stateAfterFetch, target.sessionIdentity) ?? targetSessionKey;
        const grouped = groupApprovalsBySession(payload.approvals.flatMap((approval) => {
          const recordKey = findSessionRecordKey(stateAfterFetch, approval.sessionIdentity);
          if (!recordKey) {
            return [];
          }
          const meta = getSessionMeta(stateAfterFetch, recordKey);
          return [{
            ...approval,
            sessionKey: recordKey,
            endpointSessionId: meta.endpointSessionId ?? undefined,
            allowedDecisions: [...approval.allowedDecisions],
          }];
        }));
        set((state) => buildSyncPendingApprovalsPatch({
          state,
          grouped,
          sessionKeys: [targetRecordKey],
        }));
      } catch {
        // ignore
      }
    },
    resolveApproval: async (approval, decision) => {
      const approvalId = approval.id.trim();
      if (!approvalId) return;
      beginMutating();
      try {
        const pendingApproval = (get().pendingApprovalsBySession[approval.sessionKey] ?? [])
          .find((item) => item.id === approvalId
            && buildSessionIdentityKey(item.sessionIdentity) === buildSessionIdentityKey(approval.sessionIdentity));
        if (!pendingApproval) {
          return;
        }
        const endpointSessionId = pendingApproval.endpointSessionId;
        if (!endpointSessionId) {
          return;
        }
        const outcome = readApprovalResolveOutcome(await hostSessionResolveApproval({
          id: approvalId,
          endpointSessionId,
          sessionIdentity: pendingApproval.sessionIdentity,
          decision,
          ...(pendingApproval.request ? { request: pendingApproval.request } : {}),
        }));
        if (outcome !== 'responded') {
          if (outcome === 'target_rejected') {
            set({ error: 'approval target rejected' });
          }
          return;
        }
        set((state) => buildApprovalResolvedPatch({
          state,
          id: approvalId,
          resolvedSessionKey: pendingApproval.sessionKey,
          decision,
        }) ?? state);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isStaleApprovalResolveError(message)) {
          set((state) => buildApprovalResolvedPatch({
            state,
            id: approvalId,
            resolvedSessionKey: approval.sessionKey,
            decision: 'deny',
          }) ?? state);
        }
        set({ error: message });
        await get().syncPendingApprovals(approval.sessionKey || get().currentSessionKey);
      } finally {
        finishMutating();
      }
    },
    setSessionIdentity: (sessionKey, identity) => {
      const normalizedSessionKey = sessionKey.trim();
      if (!normalizedSessionKey) {
        return;
      }
      const sessionIdentity = {
        ...identity,
        sessionKey: identity.sessionKey || normalizedSessionKey,
      };
      set((state) => {
        const endpoint = sessionIdentity.endpoint as RuntimeEndpointRef;
        const endpointMeta = sessionEndpointMeta(endpoint);
        const loadedSessions = patchSessionMeta(state, normalizedSessionKey, {
          runtimeScopeKey: buildRuntimeScopeKey(endpoint),
          agentId: sessionIdentity.agentId,
          ...endpointMeta,
          sessionIdentity,
        });
        const runtimeTarget = state.sessionRuntimeCatalog.status === 'ready'
          ? state.sessionRuntimeCatalog.endpoints.find((target) => sameRuntimeEndpointScope(target.endpoint, endpoint)) ?? null
          : null;
        const sessionRuntimeCatalog = runtimeTarget
          ? {
              ...state.sessionRuntimeCatalog,
              defaultSessionPromptScope: runtimeTarget.defaultSessionPromptScope,
            }
          : state.sessionRuntimeCatalog;
        const sessionRuntimeGraph = buildSessionRuntimeGraph(sessionRuntimeCatalog, loadedSessions);
        return {
          ...(normalizedSessionKey === state.currentSessionKey ? {
            currentConversation: buildCurrentConversationFromSessionRecord(loadedSessions[normalizedSessionKey]!),
            sessionRuntimeCatalog,
          } : {}),
          sessionRuntimeGraph,
          loadedSessions,
          sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
        };
      });
    },
    getTaskBridgeState: () => buildTaskBridgeState(get(), DEFAULT_SESSION_KEY),
    openTaskSession: (sessionKey) => {
      const { currentSessionKey, switchSession } = get();
      const targetSessionKey = normalizeTaskSessionKey(sessionKey, currentSessionKey || DEFAULT_SESSION_KEY);
      if (targetSessionKey !== currentSessionKey) {
        switchSession(targetSessionKey);
      }
      return targetSessionKey;
    },
    sendTaskRecoveryPrompt: async (sessionKey, prompt) => {
      const text = typeof prompt === 'string' ? prompt.trim() : '';
      if (!text) {
        return false;
      }
      const state = get();
      const targetSessionKey = normalizeTaskSessionKey(sessionKey, state.currentSessionKey || DEFAULT_SESSION_KEY);
      const bridge = buildTaskBridgeState(state, DEFAULT_SESSION_KEY);
      if (bridge.sessionKey !== targetSessionKey || !bridge.canSendRecoveryPrompt) {
        return false;
      }
      const result = await state.sendMessage(text);
      return result.accepted;
    },
    toggleThinking: () => set((state) => ({ showThinking: !state.showThinking })),
    refresh: async () => {
      const { loadHistory, loadSessions, currentSessionKey } = get();
      await Promise.all([
        loadHistory({
          sessionKey: currentSessionKey,
          mode: 'active',
          scope: 'foreground',
          reason: 'manual_refresh',
        }),
        loadSessions(),
      ]);
    },
    clearError: () => set((state) => {
      const runtime = getSessionRuntime(state, state.currentSessionKey);
      const marker = buildRuntimeErrorDismissMarker(runtime);
      return {
        error: null,
        dismissedRuntimeErrorBySession: {
          ...state.dismissedRuntimeErrorBySession,
          [state.currentSessionKey]: marker ?? undefined,
        },
      };
    }),
  };
});
