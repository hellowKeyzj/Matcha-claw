import type { RuntimeEndpointRef } from '../../types/desktop/runtime-address';
import { isCronSessionKey } from './cron-session-utils';
import { buildRuntimeScopeKey, sameRuntimeEndpointScope } from './session-identity';
import { readSessionsFromState } from './session-helpers';
import { buildCurrentConversationFromSessionRecord, createDraftCurrentConversation } from './session-runtime-graph';
import { isOrdinarySessionCandidate } from './types';
import type { ChatCurrentConversation, ChatSession, ChatSessionRuntimeEndpointTarget, ChatSessionRuntimeGraph, ChatStoreState } from './types';

type SessionSelectionState = Pick<ChatStoreState,
  'currentSessionKey' | 'currentConversation' | 'sessionRuntimeCatalog' | 'lastSelectedSessionKeyByRuntimeScopeKey' | 'loadedSessions'>;
type SessionSelectionPatch = Pick<ChatStoreState,
  'currentSessionKey' | 'currentConversation' | 'sessionRuntimeCatalog' | 'lastSelectedSessionKeyByRuntimeScopeKey'>;
type SessionSelection = ChatCurrentConversation
  | { kind: 'record'; sessionKey: string; conversation?: ChatCurrentConversation | null }
  | { kind: 'endpoint'; endpoint: RuntimeEndpointRef }
  | { kind: 'context'; endpoint: RuntimeEndpointRef }
  | null;

export function buildCurrentConversationForSessionKey(
  loadedSessions: ChatStoreState['loadedSessions'],
  sessionKey: string,
  previous?: ChatCurrentConversation | null,
): ReturnType<typeof buildCurrentConversationFromSessionRecord> {
  const record = loadedSessions[sessionKey];
  return record ? buildCurrentConversationFromSessionRecord(record, previous) : null;
}

export function isCurrentConversationSelection(
  state: SessionSelectionState,
  previous: Pick<ChatStoreState, 'currentSessionKey' | 'currentConversation' | 'sessionRuntimeCatalog'>,
): boolean {
  return state.currentSessionKey === previous.currentSessionKey
    && state.currentConversation === previous.currentConversation
    && (state.currentConversation !== null || state.sessionRuntimeCatalog === previous.sessionRuntimeCatalog);
}

function findRuntimeTarget(catalog: ChatStoreState['sessionRuntimeCatalog'], endpoint: RuntimeEndpointRef) {
  return catalog.status === 'ready'
    ? catalog.endpoints.find((target) => sameRuntimeEndpointScope(target.endpoint, endpoint)) ?? null
    : null;
}

function selectRuntimeContext(
  catalog: ChatStoreState['sessionRuntimeCatalog'],
  endpoint: RuntimeEndpointRef,
  target: ChatSessionRuntimeEndpointTarget | null,
): ChatStoreState['sessionRuntimeCatalog'] {
  return target && catalog.defaultSessionPromptScope === target.defaultSessionPromptScope
    && catalog.selectedEndpoint && sameRuntimeEndpointScope(catalog.selectedEndpoint, target.endpoint)
    ? catalog
    : { ...catalog, selectedEndpoint: target?.endpoint ?? endpoint, defaultSessionPromptScope: target?.defaultSessionPromptScope ?? null };
}

