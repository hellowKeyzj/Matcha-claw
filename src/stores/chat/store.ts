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
import { buildRuntimeScopeKey, buildSessionRecordKey, findSessionRecordKey, resolveSessionOperationTarget, sameRuntimeEndpointScope } from './session-identity';
import type { RuntimeAddress } from '../../../runtime-host/shared/runtime-address';
import type { RuntimeEndpointSummary } from '../../../runtime-host/shared/runtime-topology';
import { finishChatRunTelemetry } from './telemetry';
import { buildRuntimeErrorDismissMarker } from './runtime-error-view';

function isStaleApprovalResolveError(message: string): boolean {
  return /not found|expired|already resolved|unknown approval|invalid approval/i.test(message);
}

function runtimeEndpointIdFromAddress(runtimeAddress: RuntimeAddress): string {
  return runtimeAddress.kind === 'native-runtime'
    ? runtimeAddress.runtimeInstanceId
    : runtimeAddress.endpointId;
}

function protocolIdFromAddress(runtimeAddress: RuntimeAddress): string | null {
  return runtimeAddress.kind === 'protocol-connector'
    ? runtimeAddress.protocolId
    : null;
}

const SESSION_PROMPT_CAPABILITY_ID = 'session.prompt';

function readSessionPromptAddresses(endpoint: RuntimeEndpointSummary): RuntimeAddress[] {
  return endpoint.capabilityAddresses.filter((address) => address.capabilityId === SESSION_PROMPT_CAPABILITY_ID);
}

function isReadySessionEndpoint(endpoint: RuntimeEndpointSummary): boolean {
  return readSessionPromptAddresses(endpoint).length > 0
    && endpoint.controlState.readiness?.ready !== false;
}

function compareRuntimeEndpointTarget(left: ChatSessionRuntimeEndpointTarget, right: ChatSessionRuntimeEndpointTarget): number {
  return left.endpointId.localeCompare(right.endpointId)
    || left.defaultSessionPromptAddress.agentId.localeCompare(right.defaultSessionPromptAddress.agentId)
    || JSON.stringify(left.defaultSessionPromptAddress).localeCompare(JSON.stringify(right.defaultSessionPromptAddress));
}

