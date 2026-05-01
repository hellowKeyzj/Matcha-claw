/**
 * Chat State Store
 * Manages chat messages, sessions, streaming, and thinking state.
 * Communicates with OpenClaw Gateway via renderer WebSocket RPC.
 */
import { create } from 'zustand';
import { createIdleResourceStatusState } from '@/lib/resource-state';
import { useGatewayStore } from '../gateway';
import { executeStoreAbortRun } from './abort-handlers';
import {
  normalizeApprovalDecision,
  normalizeApprovalTimestampMs,
  parseGatewayApprovalResponse,
  resolveApprovalSessionKey,
} from './approval-helpers';
import {
  buildApprovalRequestedPatch,
  buildApprovalResolvedPatch,
  buildSyncPendingApprovalsPatch,
  groupApprovalsBySession,
} from './approval-handlers';
import { handleStoreConversationEvent } from './event-actions';
import { executeHistoryLoad } from './history-load-execution';
import { CHAT_HISTORY_LOADING_TIMEOUT_MS } from './history-constants';
import { executeStoreSend } from './send-handlers';
import {
  executeCleanupEmptySession,
  executeDeleteSession,
  executeJumpToLatest,
  executeLoadOlderMessages,
  executeLoadSessions,
  executeNewSession,
  executeOpenAgentConversation,
  executeSetViewportLastVisibleMessageId,
  executeSwitchSession,
} from './session-actions';
import { buildTaskInboxBridgeState, normalizeTaskInboxSessionKey } from './session-helpers';
import { createChatStoreKernel } from './store-kernel';
import {
  DEFAULT_CANONICAL_PREFIX,
  DEFAULT_SESSION_KEY,
  type ChatStoreState,
} from './types';
import { createEmptySessionRecord } from './store-state-helpers';
import { finishChatRunTelemetry } from './telemetry';

function isStaleApprovalResolveError(message: string): boolean {
  return /not found|expired|already resolved|unknown approval|invalid approval/i.test(message);
}

export const useChatStore = create<ChatStoreState>((set, get) => {
  const runtimeKernel = createChatStoreKernel(set);
  const { beginMutating, finishMutating, historyRuntime } = runtimeKernel;
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
    newSession: (agentId) => {
      executeNewSession(sessionInput, agentId);
    },
    deleteSession: (key) => executeDeleteSession(sessionInput, key),
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
      }, {
        ...request,
        sessionKey: normalizedSessionKey,
      });
    },
    loadOlderMessages: (sessionKey) => executeLoadOlderMessages(sessionInput, sessionKey),
    jumpToLatest: (sessionKey) => executeJumpToLatest(sessionInput, sessionKey),
    setViewportLastVisibleMessageId: (messageId, sessionKey) => {
      executeSetViewportLastVisibleMessageId(sessionInput, messageId, sessionKey);
    },
    sendMessage: (text, attachments) => executeStoreSend({
      set,
      get,
      beginMutating,
      finishMutating,
      text,
      attachments,
    }),
    abortRun: async () => {
      await executeStoreAbortRun({
        set,
        get,
        onBeginMutating: beginMutating,
        onFinishMutating: finishMutating,
        onAbortedTelemetry: (sessionKey) => {
          finishChatRunTelemetry(sessionKey, 'aborted', { stage: 'abort_action' });
        },
      });
    },
    syncPendingApprovals: async (sessionKeyHint) => {
      try {
        const payload = await useGatewayStore.getState().rpc<unknown>('exec.approvals.get', {});
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
      const id = typeof payload.id === 'string' ? payload.id.trim() : '';
      const sessionKey = resolveApprovalSessionKey(payload);
      if (!id || !sessionKey) return;

      const runId = typeof payload.runId === 'string' ? payload.runId.trim() : undefined;
      const toolName = typeof payload.toolName === 'string' ? payload.toolName.trim() : undefined;
      const createdAtMs = normalizeApprovalTimestampMs(payload.createdAt)
        ?? normalizeApprovalTimestampMs(payload.requestedAt)
        ?? Date.now();
      const expiresAtMs = normalizeApprovalTimestampMs(payload.expiresAt);

      set((state) => buildApprovalRequestedPatch({
        state,
        approval: {
          id,
          sessionKey,
          ...(runId ? { runId } : {}),
          ...(toolName ? { toolName } : {}),
          createdAtMs,
          ...(expiresAtMs ? { expiresAtMs } : {}),
        },
      }));
    },
    handleApprovalResolved: (payload) => {
      const id = typeof payload.id === 'string' ? payload.id.trim() : '';
      if (!id) return;
      set((state) => {
        const patch = buildApprovalResolvedPatch({
          state,
          id,
          resolvedSessionKey: resolveApprovalSessionKey(payload) ?? undefined,
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
        await useGatewayStore.getState().rpc(
          'exec.approval.resolve',
          { id: approvalId, decision },
        );
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
    getTaskInboxBridgeState: () => buildTaskInboxBridgeState(get(), DEFAULT_SESSION_KEY),
    openTaskInboxSession: (sessionKey) => {
      const { currentSessionKey, switchSession } = get();
      const targetSessionKey = normalizeTaskInboxSessionKey(sessionKey, currentSessionKey || DEFAULT_SESSION_KEY);
      if (targetSessionKey !== currentSessionKey) {
        switchSession(targetSessionKey);
      }
      return targetSessionKey;
    },
    sendTaskInboxRecoveryPrompt: async (sessionKey, prompt) => {
      const text = typeof prompt === 'string' ? prompt.trim() : '';
      if (!text) {
        return false;
      }
      const state = get();
      const targetSessionKey = normalizeTaskInboxSessionKey(sessionKey, state.currentSessionKey || DEFAULT_SESSION_KEY);
      const bridge = buildTaskInboxBridgeState(state, DEFAULT_SESSION_KEY);
      if (bridge.sessionKey !== targetSessionKey || !bridge.canSendRecoveryPrompt) {
        return false;
      }
      await state.sendMessage(text);
      return true;
    },
    handleConversationEvent: (event) => {
      handleStoreConversationEvent({ set, get }, event);
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
    clearError: () => set({ error: null }),
  };
});
