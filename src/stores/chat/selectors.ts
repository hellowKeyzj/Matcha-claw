import { type ApprovalItem, type ChatSession, type ChatStoreState } from '@/stores/chat';
import { readSessionsFromState } from './session-helpers';
import {
  getPendingApprovals,
  getSessionMeta,
  getSessionRuntime,
  getSessionTranscript,
} from './store-state-helpers';
import { selectStreamingRenderMessage } from './stream-overlay-message';

const EMPTY_APPROVAL_ITEMS: ApprovalItem[] = [];
const EMPTY_AGENT_PANE_SESSION_ENTRIES: AgentSessionsPaneSessionEntry[] = [];

export interface AgentSessionsPaneSessionEntry {
  session: ChatSession;
  label: string | null;
  lastActivityAt: number | null;
  ready: boolean;
}

let cachedAgentPaneSessionEntries: AgentSessionsPaneSessionEntry[] = [];
let cachedAgentPaneSessionEntryByKey = new Map<string, AgentSessionsPaneSessionEntry>();
let cachedAgentSessionsPaneState: ReturnType<typeof buildAgentSessionsPaneState> | null = null;
let cachedLiveThreadHostKeys: string[] = [];

function normalizeAgentPaneSessionLabel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildAgentPaneSessionEntries(state: ChatStoreState): AgentSessionsPaneSessionEntry[] {
  const sessions = readSessionsFromState(state);
  if (sessions.length === 0) {
    cachedAgentPaneSessionEntries = EMPTY_AGENT_PANE_SESSION_ENTRIES;
    cachedAgentPaneSessionEntryByKey = new Map();
    return cachedAgentPaneSessionEntries;
  }

  const nextEntries: AgentSessionsPaneSessionEntry[] = new Array(sessions.length);
  const nextEntryByKey = new Map<string, AgentSessionsPaneSessionEntry>();
  let changed = cachedAgentPaneSessionEntries.length !== sessions.length;

  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    const meta = state.sessionsByKey[session.key]?.meta;
    const label = normalizeAgentPaneSessionLabel(meta?.label);
    const lastActivityAt = typeof meta?.lastActivityAt === 'number' ? meta.lastActivityAt : null;
    const ready = Boolean(meta?.ready);
    const previousEntry = cachedAgentPaneSessionEntryByKey.get(session.key);
    const nextEntry = previousEntry
      && previousEntry.session === session
      && previousEntry.label === label
      && previousEntry.lastActivityAt === lastActivityAt
      && previousEntry.ready === ready
      ? previousEntry
      : {
          session,
          label,
          lastActivityAt,
          ready,
        };
    nextEntries[index] = nextEntry;
    nextEntryByKey.set(session.key, nextEntry);
    if (cachedAgentPaneSessionEntries[index] !== nextEntry) {
      changed = true;
    }
  }

  if (!changed) {
    return cachedAgentPaneSessionEntries;
  }

  cachedAgentPaneSessionEntries = nextEntries;
  cachedAgentPaneSessionEntryByKey = nextEntryByKey;
  return cachedAgentPaneSessionEntries;
}

function buildAgentSessionsPaneState(state: ChatStoreState, sessionEntries: AgentSessionsPaneSessionEntry[]) {
  return {
    sessionEntries,
    sessionsResource: state.sessionsResource,
    currentSessionKey: state.currentSessionKey,
    switchSession: state.switchSession,
    openAgentConversation: state.openAgentConversation,
    newSession: state.newSession,
    deleteSession: state.deleteSession,
  };
}

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
  const sessionEntries = buildAgentPaneSessionEntries(state);
  if (
    cachedAgentSessionsPaneState
    && cachedAgentSessionsPaneState.sessionEntries === sessionEntries
    && cachedAgentSessionsPaneState.sessionsResource === state.sessionsResource
    && cachedAgentSessionsPaneState.currentSessionKey === state.currentSessionKey
    && cachedAgentSessionsPaneState.switchSession === state.switchSession
    && cachedAgentSessionsPaneState.openAgentConversation === state.openAgentConversation
    && cachedAgentSessionsPaneState.newSession === state.newSession
    && cachedAgentSessionsPaneState.deleteSession === state.deleteSession
  ) {
    return cachedAgentSessionsPaneState;
  }
  cachedAgentSessionsPaneState = buildAgentSessionsPaneState(state, sessionEntries);
  return cachedAgentSessionsPaneState;
}

export function selectChatLiveThreadHostKeys(state: ChatStoreState): string[] {
  const currentSessionKey = state.currentSessionKey;
  const nextSessionKeys = [currentSessionKey];

  for (const session of readSessionsFromState(state)) {
    const sessionKey = session.key;
    if (!sessionKey || sessionKey === currentSessionKey) {
      continue;
    }
    const record = state.sessionsByKey[sessionKey];
    if (!record) {
      continue;
    }
    if (record.meta.ready || record.transcript.length > 0) {
      nextSessionKeys.push(sessionKey);
    }
  }

  if (
    cachedLiveThreadHostKeys.length === nextSessionKeys.length
    && cachedLiveThreadHostKeys.every((sessionKey, index) => sessionKey === nextSessionKeys[index])
  ) {
    return cachedLiveThreadHostKeys;
  }

  cachedLiveThreadHostKeys = nextSessionKeys;
  return cachedLiveThreadHostKeys;
}
