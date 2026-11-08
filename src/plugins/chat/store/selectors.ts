import { shallow } from 'zustand/vanilla/shallow';
import { isDeletableSession, isRunActive, type ChatSession, type ChatSessionImageGenerationRuntimeState, type ChatSessionRuntimeEndpointNode, type ChatSessionRuntimeEndpointTarget, type ChatStoreState } from '@/plugins/chat/store/types';
import { agentScope, sessionIdentitiesEqual, type AgentScope, type SessionIdentity } from '@/types/desktop/runtime-address';
let selectedAgentConversation: ChatStoreState['currentConversation'] = null;
let selectedAgentScope: AgentScope | null = null;

export function selectRuntimeEndpoint(state: ChatStoreState) {
  return state.currentConversation?.endpoint ?? state.sessionRuntimeCatalog.selectedEndpoint;
}

export function selectRuntimeAgentScope(state: ChatStoreState) {
  const conversation = state.currentConversation;
  if (selectedAgentConversation !== conversation) {
    selectedAgentConversation = conversation;
    selectedAgentScope = conversation ? agentScope(conversation.endpoint, conversation.agentId) : null;
  }
  return selectedAgentScope;
}
import {
  deriveSessionImageGenerationPendingStateFromItems,
} from '@/types/session/render-item';
import { readSessionCatalogStatusShell } from '@/plugins/chat/store/session-helpers';
import { readSessionsFromState, readSessionTitlesFromState } from '@/plugins/chat/session-catalog';
import {
  getSessionMeta,
  getSessionRuntime,
  getSessionItems,
  getSessionItemCount,
} from '@/plugins/chat/store/store-state-helpers';
import type { ChatSessionRecord } from '@/plugins/chat/store/types';
import {
  areCurrentChatSendGateSourcesEquivalent,
  deriveChatSendGate,
  readCurrentChatSendGateSource,
  type CurrentChatSendGateSource,
} from '@/plugins/chat/store/send-gate';

const EMPTY_AGENT_PANE_SESSION_ENTRIES: AgentSessionsPaneSessionEntry[] = [];

export type AgentSessionsPaneSession = Pick<ChatSession,
  'key' | 'agentId' | 'sessionIdentity' | 'ownership' | 'kind' | 'preferred' | 'titleSource'>;

export interface AgentSessionsPaneSessionEntry {
  session: AgentSessionsPaneSession;
  title: string | null;
  isRunning: boolean;
}

export type AgentSessionsPaneRuntimeTarget = Pick<ChatSessionRuntimeEndpointTarget,
  'endpoint' | 'acceptsDynamicAgents' | 'sessionPromptScopes'>;

export type AgentSessionsPaneRuntimeEndpoint = Pick<ChatSessionRuntimeEndpointNode,
  'runtimeScopeKey' | 'endpoint' | 'displayName'> & {
  target: AgentSessionsPaneRuntimeTarget | null;
  agentCatalogSource: ChatSessionRuntimeEndpointTarget['agentCatalog']['source'] | null;
  agents: {
    agentId: string;
    catalogEntry: { id: string; name?: string } | null;
    deletableIdentities: SessionIdentity[];
  }[];
};

let cachedAgentPaneRuntimeEndpoints: AgentSessionsPaneRuntimeEndpoint[] = [];
let cachedAgentPaneSessionEntries: AgentSessionsPaneSessionEntry[] = [];
let cachedAgentPaneSessionEntryByKey = new Map<string, AgentSessionsPaneSessionEntry>();
let cachedAgentSessionsPaneState: ReturnType<typeof buildAgentSessionsPaneState> | null = null;
let cachedCurrentSendGateSource: CurrentChatSendGateSource | null = null;
let cachedCurrentSendGate: ReturnType<typeof deriveChatSendGate> | null = null;

function resolveCurrentSessionRecordKey(state: ChatStoreState): string {
  return state.currentConversation?.kind === 'session'
    ? state.currentConversation.sessionRecordKey
    : '';
}

function resolveCurrentAgentId(state: ChatStoreState): string {
  return state.currentConversation?.agentId ?? '';
}

function hasSessionPaneActivity(record: ChatSessionRecord): boolean {
  return record.meta.label != null
    || getSessionItemCount(record) > 0
    || typeof record.meta.lastActivityAt === 'number'
    || record.runtime.activeRunId != null
    || record.runtime.activeTurnItemKey != null
    || record.runtime.lastUserMessageAt != null;
}

export function deriveSessionImageGenerationRuntime(record: ChatSessionRecord | undefined): ChatSessionImageGenerationRuntimeState {
  return deriveSessionImageGenerationPendingStateFromItems(record?.items ?? []);
}