// undefined resolves context from the selection; null deliberately leaves context unchanged.
export function buildSessionSelectionPatch(
  state: SessionSelectionState,
  selection: SessionSelection,
  contextTarget?: ChatSessionRuntimeEndpointTarget | null,
): SessionSelectionPatch {
  if (selection?.kind === 'context') {
    return {
      currentSessionKey: state.currentSessionKey,
      currentConversation: state.currentConversation,
      lastSelectedSessionKeyByRuntimeScopeKey: state.lastSelectedSessionKeyByRuntimeScopeKey,
      sessionRuntimeCatalog: selectRuntimeContext(state.sessionRuntimeCatalog, selection.endpoint, findRuntimeTarget(state.sessionRuntimeCatalog, selection.endpoint)),
    };
  }
  const endpointTarget = selection?.kind === 'endpoint' ? findRuntimeTarget(state.sessionRuntimeCatalog, selection.endpoint) : null;
  const currentConversation = selection?.kind === 'record'
    ? selection.conversation === undefined ? buildCurrentConversationForSessionKey(state.loadedSessions, selection.sessionKey) : selection.conversation
    : selection?.kind === 'endpoint'
      ? endpointTarget?.defaultSessionPromptScope
        ? createDraftCurrentConversation(endpointTarget.endpoint, endpointTarget.defaultSessionPromptScope.agentId) : null
      : selection;
  const currentSessionKey = selection?.kind === 'record' ? selection.sessionKey
    : currentConversation?.kind === 'session' ? currentConversation.sessionRecordKey : '';
  const endpoint = selection?.kind === 'endpoint' ? selection.endpoint
    : currentConversation?.endpoint ?? (selection?.kind === 'record' ? state.loadedSessions[selection.sessionKey]?.meta.sessionIdentity?.endpoint : null);
  const sessionRuntimeCatalog = contextTarget === null ? state.sessionRuntimeCatalog
    : contextTarget ? selectRuntimeContext(state.sessionRuntimeCatalog, contextTarget.endpoint, contextTarget)
      : endpoint ? selectRuntimeContext(state.sessionRuntimeCatalog, endpoint, findRuntimeTarget(state.sessionRuntimeCatalog, endpoint)) : state.sessionRuntimeCatalog;
  let lastSelectedSessionKeyByRuntimeScopeKey = state.lastSelectedSessionKeyByRuntimeScopeKey;
  if (endpoint && currentSessionKey) {
    const runtimeScopeKey = buildRuntimeScopeKey(endpoint);
    if (lastSelectedSessionKeyByRuntimeScopeKey[runtimeScopeKey] !== currentSessionKey) {
      lastSelectedSessionKeyByRuntimeScopeKey = { ...lastSelectedSessionKeyByRuntimeScopeKey, [runtimeScopeKey]: currentSessionKey };
    }
  }
  return { currentSessionKey, currentConversation, sessionRuntimeCatalog, lastSelectedSessionKeyByRuntimeScopeKey };
}

function findRememberedSessionKeyForRuntimeEndpoint(
  state: Pick<ChatStoreState, 'lastSelectedSessionKeyByRuntimeScopeKey' | 'loadedSessions'>,
  endpoint: RuntimeEndpointRef,
): string | null {
  const sessionKey = state.lastSelectedSessionKeyByRuntimeScopeKey[buildRuntimeScopeKey(endpoint)];
  const meta = sessionKey ? state.loadedSessions[sessionKey]?.meta : null;
  return meta?.sessionIdentity && isOrdinarySessionCandidate(meta)
    && sameRuntimeEndpointScope(meta.sessionIdentity.endpoint, endpoint) ? sessionKey : null;
}

function findPreferredSessionKeyForRuntimeEndpoint(
  graph: ChatSessionRuntimeGraph,
  endpoint: RuntimeEndpointRef,
  currentSessionKey = '',
): string | null {
  const endpointNode = graph.endpoints.find((candidate) => sameRuntimeEndpointScope(candidate.endpoint, endpoint));
  if (!endpointNode) return null;
  if (currentSessionKey) {
    for (const agent of endpointNode.agents) {
      const currentSession = agent.sessions.find((session) => session.sessionRecordKey === currentSessionKey);
      if (currentSession && isOrdinarySessionCandidate(currentSession)) return currentSession.sessionRecordKey;
    }
  }
  for (const agent of endpointNode.agents) {
    if (agent.preferredSessionKey) return agent.preferredSessionKey;
  }
  return null;
}

export function findExistingSessionKeyForRuntimeEndpoint(
  state: SessionSelectionState & Pick<ChatStoreState, 'sessionRuntimeGraph'>,
  endpoint: RuntimeEndpointRef,
): string | null {
  if (state.currentConversation?.kind === 'session' && sameRuntimeEndpointScope(state.currentConversation.endpoint, endpoint)) {
    return state.currentConversation.sessionRecordKey;
  }
  return findRememberedSessionKeyForRuntimeEndpoint(state, endpoint)
    ?? findPreferredSessionKeyForRuntimeEndpoint(state.sessionRuntimeGraph, endpoint, state.currentSessionKey)
    ?? readSessionsFromState(state).find((session) => isOrdinarySessionCandidate(session)
      && sameRuntimeEndpointScope(session.sessionIdentity.endpoint, endpoint))?.key
    ?? null;
}

