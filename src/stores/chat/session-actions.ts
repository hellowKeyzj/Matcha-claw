import {
  hostSessionDelete,
  hostSessionList,
  hostSessionLoad,
  hostSessionNew,
} from '@/lib/host-api';
import {
  createErrorResourceStatusState,
  createLoadingResourceStatusState,
  createReadyResourceStatusState,
} from '@/lib/resource-state';
import {
  isTrulyEmptyNonMainSession,
  parseSessionUpdatedAtMs,
  readSessionsFromState,
  shouldKeepMissingCurrentSession,
  shouldRetainLocalSessionRecord,
} from './session-helpers';
import { resumeActiveStoreSend } from './send-handlers';
import { executeViewportWindowLoad } from './history-load-execution';
import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
} from './timers';
import {
  applySessionView,
  createEmptySessionRecord,
  getSessionItemCount,
  getSessionMeta,
  getSessionViewportState,
  patchSessionMeta,
  patchSessionRecord,
  patchSessionViewportState,
  removeSessionRecord,
  resetSessionProjection,
  resolveSessionRecord,
} from './store-state-helpers';
import {
  buildRuntimeScopeKey,
  buildSessionIdentityRecordIndex,
  buildSessionRecordKey,
  findAgentScope,
  findSessionRecordKey,
  resolveSessionOperationTarget,
  sameRuntimeEndpointScope,
} from './session-identity';
import {
  buildCurrentConversationFromSessionRecord,
  buildSessionRuntimeGraph,
  createDraftCurrentConversation,
  findPreferredSessionForAgent,
} from './session-runtime-graph';
import {
  decodeHistorySessionView,
  resolveSessionViewError,
} from './history-fetch-helpers';
import {
  createSessionTraceId,
  logSessionTrace,
  summarizeEndpoint,
  summarizeError,
  summarizeIdentifier,
  summarizeSessionIdentity,
} from '@/lib/session-trace';
import { useComposerDraftStore } from '../composer-drafts';
import { isSessionRuntimeEndpointStarting, useRuntimeEndpointsStore } from '../runtime-endpoints';
import type { StoreHistoryCache } from './history-cache';
import type {
  AgentScope,
  RuntimeEndpointRef,
  SessionIdentity,
} from '../../../electron/desktop-contract/runtime-address';
import type {
  ChatCurrentConversation,
  ChatSession,
  ChatSessionRuntimeEndpointTarget,
  ChatSessionRuntimeGraph,
  ChatStoreState,
} from './types';
import { isRunActive } from './types';

const SESSION_CATALOG_NOT_READY_RETRY_MS = 1200;
const SESSION_CATALOG_ENDPOINT_TIMEOUT_MS = 30000;
const SESSION_CATALOG_ENDPOINT_TIMEOUT_ERROR = 'Session catalog request timed out';
const SESSION_DELETE_UNAVAILABLE_ERROR = 'Session delete is unavailable';

type SessionDeleteReceipt = Readonly<{
  outcome: 'succeeded' | 'target_rejected' | 'unknown';
}>;

let sessionCatalogRetryTimer: ReturnType<typeof setTimeout> | null = null;
let sessionCatalogLoadSequence = 0;
let newSessionRequestSequence = 0;
const forgottenAgentSessionIds = new Set<string>();

function normalizeAgentSessionTombstoneId(agentId: unknown): string {
  return typeof agentId === 'string' ? agentId.trim().toLowerCase() : '';
}

export function isAgentSessionTombstoned(agentId: unknown): boolean {
  const normalized = normalizeAgentSessionTombstoneId(agentId);
  return normalized.length > 0 && forgottenAgentSessionIds.has(normalized);
}

function isTombstonedCatalogSession(session: ChatSession): boolean {
  return isAgentSessionTombstoned(session.sessionIdentity.agentId);
}

function isAgentSessionRecord(record: ChatStoreState['loadedSessions'][string], normalizedAgentId: string): boolean {
  const agentId = record.meta.sessionIdentity?.agentId ?? record.meta.agentId;
  return normalizeAgentSessionTombstoneId(agentId) === normalizedAgentId;
}

export function executeReconcileAgentSessionTombstones(agentIds: readonly string[]): void {
  for (const agentId of agentIds) {
    const normalized = normalizeAgentSessionTombstoneId(agentId);
    if (normalized) {
      forgottenAgentSessionIds.delete(normalized);
    }
  }
}

function clearSessionCatalogRetry(): void {
  if (!sessionCatalogRetryTimer) {
    return;
  }
  clearTimeout(sessionCatalogRetryTimer);
  sessionCatalogRetryTimer = null;
}

function scheduleSessionCatalogRetry(loadSessions: () => Promise<void>): void {
  if (sessionCatalogRetryTimer) {
    return;
  }
  sessionCatalogRetryTimer = setTimeout(() => {
    sessionCatalogRetryTimer = null;
    void loadSessions();
  }, SESSION_CATALOG_NOT_READY_RETRY_MS);
}

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface CreateStoreSessionActionsInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  beginMutating: () => void;
  finishMutating: () => void;
  historyRuntime: StoreHistoryCache;
}

interface RenameStoreSessionInput extends CreateStoreSessionActionsInput {
  renameSession: (payload: { sessionIdentity: SessionIdentity; label: string }) => Promise<{ success: boolean; error?: string }>;
}

function clearSessionHistoryFingerprints(
  historyRuntime: StoreHistoryCache,
  sessionKey: string,
): void {
  historyRuntime.historyFingerprintBySession.delete(sessionKey);
  historyRuntime.historyRenderFingerprintBySession.delete(sessionKey);
}

function ensureSessionRecordMap(
  runtimeByKey: Record<string, ReturnType<typeof createEmptySessionRecord>>,
  sessionKey: string,
): Record<string, ReturnType<typeof createEmptySessionRecord>> {
  if (!sessionKey || Object.prototype.hasOwnProperty.call(runtimeByKey, sessionKey)) {
    return runtimeByKey;
  }
  return {
    ...runtimeByKey,
    [sessionKey]: createEmptySessionRecord(),
  };
}

function normalizeCatalogString(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveOperationTarget(state: ChatStoreState, recordKey: string) {
  return resolveSessionOperationTarget(state, recordKey);
}

const SESSION_CATALOG_LIST_CONCURRENCY = 4;

interface SessionCatalogLoadResult {
  target: ChatSessionRuntimeEndpointTarget;
  sessions: ChatSession[];
  ready: boolean;
  error: string | null;
}

function readSessionRuntimeTargets(state: ChatStoreState): ChatSessionRuntimeEndpointTarget[] {
  return state.sessionRuntimeCatalog.status === 'ready'
    ? state.sessionRuntimeCatalog.endpoints
    : [];
}

function isSessionEndpointStarting(state: ChatStoreState, recordKey: string): boolean {
  const identity = state.loadedSessions[recordKey]?.meta.sessionIdentity;
  if (!identity) {
    return false;
  }
  return useRuntimeEndpointsStore.getState().endpoints.some((endpoint) => (
    sameRuntimeEndpointScope(endpoint.endpointRef, identity.endpoint)
    && isSessionRuntimeEndpointStarting(endpoint)
  ));
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!);
    }
  }));
  return results;
}

function normalizeCatalogSession(session: ChatSession): ChatSession | null {
  if (!session.key || !session.agentId || !session.sessionIdentity) {
    return null;
  }
  const recordKey = buildSessionRecordKey(session.sessionIdentity);
  return {
    ...session,
    key: recordKey,
    endpointSessionId: normalizeCatalogString(session.endpointSessionId) ?? undefined,
  };
}