function buildAgentPaneSessionEntries(state: ChatStoreState): AgentSessionsPaneSessionEntry[] {
  const sessions = readSessionsFromState(state);
  const titles = readSessionTitlesFromState(state);
  let nextEntries: AgentSessionsPaneSessionEntry[] | null = null;
  let visibleIndex = 0;

  for (const session of sessions) {
    const record = state.loadedSessions[session.key];
    const title = titles[session.key] ?? null;
    if (!record || !hasSessionPaneActivity(record)) {
      continue;
    }
    const isRunning = isRunActive(record.runtime);
    const previousEntry = cachedAgentPaneSessionEntryByKey.get(session.key);
    const before = previousEntry?.session;
    const paneSession = before
      && before.agentId === session.agentId
      && sessionIdentitiesEqual(before.sessionIdentity, session.sessionIdentity)
      && shallow(before.ownership, session.ownership)
      && before.kind === session.kind
      && before.preferred === session.preferred
      && before.titleSource === session.titleSource
      ? before : {
        key: session.key,
        agentId: session.agentId,
        sessionIdentity: { ...session.sessionIdentity, endpoint: { ...session.sessionIdentity.endpoint } },
        ownership: session.ownership ? { ...session.ownership } : null,
        kind: session.kind,
        preferred: session.preferred,
        titleSource: session.titleSource,
      };
    const nextEntry = previousEntry
      && previousEntry.session === paneSession
      && previousEntry.title === title
      && previousEntry.isRunning === isRunning
      ? previousEntry
      : { session: paneSession, title, isRunning };
    if (!nextEntries && cachedAgentPaneSessionEntries[visibleIndex] !== nextEntry) {
      nextEntries = cachedAgentPaneSessionEntries.slice(0, visibleIndex);
    }
    nextEntries?.push(nextEntry);
    visibleIndex += 1;
  }

  if (!nextEntries && visibleIndex === cachedAgentPaneSessionEntries.length) {
    return cachedAgentPaneSessionEntries;
  }

  cachedAgentPaneSessionEntries = visibleIndex === 0 ? EMPTY_AGENT_PANE_SESSION_ENTRIES
    : nextEntries ?? cachedAgentPaneSessionEntries.slice(0, visibleIndex);
  cachedAgentPaneSessionEntryByKey = new Map(cachedAgentPaneSessionEntries.map((entry) => [entry.session.key, entry]));
  return cachedAgentPaneSessionEntries;
}

// The pane observes navigation, titles and actions, not model/thinking/token facts.
// Retain only the current projection; membership, order, identity and metadata invalidate it.
function buildAgentPaneRuntimeEndpoints(state: ChatStoreState): AgentSessionsPaneRuntimeEndpoint[] {
  const previousByScope = new Map(cachedAgentPaneRuntimeEndpoints.map((endpoint) => [endpoint.runtimeScopeKey, endpoint]));
  const endpoints = state.sessionRuntimeGraph.endpoints.map((endpoint) => {
    const before = previousByScope.get(endpoint.runtimeScopeKey);
    const previousAgents = new Map(before?.agents.map((agent) => [agent.agentId, agent]));
    const agents = endpoint.agents.map((agent) => {
      const previous = previousAgents.get(agent.agentId);
      const identities = agent.sessions.filter(isDeletableSession).map((session) => session.sessionIdentity);
      const deletableIdentities = previous && identities.length === previous.deletableIdentities.length
        && identities.every((identity, index) => sessionIdentitiesEqual(identity, previous.deletableIdentities[index]))
        ? previous.deletableIdentities
        : identities.map((identity) => ({ ...identity, endpoint: { ...identity.endpoint } }));
      return previous && shallow(previous.catalogEntry, agent.catalogEntry) && previous.deletableIdentities === deletableIdentities
        ? previous : { agentId: agent.agentId, catalogEntry: agent.catalogEntry ? { ...agent.catalogEntry } : null, deletableIdentities };
    });
    const target = endpoint.target;
    const previousTarget = before?.target;
    const paneTarget = target ? previousTarget
      && shallow(previousTarget.endpoint, target.endpoint)
      && previousTarget.acceptsDynamicAgents === target.acceptsDynamicAgents
      && previousTarget.sessionPromptScopes.length === target.sessionPromptScopes.length
      && previousTarget.sessionPromptScopes.every((scope, index) => {
        const next = target.sessionPromptScopes[index];
        return scope.kind === next.kind && scope.agentId === next.agentId && shallow(scope.endpoint, next.endpoint);
      })
      ? previousTarget : {
        endpoint: { ...target.endpoint },
        acceptsDynamicAgents: target.acceptsDynamicAgents,
        sessionPromptScopes: target.sessionPromptScopes.map((scope) => ({ ...scope, endpoint: { ...scope.endpoint } })),
      } : null;
    const agentCatalogSource = target?.agentCatalog.source ?? null;
    return before && shallow(before.endpoint, endpoint.endpoint) && before.target === paneTarget
      && before.agentCatalogSource === agentCatalogSource
      && before.displayName === endpoint.displayName && shallow(before.agents, agents)
      ? before : {
        runtimeScopeKey: endpoint.runtimeScopeKey,
        endpoint: { ...endpoint.endpoint },
        target: paneTarget,
        agentCatalogSource,
        displayName: endpoint.displayName,
        agents,
      };
  });
  if (!shallow(cachedAgentPaneRuntimeEndpoints, endpoints)) cachedAgentPaneRuntimeEndpoints = endpoints;
  return cachedAgentPaneRuntimeEndpoints;
}

