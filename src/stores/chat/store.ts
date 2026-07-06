/**
 * Chat State Store
 * Manages chat messages, sessions, streaming, and thinking state.
 * Communicates with OpenClaw Gateway via renderer WebSocket RPC.
 */
import { create } from 'zustand';
import type { GatewayStatus } from '@/types/gateway';
import { createIdleResourceStatusState } from '@/lib/resource-state';
import { hostRuntimeEndpointsList, hostSessionApprovals, hostSessionRename, hostSessionResolveApproval } from '@/lib/host-api';
import { useGatewayStore } from '../gateway';
import { executeStoreAbortRun } from './abort-handlers';
import {
  buildApprovalResolvedPatch,
  buildSyncPendingApprovalsPatch,
  groupApprovalsBySession,
} from './approval-handlers';
import { handleStoreSessionUpdateEvent } from './event-actions';
import { executeHistoryLoad } from './history-load-execution';
import { CHAT_HISTORY_LOADING_TIMEOUT_MS } from './history-constants';
import { executeStoreSend } from './send-handlers';
import {
  executeCleanupEmptySession,
  executeDeleteSession,
  executeJumpViewportToLatest,
  executeLoadOlderViewportItems,
  executeLoadSessions,
  executeNewSession,
  executeOpenAgentConversation,
  executeOpenSessionIdentity,
  executeRenameSession,
  executeSetViewportAnchorItemKey,
  executeSwitchSession,
} from './session-actions';
import { buildTaskBridgeState, normalizeTaskSessionKey } from './session-helpers';
import { createChatStoreKernel } from './store-kernel';
import {
  DEFAULT_SESSION_KEY,
  type ChatSessionRuntimeEndpointTarget,
  type ChatStoreState,
} from './types';
import { getSessionMeta, getSessionRuntime, patchSessionMeta } from './store-state-helpers';
import { buildRuntimeScopeKey, buildSessionIdentityRecordIndex, findSessionRecordKey, resolveSessionOperationTarget, sameRuntimeEndpointScope } from './session-identity';
import { buildSessionIdentityKey, type AgentScope } from '../../../runtime-host/shared/runtime-address';
import type { RuntimeEndpointSummary } from '../../../runtime-host/shared/runtime-topology';
import { finishChatRunTelemetry } from './telemetry';
import { buildRuntimeErrorDismissMarker } from './runtime-error-view';

function isStaleApprovalResolveError(message: string): boolean {
  return /not found|expired|already resolved|unknown approval|invalid approval/i.test(message);
}

const SESSION_PROMPT_CAPABILITY_ID = 'session.prompt';

function readSessionPromptScopes(endpoint: RuntimeEndpointSummary): AgentScope[] {
  return endpoint.capabilitySummaries
    .filter((capability) => capability.id === SESSION_PROMPT_CAPABILITY_ID && capability.scope.kind === 'agent')
    .map((capability) => capability.scope as AgentScope);
}

function isReadySessionEndpoint(endpoint: RuntimeEndpointSummary): boolean {
  return readSessionPromptScopes(endpoint).length > 0
    && endpoint.controlState.readiness?.ready !== false;
}

function compareRuntimeEndpointTarget(left: ChatSessionRuntimeEndpointTarget, right: ChatSessionRuntimeEndpointTarget): number {
  return left.endpointId.localeCompare(right.endpointId)
    || left.defaultSessionPromptScope.agentId.localeCompare(right.defaultSessionPromptScope.agentId)
    || JSON.stringify(left.defaultSessionPromptScope).localeCompare(JSON.stringify(right.defaultSessionPromptScope));
}

function buildSessionRuntimeEndpointTargets(endpoints: RuntimeEndpointSummary[]): ChatSessionRuntimeEndpointTarget[] {
  return endpoints
    .filter(isReadySessionEndpoint)
    .map((endpoint) => {
      const sessionPromptScopes = readSessionPromptScopes(endpoint)
        .sort((left, right) => left.agentId.localeCompare(right.agentId) || JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const defaultSessionPromptScope = sessionPromptScopes.find((scope) => scope.agentId === 'main' || scope.agentId === 'default')
        ?? sessionPromptScopes[0]!;
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
        sessionPromptScopes,
        defaultSessionPromptScope,
      };
    })
    .sort(compareRuntimeEndpointTarget);
}

function matchesCurrentSessionRuntime(
  target: ChatSessionRuntimeEndpointTarget,
  state: ChatStoreState,
): boolean {
  const identity = getSessionMeta(state, state.currentSessionKey).sessionIdentity;
  return Boolean(identity && sameRuntimeEndpointScope(target.endpoint, identity.endpoint));
}

function selectDefaultSessionPromptScope(
  targets: ChatSessionRuntimeEndpointTarget[],
  state: ChatStoreState,
): AgentScope | null {
  if (targets.length === 0) {
    return null;
  }
  return targets.find((target) => matchesCurrentSessionRuntime(target, state))?.defaultSessionPromptScope
    ?? targets.find((target) => target.defaultSessionPromptScope.agentId === 'main' || target.defaultSessionPromptScope.agentId === 'default')?.defaultSessionPromptScope
    ?? targets[0]!.defaultSessionPromptScope;
}

