import { type ApprovalItem, type ChatSession, type ChatStoreState } from '@/stores/chat';
import { resolveSessionLabelFromMessages } from './message-helpers';
import { readSessionsFromState } from './session-helpers';
import {
  getPendingApprovals,
  getSessionMeta,
  getSessionMessages,
  getSessionRuntime,
  getSessionViewportState,
} from './store-state-helpers';
import type { ChatSessionHistoryStatus } from './types';

const EMPTY_APPROVAL_ITEMS: ApprovalItem[] = [];
const EMPTY_AGENT_PANE_SESSION_ENTRIES: AgentSessionsPaneSessionEntry[] = [];

export interface AgentSessionsPaneSessionEntry {
  session: ChatSession;
  label: string | null;
  titlePreview: string | null;
  lastActivityAt: number | null;
  historyStatus: ChatSessionHistoryStatus;
}

let cachedAgentPaneSessionEntries: AgentSessionsPaneSessionEntry[] = [];
let cachedAgentPaneSessionEntryByKey = new Map<string, AgentSessionsPaneSessionEntry>();
let cachedAgentSessionsPaneState: ReturnType<typeof buildAgentSessionsPaneState> | null = null;

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
    const meta = state.loadedSessions[session.key]?.meta;
    const runtime = getSessionRuntime(state, session.key);
    const viewport = getSessionViewportState(state, session.key);
    const label = normalizeAgentPaneSessionLabel(meta?.label);
    const pendingUserPreview = runtime.pendingUserMessage
      ? resolveSessionLabelFromMessages([runtime.pendingUserMessage.message])
      : null;
    const titlePreview = pendingUserPreview
      ?? resolveSessionLabelFromMessages(getSessionMessages(state, session.key))
      ?? resolveSessionLabelFromMessages(viewport.messages);
    const lastActivityAt = typeof meta?.lastActivityAt === 'number' ? meta.lastActivityAt : null;
    const historyStatus = meta?.historyStatus ?? 'idle';
    const previousEntry = cachedAgentPaneSessionEntryByKey.get(session.key);
    const nextEntry = previousEntry
      && previousEntry.session === session
      && previousEntry.label === label
      && previousEntry.titlePreview === titlePreview
      && previousEntry.lastActivityAt === lastActivityAt
      && previousEntry.historyStatus === historyStatus
      ? previousEntry
      : {
          session,
          label,
          titlePreview,
          lastActivityAt,
          historyStatus,
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
    sessionMetasResource: state.sessionMetasResource,
    currentSessionKey: state.currentSessionKey,
    switchSession: state.switchSession,
    openAgentConversation: state.openAgentConversation,
    newSession: state.newSession,
    deleteSession: state.deleteSession,
  };
}

export function selectCanonicalTranscript(state: ChatStoreState, sessionKey: string) {
  return getSessionMessages(state, sessionKey);
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
    foregroundHistorySessionKey: state.foregroundHistorySessionKey,
    sessionMetasResource: state.sessionMetasResource,
    mutating: state.mutating,
    error: state.error,
    showThinking: state.showThinking,
  };
}

export function selectChatPageSessionState(state: ChatStoreState) {
  const currentSessionKey = state.currentSessionKey;
  const currentSessionMeta = selectSessionMeta(state, currentSessionKey);
  const viewportWindow = getSessionViewportState(state, currentSessionKey);
  return {
    viewportMessages: viewportWindow.messages,
    viewport: viewportWindow,
    currentSessionKey,
    currentSessionStatus: currentSessionMeta.historyStatus,
    thinkingLevel: currentSessionMeta.thinkingLevel,
  };
}

export function selectChatPageViewState(state: ChatStoreState) {
  const view = selectViewLayerState(state);
  return {
    foregroundHistorySessionKey: view.foregroundHistorySessionKey,
    sessionMetasResource: view.sessionMetasResource,
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
    streamingMessageId: runtime.streamingMessageId,
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
    loadOlderMessages: state.loadOlderMessages,
    jumpToLatest: state.jumpToLatest,
    trimTopMessages: state.trimTopMessages,
    setViewportLastVisibleMessageId: state.setViewportLastVisibleMessageId,
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
    foregroundHistorySessionKey: view.foregroundHistorySessionKey,
    sessionMetasResource: view.sessionMetasResource,
    showThinking: view.showThinking,
    toggleThinking: state.toggleThinking,
  };
}

export function selectSidebarPendingBlockersState(state: ChatStoreState) {
  return {
    pendingApprovalsBySession: state.pendingApprovalsBySession,
    loadedSessions: state.loadedSessions,
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
    && cachedAgentSessionsPaneState.sessionMetasResource === state.sessionMetasResource
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
