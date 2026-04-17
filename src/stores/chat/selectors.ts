import { type ApprovalItem, type ChatStoreState } from '@/stores/chat';

const EMPTY_APPROVAL_ITEMS: ApprovalItem[] = [];

export function selectSnapshotLayerState(state: ChatStoreState) {
  return {
    messages: state.messages,
    sessions: state.sessions,
    currentSessionKey: state.currentSessionKey,
    sessionLabels: state.sessionLabels,
    sessionLastActivity: state.sessionLastActivity,
    sessionReadyByKey: state.sessionReadyByKey,
  };
}

export function selectRuntimeLayerState(state: ChatStoreState) {
  return {
    sending: state.sending,
    activeRunId: state.activeRunId,
    runPhase: state.runPhase,
    streamingText: state.streamingText,
    streamingMessage: state.streamingMessage,
    streamingTools: state.streamingTools,
    pendingFinal: state.pendingFinal,
    lastUserMessageAt: state.lastUserMessageAt,
    pendingToolImages: state.pendingToolImages,
    approvalStatus: state.approvalStatus,
    pendingApprovalsBySession: state.pendingApprovalsBySession,
    sessionRuntimeByKey: state.sessionRuntimeByKey,
  };
}

export function selectViewLayerState(state: ChatStoreState) {
  return {
    snapshotReady: state.snapshotReady,
    initialLoading: state.initialLoading,
    refreshing: state.refreshing,
    mutating: state.mutating,
    error: state.error,
    showThinking: state.showThinking,
    thinkingLevel: state.thinkingLevel,
  };
}

export function selectChatPageSessionState(state: ChatStoreState) {
  const snapshot = selectSnapshotLayerState(state);
  const currentSessionKey = snapshot.currentSessionKey;
  return {
    messages: snapshot.messages,
    currentSessionKey,
    currentSessionReady: Boolean(snapshot.sessionReadyByKey[currentSessionKey]),
    currentSessionHasActivity: typeof snapshot.sessionLastActivity[currentSessionKey] === 'number',
  };
}

export function selectChatPageViewState(state: ChatStoreState) {
  const view = selectViewLayerState(state);
  return {
    initialLoading: view.initialLoading,
    refreshing: view.refreshing,
    mutating: view.mutating,
    error: view.error,
    showThinking: view.showThinking,
  };
}

export function selectChatPageRuntimeState(state: ChatStoreState) {
  const runtime = selectRuntimeLayerState(state);
  return {
    sending: runtime.sending,
    streamingMessage: runtime.streamingMessage,
    streamingTools: runtime.streamingTools,
    pendingFinal: runtime.pendingFinal,
    lastUserMessageAt: runtime.lastUserMessageAt,
    approvalStatus: runtime.approvalStatus,
    currentPendingApprovals: runtime.pendingApprovalsBySession[state.currentSessionKey] ?? EMPTY_APPROVAL_ITEMS,
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
  const runtime = selectRuntimeLayerState(state);
  const snapshot = selectSnapshotLayerState(state);
  return {
    pendingApprovalsBySession: runtime.pendingApprovalsBySession,
    sessionLabels: snapshot.sessionLabels,
    chatSessions: snapshot.sessions,
  };
}

export function selectSidebarNewSessionAction(state: ChatStoreState) {
  return state.newSession;
}

export function selectChatInputSessionKey(state: ChatStoreState) {
  return state.currentSessionKey;
}

export function selectAgentSessionsPaneState(state: ChatStoreState) {
  const snapshot = selectSnapshotLayerState(state);
  return {
    sessions: snapshot.sessions,
    sessionLabels: snapshot.sessionLabels,
    sessionLastActivity: snapshot.sessionLastActivity,
    currentSessionKey: snapshot.currentSessionKey,
    switchSession: state.switchSession,
    openAgentConversation: state.openAgentConversation,
    newSession: state.newSession,
    deleteSession: state.deleteSession,
  };
}
