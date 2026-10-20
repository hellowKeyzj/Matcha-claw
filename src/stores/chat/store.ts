/**
 * Chat State Store
 * Manages chat messages, sessions, streaming, and thinking state.
 * Communicates with runtime-host session APIs.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { createIdleResourceStatusState } from '@/lib/resource-state';
import { subscribeHostEvent } from '@/lib/host-events';
import { executeComposerSend, executeSessionModelSelection } from './session-initialization';
import { hostSessionApprovals, hostSessionRename, hostSessionResolveApproval } from '@/lib/host-api';
import {
  isRuntimeEndpointDirectoryPending,
  isSessionRuntimeEndpointReady,
  isSessionRuntimeEndpointStarting,
  supportsSessionChat,
  useRuntimeEndpointsStore,
} from '../runtime-endpoints';
import { executeStoreAbortRun } from './abort-handlers';
import {
  buildApprovalResolvedPatch,
  buildSyncPendingApprovalsPatch,
  groupApprovalsBySession,
} from './approval-handlers';
import { createSessionObservation } from './session-observation';
import { executeStoreSend } from './send-handlers';
import {
  executeCleanupEmptySession,
  executeDeleteSession,
  executeForgetAgentSessions,
  executeJumpViewportToLatest,
  executeLoadOlderViewportItems,
  executeLoadSessions,
  executeNewSession,
  executeNewSessionDraft,
  executeNewSessionForScope,
  executeOpenAgentConversation,
  executeReconcileAgentSessionTombstones,
  executeOpenSessionIdentity,
  executeRenameSession,
  executeSelectSessionRuntimeEndpoint,
  executeSetViewportAnchorItemKey,
  executeSwitchSession,
} from './session-actions';
import { reconcileSessionSelectionAfterRuntimeBootstrap } from './session-selection';
import { buildTaskBridgeState, normalizeTaskSessionKey } from './session-helpers';
import {
  EMPTY_SESSION_RUNTIME_GRAPH,
  buildCurrentConversationFromSessionRecord,
  buildSessionRuntimeGraph,
} from './session-runtime-graph';
import { createChatStoreKernel } from './store-kernel';
import {
  DEFAULT_SESSION_KEY,
  type ChatSessionRuntimeEndpointTarget,
  type ChatStoreState,
} from './types';
import { applySessionDelta as applySessionDeltaProjection, getSessionMeta, getSessionProjectionWatermark, getSessionRuntime, patchSessionMeta } from './store-state-helpers';
import { logSessionTrace, summarizeError } from '@/lib/session-trace';
import { reconcileSessionDirectory } from './session-directory';
import { buildRuntimeScopeKey, findSessionRecordKey, resolveSessionOperationTarget, sameRuntimeEndpointScope } from './session-identity';
import {
  assertRuntimeEndpointRef,
  buildSessionIdentityKey,
  type AgentScope,
  type RuntimeEndpointRef,
} from '../../types/desktop/runtime-address';
import type { RuntimeEndpointSummary } from '../../types/runtime-topology';
import { finishChatRunTelemetry } from './telemetry';
import { buildRuntimeErrorDismissMarker } from './runtime-error-view';

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
    .filter((agentId) => supportsSessionChat(endpoint, agentId))
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
  return supportsSessionChat(endpoint, endpoint.defaultAgentId) ? buildAgentScope(endpoint, endpoint.defaultAgentId) : null;
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
    || (left.defaultSessionPromptScope?.agentId ?? '').localeCompare(right.defaultSessionPromptScope?.agentId ?? '')
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
        defaultSessionPromptScope: buildDefaultSessionPromptScope(endpoint),
      };
    })
    .sort(compareRuntimeEndpointTarget);
}

export const useChatStore: UseBoundStore<StoreApi<ChatStoreState>> = create<ChatStoreState>((set, get) => {
  const runtimeKernel = createChatStoreKernel(set);
  const { beginMutating, finishMutating, historyRuntime, sessionRunCache } = runtimeKernel;
  let sessionRuntimeBootstrapSequence = 0;
  let sessionCatalogLoad: Promise<void> | null = null;
  let sessionCatalogDirty = false;
  let sessionCatalogEventCleanup: (() => void) | null = null;
  import.meta.hot?.dispose(() => {
    sessionCatalogEventCleanup?.();
    sessionCatalogDirty = false;
  });
  const approvalSyncRequests = new Map<string, symbol>();
  const sessionObservation = createSessionObservation({
    set, get, historyRuntime, getSendGeneration: sessionRunCache.getSendGeneration,
  });
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
      directoryRevision: 0,
      directoryRevisionByRuntimeScopeKey: {},
      selectedEndpoint: null,
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
    ...sessionObservation,
    applySessionDelta: (delta) => {
      const result = applySessionDeltaProjection({ set, get }, delta);
      if (result.status === 'gap' || result.status === 'epoch-mismatch') {
        void get().resyncSession({ identity: delta.identity, epoch: delta.epoch, seq: delta.seq })
          .catch((error) => {
            console.warn('[session.resync]', summarizeError(error));
            logSessionTrace('session.resync.failed', 'session-resync-boundary', () => summarizeError(error));
          });
      }
      return result;
    },
    bootstrapSessionRuntime: async () => {
      sessionCatalogEventCleanup ??= subscribeHostEvent('sessions:catalog-changed', (payload) => {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'endpoint')) return;
        const endpoint = (payload as { endpoint: unknown }).endpoint;
        try {
          assertRuntimeEndpointRef(endpoint);
        } catch { return; }
        if (endpoint.kind !== 'native-runtime' || endpoint.runtimeAdapterId !== 'matcha-agent'
          || endpoint.runtimeInstanceId !== 'local') return;
        const { sessionRuntimeCatalog, loadSessions } = get();
        if (sessionRuntimeCatalog.status !== 'ready'
          || !sessionRuntimeCatalog.endpoints.some((target) => sameRuntimeEndpointScope(target.endpoint, endpoint))) return;
        void loadSessions().catch((error) => {
          console.warn('[sessions:catalog-changed]', summarizeError(error));
        });
      });
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
        const { status, error, endpoints, revision, revisionByRuntimeScopeKey } = useRuntimeEndpointsStore.getState();
        if (sessionRuntimeBootstrapSequence !== requestSequence) {
          return;
        }
        const endpointSource = status === 'ready' ? endpoints : [];
        const targets = buildSessionRuntimeEndpointTargets(endpointSource);
        if (targets.length === 0) {
          const starting = status === 'loading' || endpoints.some(isSessionRuntimeEndpointStarting);
          const message = status === 'error' && error
            ? error
            : starting
              ? 'Session runtime endpoint is starting'
              : 'No session runtime endpoint is available';
          set((state) => {
            const nextSessionRuntimeCatalog: ChatStoreState['sessionRuntimeCatalog'] = {
              status: starting ? 'loading' : 'error',
              error: starting ? null : message,
              endpoints: targets,
              directoryRevision: revision,
              directoryRevisionByRuntimeScopeKey: revisionByRuntimeScopeKey,
              selectedEndpoint: null,
              defaultSessionPromptScope: null,
            };
            const sessionRuntimeGraph = buildSessionRuntimeGraph(nextSessionRuntimeCatalog, state.loadedSessions);
            return {
              ...reconcileSessionSelectionAfterRuntimeBootstrap(state, nextSessionRuntimeCatalog, sessionRuntimeGraph),
              sessionRuntimeGraph,
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
            directoryRevision: revision,
            directoryRevisionByRuntimeScopeKey: revisionByRuntimeScopeKey,
            selectedEndpoint: null,
            defaultSessionPromptScope: null,
          };
          const sessionRuntimeGraph = buildSessionRuntimeGraph(sessionRuntimeCatalog, state.loadedSessions);
          return {
            ...reconcileSessionSelectionAfterRuntimeBootstrap(state, sessionRuntimeCatalog, sessionRuntimeGraph),
            sessionRuntimeGraph,
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
    loadSessions: () => {
      sessionCatalogDirty = true;
      if (!sessionCatalogLoad) {
        sessionCatalogLoad = Promise.resolve().then(async () => {
          try {
            do {
              sessionCatalogDirty = false;
              await executeLoadSessions(sessionInput);
            } while (sessionCatalogDirty);
          } finally {
            sessionCatalogLoad = null;
          }
        });
      }
      return sessionCatalogLoad;
    },
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
    newSession: async (agentId) => {
      executeNewSessionDraft(sessionInput, agentId);
    },
    newSessionForScope: async (scope) => {
      await executeNewSessionForScope(sessionInput, scope);
    },
    deleteSession: (key) => executeDeleteSession(sessionInput, key),
    forgetAgentSessions: (agentId, endpoint) => {
      executeForgetAgentSessions(sessionInput, agentId, endpoint);
    },
    reconcileAgentSessionTombstones: (agentIds, endpoint) => {
      executeReconcileAgentSessionTombstones(agentIds, endpoint);
    },
    renameSession: (key, label) => executeRenameSession({
      ...sessionInput,
      renameSession: hostSessionRename,
    }, key, label),
    cleanupEmptySession: () => {
      executeCleanupEmptySession(sessionInput);
    },
    loadOlderViewportItems: (sessionKey) => executeLoadOlderViewportItems(sessionInput, sessionKey),
    jumpViewportToLatest: (sessionKey) => executeJumpViewportToLatest(sessionInput, sessionKey),
    setViewportAnchorItemKey: (itemKey, sessionKey) => {
      executeSetViewportAnchorItemKey(sessionInput, itemKey, sessionKey);
    },
    selectSessionModel: (key, selectionId) => executeSessionModelSelection({
      ...sessionInput, subscribe: (listener) => useChatStore.subscribe(listener),
    }, key, selectionId),
    sendMessage: (text, attachments, intent, operationId) => executeComposerSend({
      ...sessionInput,
      subscribe: (listener) => useChatStore.subscribe(listener),
      create: (draft) => executeNewSession(sessionInput, undefined, undefined, draft),
      send: () => executeStoreSend({
        set, get, sessionRunCache, beginMutating, finishMutating, text, attachments, intent, operationId,
      }),
    }, { text, attachments, intent, operationId }),
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
      let identityKey: string | null = null;
      const request = Symbol();
      try {
        const stateBeforeFetch = get();
        const targetSessionKey = normalizeTaskSessionKey(sessionKeyHint, stateBeforeFetch.currentSessionKey);
        const target = resolveSessionOperationTarget(stateBeforeFetch, targetSessionKey);
        if (!target.endpointSessionId) {
          return;
        }
        const targetIdentityKey = buildSessionIdentityKey(target.sessionIdentity);
        identityKey = targetIdentityKey;
        approvalSyncRequests.set(targetIdentityKey, request);
        const recordIdentity = stateBeforeFetch.loadedSessions[targetSessionKey]?.meta.sessionIdentity;
        const approvalsBeforeFetch = stateBeforeFetch.pendingApprovalsBySession[targetSessionKey];
        const watermark = getSessionProjectionWatermark(get, target.sessionIdentity);
        const payload = await hostSessionApprovals({
          sessionIdentity: target.sessionIdentity,
          endpointSessionId: target.endpointSessionId,
        });
        set((state) => {
          const targetRecordKey = findSessionRecordKey(state, target.sessionIdentity);
          if (!targetRecordKey
            || approvalSyncRequests.get(targetIdentityKey) !== request
            || state.loadedSessions[targetRecordKey]?.meta.sessionIdentity !== recordIdentity
            || getSessionMeta(state, targetRecordKey).endpointSessionId !== target.endpointSessionId
            || state.pendingApprovalsBySession[targetRecordKey] !== approvalsBeforeFetch
            || getSessionProjectionWatermark(get, target.sessionIdentity) !== watermark) {
            return state;
          }
          const grouped = groupApprovalsBySession(payload.approvals.flatMap((approval) => (
            buildSessionIdentityKey(approval.sessionIdentity) === targetIdentityKey ? [{
              ...approval,
              sessionKey: targetRecordKey,
              endpointSessionId: target.endpointSessionId,
              allowedDecisions: [...approval.allowedDecisions],
            }] : []
          )));
          return buildSyncPendingApprovalsPatch({ state, grouped, sessionKeys: [targetRecordKey] });
        });
      } catch {
        // ignore
      } finally {
        if (identityKey && approvalSyncRequests.get(identityKey) === request) {
          approvalSyncRequests.delete(identityKey);
        }
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
        return {
          ...(normalizedSessionKey === state.currentSessionKey ? {
            currentConversation: buildCurrentConversationFromSessionRecord(loadedSessions[normalizedSessionKey]!, state.currentConversation),
            sessionRuntimeCatalog,
          } : {}),
          ...reconcileSessionDirectory(state, loadedSessions, [normalizedSessionKey]),
          loadedSessions,
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
