import type { ChatSession, ChatStoreState } from './types';
import { readSessionCatalogStatusShell, readSessionsFromState, resolveSessionListLabel } from './session-helpers';
import {
  getSessionMeta,
  getSessionMessages,
  getSessionRuntime,
} from './store-state-helpers';
import type { ChatSessionHistoryStatus } from './types';

const EMPTY_AGENT_PANE_SESSION_ENTRIES: AgentSessionsPaneSessionEntry[] = [];

export interface AgentSessionsPaneSessionEntry {
  session: ChatSession;
  title: string | null;
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
    const title = normalizeAgentPaneSessionLabel(resolveSessionListLabel(state, session.key, session.label ?? null));
    const lastActivityAt = typeof meta?.lastActivityAt === 'number' ? meta.lastActivityAt : null;
    const historyStatus = meta?.historyStatus ?? 'idle';
    const previousEntry = cachedAgentPaneSessionEntryByKey.get(session.key);
    const nextEntry = previousEntry
      && previousEntry.session === session
      && previousEntry.title === title
      && previousEntry.lastActivityAt === lastActivityAt
      && previousEntry.historyStatus === historyStatus
      ? previousEntry
      : {
          session,
          title,
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
  const sessionCatalogStatus = readSessionCatalogStatusShell(state);
  return {
    sessionEntries,
    ...sessionCatalogStatus,
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
  const sessionCatalogStatus = readSessionCatalogStatusShell(state);
  return {
    foregroundHistorySessionKey: state.foregroundHistorySessionKey,
    ...sessionCatalogStatus,
    mutating: state.mutating,
    error: state.error,
    showThinking: state.showThinking,
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

export function selectAgentSessionsPaneState(state: ChatStoreState) {
  const sessionEntries = buildAgentPaneSessionEntries(state);
  const sessionCatalogStatus = readSessionCatalogStatusShell(state);
  if (
    cachedAgentSessionsPaneState
    && cachedAgentSessionsPaneState.sessionEntries === sessionEntries
    && cachedAgentSessionsPaneState.sessionsLoading === sessionCatalogStatus.sessionsLoading
    && cachedAgentSessionsPaneState.sessionsLoadedOnce === sessionCatalogStatus.sessionsLoadedOnce
    && cachedAgentSessionsPaneState.sessionsError === sessionCatalogStatus.sessionsError
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