function buildAgentSessionsPaneState(state: ChatStoreState, sessionEntries: AgentSessionsPaneSessionEntry[], runtimeEndpoints: AgentSessionsPaneRuntimeEndpoint[]) {
  const sessionCatalogStatus = readSessionCatalogStatusShell(state);
  return {
    sessionEntries,
    sessionsLoadedOnce: sessionCatalogStatus.sessionsLoadedOnce,
    sessionsError: sessionCatalogStatus.sessionsError,
    currentConversation: state.currentConversation,
    runtimeEndpoints,
    currentSessionKey: resolveCurrentSessionRecordKey(state),
    currentAgentId: resolveCurrentAgentId(state),
    switchSession: state.switchSession,
    openAgentConversation: state.openAgentConversation,
    openSessionIdentity: state.openSessionIdentity,
    newSession: state.newSession,
    newSessionForScope: state.newSessionForScope,
    deleteSession: state.deleteSession,
    deleteAgentSessions: state.deleteAgentSessions,
    renameSession: state.renameSession,
  };
}

export function selectSessionItems(state: ChatStoreState, sessionKey: string) {
  return getSessionItems(state, sessionKey);
}

export function selectSessionMeta(state: ChatStoreState, sessionKey: string) {
  return getSessionMeta(state, sessionKey);
}

export function selectSessionRuntime(state: ChatStoreState, sessionKey: string) {
  return getSessionRuntime(state, sessionKey);
}

export function selectCurrentChatSendGate(state: ChatStoreState) {
  const source = readCurrentChatSendGateSource(state);
  if (
    cachedCurrentSendGate
    && cachedCurrentSendGateSource
    && areCurrentChatSendGateSourcesEquivalent(cachedCurrentSendGateSource, source)
  ) {
    return cachedCurrentSendGate;
  }
  cachedCurrentSendGateSource = source;
  cachedCurrentSendGate = deriveChatSendGate(source);
  return cachedCurrentSendGate;
}

export function selectSnapshotLayerState(state: ChatStoreState) {
  return {
    sessions: readSessionsFromState(state),
    currentSessionKey: resolveCurrentSessionRecordKey(state),
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
  const runtimeEndpoints = buildAgentPaneRuntimeEndpoints(state);
  const sessionCatalogStatus = readSessionCatalogStatusShell(state);
  if (
    cachedAgentSessionsPaneState
    && cachedAgentSessionsPaneState.sessionEntries === sessionEntries
    && cachedAgentSessionsPaneState.sessionsLoadedOnce === sessionCatalogStatus.sessionsLoadedOnce
    && cachedAgentSessionsPaneState.sessionsError === sessionCatalogStatus.sessionsError
    && cachedAgentSessionsPaneState.currentConversation === state.currentConversation
    && cachedAgentSessionsPaneState.runtimeEndpoints === runtimeEndpoints
    && cachedAgentSessionsPaneState.currentSessionKey === resolveCurrentSessionRecordKey(state)
    && cachedAgentSessionsPaneState.currentAgentId === resolveCurrentAgentId(state)
    && cachedAgentSessionsPaneState.switchSession === state.switchSession
    && cachedAgentSessionsPaneState.openAgentConversation === state.openAgentConversation
    && cachedAgentSessionsPaneState.openSessionIdentity === state.openSessionIdentity
    && cachedAgentSessionsPaneState.newSession === state.newSession
    && cachedAgentSessionsPaneState.newSessionForScope === state.newSessionForScope
    && cachedAgentSessionsPaneState.deleteSession === state.deleteSession
    && cachedAgentSessionsPaneState.deleteAgentSessions === state.deleteAgentSessions
    && cachedAgentSessionsPaneState.renameSession === state.renameSession
  ) {
    return cachedAgentSessionsPaneState;
  }
  cachedAgentSessionsPaneState = buildAgentSessionsPaneState(state, sessionEntries, runtimeEndpoints);
  return cachedAgentSessionsPaneState;
}