export function resolveCurrentConversationAfterCatalogRefresh(input: {
  previousConversation: ChatCurrentConversation | null;
  currentSessionKey: string;
  contextTarget: ChatSessionRuntimeEndpointTarget | null;
  graph: ChatSessionRuntimeGraph;
  loadedSessions: ChatStoreState['loadedSessions'];
  lastSelectedSessionKeyByRuntimeScopeKey: ChatStoreState['lastSelectedSessionKeyByRuntimeScopeKey'];
}): ChatCurrentConversation | null {
  const previousConversation = input.previousConversation;
  const currentSessionConversation = buildCurrentConversationForSessionKey(input.loadedSessions, input.currentSessionKey, previousConversation);
  if (currentSessionConversation) return currentSessionConversation;
  if (previousConversation?.kind === 'draft') return previousConversation;
  const endpoint = previousConversation?.endpoint ?? input.contextTarget?.endpoint ?? null;
  if (!endpoint) return null;
  const sessionKey = findRememberedSessionKeyForRuntimeEndpoint(input, endpoint)
    ?? findPreferredSessionKeyForRuntimeEndpoint(input.graph, endpoint, input.currentSessionKey);
  const agentId = previousConversation?.agentId ?? input.contextTarget?.defaultSessionPromptScope?.agentId ?? null;
  return sessionKey ? buildCurrentConversationForSessionKey(input.loadedSessions, sessionKey)
    : agentId ? createDraftCurrentConversation(endpoint, agentId) : null;
}

function pruneSessionSelectionMemory(
  state: SessionSelectionState,
  remove: (sessionKey: string) => boolean,
  firstOnly = false,
): ChatStoreState['lastSelectedSessionKeyByRuntimeScopeKey'] {
  let remembered = state.lastSelectedSessionKeyByRuntimeScopeKey;
  for (const [runtimeScopeKey, sessionKey] of Object.entries(remembered)) {
    if (!remove(sessionKey)) continue;
    if (remembered === state.lastSelectedSessionKeyByRuntimeScopeKey) remembered = { ...remembered };
    delete remembered[runtimeScopeKey];
    if (firstOnly) break;
  }
  return remembered;
}

export function reconcileSessionSelectionAfterRemoval(
  state: SessionSelectionState,
  removed: string | ReadonlySet<string>,
  replacement?: SessionSelection,
  contextTarget: ChatSessionRuntimeEndpointTarget | null = null,
): Pick<ChatStoreState, 'lastSelectedSessionKeyByRuntimeScopeKey'> & Partial<SessionSelectionPatch> {
  const lastSelectedSessionKeyByRuntimeScopeKey = pruneSessionSelectionMemory(
    state, (key) => typeof removed === 'string' ? key === removed : removed.has(key), typeof removed === 'string',
  );
  if (replacement === undefined) return { lastSelectedSessionKeyByRuntimeScopeKey };
  const patch = buildSessionSelectionPatch({ ...state, lastSelectedSessionKeyByRuntimeScopeKey }, replacement, contextTarget);
  if (typeof removed !== 'string' && patch.currentSessionKey) {
    patch.lastSelectedSessionKeyByRuntimeScopeKey = { ...patch.lastSelectedSessionKeyByRuntimeScopeKey };
  }
  return patch;
}

export function reconcileSessionSelectionAfterCatalogRefresh(
  state: SessionSelectionState & Pick<ChatStoreState, 'sessionRuntimeGraph'>,
  currentSessionKey: string,
  contextTarget: ChatSessionRuntimeEndpointTarget | null,
  ownsSelection: boolean,
): SessionSelectionPatch {
  const lastSelectedSessionKeyByRuntimeScopeKey = pruneSessionSelectionMemory(state, (key) => !state.loadedSessions[key]);
  if (!ownsSelection) return {
    currentSessionKey: state.currentSessionKey, currentConversation: state.currentConversation,
    sessionRuntimeCatalog: state.sessionRuntimeCatalog, lastSelectedSessionKeyByRuntimeScopeKey,
  };
  const currentConversation = resolveCurrentConversationAfterCatalogRefresh({
    previousConversation: state.currentConversation, currentSessionKey, contextTarget,
    graph: state.sessionRuntimeGraph, loadedSessions: state.loadedSessions, lastSelectedSessionKeyByRuntimeScopeKey,
  });
  return buildSessionSelectionPatch({ ...state, lastSelectedSessionKeyByRuntimeScopeKey }, currentConversation, contextTarget);
}

