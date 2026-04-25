import { type ApprovalItem, type ChatStoreState } from '@/stores/chat';
import { readSessionsFromState } from './session-helpers';
import {
  getPendingApprovals,
  getSessionMeta,
  getSessionRuntime,
  getSessionTranscript,
} from './store-state-helpers';
import { selectStreamingRenderMessage } from './stream-overlay-message';

const EMPTY_APPROVAL_ITEMS: ApprovalItem[] = [];

export function selectCanonicalTranscript(state: ChatStoreState, sessionKey: string) {
  return getSessionTranscript(state, sessionKey);
}

export function selectSessionMeta(state: ChatStoreState, sessionKey: string) {
  return getSessionMeta(state, sessionKey);
}

export function selectSessionRuntime(state: ChatStoreState, sessionKey: string) {
  return getSessionRuntime(state, sessionKey);
}

export function selectSnapshotLayerState(state: ChatStoreState) {
  return {
    sessions: readSessionsFromState(state),
    currentSessionKey: state.currentSessionKey,
  };
}

export function selectViewLayerState(state: ChatStoreState) {
  return {
    snapshotReady: state.snapshotReady,
    initialLoading: state.initialLoading,
    refreshing: state.refreshing,
    sessionsResource: state.sessionsResource,
    mutating: state.mutating,
    error: state.error,
    showThinking: state.showThinking,
  };
}

export function selectChatPageSessionState(state: ChatStoreState) {
  const currentSessionKey = state.currentSessionKey;
  const currentSessionMeta = selectSessionMeta(state, currentSessionKey);
  return {
    canonicalMessages: selectCanonicalTranscript(state, currentSessionKey),
    currentSessionKey,
    currentSessionReady: Boolean(currentSessionMeta.ready),
    currentSessionHasActivity: typeof currentSessionMeta.lastActivityAt === 'number',
    thinkingLevel: currentSessionMeta.thinkingLevel,
  };
}

export function selectChatPageViewState(state: ChatStoreState) {
  const view = selectViewLayerState(state);
  return {
    initialLoading: view.initialLoading,
    refreshing: view.refreshing,
    sessionsResource: view.sessionsResource,
    mutating: view.mutating,
    error: view.error,
    showThinking: view.showThinking,
  };
}

export function selectChatPageRuntimeState(state: ChatStoreState) {
  const runtime = selectSessionRuntime(state, state.currentSessionKey);
  return {
    sending: runtime.sending,
    activeRunId: runtime.activeRunId,
    runPhase: runtime.runPhase,
    pendingUserMessage: runtime.pendingUserMessage?.message ?? null,
    streamingMessage: selectStreamingRenderMessage(runtime),
    assistantOverlay: runtime.assistantOverlay,
    streamingTools: runtime.streamingTools,
    pendingFinal: runtime.pendingFinal,
    lastUserMessageAt: runtime.lastUserMessageAt,
    pendingToolImages: runtime.pendingToolImages,
    approvalStatus: runtime.approvalStatus,
    currentPendingApprovals: getPendingApprovals(state, state.currentSessionKey) ?? EMPTY_APPROVAL_ITEMS,
  };
}

export function selectChatPageActions(state: ChatStoreState) {
  return {
    resolveApproval: state.resolveApproval,
    loadHistory: state.loadHistory,
    loadSessions: state.loadSessions,
    switchSession: state.switchSession,
    openAgentConversation: state.openAgentConversation,
    sendMessage: state.sendMessage,
    abortRun: state.abortRun,
    clearError: state.clearError,
    cleanupEmptySession: state.cleanupEmptySession,
  };
}

export function selectChatToolbarState(state: ChatStoreState) {
  const view = selectViewLayerState(state);
  return {
    refresh: state.refresh,
    initialLoading: view.initialLoading,
    refreshing: view.refreshing,
    showThinking: view.showThinking,
    toggleThinking: state.toggleThinking,
  };
}

export function selectSidebarPendingBlockersState(state: ChatStoreState) {
  return {
    pendingApprovalsBySession: state.pendingApprovalsBySession,
    sessionsByKey: state.sessionsByKey,
    chatSessions: readSessionsFromState(state),
  };
}

export function selectSidebarNewSessionAction(state: ChatStoreState) {
  return state.newSession;
}

export function selectChatInputSessionKey(state: ChatStoreState) {
  return state.currentSessionKey;
}

export function selectAgentSessionsPaneState(state: ChatStoreState) {
  return {
    sessions: readSessionsFromState(state),
    sessionsByKey: state.sessionsByKey,
    sessionsResource: state.sessionsResource,
    currentSessionKey: state.currentSessionKey,
    switchSession: state.switchSession,
    openAgentConversation: state.openAgentConversation,
    newSession: state.newSession,
    deleteSession: state.deleteSession,
  };
}
