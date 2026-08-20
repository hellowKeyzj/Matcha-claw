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
  resolvePreferredSessionKeyForAgent,
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
import { pickStartupSessionFallback } from './session-selection';
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
import type { StoreHistoryCache } from './history-cache';
import type {
  AgentScope,
  SessionIdentity,
} from '../../../electron/desktop-contract/runtime-address';
import type {
  ChatSession,
  ChatSessionRuntimeEndpointTarget,
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
  defaultSessionKey: string;
  historyRuntime: StoreHistoryCache;
}

interface RenameStoreSessionInput extends CreateStoreSessionActionsInput {
  renameSession: (payload: { sessionKey: string; sessionIdentity: SessionIdentity; label: string }) => Promise<{ success: boolean; error?: string }>;
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
    backendSessionKey: session.key,
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
        backendSessionKey: session.key || '',
        agentId: typeof session.agentId === 'string' ? session.agentId : '',
        protocolId: typeof session.protocolId === 'string' ? session.protocolId : undefined,
        runtimeEndpointId: typeof session.runtimeEndpointId === 'string' ? session.runtimeEndpointId : undefined,
        endpointSessionId: typeof session.endpointSessionId === 'string' ? session.endpointSessionId : undefined,
        sessionIdentity: session.sessionIdentity,
        kind: session.kind === 'main' || session.kind === 'subsession' || session.kind === 'session' || session.kind === 'named'
          ? session.kind
          : undefined,
        preferred: session.preferred === true,
        label: typeof session.label === 'string' ? session.label : undefined,
        titleSource: session.titleSource === 'user' || session.titleSource === 'assistant' || session.titleSource === 'none'
          ? session.titleSource
          : undefined,
        displayName: typeof session.displayName === 'string' ? session.displayName : undefined,
        model: normalizeCatalogString(session.model) ?? undefined,
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
  identity: SessionIdentity,
): ChatSessionRuntimeEndpointTarget | null {
  return targets.find((target) => sameRuntimeEndpointScope(target.endpoint, identity.endpoint)) ?? null;
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
  const targetEndpoint = currentMeta.sessionIdentity
    ? findRuntimeTargetForEndpoint(targets, currentMeta.sessionIdentity)
    : null;
  const defaultScope = state.sessionRuntimeCatalog.defaultSessionPromptScope;
  const defaultEndpoint = defaultScope
    ? targets.find((target) => target.sessionPromptScopes.some((scope) => scope === defaultScope || (scope.agentId === defaultScope.agentId && sameRuntimeEndpointScope(scope.endpoint, defaultScope.endpoint)))) ?? null
    : null;
  const target = targetEndpoint ?? defaultEndpoint ?? targets[0]!;
  const targetAgentId = agentId?.trim()
    || currentMeta.agentId
    || currentMeta.sessionIdentity?.agentId
    || target.defaultSessionPromptScope.agentId;
  return resolveScopeForAgent(target, targetAgentId);
}