export function reconcileSessionSelectionAfterRuntimeBootstrap(
  state: SessionSelectionState,
  catalog: ChatStoreState['sessionRuntimeCatalog'],
  graph: ChatSessionRuntimeGraph,
): SessionSelectionPatch {
  if (catalog.endpoints.length === 0) return {
    currentSessionKey: state.currentSessionKey, currentConversation: state.currentConversation,
    lastSelectedSessionKeyByRuntimeScopeKey: state.lastSelectedSessionKeyByRuntimeScopeKey,
    sessionRuntimeCatalog: { ...catalog, selectedEndpoint: state.currentConversation?.endpoint ?? state.sessionRuntimeCatalog.selectedEndpoint, defaultSessionPromptScope: null },
  };
  const endpoint = state.currentConversation?.endpoint
    ?? state.loadedSessions[state.currentSessionKey]?.meta.sessionIdentity?.endpoint
    ?? state.sessionRuntimeCatalog.selectedEndpoint;
  const contextTarget = (endpoint ? catalog.endpoints.find((target) => sameRuntimeEndpointScope(target.endpoint, endpoint)) : null)
    ?? (state.currentConversation || state.loadedSessions[state.currentSessionKey]?.meta.sessionIdentity || state.sessionRuntimeCatalog.selectedEndpoint
      ? null : catalog.endpoints.find((target) => target.runtimeAdapterId === 'openclaw') ?? catalog.endpoints[0] ?? null);
  const currentConversation = state.currentConversation ?? resolveCurrentConversationAfterCatalogRefresh({
    previousConversation: null, currentSessionKey: state.currentSessionKey, contextTarget, graph,
    loadedSessions: state.loadedSessions, lastSelectedSessionKeyByRuntimeScopeKey: state.lastSelectedSessionKeyByRuntimeScopeKey,
  });
  const patch = buildSessionSelectionPatch(state, currentConversation, null);
  return {
    ...patch,
    lastSelectedSessionKeyByRuntimeScopeKey: state.lastSelectedSessionKeyByRuntimeScopeKey,
    sessionRuntimeCatalog: {
      ...catalog,
      selectedEndpoint: currentConversation?.endpoint ?? state.sessionRuntimeCatalog.selectedEndpoint ?? contextTarget?.endpoint ?? null,
      defaultSessionPromptScope: contextTarget?.sessionPromptScopes.find((scope) => scope.agentId === state.currentConversation?.agentId)
        ?? contextTarget?.defaultSessionPromptScope ?? null,
    },
  };
}

function sortByRecentActivity(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

function sessionMatchesKey(session: ChatSession, sessionKey: string): boolean {
  return session.key === sessionKey
    || session.sessionIdentity.sessionKey === sessionKey;
}

function getSessionOwnerAgentId(session: ChatSession): string | null {
  return session.agentId.trim() || session.sessionIdentity.agentId.trim() || null;
}

function pickMostRecentNonCronSession(sessions: ChatSession[]): string | null {
  const nonCron = sortByRecentActivity(sessions.filter((session) => !isCronSessionKey(session.key)));
  return nonCron[0]?.key ?? null;
}

export function pickStartupSessionFallback(currentSessionKey: string, sessions: ChatSession[]): string | null {
  if (sessions.length === 0) {
    return null;
  }

  const currentSession = sessions.find((session) => sessionMatchesKey(session, currentSessionKey));
  const ownerAgentId = currentSession ? getSessionOwnerAgentId(currentSession) : null;
  if (!ownerAgentId) {
    return pickMostRecentNonCronSession(sessions);
  }

  const agentMainKey = `agent:${ownerAgentId}:main`;
  const agentMain = sessions.find((session) => (
    getSessionOwnerAgentId(session) === ownerAgentId
    && sessionMatchesKey(session, agentMainKey)
  ));
  if (agentMain) {
    return agentMain.key;
  }

  const sameAgentNonCron = sortByRecentActivity(
    sessions.filter((session) => getSessionOwnerAgentId(session) === ownerAgentId && !isCronSessionKey(session.key)),
  );
  if (sameAgentNonCron.length > 0) {
    return sameAgentNonCron[0]!.key;
  }

  return pickMostRecentNonCronSession(sessions);
}
