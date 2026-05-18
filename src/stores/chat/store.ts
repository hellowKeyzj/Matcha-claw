/**
 * Chat State Store
 * Manages chat messages, sessions, streaming, and thinking state.
 * Communicates with OpenClaw Gateway via renderer WebSocket RPC.
 */
import { create } from 'zustand';
import type { GatewayStatus } from '@/types/gateway';
import { createIdleResourceStatusState } from '@/lib/resource-state';
import { hostSessionApprovals, hostSessionRename, hostSessionResolveApproval } from '@/lib/host-api';
import { useGatewayStore } from '../gateway';
import { executeStoreAbortRun } from './abort-handlers';
import {
  normalizeApprovalDecision,
  parseGatewayApprovalResponse,
  resolveApprovalSessionKey,
} from './approval-helpers';
import {
  buildApprovalRequestedPatch,
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
  DEFAULT_CANONICAL_PREFIX,
  DEFAULT_SESSION_KEY,
  type ChatStoreState,
} from './types';
import { createEmptySessionRecord, getSessionRuntime } from './store-state-helpers';
import { finishChatRunTelemetry } from './telemetry';
import { buildRuntimeErrorDismissMarker } from './runtime-error-view';

function isStaleApprovalResolveError(message: string): boolean {
  return /not found|expired|already resolved|unknown approval|invalid approval/i.test(message);
}

export const useChatStore = create<ChatStoreState>((set, get) => {
  const runtimeKernel = createChatStoreKernel(set);
  const { beginMutating, finishMutating, historyRuntime, sessionRunCache } = runtimeKernel;
  const sessionInput = {
    set,
    get,
    beginMutating,
    finishMutating,
    defaultCanonicalPrefix: DEFAULT_CANONICAL_PREFIX,
    defaultSessionKey: DEFAULT_SESSION_KEY,
    historyRuntime,
  } as const;

  return {
    currentSessionKey: DEFAULT_SESSION_KEY,
    loadedSessions: {
      [DEFAULT_SESSION_KEY]: createEmptySessionRecord(),
    },
    pendingApprovalsBySession: {},
    dismissedRuntimeErrorBySession: {},
    foregroundHistorySessionKey: null,
    sessionCatalogStatus: createIdleResourceStatusState(),
    mutating: false,
    error: null,
    showThinking: true,
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
      return executeHistoryLoad({
        set,
        get,
        historyRuntime,
        loadingTimeoutMs: CHAT_HISTORY_LOADING_TIMEOUT_MS,
        getGatewayStatus: (): GatewayStatus => useGatewayStore.getState().status,
      }, {
        ...request,
        sessionKey: normalizedSessionKey,
      });
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
        const payload = await hostSessionApprovals();
        const parsed = parseGatewayApprovalResponse(payload);
        if (!parsed.recognized) return;

        const grouped = groupApprovalsBySession(parsed.items);
        set((state) => buildSyncPendingApprovalsPatch({
          state,
          grouped,
          sessionKeyHint,
        }));
      } catch {
        // ignore
      }
    },
    handleApprovalRequested: (payload) => {
      const parsed = parseGatewayApprovalResponse(payload);
      const approval = parsed.items[0];
      if (!approval) return;

      set((state) => buildApprovalRequestedPatch({ state, approval }));
    },
    handleApprovalResolved: (payload) => {
      const id = typeof payload.id === 'string' ? payload.id.trim() : '';
      if (!id) return;
      set((state) => {
        const patch = buildApprovalResolvedPatch({
          state,
          id,
          resolvedSessionKey: resolveApprovalSessionKey(payload),
          decision: normalizeApprovalDecision(payload.decision),
        });
        return patch ?? state;
      });
    },
    resolveApproval: async (id, decision) => {
      const approvalId = id.trim();
      if (!approvalId) return;
      beginMutating();
      try {
        await hostSessionResolveApproval({ id: approvalId, decision });
        get().handleApprovalResolved({
          id: approvalId,
          decision,
          sessionKey: get().currentSessionKey,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isStaleApprovalResolveError(message)) {
          get().handleApprovalResolved({
            id: approvalId,
            decision: 'deny',
            sessionKey: get().currentSessionKey,
          });
        }
        set({ error: message });
        await get().syncPendingApprovals(get().currentSessionKey);
      } finally {
        finishMutating();
      }
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