async function loadEndpointSessionCatalog(target: ChatSessionRuntimeEndpointTarget): Promise<SessionCatalogLoadResult> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error(SESSION_CATALOG_ENDPOINT_TIMEOUT_ERROR)), SESSION_CATALOG_ENDPOINT_TIMEOUT_MS);
    });
    const data = await Promise.race([
      hostSessionList(
        { endpoint: target.defaultSessionPromptScope.endpoint },
        { timeoutMs: SESSION_CATALOG_ENDPOINT_TIMEOUT_MS },
      ),
      timeout,
    ]);
    const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];
    return {
      target,
      sessions: rawSessions.map((session) => normalizeCatalogSession({
        key: session.key || '',
        agentId: typeof session.agentId === 'string' ? session.agentId : '',
        protocolId: typeof session.protocolId === 'string' ? session.protocolId : undefined,
        runtimeEndpointId: typeof session.runtimeEndpointId === 'string' ? session.runtimeEndpointId : undefined,
        endpointSessionId: typeof session.endpointSessionId === 'string' ? session.endpointSessionId : undefined,
        sessionIdentity: session.sessionIdentity,
        kind: session.kind === 'main' || session.kind === 'subsession' || session.kind === 'session' || session.kind === 'automation'
          ? session.kind
          : undefined,
        preferred: session.preferred === true,
        label: typeof session.label === 'string' ? session.label : undefined,
        titleSource: session.titleSource === 'user' || session.titleSource === 'assistant' || session.titleSource === 'none'
          ? session.titleSource
          : undefined,
        displayName: typeof session.displayName === 'string' ? session.displayName : undefined,
        modelState: session.modelState,
        contextTokens: session.contextTokens,
        updatedAt: parseSessionUpdatedAtMs(session.updatedAt),
      })).filter((session): session is ChatSession => session != null),
      ready: data.ready !== false,
      error: typeof data.error === 'string' ? data.error : null,
    };
  } catch (error) {
    return {
      target,
      sessions: [],
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function findRuntimeTargetForEndpoint(
  targets: readonly ChatSessionRuntimeEndpointTarget[],
  endpoint: RuntimeEndpointRef,
): ChatSessionRuntimeEndpointTarget | null {
  return targets.find((target) => sameRuntimeEndpointScope(target.endpoint, endpoint)) ?? null;
}

function findRuntimeEndpointNode(
  graph: ChatSessionRuntimeGraph,
  endpoint: RuntimeEndpointRef,
) {
  return graph.endpoints.find((candidate) => sameRuntimeEndpointScope(candidate.endpoint, endpoint)) ?? null;
}

function buildCurrentConversationForSessionKey(
  loadedSessions: ChatStoreState['loadedSessions'],
  sessionKey: string,
): ChatCurrentConversation | null {
  const record = loadedSessions[sessionKey];
  return record ? buildCurrentConversationFromSessionRecord(record) : null;
}

function buildRuntimeCatalogContextPatch(
  state: ChatStoreState,
  target: ChatSessionRuntimeEndpointTarget,
): Pick<ChatStoreState, 'sessionRuntimeCatalog'> {
  return {
    sessionRuntimeCatalog: state.sessionRuntimeCatalog.defaultSessionPromptScope === target.defaultSessionPromptScope
      ? state.sessionRuntimeCatalog
      : {
          ...state.sessionRuntimeCatalog,
          defaultSessionPromptScope: target.defaultSessionPromptScope,
        },
  };
}

function buildRuntimeCatalogContextPatchForEndpoint(
  state: ChatStoreState,
  endpoint: RuntimeEndpointRef,
): Pick<ChatStoreState, 'sessionRuntimeCatalog'> {
  const target = findRuntimeTargetForEndpoint(readSessionRuntimeTargets(state), endpoint);
  return target ? buildRuntimeCatalogContextPatch(state, target) : { sessionRuntimeCatalog: state.sessionRuntimeCatalog };
}

function buildLastSelectedSessionPatchForEndpoint(
  state: ChatStoreState,
  endpoint: RuntimeEndpointRef,
  sessionKey: string,
): Pick<ChatStoreState, 'lastSelectedSessionKeyByRuntimeScopeKey'> {
  const runtimeScopeKey = buildRuntimeScopeKey(endpoint);
  if (state.lastSelectedSessionKeyByRuntimeScopeKey[runtimeScopeKey] === sessionKey) {
    return { lastSelectedSessionKeyByRuntimeScopeKey: state.lastSelectedSessionKeyByRuntimeScopeKey };
  }
  return {
    lastSelectedSessionKeyByRuntimeScopeKey: {
      ...state.lastSelectedSessionKeyByRuntimeScopeKey,
      [runtimeScopeKey]: sessionKey,
    },
  };
}

function buildLastSelectedSessionPatchAfterRemoval(
  state: ChatStoreState,
  removedSessionKey: string,
  replacement?: { endpoint: RuntimeEndpointRef; sessionKey: string | null },
): Pick<ChatStoreState, 'lastSelectedSessionKeyByRuntimeScopeKey'> {
  let lastSelectedSessionKeyByRuntimeScopeKey = state.lastSelectedSessionKeyByRuntimeScopeKey;
  for (const [runtimeScopeKey, sessionKey] of Object.entries(lastSelectedSessionKeyByRuntimeScopeKey)) {
    if (sessionKey !== removedSessionKey) {
      continue;
    }
    lastSelectedSessionKeyByRuntimeScopeKey = { ...lastSelectedSessionKeyByRuntimeScopeKey };
    delete lastSelectedSessionKeyByRuntimeScopeKey[runtimeScopeKey];
    break;
  }
  if (replacement?.sessionKey) {
    const runtimeScopeKey = buildRuntimeScopeKey(replacement.endpoint);
    if (lastSelectedSessionKeyByRuntimeScopeKey[runtimeScopeKey] !== replacement.sessionKey) {
      lastSelectedSessionKeyByRuntimeScopeKey = {
        ...lastSelectedSessionKeyByRuntimeScopeKey,
        [runtimeScopeKey]: replacement.sessionKey,
      };
    }
  }
  return { lastSelectedSessionKeyByRuntimeScopeKey };
}

function findRememberedSessionKeyForRuntimeEndpoint(
  state: Pick<ChatStoreState, 'lastSelectedSessionKeyByRuntimeScopeKey' | 'loadedSessions'>,
  endpoint: RuntimeEndpointRef,
): string | null {
  const sessionKey = state.lastSelectedSessionKeyByRuntimeScopeKey[buildRuntimeScopeKey(endpoint)];
  const identity = sessionKey ? state.loadedSessions[sessionKey]?.meta.sessionIdentity : null;
  return identity && sameRuntimeEndpointScope(identity.endpoint, endpoint) ? sessionKey : null;
}

function findPreferredSessionKeyForRuntimeEndpoint(
  graph: ChatSessionRuntimeGraph,
  endpoint: RuntimeEndpointRef,
  currentSessionKey = '',
): string | null {
  const endpointNode = findRuntimeEndpointNode(graph, endpoint);
  if (!endpointNode) {
    return null;
  }
  if (currentSessionKey) {
    for (const agent of endpointNode.agents) {
      const currentSession = agent.sessions.find((session) => session.sessionRecordKey === currentSessionKey);
      if (currentSession) {
        return currentSession.sessionRecordKey;
      }
    }
  }
  for (const agent of endpointNode.agents) {
    if (agent.preferredSessionKey) {
      return agent.preferredSessionKey;
    }
  }
  return null;
}

function findExistingSessionKeyForRuntimeEndpoint(
  state: ChatStoreState,
  endpoint: RuntimeEndpointRef,
): string | null {
  return findRememberedSessionKeyForRuntimeEndpoint(state, endpoint)
    ?? findPreferredSessionKeyForRuntimeEndpoint(state.sessionRuntimeGraph, endpoint, state.currentSessionKey)
    ?? readSessionsFromState(state).find((session) => sameRuntimeEndpointScope(session.sessionIdentity.endpoint, endpoint))?.key
    ?? null;
}

function findRuntimeTargetForConversationContext(state: ChatStoreState): ChatSessionRuntimeEndpointTarget | null {
  const endpoint = state.currentConversation?.endpoint
    ?? getSessionMeta(state, state.currentSessionKey).sessionIdentity?.endpoint
    ?? state.sessionRuntimeCatalog.defaultSessionPromptScope?.endpoint;
  return endpoint ? findRuntimeTargetForEndpoint(readSessionRuntimeTargets(state), endpoint) : null;
}

function sameOptionalCurrentConversation(left: ChatCurrentConversation | null, right: ChatCurrentConversation | null): boolean {
  if (!left || !right) {
    return left === right;
  }
  if (left.kind !== right.kind || left.agentId !== right.agentId || !sameRuntimeEndpointScope(left.endpoint, right.endpoint)) {
    return false;
  }
  return left.kind === 'draft' || right.kind === 'draft' || left.sessionRecordKey === right.sessionRecordKey;
}

function resolveScopeForAgent(target: ChatSessionRuntimeEndpointTarget, agentId: string): AgentScope {
  const matched = findAgentScope(target.sessionPromptScopes, agentId);
  if (matched) {
    return matched;
  }
  if (!target.acceptsDynamicAgents) {
    throw new Error(`Runtime endpoint does not support agent: ${agentId}`);
  }
  return {
    ...target.defaultSessionPromptScope,
    agentId,
  };
}

function resolveNewSessionAgentScope(state: ChatStoreState, agentId?: string): AgentScope {
  const targets = readSessionRuntimeTargets(state);
  if (targets.length === 0) {
    throw new Error('Session runtime is not ready');
  }
  const currentMeta = getSessionMeta(state, state.currentSessionKey);
  const currentConversation = state.currentConversation;
  const currentEndpoint = currentConversation?.endpoint
    ?? currentMeta.sessionIdentity?.endpoint
    ?? state.sessionRuntimeCatalog.defaultSessionPromptScope?.endpoint
    ?? null;
  const targetEndpoint = currentEndpoint
    ? findRuntimeTargetForEndpoint(targets, currentEndpoint)
    : null;
  const defaultScope = state.sessionRuntimeCatalog.defaultSessionPromptScope;
  const defaultEndpoint = defaultScope
    ? targets.find((target) => target.sessionPromptScopes.some((scope) => scope === defaultScope || (scope.agentId === defaultScope.agentId && sameRuntimeEndpointScope(scope.endpoint, defaultScope.endpoint)))) ?? null
    : null;
  const target = targetEndpoint ?? defaultEndpoint ?? targets[0]!;
  const currentAgentId = currentConversation && sameRuntimeEndpointScope(currentConversation.endpoint, target.endpoint)
    ? currentConversation.agentId
    : currentMeta.sessionIdentity && sameRuntimeEndpointScope(currentMeta.sessionIdentity.endpoint, target.endpoint)
      ? currentMeta.agentId ?? currentMeta.sessionIdentity.agentId
      : null;
  const targetAgentId = agentId?.trim()
    || currentAgentId
    || target.defaultSessionPromptScope.agentId;
  return resolveScopeForAgent(target, targetAgentId);
}

function resolveCurrentConversationAfterSessionCatalogLoad(input: {
  previousConversation: ChatCurrentConversation | null;
  currentSessionKey: string;
  contextTarget: ChatSessionRuntimeEndpointTarget | null;
  graph: ChatSessionRuntimeGraph;
  loadedSessions: ChatStoreState['loadedSessions'];
  lastSelectedSessionKeyByRuntimeScopeKey: ChatStoreState['lastSelectedSessionKeyByRuntimeScopeKey'];
}): ChatCurrentConversation | null {
  const currentSessionConversation = buildCurrentConversationForSessionKey(input.loadedSessions, input.currentSessionKey);
  if (currentSessionConversation) {
    return currentSessionConversation;
  }
  const previousConversation = input.previousConversation;
  if (previousConversation?.kind === 'draft') {
    const rememberedSessionKey = findRememberedSessionKeyForRuntimeEndpoint(input, previousConversation.endpoint);
    const rememberedConversation = rememberedSessionKey
      ? buildCurrentConversationForSessionKey(input.loadedSessions, rememberedSessionKey)
      : null;
    if (rememberedConversation) {
      return rememberedConversation;
    }
    const session = findPreferredSessionForAgent(input.graph, previousConversation.endpoint, previousConversation.agentId);
    return session
      ? buildCurrentConversationForSessionKey(input.loadedSessions, session.sessionRecordKey)
      : createDraftCurrentConversation(previousConversation.endpoint, previousConversation.agentId);
  }
  const endpoint = previousConversation?.endpoint ?? input.contextTarget?.endpoint ?? null;
  const agentId = previousConversation?.agentId ?? input.contextTarget?.defaultSessionPromptScope.agentId ?? null;
  if (!endpoint || !agentId) {
    return null;
  }
  const rememberedSessionKey = findRememberedSessionKeyForRuntimeEndpoint(input, endpoint);
  const sessionKey = rememberedSessionKey
    ?? findPreferredSessionKeyForRuntimeEndpoint(input.graph, endpoint, input.currentSessionKey);
  return sessionKey
    ? buildCurrentConversationForSessionKey(input.loadedSessions, sessionKey)
    : createDraftCurrentConversation(endpoint, agentId);
}

function buildSessionRuntimeProjectionPatch(input: {
  state: ChatStoreState;
  loadedSessions: ChatStoreState['loadedSessions'];
  currentSessionKey?: string;
  currentConversation?: ChatCurrentConversation | null;
}): Pick<ChatStoreState, 'sessionRuntimeGraph' | 'currentConversation'> {
  const graph = buildSessionRuntimeGraph(input.state.sessionRuntimeCatalog, input.loadedSessions);
  const currentSessionKey = input.currentSessionKey ?? input.state.currentSessionKey;
  const currentConversation = input.currentConversation === undefined
    ? buildCurrentConversationForSessionKey(input.loadedSessions, currentSessionKey) ?? input.state.currentConversation
    : input.currentConversation;
  return {
    sessionRuntimeGraph: graph,
    currentConversation,
  };
}

async function requestSessionLifecycleView(
  target: { sessionKey: string; endpointSessionId?: string; sessionIdentity: SessionIdentity },
  traceId?: string | null,
) {
  logSessionTrace('session.lifecycle.request', traceId, {
    sessionKey: summarizeIdentifier(target.sessionKey),
    endpointSessionId: summarizeIdentifier(target.endpointSessionId),
    sessionIdentity: summarizeSessionIdentity(target.sessionIdentity),
  });
  try {
    const view = decodeHistorySessionView(await hostSessionLoad({
      ...(target.endpointSessionId ? { endpointSessionId: target.endpointSessionId } : {}),
      sessionIdentity: target.sessionIdentity,
      limit: 200,
    }, { traceId }));
    logSessionTrace('session.lifecycle.response', traceId, {
      sessionKey: summarizeIdentifier(view.sessionKey),
      identity: summarizeSessionIdentity(view.identity),
      completeness: view.completeness,
    });
    return view;
  } catch (error) {
    logSessionTrace('session.lifecycle.error', traceId, {
      ...summarizeError(error),
    });
    throw resolveSessionViewError(error);
  }
}

function applyBackendSessionView(
  input: {
    set: ChatStoreSetFn;
    get: ChatStoreGetFn;
    sessionKey: string;
    view: ReturnType<typeof decodeHistorySessionView>;
  },
): void {
  const result = applySessionView({ set: input.set, get: input.get }, input.view);
  if (result.status === 'unavailable' || result.status === 'epoch-mismatch') {
    throw new Error('Session view is unavailable');
  }
  input.set((state) => {
    const loadedSessions = patchSessionMeta(state, input.sessionKey, { historyStatus: 'ready' });
    return {
      ...buildSessionRuntimeProjectionPatch({
        state,
        loadedSessions,
        currentConversation: state.currentSessionKey === input.sessionKey
          ? buildCurrentConversationForSessionKey(loadedSessions, input.sessionKey)
          : state.currentConversation,
      }),
      loadedSessions,
    };
  });
}

function shouldMarkSessionLoadingOnSwitch(
  sessionKey: string,
  sessionRecord: ReturnType<typeof resolveSessionRecord>,
): boolean {
  if (!sessionKey) {
    return false;
  }
  if (isRunActive(sessionRecord.runtime)) {
    return false;
  }
  return sessionRecord.meta.historyStatus !== 'ready' && getSessionItemCount(sessionRecord) === 0;
}

function summarizeSwitchSessionRecord(record: ReturnType<typeof resolveSessionRecord>) {
  return {
    historyStatus: record.meta.historyStatus,
    itemCount: getSessionItemCount(record),
    activeRun: isRunActive(record.runtime),
    endpointSessionId: summarizeIdentifier(record.meta.endpointSessionId),
    sessionIdentity: summarizeSessionIdentity(record.meta.sessionIdentity),
  };
}

export async function executeLoadSessions(input: CreateStoreSessionActionsInput): Promise<void> {
  const requestSequence = sessionCatalogLoadSequence + 1;
  sessionCatalogLoadSequence = requestSequence;
  await executeLoadSessionsNow(input, requestSequence);
}

async function executeLoadSessionsNow(
  input: CreateStoreSessionActionsInput,
  requestSequence: number,
): Promise<void> {
  const {
    set,
    get,
  } = input;
  const stateBeforeLoad = get();
  const previousResource = stateBeforeLoad.sessionCatalogStatus;
  const currentSessionKeyBeforeLoad = stateBeforeLoad.currentSessionKey;
  const currentConversationBeforeLoad = stateBeforeLoad.currentConversation;
  set({
    sessionCatalogStatus: createLoadingResourceStatusState(previousResource),
  });
  const targets = readSessionRuntimeTargets(stateBeforeLoad);
  if (targets.length === 0) {
    if (sessionCatalogLoadSequence !== requestSequence) {
      return;
    }
    set({
      sessionCatalogStatus: createErrorResourceStatusState(previousResource, 'Session runtime is not ready'),
    });
    return;
  }

  const results = await mapWithConcurrency(
    targets,
    SESSION_CATALOG_LIST_CONCURRENCY,
    loadEndpointSessionCatalog,
  );
  if (sessionCatalogLoadSequence !== requestSequence) {
    return;
  }
  const readyResults = results.filter((result) => result.ready);
  const mergedSessions = new Map<string, ChatSession>();
  for (const result of results) {
    for (const session of result.sessions) {
      if (isTombstonedCatalogSession(session)) {
        continue;
      }
      mergedSessions.set(session.key, session);
    }
  }
  const sessions = Array.from(mergedSessions.values());
  const errors = results.flatMap((result) => result.error ? [result.error] : []);

  if (readyResults.length === 0 && sessions.length === 0) {
    if (sessionCatalogLoadSequence !== requestSequence) {
      return;
    }
    clearSessionCatalogRetry();
    const message = errors[0] ?? 'Failed to load sessions';
    set((state) => {
      if (sessionCatalogLoadSequence !== requestSequence) {
        return state;
      }
      return {
        sessionCatalogStatus: createErrorResourceStatusState(state.sessionCatalogStatus, message),
        error: message,
      };
    });
    return;
  }

  if (sessionCatalogLoadSequence !== requestSequence) {
    return;
  }
  if (results.some((result) => !result.ready)) {
    scheduleSessionCatalogRetry(() => executeLoadSessions(input));
  } else {
    clearSessionCatalogRetry();
  }

  if (sessionCatalogLoadSequence !== requestSequence) {
    return;
  }
  const stateSnapshot = get();
  const { currentSessionKey } = stateSnapshot;
  const contextTarget = findRuntimeTargetForConversationContext(stateSnapshot);
  const contextSessions = contextTarget
    ? sessions.filter((session) => sameRuntimeEndpointScope(session.sessionIdentity.endpoint, contextTarget.endpoint))
    : sessions;
  const loadedAt = Date.now();
  const endpointRevisionByRuntimeScopeKey = useRuntimeEndpointsStore.getState().revisionByRuntimeScopeKey;
  const successfulRuntimeScopes = new Set(
    readyResults.map((result) => buildRuntimeScopeKey(result.target.defaultSessionPromptScope.endpoint)),
  );
  const contextCatalogLoaded = contextTarget
    ? successfulRuntimeScopes.has(buildRuntimeScopeKey(contextTarget.defaultSessionPromptScope.endpoint))
    : true;
  const hasSessionInBackend = (sessionKey: string): boolean => Boolean(sessionKey) && mergedSessions.has(sessionKey);
  let nextSessionKey = currentSessionKey;
  let shouldKeepMissingCurrent = false;
  if (nextSessionKey && !hasSessionInBackend(nextSessionKey)) {
    const currentMeta = getSessionMeta(stateSnapshot, nextSessionKey);
    const currentMatchesContext = !contextTarget || (currentMeta.sessionIdentity
      ? sameRuntimeEndpointScope(currentMeta.sessionIdentity.endpoint, contextTarget.endpoint)
      : false);
    shouldKeepMissingCurrent = currentMatchesContext && !contextCatalogLoaded && shouldKeepMissingCurrentSession(
      nextSessionKey,
      stateSnapshot,
      contextSessions.length,
    );
    if (!shouldKeepMissingCurrent) {
      nextSessionKey = '';
    }
  }
  const currentExistsInBackend = hasSessionInBackend(nextSessionKey);
  const shouldMarkCurrentAsReadyEmpty = (
    !currentExistsInBackend
    && shouldKeepMissingCurrent
    && contextSessions.length === 0
    && nextSessionKey.length > 0
  );
  set((state) => {
    if (sessionCatalogLoadSequence !== requestSequence) {
      return state;
    }
    const ownsCurrentSessionSelection = state.currentSessionKey === currentSessionKeyBeforeLoad
      && sameOptionalCurrentConversation(state.currentConversation, currentConversationBeforeLoad);
    const ownedNextSessionKey = ownsCurrentSessionSelection ? nextSessionKey : state.currentSessionKey;
    const sessionRecordKeys = new Set(sessions.map((session) => session.key));
    let loadedSessions = Object.fromEntries(
      Object.entries(state.loadedSessions).filter(([sessionKey, record]) => {
        const runtimeScope = record.meta.runtimeScopeKey;
        if (sessionRecordKeys.has(sessionKey)) {
          return true;
        }
        if (runtimeScope && !successfulRuntimeScopes.has(runtimeScope)) {
          return true;
        }
        return shouldRetainLocalSessionRecord(sessionKey, {
          currentSessionKey: ownedNextSessionKey,
          loadedSessions: state.loadedSessions,
          pendingApprovalsBySession: state.pendingApprovalsBySession,
        });
      }),
    );

    for (const session of sessions) {
      loadedSessions = ensureSessionRecordMap(loadedSessions, session.key);
      const currentMeta = getSessionMeta({ loadedSessions }, session.key);
      const explicitLabel = normalizeCatalogString(session.label);
      loadedSessions = patchSessionMeta({ loadedSessions }, session.key, {
        endpointSessionId: session.endpointSessionId ?? currentMeta.endpointSessionId,
        runtimeScopeKey: buildRuntimeScopeKey(session.sessionIdentity.endpoint),
        agentId: normalizeCatalogString(session.agentId) ?? currentMeta.agentId,
        protocolId: normalizeCatalogString(session.protocolId) ?? currentMeta.protocolId,
        runtimeEndpointId: normalizeCatalogString(session.runtimeEndpointId) ?? currentMeta.runtimeEndpointId,
        sessionIdentity: session.sessionIdentity,
        kind: session.kind ?? currentMeta.kind,
        preferred: session.preferred ?? currentMeta.preferred,
        label: explicitLabel && explicitLabel !== session.key && explicitLabel !== session.sessionIdentity.sessionKey ? explicitLabel : currentMeta.label,
        titleSource: session.titleSource ?? currentMeta.titleSource,
        displayName: normalizeCatalogString(session.displayName) ?? currentMeta.displayName ?? null,
        thinkingLevel: normalizeCatalogString(session.thinkingLevel) ?? currentMeta.thinkingLevel,
        modelState: session.modelState ?? currentMeta.modelState,
        lastActivityAt: typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
          ? session.updatedAt
          : currentMeta.lastActivityAt,
      });
      loadedSessions = patchSessionRecord({ loadedSessions }, session.key, {
        contextTokens: session.contextTokens,
      });
    }

    let lastSelectedSessionKeyByRuntimeScopeKey = state.lastSelectedSessionKeyByRuntimeScopeKey;
    for (const [runtimeScopeKey, sessionKey] of Object.entries(lastSelectedSessionKeyByRuntimeScopeKey)) {
      if (loadedSessions[sessionKey]) {
        continue;
      }
      if (lastSelectedSessionKeyByRuntimeScopeKey === state.lastSelectedSessionKeyByRuntimeScopeKey) {
        lastSelectedSessionKeyByRuntimeScopeKey = { ...lastSelectedSessionKeyByRuntimeScopeKey };
      }
      delete lastSelectedSessionKeyByRuntimeScopeKey[runtimeScopeKey];
    }

    if (ownsCurrentSessionSelection && shouldMarkCurrentAsReadyEmpty) {
      loadedSessions = ensureSessionRecordMap(loadedSessions, nextSessionKey);
      loadedSessions = patchSessionMeta({ loadedSessions }, nextSessionKey, { historyStatus: 'ready' });
    }

    const sessionRuntimeGraph = buildSessionRuntimeGraph(state.sessionRuntimeCatalog, loadedSessions);
    const ownedCurrentConversation = ownsCurrentSessionSelection
      ? resolveCurrentConversationAfterSessionCatalogLoad({
          previousConversation: state.currentConversation,
          currentSessionKey: ownedNextSessionKey,
          contextTarget,
          graph: sessionRuntimeGraph,
          loadedSessions,
          lastSelectedSessionKeyByRuntimeScopeKey,
        })
      : state.currentConversation;
    const retainedSessionKeys = new Set(Object.keys(loadedSessions));
    const sessionCatalogLoadedAtByRuntimeScopeKey = {
      ...state.sessionCatalogLoadedAtByRuntimeScopeKey,
    };
    const sessionCatalogLoadedRevisionByRuntimeScopeKey = {
      ...state.sessionCatalogLoadedRevisionByRuntimeScopeKey,
    };
    for (const runtimeScopeKey of successfulRuntimeScopes) {
      sessionCatalogLoadedAtByRuntimeScopeKey[runtimeScopeKey] = loadedAt;
      sessionCatalogLoadedRevisionByRuntimeScopeKey[runtimeScopeKey] = endpointRevisionByRuntimeScopeKey[runtimeScopeKey] ?? 0;
    }
    let lastSelectedSessionPatch: Pick<ChatStoreState, 'lastSelectedSessionKeyByRuntimeScopeKey'> = {
      lastSelectedSessionKeyByRuntimeScopeKey,
    };
    if (ownsCurrentSessionSelection && ownedCurrentConversation?.kind === 'session') {
      lastSelectedSessionPatch = buildLastSelectedSessionPatchForEndpoint(
        { ...state, lastSelectedSessionKeyByRuntimeScopeKey },
        ownedCurrentConversation.endpoint,
        ownedCurrentConversation.sessionRecordKey,
      );
    }
    return {
      ...(ownsCurrentSessionSelection && contextTarget ? buildRuntimeCatalogContextPatch(state, contextTarget) : {}),
      sessionCatalogStatus: createReadyResourceStatusState(loadedAt),
      sessionCatalogLoadedAtByRuntimeScopeKey,
      sessionCatalogLoadedRevisionByRuntimeScopeKey,
      ...lastSelectedSessionPatch,
      currentSessionKey: ownedCurrentConversation?.kind === 'session' ? ownedCurrentConversation.sessionRecordKey : '',
      currentConversation: ownedCurrentConversation,
      sessionRuntimeGraph,
      loadedSessions,
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      pendingApprovalsBySession: Object.fromEntries(
        Object.entries(state.pendingApprovalsBySession).filter(([sessionKey]) => retainedSessionKeys.has(sessionKey)),
      ),
      error: errors[0] ?? state.error,
    };
  });
}

export function executeOpenAgentConversation(input: CreateStoreSessionActionsInput, agentId: string): void {
  const { get, set } = input;
  const normalized = agentId.trim();
  if (!normalized) {
    return;
  }
  const traceId = createSessionTraceId('open-agent');
  const state = get();
  const contextEndpoint = state.currentConversation?.endpoint
    ?? getSessionMeta(state, state.currentSessionKey).sessionIdentity?.endpoint
    ?? state.sessionRuntimeCatalog.defaultSessionPromptScope?.endpoint;
  if (!contextEndpoint) {
    return;
  }
  const preferredSession = findPreferredSessionForAgent(state.sessionRuntimeGraph, contextEndpoint, normalized);
  logSessionTrace('open-agent.request', traceId, {
    agentId: summarizeIdentifier(normalized),
    preferredSessionKey: summarizeIdentifier(preferredSession?.sessionRecordKey),
    currentSessionKey: summarizeIdentifier(state.currentSessionKey),
  });
  if (preferredSession) {
    get().switchSession(preferredSession.sessionRecordKey, traceId);
    return;
  }
  const target = findRuntimeTargetForEndpoint(readSessionRuntimeTargets(state), contextEndpoint);
  if (!target) {
    return;
  }
  const draftScope = resolveScopeForAgent(target, normalized);
  set((stateValue) => ({
    ...buildRuntimeCatalogContextPatch(stateValue, target),
    currentSessionKey: '',
    currentConversation: createDraftCurrentConversation(draftScope.endpoint, draftScope.agentId),
    error: null,
  }));
}

export function executeOpenSessionIdentity(
  input: CreateStoreSessionActionsInput,
  target: { sessionIdentity: SessionIdentity; endpointSessionId?: string | null },
): void {
  const { get, set } = input;
  const traceId = createSessionTraceId('open-session-identity');
  const identity = target.sessionIdentity;
  const endpointSessionId = normalizeCatalogString(target.endpointSessionId ?? undefined);
  const recordKey = findSessionRecordKey(get(), identity) ?? buildSessionRecordKey(identity);
  const existing = get().loadedSessions[recordKey];
  logSessionTrace('open-session-identity.request', traceId, {
    recordKey: summarizeIdentifier(recordKey),
    endpointSessionId: summarizeIdentifier(endpointSessionId),
    sessionIdentity: summarizeSessionIdentity(identity),
    existing: Boolean(existing),
  });
  set((state) => {
    const currentMeta = getSessionMeta(state, recordKey);
    const loadedSessions = patchSessionMeta({
      loadedSessions: ensureSessionRecordMap(state.loadedSessions, recordKey),
    }, recordKey, {
      endpointSessionId: endpointSessionId ?? currentMeta.endpointSessionId,
      runtimeScopeKey: buildRuntimeScopeKey(identity.endpoint),
      agentId: identity.agentId,
      sessionIdentity: identity,
      kind: currentMeta.kind ?? 'session',
      preferred: currentMeta.preferred,
      historyStatus: existing ? currentMeta.historyStatus : 'loading',
    });
    const currentSessionKey = existing ? state.currentSessionKey : recordKey;
    const currentConversation = existing
      ? state.currentConversation
      : buildCurrentConversationForSessionKey(loadedSessions, recordKey);
    return {
      ...(existing ? {} : buildRuntimeCatalogContextPatchForEndpoint(state, identity.endpoint)),
      ...(existing ? {} : buildLastSelectedSessionPatchForEndpoint(state, identity.endpoint, recordKey)),
      ...buildSessionRuntimeProjectionPatch({
        state,
        loadedSessions,
        currentSessionKey,
        currentConversation,
      }),
      loadedSessions,
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      currentSessionKey,
      error: null,
    };
  });
  if (existing) {
    set((state) => buildRuntimeCatalogContextPatchForEndpoint(state, identity.endpoint));
    get().switchSession(recordKey, traceId);
    return;
  }
  void get().loadHistory({
    sessionKey: recordKey,
    mode: 'active',
    scope: 'foreground',
    reason: 'open_session_identity',
    traceId,
  });
}

export function executeSelectSessionRuntimeEndpoint(
  input: CreateStoreSessionActionsInput,
  endpoint: RuntimeEndpointRef,
): void {
  const { get, set, historyRuntime } = input;
  const state = get();
  const target = findRuntimeTargetForEndpoint(readSessionRuntimeTargets(state), endpoint);
  if (!target) {
    return;
  }
  const currentSessionKey = state.currentSessionKey;
  const existingSessionKey = findExistingSessionKeyForRuntimeEndpoint(state, endpoint);
  if (existingSessionKey && existingSessionKey !== currentSessionKey) {
    executeSwitchSession(input, existingSessionKey, createSessionTraceId('select-runtime'));
    return;
  }
  if (existingSessionKey) {
    set((stateValue) => ({
      ...buildRuntimeCatalogContextPatch(stateValue, target),
      ...buildLastSelectedSessionPatchForEndpoint(stateValue, endpoint, existingSessionKey),
      currentSessionKey: existingSessionKey,
      currentConversation: buildCurrentConversationForSessionKey(stateValue.loadedSessions, existingSessionKey),
      error: null,
    }));
    return;
  }

  clearHistoryPoll();
  clearErrorRecoveryTimer();
  const leavingEmpty = isTrulyEmptyNonMainSession(currentSessionKey, state);
  let loadedSessions = state.loadedSessions;
  if (leavingEmpty) {
    clearSessionHistoryFingerprints(historyRuntime, currentSessionKey);
    loadedSessions = removeSessionRecord(state, currentSessionKey);
  }
  set((stateValue) => ({
    ...buildRuntimeCatalogContextPatch(stateValue, target),
    ...buildSessionRuntimeProjectionPatch({
      state: stateValue,
      loadedSessions,
      currentSessionKey: '',
      currentConversation: createDraftCurrentConversation(target.defaultSessionPromptScope.endpoint, target.defaultSessionPromptScope.agentId),
    }),
    currentSessionKey: '',
    loadedSessions,
    sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
    foregroundHistorySessionKey: null,
    pendingApprovalsBySession: leavingEmpty
      ? Object.fromEntries(
          Object.entries(stateValue.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== currentSessionKey),
        )
      : stateValue.pendingApprovalsBySession,
    error: null,
  }));
}

export function executeSwitchSession(input: CreateStoreSessionActionsInput, key: string, inheritedTraceId?: string | null): void {
  const { set, get, historyRuntime } = input;
  const traceId = inheritedTraceId ?? createSessionTraceId('switch-session');
  const currentState = get();
  const requestedRecord = currentState.loadedSessions[key];
  logSessionTrace('switch-session.request', traceId, {
    requestedSessionKey: summarizeIdentifier(key),
    currentSessionKey: summarizeIdentifier(currentState.currentSessionKey),
    targetRecord: requestedRecord ? summarizeSwitchSessionRecord(resolveSessionRecord(requestedRecord)) : null,
  });
  if (key === currentState.currentSessionKey) {
    logSessionTrace('switch-session.branch', traceId, { branch: 'same-current' });
    const targetEndpoint = getSessionMeta(currentState, key).sessionIdentity?.endpoint;
    if (targetEndpoint) {
      set((stateValue) => ({
        ...buildRuntimeCatalogContextPatchForEndpoint(stateValue, targetEndpoint),
        ...buildLastSelectedSessionPatchForEndpoint(stateValue, targetEndpoint, key),
        currentConversation: buildCurrentConversationForSessionKey(stateValue.loadedSessions, key),
      }));
    }
    void (async () => {
      try {
        const target = resolveOperationTarget(get(), key);
        logSessionTrace('switch-session.lifecycle-target', traceId, {
          sessionKey: summarizeIdentifier(target.sessionKey),
          endpointSessionId: summarizeIdentifier(target.endpointSessionId),
          sessionIdentity: summarizeSessionIdentity(target.sessionIdentity),
        });
        const result = await requestSessionLifecycleView(target, traceId);
        if (get().currentSessionKey !== key) {
          logSessionTrace('switch-session.lifecycle-stale', traceId, {
            requestedSessionKey: summarizeIdentifier(key),
            currentSessionKey: summarizeIdentifier(get().currentSessionKey),
          });
          return;
        }
        applyBackendSessionView({
          set,
          get,
          sessionKey: key,
          view: result,
        });
        logSessionTrace('switch-session.lifecycle-applied', traceId, {
          requestedSessionKey: summarizeIdentifier(key),
          targetRecord: summarizeSwitchSessionRecord(resolveSessionRecord(get().loadedSessions[key])),
        });
      } catch (error) {
        const starting = isSessionEndpointStarting(get(), key);
        logSessionTrace('switch-session.lifecycle-error', traceId, {
          requestedSessionKey: summarizeIdentifier(key),
          starting,
          ...summarizeError(error),
        });
        set((state) => {
          const loadedSessions = patchSessionMeta(state, key, { historyStatus: starting ? 'loading' : 'ready' });
          return {
            ...buildSessionRuntimeProjectionPatch({ state, loadedSessions }),
            error: starting ? null : resolveSessionViewError(error).message,
            loadedSessions,
          };
        });
      }
    })();
    return;
  }
  clearHistoryPoll();
  clearErrorRecoveryTimer();
  const state = get();
  const { currentSessionKey } = state;
  const leavingEmpty = isTrulyEmptyNonMainSession(currentSessionKey, state);
  let nextloadedSessions = { ...state.loadedSessions };
  if (leavingEmpty) {
    clearSessionHistoryFingerprints(historyRuntime, currentSessionKey);
    nextloadedSessions = removeSessionRecord({ loadedSessions: nextloadedSessions }, currentSessionKey);
  }
  nextloadedSessions = ensureSessionRecordMap(nextloadedSessions, key);
  let targetRecord = resolveSessionRecord(nextloadedSessions[key]);
  if (shouldMarkSessionLoadingOnSwitch(key, targetRecord)) {
    nextloadedSessions = patchSessionMeta({ loadedSessions: nextloadedSessions }, key, {
      historyStatus: 'loading',
    });
    targetRecord = resolveSessionRecord(nextloadedSessions[key]);
  }
  const targetSessionReady = targetRecord.meta.historyStatus === 'ready' || getSessionItemCount(targetRecord) > 0;
  logSessionTrace('switch-session.branch', traceId, {
    branch: 'different-current',
    leavingEmpty,
    targetSessionReady,
    targetRecord: summarizeSwitchSessionRecord(targetRecord),
  });

  set((stateValue) => {
    const targetMeta = getSessionMeta({ loadedSessions: nextloadedSessions }, key);
    const targetEndpoint = targetMeta.sessionIdentity?.endpoint;
    return {
      ...(targetEndpoint ? buildRuntimeCatalogContextPatchForEndpoint(stateValue, targetEndpoint) : {}),
      ...(targetEndpoint ? buildLastSelectedSessionPatchForEndpoint(stateValue, targetEndpoint, key) : {}),
      ...buildSessionRuntimeProjectionPatch({
        state: stateValue,
        loadedSessions: nextloadedSessions,
        currentSessionKey: key,
        currentConversation: buildCurrentConversationForSessionKey(nextloadedSessions, key),
      }),
      sessionCatalogStatus: stateValue.sessionCatalogStatus,
      currentSessionKey: key,
      error: null,
      loadedSessions: nextloadedSessions,
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(nextloadedSessions),
      ...(leavingEmpty ? {
        pendingApprovalsBySession: Object.fromEntries(
          Object.entries(stateValue.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== currentSessionKey),
        ),
      } : {}),
    };
  });
  logSessionTrace('switch-session.state-applied', traceId, {
    requestedSessionKey: summarizeIdentifier(key),
    currentSessionKey: summarizeIdentifier(get().currentSessionKey),
    targetRecord: summarizeSwitchSessionRecord(resolveSessionRecord(get().loadedSessions[key])),
  });

  resumeActiveStoreSend({ set, get, sessionKey: key });

  void (async () => {
    try {
      const target = resolveOperationTarget(get(), key);
      logSessionTrace('switch-session.lifecycle-target', traceId, {
        sessionKey: summarizeIdentifier(target.sessionKey),
        endpointSessionId: summarizeIdentifier(target.endpointSessionId),
        sessionIdentity: summarizeSessionIdentity(target.sessionIdentity),
      });
      const result = await requestSessionLifecycleView(target, traceId);
      if (get().currentSessionKey !== key) {
        logSessionTrace('switch-session.lifecycle-stale', traceId, {
          requestedSessionKey: summarizeIdentifier(key),
          currentSessionKey: summarizeIdentifier(get().currentSessionKey),
        });
        return;
      }
      applyBackendSessionView({
        set,
        get,
        sessionKey: key,
        view: result,
      });
      logSessionTrace('switch-session.lifecycle-applied', traceId, {
        requestedSessionKey: summarizeIdentifier(key),
        targetRecord: summarizeSwitchSessionRecord(resolveSessionRecord(get().loadedSessions[key])),
      });
    } catch (error) {
      if (get().currentSessionKey !== key) {
        logSessionTrace('switch-session.lifecycle-error-stale', traceId, {
          requestedSessionKey: summarizeIdentifier(key),
          currentSessionKey: summarizeIdentifier(get().currentSessionKey),
          ...summarizeError(error),
        });
        return;
      }
      const starting = isSessionEndpointStarting(get(), key);
      logSessionTrace('switch-session.lifecycle-error', traceId, {
        requestedSessionKey: summarizeIdentifier(key),
        starting,
        targetSessionReady,
        ...summarizeError(error),
      });
      set((state) => {
        const loadedSessions = patchSessionMeta(state, key, {
          historyStatus: starting ? 'loading' : targetSessionReady ? 'ready' : 'error',
        });
        return {
          ...buildSessionRuntimeProjectionPatch({ state, loadedSessions }),
          error: starting ? null : resolveSessionViewError(error).message,
          loadedSessions,
        };
      });
    }
  })();
}

export async function executeLoadOlderViewportItems(
  input: CreateStoreSessionActionsInput,
  sessionKeyHint?: string,
): Promise<void> {
  const { set, get } = input;
  await executeViewportWindowLoad({ set, get }, {
    sessionKey: sessionKeyHint?.trim() || get().currentSessionKey,
    mode: 'older',
  });
}

export async function executeJumpViewportToLatest(
  input: CreateStoreSessionActionsInput,
  sessionKeyHint?: string,
): Promise<void> {
  const { set, get } = input;
  await executeViewportWindowLoad({ set, get }, {
    sessionKey: sessionKeyHint?.trim() || get().currentSessionKey,
    mode: 'latest',
  });
}

export function executeSetViewportAnchorItemKey(
  input: CreateStoreSessionActionsInput,
  itemKey: string | null,
  sessionKeyHint?: string,
): void {
  const { set, get } = input;
  const sessionKey = sessionKeyHint?.trim() || get().currentSessionKey;
  set((state) => ({
    loadedSessions: patchSessionViewportState(state, sessionKey, {
      ...getSessionViewportState(state, sessionKey),
      anchorItemKey: itemKey,
    }),
  }));
}

export function executeForgetAgentSessions(input: CreateStoreSessionActionsInput, agentId: string): void {
  const normalizedAgentId = normalizeAgentSessionTombstoneId(agentId);
  if (!normalizedAgentId) {
    return;
  }
  forgottenAgentSessionIds.add(normalizedAgentId);
  useComposerDraftStore.getState().clearAgentDrafts(agentId);
  const { set, get, historyRuntime } = input;
  const state = get();
  const removedSessionKeys = new Set(
    Object.entries(state.loadedSessions)
      .filter(([, record]) => isAgentSessionRecord(record, normalizedAgentId))
      .map(([sessionKey]) => sessionKey),
  );
  const currentConversationMatchesDeletedAgent = normalizeAgentSessionTombstoneId(state.currentConversation?.agentId) === normalizedAgentId;
  if (removedSessionKeys.size === 0 && !currentConversationMatchesDeletedAgent) {
    return;
  }
  for (const sessionKey of removedSessionKeys) {
    clearSessionHistoryFingerprints(historyRuntime, sessionKey);
    resetSessionProjection(sessionKey);
    useComposerDraftStore.getState().clearDraft(sessionKey);
  }
  const removedCurrentRecord = removedSessionKeys.has(state.currentSessionKey)
    ? state.loadedSessions[state.currentSessionKey]
    : null;
  const removedCurrentEndpoint = removedCurrentRecord?.meta.sessionIdentity?.endpoint
    ?? (currentConversationMatchesDeletedAgent ? state.currentConversation?.endpoint : null)
    ?? null;
  if (removedCurrentRecord || currentConversationMatchesDeletedAgent) {
    clearHistoryPoll();
    clearErrorRecoveryTimer();
  }
  set((stateValue) => {
    const loadedSessions = Object.fromEntries(
      Object.entries(stateValue.loadedSessions).filter(([sessionKey]) => !removedSessionKeys.has(sessionKey)),
    );
    const retainedSessionKeys = new Set(Object.keys(loadedSessions));
    let lastSelectedSessionKeyByRuntimeScopeKey = stateValue.lastSelectedSessionKeyByRuntimeScopeKey;
    for (const [runtimeScopeKey, sessionKey] of Object.entries(lastSelectedSessionKeyByRuntimeScopeKey)) {
      if (!removedSessionKeys.has(sessionKey)) {
        continue;
      }
      if (lastSelectedSessionKeyByRuntimeScopeKey === stateValue.lastSelectedSessionKeyByRuntimeScopeKey) {
        lastSelectedSessionKeyByRuntimeScopeKey = { ...lastSelectedSessionKeyByRuntimeScopeKey };
      }
      delete lastSelectedSessionKeyByRuntimeScopeKey[runtimeScopeKey];
    }
    const currentWasRemoved = removedSessionKeys.has(stateValue.currentSessionKey);
    const currentConversationWasRemoved = normalizeAgentSessionTombstoneId(stateValue.currentConversation?.agentId) === normalizedAgentId;
    const sessionRuntimeGraph = buildSessionRuntimeGraph(stateValue.sessionRuntimeCatalog, loadedSessions);
    let nextSessionKey = stateValue.currentSessionKey;
    let currentConversation = stateValue.currentConversation;
    let runtimeCatalogPatch: Pick<ChatStoreState, 'sessionRuntimeCatalog'> = {
      sessionRuntimeCatalog: stateValue.sessionRuntimeCatalog,
    };
    if (currentWasRemoved || currentConversationWasRemoved) {
      const endpoint = removedCurrentEndpoint;
      const next = endpoint
        ? readSessionsFromState({ loadedSessions }).find((session) => sameRuntimeEndpointScope(
            session.sessionIdentity.endpoint,
            endpoint,
          ))
        : null;
      const targetRuntime = endpoint ? findRuntimeTargetForEndpoint(readSessionRuntimeTargets(stateValue), endpoint) : null;
      nextSessionKey = next?.key ?? '';
      currentConversation = next
        ? buildCurrentConversationForSessionKey(loadedSessions, next.key)
        : targetRuntime
          ? createDraftCurrentConversation(
              targetRuntime.defaultSessionPromptScope.endpoint,
              targetRuntime.defaultSessionPromptScope.agentId,
            )
          : null;
      runtimeCatalogPatch = targetRuntime ? buildRuntimeCatalogContextPatch(stateValue, targetRuntime) : runtimeCatalogPatch;
      if (next && endpoint) {
        const runtimeScopeKey = buildRuntimeScopeKey(endpoint);
        lastSelectedSessionKeyByRuntimeScopeKey = {
          ...lastSelectedSessionKeyByRuntimeScopeKey,
          [runtimeScopeKey]: next.key,
        };
      }
    }
    return {
      ...runtimeCatalogPatch,
      sessionRuntimeGraph,
      currentSessionKey: nextSessionKey,
      currentConversation,
      loadedSessions,
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      pendingApprovalsBySession: Object.fromEntries(
        Object.entries(stateValue.pendingApprovalsBySession).filter(([sessionKey]) => retainedSessionKeys.has(sessionKey)),
      ),
      dismissedRuntimeErrorBySession: Object.fromEntries(
        Object.entries(stateValue.dismissedRuntimeErrorBySession).filter(([sessionKey]) => retainedSessionKeys.has(sessionKey)),
      ),
      lastSelectedSessionKeyByRuntimeScopeKey,
      foregroundHistorySessionKey: removedSessionKeys.has(stateValue.foregroundHistorySessionKey ?? '')
        ? null
        : stateValue.foregroundHistorySessionKey,
      error: null,
    };
  });
}

export async function executeDeleteSession(input: CreateStoreSessionActionsInput, key: string): Promise<void> {
  const {
    set,
    get,
    beginMutating,
    finishMutating,
    historyRuntime,
  } = input;
  beginMutating();
  try {
    const target = resolveOperationTarget(get(), key);
    let receipt: SessionDeleteReceipt;
    try {
      receipt = await hostSessionDelete({
        sessionIdentity: target.sessionIdentity,
      }) as unknown as SessionDeleteReceipt;
    } catch {
      throw new Error(SESSION_DELETE_UNAVAILABLE_ERROR);
    }
    if (receipt.outcome !== 'succeeded') {
      return;
    }

    const { currentSessionKey } = get();
    const sessions = readSessionsFromState(get());
    const remainingSessions = sessions.filter((session) => session.key !== key);
    clearSessionHistoryFingerprints(historyRuntime, key);

    if (currentSessionKey === key) {
      clearHistoryPoll();
      clearErrorRecoveryTimer();
      const next = remainingSessions.find((session) => sameRuntimeEndpointScope(
        session.sessionIdentity.endpoint,
        target.sessionIdentity.endpoint,
      ));
      set((state) => {
        const loadedSessions = removeSessionRecord(state, key);
        const targetRuntime = findRuntimeTargetForEndpoint(readSessionRuntimeTargets(state), target.sessionIdentity.endpoint);
        const currentConversation = next
          ? buildCurrentConversationForSessionKey(loadedSessions, next.key)
          : createDraftCurrentConversation(
              targetRuntime?.defaultSessionPromptScope.endpoint ?? target.sessionIdentity.endpoint,
              targetRuntime?.defaultSessionPromptScope.agentId ?? target.sessionIdentity.agentId,
            );
        return {
          ...(targetRuntime ? buildRuntimeCatalogContextPatch(state, targetRuntime) : {}),
          ...buildLastSelectedSessionPatchAfterRemoval(state, key, {
            endpoint: target.sessionIdentity.endpoint,
            sessionKey: next?.key ?? null,
          }),
          ...buildSessionRuntimeProjectionPatch({
            state,
            loadedSessions,
            currentSessionKey: next?.key ?? '',
            currentConversation,
          }),
          loadedSessions,
          sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
          sessionCatalogStatus: state.sessionCatalogStatus,
          pendingApprovalsBySession: Object.fromEntries(
            Object.entries(state.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== key),
          ),
          error: null,
          currentSessionKey: next?.key ?? '',
        };
      });
      if (next) {
        try {
          const nextTarget = resolveOperationTarget(get(), next.key);
          const result = await requestSessionLifecycleView(nextTarget);
          if (get().currentSessionKey === next.key) {
            applyBackendSessionView({
              set,
              get,
              sessionKey: next.key,
              view: result,
            });
          }
        } catch (error) {
          if (get().currentSessionKey === next.key) {
            set((state) => {
              const loadedSessions = patchSessionMeta(state, next.key, {
                historyStatus: 'error',
              });
              return {
                ...buildSessionRuntimeProjectionPatch({ state, loadedSessions }),
                error: resolveSessionViewError(error).message,
                loadedSessions,
              };
            });
          }
        }
      }
      await get().loadSessions();
      return;
    }

    set((state) => {
      const loadedSessions = removeSessionRecord(state, key);
      return {
        ...buildLastSelectedSessionPatchAfterRemoval(state, key),
        ...buildSessionRuntimeProjectionPatch({ state, loadedSessions }),
        loadedSessions,
        sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
        sessionCatalogStatus: state.sessionCatalogStatus,
        pendingApprovalsBySession: Object.fromEntries(
          Object.entries(state.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== key),
        ),
      };
    });
    await get().loadSessions();
  } finally {
    finishMutating();
  }
}

export async function executeRenameSession(
  input: RenameStoreSessionInput,
  key: string,
  label: string,
): Promise<void> {
  const normalizedLabel = label.trim();
  if (!key.trim()) {
    return;
  }
  if (!normalizedLabel) {
    throw new Error('Session label cannot be empty');
  }

  input.beginMutating();
  try {
    const target = resolveOperationTarget(input.get(), key);
    const result = await input.renameSession({
      sessionIdentity: target.sessionIdentity,
      label: normalizedLabel,
    });
    if (result.success === false) {
      throw new Error(result.error || 'Failed to rename session');
    }
    input.set((state) => {
      const loadedSessions = patchSessionMeta(state, key, {
        label: normalizedLabel,
        titleSource: 'user',
        manualLabel: true,
      });
      return {
        ...buildSessionRuntimeProjectionPatch({ state, loadedSessions }),
        loadedSessions,
        sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      };
    });
  } finally {
    input.finishMutating();
  }
}

type NewSessionAgentScopeResolver = (state: ChatStoreState) => AgentScope;

function isLatestNewSessionRequest(requestSequence: number): boolean {
  return newSessionRequestSequence === requestSequence;
}

async function executeNewSessionWithScopeResolver(
  input: CreateStoreSessionActionsInput,
  resolveAgentScope: NewSessionAgentScopeResolver,
  inheritedTraceId?: string | null,
): Promise<void> {
  const {
    set,
    get,
    beginMutating,
    finishMutating,
    historyRuntime,
  } = input;
  const requestSequence = newSessionRequestSequence + 1;
  newSessionRequestSequence = requestSequence;
  const traceId = inheritedTraceId ?? createSessionTraceId('new-session');
  beginMutating();
  try {
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    const state = get();
    const { currentSessionKey } = state;
    const leavingEmpty = isTrulyEmptyNonMainSession(currentSessionKey, state);
    if (leavingEmpty) {
      clearSessionHistoryFingerprints(historyRuntime, currentSessionKey);
    }
    const agentScope = resolveAgentScope(state);
    logSessionTrace('new-session.request', traceId, {
      endpoint: summarizeEndpoint(agentScope.endpoint),
      agentId: summarizeIdentifier(agentScope.agentId),
      currentSessionKey: summarizeIdentifier(currentSessionKey),
    });
    const rawCreated = await hostSessionNew({
      endpoint: agentScope.endpoint,
      agentId: agentScope.agentId,
    }, { traceId }) as unknown;
    if (
      rawCreated
      && typeof rawCreated === 'object'
      && !Array.isArray(rawCreated)
      && 'outcome' in rawCreated
      && typeof rawCreated.outcome === 'string'
    ) {
      throw new Error(`Session create ${rawCreated.outcome}`);
    }
    const created = decodeHistorySessionView(rawCreated);
    logSessionTrace('new-session.response', traceId, {
      sessionKey: summarizeIdentifier(created.sessionKey),
      identity: summarizeSessionIdentity(created.identity),
      completeness: created.completeness,
    });
    const createdAgentId = created.identity.agentId;
    if (!createdAgentId) {
      throw new Error('Session view identity is incomplete');
    }
    const createdEndpoint = created.identity.endpoint;
    const newKey = buildSessionRecordKey({
      endpoint: createdEndpoint,
      agentId: createdAgentId,
      sessionKey: created.sessionKey,
    });
    const stateBeforeProjection = get();
    const ownsSelection = isLatestNewSessionRequest(requestSequence);
    const baseLoadedSessions = ownsSelection && leavingEmpty
      ? removeSessionRecord(stateBeforeProjection, currentSessionKey)
      : stateBeforeProjection.loadedSessions;
    set({
      loadedSessions: baseLoadedSessions[newKey]
        ? baseLoadedSessions
        : { ...baseLoadedSessions, [newKey]: createEmptySessionRecord() },
    });
    const projection = applySessionView({ set, get }, created);
    if (projection.status !== 'applied') {
      throw new Error(`Session create projection ${projection.status}`);
    }
    set((stateValue) => {
      const loadedSessions = patchSessionMeta(
        { loadedSessions: stateValue.loadedSessions },
        newKey,
        { historyStatus: 'ready' },
      );
      const selectedSessionKey = ownsSelection ? newKey : stateValue.currentSessionKey;
      return {
        ...(ownsSelection ? buildRuntimeCatalogContextPatchForEndpoint(stateValue, createdEndpoint) : {}),
        ...(ownsSelection ? buildLastSelectedSessionPatchForEndpoint(stateValue, createdEndpoint, newKey) : {}),
        ...buildSessionRuntimeProjectionPatch({
          state: stateValue,
          loadedSessions,
          currentSessionKey: selectedSessionKey,
          currentConversation: ownsSelection
            ? buildCurrentConversationForSessionKey(loadedSessions, newKey)
            : stateValue.currentConversation,
        }),
        loadedSessions,
        sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
        sessionCatalogStatus: stateValue.sessionCatalogStatus,
        currentSessionKey: selectedSessionKey,
        pendingApprovalsBySession: ownsSelection && leavingEmpty
          ? Object.fromEntries(
              Object.entries(stateValue.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== currentSessionKey),
            )
          : stateValue.pendingApprovalsBySession,
        error: ownsSelection ? null : stateValue.error,
      };
    });
  } catch (error) {
    logSessionTrace('new-session.error', traceId, {
      ...summarizeError(error),
    });
    if (isLatestNewSessionRequest(requestSequence)) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    finishMutating();
  }
}

export async function executeNewSession(input: CreateStoreSessionActionsInput, agentId?: string, traceId?: string | null): Promise<void> {
  await executeNewSessionWithScopeResolver(input, (state) => resolveNewSessionAgentScope(state, agentId), traceId);
}

export async function executeNewSessionForScope(
  input: CreateStoreSessionActionsInput,
  scope: AgentScope,
): Promise<void> {
  await executeNewSessionWithScopeResolver(input, () => scope);
}

export function executeCleanupEmptySession(input: CreateStoreSessionActionsInput): void {
  const { set, get, historyRuntime } = input;
  const state = get();
  const { currentSessionKey } = state;
  const isEmptyNonMain = isTrulyEmptyNonMainSession(currentSessionKey, state);
  if (!isEmptyNonMain) return;
  clearSessionHistoryFingerprints(historyRuntime, currentSessionKey);
  set((stateValue) => {
    const loadedSessions = removeSessionRecord(stateValue, currentSessionKey);
    return {
      ...buildSessionRuntimeProjectionPatch({ state: stateValue, loadedSessions }),
      loadedSessions,
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      sessionCatalogStatus: stateValue.sessionCatalogStatus,
      pendingApprovalsBySession: Object.fromEntries(
        Object.entries(stateValue.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== currentSessionKey),
      ),
    };
  });
}