function buildSessionRuntimeEndpointTargets(endpoints: RuntimeEndpointSummary[]): ChatSessionRuntimeEndpointTarget[] {
  return endpoints
    .filter(isReadySessionEndpoint)
    .map((endpoint) => {
      const sessionPromptAddresses = readSessionPromptAddresses(endpoint)
        .sort((left, right) => left.agentId.localeCompare(right.agentId) || JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const defaultSessionPromptAddress = sessionPromptAddresses.find((address) => address.agentId === 'main' || address.agentId === 'default')
        ?? sessionPromptAddresses[0]!;
      return {
        endpointId: endpoint.id,
        protocolId: endpoint.protocolId ?? protocolIdFromAddress(defaultSessionPromptAddress) ?? '',
        runtimeAdapterId: endpoint.runtimeAdapterId,
        runtimeInstanceId: endpoint.runtimeInstanceId,
        connectorId: endpoint.connectorId,
        displayName: endpoint.displayName,
        agentIds: [...endpoint.agentIds],
        acceptsDynamicAgents: endpoint.acceptsDynamicAgents,
        sessionPromptAddresses,
        defaultSessionPromptAddress,
      };
    })
    .sort(compareRuntimeEndpointTarget);
}

function matchesCurrentSessionRuntime(
  target: ChatSessionRuntimeEndpointTarget,
  state: ChatStoreState,
): boolean {
  const meta = getSessionMeta(state, state.currentSessionKey);
  return Boolean(meta.runtimeAddress && sameRuntimeEndpointScope(target.defaultSessionPromptAddress, meta.runtimeAddress));
}

function selectDefaultRuntimeAddress(
  targets: ChatSessionRuntimeEndpointTarget[],
  state: ChatStoreState,
): RuntimeAddress | null {
  if (targets.length === 0) {
    return null;
  }
  return targets.find((target) => matchesCurrentSessionRuntime(target, state))?.defaultSessionPromptAddress
    ?? targets.find((target) => target.defaultSessionPromptAddress.agentId === 'main' || target.defaultSessionPromptAddress.agentId === 'default')?.defaultSessionPromptAddress
    ?? targets[0]!.defaultSessionPromptAddress;
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
    currentSessionKey: DEFAULT_SESSION_KEY,
    sessionRuntimeCatalog: {
      status: 'idle',
      error: null,
      endpoints: [],
      defaultRuntimeAddress: null,
    },
    loadedSessions: {},
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
        const defaultRuntimeAddress = selectDefaultRuntimeAddress(targets, get());
        if (!defaultRuntimeAddress) {
          throw new Error('No session runtime endpoint is available');
        }
        set((state) => {
          const currentMeta = getSessionMeta(state, state.currentSessionKey);
          if (currentMeta.runtimeAddress) {
            return {
              sessionRuntimeCatalog: {
                status: 'ready',
                error: null,
                endpoints: targets,
                defaultRuntimeAddress,
              },
            };
          }
          const runtimeAddress = {
            ...defaultRuntimeAddress,
            sessionKey: defaultRuntimeAddress.sessionKey ?? DEFAULT_SESSION_KEY,
          };
          const recordKey = buildSessionRecordKey(runtimeAddress, DEFAULT_SESSION_KEY);
          return {
            sessionRuntimeCatalog: {
              status: 'ready',
              error: null,
              endpoints: targets,
              defaultRuntimeAddress,
            },
            currentSessionKey: recordKey,
            loadedSessions: patchSessionMeta(
              { loadedSessions: state.loadedSessions },
              recordKey,
              {
                backendSessionKey: DEFAULT_SESSION_KEY,
                runtimeScopeKey: buildRuntimeScopeKey(runtimeAddress),
                agentId: runtimeAddress.agentId,
                protocolId: protocolIdFromAddress(runtimeAddress),
                runtimeEndpointId: runtimeEndpointIdFromAddress(runtimeAddress),
                runtimeAddress,
                kind: 'main',
                preferred: true,
                displayName: 'Main',
              },
            ),
          };
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({
          sessionRuntimeCatalog: {
            ...state.sessionRuntimeCatalog,
            status: 'error',
            error: message,
            endpoints: [],
            defaultRuntimeAddress: null,
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
    sendMessage: (text, attachments) => executeStoreSend({
      set,
      get,
      sessionRunCache,
      beginMutating,
      finishMutating,
      text,
      attachments,
    }),
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
        const payload = await hostSessionApprovals({ runtimeAddress: target.runtimeAddress });
        const stateAfterFetch = get();
        const endpointSessionKeys = Object.entries(stateAfterFetch.loadedSessions)
          .filter(([, record]) => record.meta.runtimeAddress && sameRuntimeEndpointScope(record.meta.runtimeAddress, target.runtimeAddress))
          .map(([recordKey]) => recordKey);
        const grouped = groupApprovalsBySession(payload.approvals.flatMap((approval) => {
          const recordKey = findSessionRecordKey(stateAfterFetch, approval.sessionKey, approval.runtimeAddress);
          if (!recordKey) {
            return [];
          }
          return [{
            ...approval,
            sessionKey: recordKey,
            backendSessionKey: approval.sessionKey,
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
    resolveApproval: async (id, decision) => {
      const approvalId = id.trim();
      if (!approvalId) return;
      beginMutating();
      try {
        const approval = Object.values(get().pendingApprovalsBySession)
          .flat()
          .find((item) => item.id === approvalId);
        if (!approval) {
          throw new Error('approval not found');
        }
        await hostSessionResolveApproval({
          id: approvalId,
          sessionKey: approval.backendSessionKey,
          runtimeAddress: approval.runtimeAddress,
          decision,
        });
        set((state) => buildApprovalResolvedPatch({
          state,
          id: approvalId,
          resolvedSessionKey: approval.sessionKey,
          decision,
        }) ?? state);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isStaleApprovalResolveError(message)) {
          set((state) => buildApprovalResolvedPatch({
            state,
            id: approvalId,
            decision: 'deny',
          }) ?? state);
        }
        set({ error: message });
        await get().syncPendingApprovals(get().currentSessionKey);
      } finally {
        finishMutating();
      }
    },
    setSessionRuntimeAddress: (sessionKey, runtimeAddress) => {
      const normalizedSessionKey = sessionKey.trim();
      if (!normalizedSessionKey) {
        return;
      }
      set((state) => ({
        loadedSessions: patchSessionMeta(state, normalizedSessionKey, {
          backendSessionKey: runtimeAddress.sessionKey ?? normalizedSessionKey,
          runtimeScopeKey: buildRuntimeScopeKey(runtimeAddress),
          agentId: runtimeAddress.agentId,
          protocolId: protocolIdFromAddress(runtimeAddress),
          runtimeEndpointId: runtimeEndpointIdFromAddress(runtimeAddress),
          runtimeAddress: {
            ...runtimeAddress,
            sessionKey: runtimeAddress.sessionKey ?? normalizedSessionKey,
          },
        }),
      }));
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
      await state.sendMessage(text);
      return true;
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