export const useChatStore = create<ChatStoreState>((set, get) => {
  const runtimeKernel = createChatStoreKernel(set);
  const { beginMutating, finishMutating, historyRuntime, sessionRunCache } = runtimeKernel;
  const sessionInput = {
    set,
    get,
    beginMutating,
    finishMutating,
    defaultSessionKey: DEFAULT_SESSION_KEY,
    historyRuntime,
  } as const;

  return {
    currentSessionKey: '',
    sessionRuntimeCatalog: {
      status: 'idle',
      error: null,
      endpoints: [],
      defaultSessionPromptScope: null,
    },
    loadedSessions: {},
    sessionRecordKeyByIdentityKey: {},
    pendingApprovalsBySession: {},
    dismissedRuntimeErrorBySession: {},
    foregroundHistorySessionKey: null,
    sessionCatalogStatus: createIdleResourceStatusState(),
    mutating: false,
    error: null,
    showThinking: true,
    bootstrapSessionRuntime: async () => {
      set((state) => ({
        sessionRuntimeCatalog: {
          ...state.sessionRuntimeCatalog,
          status: 'loading',
          error: null,
        },
      }));
      try {
        const { endpoints } = await hostRuntimeEndpointsList();
        const targets = buildSessionRuntimeEndpointTargets(endpoints);
        const defaultSessionPromptScope = selectDefaultSessionPromptScope(targets, get());
        if (!defaultSessionPromptScope) {
          throw new Error('No session runtime endpoint is available');
        }
        set({
          sessionRuntimeCatalog: {
            status: 'ready',
            error: null,
            endpoints: targets,
            defaultSessionPromptScope,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({
          sessionRuntimeCatalog: {
            ...state.sessionRuntimeCatalog,
            status: 'error',
            error: message,
            endpoints: [],
            defaultSessionPromptScope: null,
          },
          sessionCatalogStatus: createIdleResourceStatusState(),
          error: message,
        }));
      }
    },
    loadSessions: () => executeLoadSessions(sessionInput),
    openAgentConversation: (agentId) => {
      executeOpenAgentConversation(sessionInput, agentId);
    },
    openSessionIdentity: (target) => {
      executeOpenSessionIdentity(sessionInput, target);
    },
    switchSession: (key) => {
      executeSwitchSession(sessionInput, key);
    },
    newSession: async (agentId) => {
      await executeNewSession(sessionInput, agentId);
    },
    deleteSession: (key) => executeDeleteSession(sessionInput, key),
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
      const task = executeHistoryLoad({
        set,
        get,
        historyRuntime,
        loadingTimeoutMs: CHAT_HISTORY_LOADING_TIMEOUT_MS,
        getGatewayStatus: (): GatewayStatus => useGatewayStore.getState().status,
      }, {
        ...request,
        sessionKey: normalizedSessionKey,
      });
      historyRuntime.setHistoryLoadInFlight(normalizedSessionKey, task);
      void task.then(
        () => historyRuntime.clearHistoryLoadInFlight(normalizedSessionKey, task),
        () => historyRuntime.clearHistoryLoadInFlight(normalizedSessionKey, task),
      );
      return task;
    },
    loadOlderViewportItems: (sessionKey) => executeLoadOlderViewportItems(sessionInput, sessionKey),
    jumpViewportToLatest: (sessionKey) => executeJumpViewportToLatest(sessionInput, sessionKey),
    setViewportAnchorItemKey: (itemKey, sessionKey) => {
      executeSetViewportAnchorItemKey(sessionInput, itemKey, sessionKey);
    },
    sendMessage: async (text, attachments) => {
      if (!get().currentSessionKey) {
        await executeNewSession(sessionInput);
        if (!get().currentSessionKey) {
          const error = get().error ?? 'Session runtime is not ready';
          return { accepted: false, reason: 'missing-session', error };
        }
      }
      return executeStoreSend({
        set,
        get,
        sessionRunCache,
        beginMutating,
        finishMutating,
        text,
        attachments,
      });
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
        const payload = await hostSessionApprovals({ sessionIdentity: target.sessionIdentity });
        const stateAfterFetch = get();
        const endpointSessionKeys = Object.entries(stateAfterFetch.loadedSessions)
          .filter(([, record]) => record.meta.sessionIdentity && sameRuntimeEndpointScope(record.meta.sessionIdentity.endpoint, target.sessionIdentity.endpoint))
          .map(([recordKey]) => recordKey);
        const grouped = groupApprovalsBySession(payload.approvals.flatMap((approval) => {
          const recordKey = findSessionRecordKey(stateAfterFetch, approval.sessionIdentity);
          if (!recordKey) {
            return [];
          }
          const meta = getSessionMeta(stateAfterFetch, recordKey);
          return [{
            ...approval,
            sessionKey: recordKey,
            backendSessionKey: approval.sessionKey,
            endpointSessionId: meta.endpointSessionId ?? undefined,
            allowedDecisions: [...approval.allowedDecisions],
          }];
        }));
        set((state) => buildSyncPendingApprovalsPatch({
          state,
          grouped,
          sessionKeys: endpointSessionKeys,
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
          throw new Error('approval not found');
        }
        await hostSessionResolveApproval({
          id: approvalId,
          sessionKey: pendingApproval.backendSessionKey,
          ...(pendingApproval.endpointSessionId ? { endpointSessionId: pendingApproval.endpointSessionId } : {}),
          sessionIdentity: pendingApproval.sessionIdentity,
          decision,
        });
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
        const loadedSessions = patchSessionMeta(state, normalizedSessionKey, {
          backendSessionKey: sessionIdentity.sessionKey,
          runtimeScopeKey: buildRuntimeScopeKey(sessionIdentity.endpoint),
          agentId: sessionIdentity.agentId,
          protocolId: sessionIdentity.endpoint.kind === 'protocol-connector' ? sessionIdentity.endpoint.protocolId : null,
          runtimeEndpointId: sessionIdentity.endpoint.kind === 'native-runtime'
            ? sessionIdentity.endpoint.runtimeInstanceId
            : sessionIdentity.endpoint.endpointId,
          sessionIdentity,
        });
        return {
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
    handleSessionUpdateEvent: (event) => {
      handleStoreSessionUpdateEvent({ set, get }, event);
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
