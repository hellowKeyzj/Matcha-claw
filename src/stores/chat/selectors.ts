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

export function selectChatPageState(state: ChatStoreState) {
  const snapshot = selectSnapshotLayerState(state);
  const runtime = selectRuntimeLayerState(state);
  const view = selectViewLayerState(state);
  const currentSessionKey = snapshot.currentSessionKey;
  const currentSessionHasActivity = typeof snapshot.sessionLastActivity[currentSessionKey] === 'number';

  return {
    messages: snapshot.messages,
    initialLoading: view.initialLoading,
    refreshing: view.refreshing,
    mutating: view.mutating,
    sending: runtime.sending,
    error: view.error,
    showThinking: view.showThinking,
    streamingMessage: runtime.streamingMessage,
    streamingTools: runtime.streamingTools,
    pendingFinal: runtime.pendingFinal,
    approvalStatus: runtime.approvalStatus,
    currentPendingApprovals: runtime.pendingApprovalsBySession[currentSessionKey] ?? EMPTY_APPROVAL_ITEMS,
    resolveApproval: state.resolveApproval,
    loadHistory: state.loadHistory,
    loadSessions: state.loadSessions,
    switchSession: state.switchSession,
    openAgentConversation: state.openAgentConversation,
    currentSessionKey,
    currentSessionReady: Boolean(snapshot.sessionReadyByKey[currentSessionKey]),
    currentSessionHasActivity,
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