async function requestSessionLifecycleView(
  target: { sessionKey: string; endpointSessionId?: string; sessionIdentity: SessionIdentity },
  traceId?: string | null,
) {
  logSessionTrace('session.lifecycle.request', traceId, {
    backendSessionKey: summarizeIdentifier(target.sessionKey),
    endpointSessionId: summarizeIdentifier(target.endpointSessionId),
    sessionIdentity: summarizeSessionIdentity(target.sessionIdentity),
  });
  try {
    const view = decodeHistorySessionView(await hostSessionLoad({
      sessionKey: target.sessionKey,
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
  input.set((state) => ({
    loadedSessions: patchSessionMeta(state, input.sessionKey, { historyStatus: 'ready' }),
  }));
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
  const hasSessionInBackend = (sessionKey: string): boolean => Boolean(sessionKey) && mergedSessions.has(sessionKey);
  let nextSessionKey = currentSessionKey;
  let shouldKeepMissingCurrent = false;
  if (nextSessionKey && !hasSessionInBackend(nextSessionKey)) {
    shouldKeepMissingCurrent = shouldKeepMissingCurrentSession(
      nextSessionKey,
      stateSnapshot,
      sessions.length,
    );
    if (!shouldKeepMissingCurrent && sessions.length > 0) {
      nextSessionKey = pickStartupSessionFallback(nextSessionKey, sessions) ?? nextSessionKey;
    }
  }
  const currentExistsInBackend = hasSessionInBackend(nextSessionKey);
  const shouldMarkCurrentAsReadyEmpty = (
    !currentExistsInBackend
    && shouldKeepMissingCurrent
    && sessions.length === 0
    && nextSessionKey.length > 0
  );
  const loadedAt = Date.now();
  const successfulRuntimeScopes = new Set(
    readyResults.map((result) => buildRuntimeScopeKey(result.target.defaultSessionPromptScope.endpoint)),
  );
  set((state) => {
    if (sessionCatalogLoadSequence !== requestSequence) {
      return state;
    }
    const ownsCurrentSessionSelection = state.currentSessionKey === currentSessionKeyBeforeLoad;
    const ownedNextSessionKey = ownsCurrentSessionSelection ? nextSessionKey : state.currentSessionKey;
    const backendSessionKeys = new Set(sessions.map((session) => session.key));
    let loadedSessions = Object.fromEntries(
      Object.entries(state.loadedSessions).filter(([sessionKey, record]) => {
        const runtimeScope = record.meta.runtimeScopeKey;
        if (backendSessionKeys.has(sessionKey)) {
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
        backendSessionKey: session.backendSessionKey,
        endpointSessionId: session.endpointSessionId ?? currentMeta.endpointSessionId,
        runtimeScopeKey: buildRuntimeScopeKey(session.sessionIdentity.endpoint),
        agentId: normalizeCatalogString(session.agentId) ?? currentMeta.agentId,
        protocolId: normalizeCatalogString(session.protocolId) ?? currentMeta.protocolId,
        runtimeEndpointId: normalizeCatalogString(session.runtimeEndpointId) ?? currentMeta.runtimeEndpointId,
        sessionIdentity: session.sessionIdentity,
        kind: session.kind ?? currentMeta.kind,
        preferred: session.preferred ?? currentMeta.preferred,
        label: explicitLabel && explicitLabel !== session.backendSessionKey ? explicitLabel : currentMeta.label,
        titleSource: session.titleSource ?? currentMeta.titleSource,
        displayName: normalizeCatalogString(session.displayName) ?? currentMeta.displayName ?? null,
        thinkingLevel: normalizeCatalogString(session.thinkingLevel) ?? currentMeta.thinkingLevel,
        model: normalizeCatalogString(session.model) ?? currentMeta.model ?? null,
        lastActivityAt: typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
          ? session.updatedAt
          : currentMeta.lastActivityAt,
      });
      loadedSessions = patchSessionRecord({ loadedSessions }, session.key, {
        contextTokens: session.contextTokens,
      });
    }

    if (ownsCurrentSessionSelection && shouldMarkCurrentAsReadyEmpty) {
      loadedSessions = ensureSessionRecordMap(loadedSessions, nextSessionKey);
      loadedSessions = patchSessionMeta({ loadedSessions }, nextSessionKey, { historyStatus: 'ready' });
    }

    const retainedSessionKeys = new Set(Object.keys(loadedSessions));
    return {
      sessionCatalogStatus: createReadyResourceStatusState(loadedAt),
      currentSessionKey: ownedNextSessionKey,
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
  const { get } = input;
  const normalized = agentId.trim();
  if (!normalized) {
    return;
  }
  const traceId = createSessionTraceId('open-agent');
  const state = get();
  const preferredSessionKey = resolvePreferredSessionKeyForAgent(
    normalized,
    readSessionsFromState(state),
    state.loadedSessions,
  );
  logSessionTrace('open-agent.request', traceId, {
    agentId: summarizeIdentifier(normalized),
    preferredSessionKey: summarizeIdentifier(preferredSessionKey),
    currentSessionKey: summarizeIdentifier(state.currentSessionKey),
  });
  if (preferredSessionKey) {
    get().switchSession(preferredSessionKey, traceId);
    return;
  }
  get().newSession(normalized, traceId);
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
      backendSessionKey: identity.sessionKey,
      endpointSessionId: endpointSessionId ?? currentMeta.endpointSessionId,
      runtimeScopeKey: buildRuntimeScopeKey(identity.endpoint),
      agentId: identity.agentId,
      sessionIdentity: identity,
      kind: currentMeta.kind ?? 'session',
      preferred: currentMeta.preferred,
      historyStatus: existing ? currentMeta.historyStatus : 'loading',
    });
    return {
      loadedSessions,
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      currentSessionKey: existing ? state.currentSessionKey : recordKey,
      error: null,
    };
  });
  if (existing) {
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

export function executeSwitchSession(input: CreateStoreSessionActionsInput, key: string, inheritedTraceId?: string | null): void {
  const { set, get, historyRuntime } = input;
  const traceId = inheritedTraceId ?? createSessionTraceId('switch-session');
  const currentState = get();
  logSessionTrace('switch-session.request', traceId, {
    requestedSessionKey: summarizeIdentifier(key),
    currentSessionKey: summarizeIdentifier(currentState.currentSessionKey),
  });
  if (key === currentState.currentSessionKey) {
    void (async () => {
      try {
        const result = await requestSessionLifecycleView(resolveOperationTarget(get(), key), traceId);
        if (get().currentSessionKey !== key) {
          return;
        }
        applyBackendSessionView({
          set,
          get,
          sessionKey: key,
          view: result,
        });
      } catch (error) {
        set((state) => ({
          error: resolveSessionViewError(error).message,
          loadedSessions: patchSessionMeta(state, key, { historyStatus: 'ready' }),
        }));
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

  set((stateValue) => ({
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
  }));

  resumeActiveStoreSend({ set, get, sessionKey: key });

  void (async () => {
    try {
      const result = await requestSessionLifecycleView(resolveOperationTarget(get(), key));
      if (get().currentSessionKey !== key) {
        return;
      }
      applyBackendSessionView({
        set,
        get,
        sessionKey: key,
        view: result,
      });
    } catch (error) {
      if (get().currentSessionKey !== key) {
        return;
      }
      set((state) => ({
        error: resolveSessionViewError(error).message,
        loadedSessions: patchSessionMeta(state, key, {
          historyStatus: targetSessionReady ? 'ready' : 'error',
        }),
      }));
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

export async function executeDeleteSession(input: CreateStoreSessionActionsInput, key: string): Promise<void> {
  const {
    set,
    get,
    beginMutating,
    finishMutating,
    defaultSessionKey,
    historyRuntime,
  } = input;
  beginMutating();
  try {
    const target = resolveOperationTarget(get(), key);
    let receipt: SessionDeleteReceipt;
    try {
      receipt = await hostSessionDelete({
        sessionKey: target.sessionKey,
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
      const next = remainingSessions[0];
      set((state) => {
        const loadedSessions = removeSessionRecord(state, key);
        return {
          loadedSessions,
          sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
          sessionCatalogStatus: state.sessionCatalogStatus,
          pendingApprovalsBySession: Object.fromEntries(
            Object.entries(state.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== key),
          ),
          error: null,
          currentSessionKey: next?.key ?? defaultSessionKey,
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
            set((state) => ({
              error: resolveSessionViewError(error).message,
              loadedSessions: patchSessionMeta(state, next.key, {
                historyStatus: 'error',
              }),
            }));
          }
        }
      }
      await get().loadSessions();
      return;
    }

    set((state) => {
      const loadedSessions = removeSessionRecord(state, key);
      return {
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
      sessionKey: target.sessionKey,
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
    const newKey = buildSessionRecordKey({
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: created.identity.endpoint.runtimeAdapterId,
        runtimeInstanceId: created.identity.endpoint.runtimeInstanceId,
      },
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
      return {
        loadedSessions,
        sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
        sessionCatalogStatus: stateValue.sessionCatalogStatus,
        currentSessionKey: ownsSelection ? newKey : stateValue.currentSessionKey,
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
      loadedSessions,
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      sessionCatalogStatus: stateValue.sessionCatalogStatus,
      pendingApprovalsBySession: Object.fromEntries(
        Object.entries(stateValue.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== currentSessionKey),
      ),
    };
  });
}
