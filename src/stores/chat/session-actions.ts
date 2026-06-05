import {
  hostSessionDelete,
  hostSessionList,
  hostSessionNew,
  hostSessionResume,
  hostSessionSwitch,
  hostSessionWindowFetch,
  resolveHydratedSessionSnapshot,
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
  createEmptySessionRecord,
  getSessionItemCount,
  getSessionMeta,
  getSessionViewportState,
  patchSessionMeta,
  patchSessionSnapshot,
  patchSessionViewportState,
  removeSessionRecord,
  resolveSessionRecord,
} from './store-state-helpers';
import { useTaskSnapshotStore } from './task-snapshot-store';
import {
  buildRuntimeScopeKey,
  buildSessionRecordKey,
  resolveSessionOperationTarget,
  sameRuntimeEndpointScope,
} from './session-identity';
import { pickStartupSessionFallback } from './session-selection';
import type { StoreHistoryCache } from './history-cache';
import type { RuntimeAddress } from '../../../runtime-host/shared/runtime-address';
import type {
  ChatSession,
  ChatSessionRuntimeEndpointTarget,
  ChatStoreState,
} from './types';
import { isRunActive } from './types';
import type { SessionLoadResult } from '../../../runtime-host/shared/session-adapter-types';

const SESSION_CATALOG_NOT_READY_RETRY_MS = 1200;

let sessionCatalogRetryTimer: ReturnType<typeof setTimeout> | null = null;
let inflightSessionCatalogLoad: Promise<void> | null = null;

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
  renameSession: (payload: { sessionKey: string; runtimeAddress: RuntimeAddress; label: string }) => Promise<{ success: boolean; error?: string }>;
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
  if (!session.key || !session.agentId || !session.runtimeAddress) {
    return null;
  }
  const recordKey = buildSessionRecordKey(session.runtimeAddress, session.key);
  return {
    ...session,
    key: recordKey,
    backendSessionKey: session.key,
  };
}

async function loadEndpointSessionCatalog(target: ChatSessionRuntimeEndpointTarget): Promise<SessionCatalogLoadResult> {
  try {
    const data = await hostSessionList({ runtimeAddress: target.defaultSessionPromptAddress });
    const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];
    return {
      target,
      sessions: rawSessions.map((session) => normalizeCatalogSession({
        key: session.key || '',
        backendSessionKey: session.key || '',
        agentId: typeof session.agentId === 'string' ? session.agentId : '',
        protocolId: typeof session.protocolId === 'string' ? session.protocolId : undefined,
        runtimeEndpointId: typeof session.runtimeEndpointId === 'string' ? session.runtimeEndpointId : undefined,
        runtimeAddress: session.runtimeAddress,
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
  }
}

function findRuntimeTargetForAddress(
  targets: readonly ChatSessionRuntimeEndpointTarget[],
  runtimeAddress: RuntimeAddress,
): ChatSessionRuntimeEndpointTarget | null {
  return targets.find((target) => sameRuntimeEndpointScope(target.defaultSessionPromptAddress, runtimeAddress)) ?? null;
}

function resolveAddressForAgent(target: ChatSessionRuntimeEndpointTarget, agentId: string): RuntimeAddress {
  const matched = target.sessionPromptAddresses.find((address) => address.agentId === agentId);
  if (matched) {
    return matched;
  }
  if (!target.acceptsDynamicAgents) {
    throw new Error(`Runtime endpoint does not support agent: ${agentId}`);
  }
  return {
    ...target.defaultSessionPromptAddress,
    agentId,
  };
}

function resolveNewSessionRuntimeAddress(state: ChatStoreState, agentId?: string): RuntimeAddress {
  const targets = readSessionRuntimeTargets(state);
  if (targets.length === 0) {
    throw new Error('Session runtime is not ready');
  }
  const currentMeta = getSessionMeta(state, state.currentSessionKey);
  const currentRuntimeAddress = currentMeta.runtimeAddress;
  const targetEndpoint = currentRuntimeAddress
    ? findRuntimeTargetForAddress(targets, currentRuntimeAddress)
    : null;
  const defaultRuntimeAddress = state.sessionRuntimeCatalog.defaultRuntimeAddress;
  const defaultEndpoint = defaultRuntimeAddress
    ? findRuntimeTargetForAddress(targets, defaultRuntimeAddress)
    : null;
  const target = targetEndpoint ?? defaultEndpoint ?? targets[0]!;
  const targetAgentId = agentId?.trim()
    || currentMeta.agentId
    || currentRuntimeAddress?.agentId
    || target.defaultSessionPromptAddress.agentId;
  return resolveAddressForAgent(target, targetAgentId);
}

async function requestSessionLifecycleSnapshot(
  action: 'switch' | 'resume',
  target: { sessionKey: string; runtimeAddress: RuntimeAddress },
): Promise<SessionLoadResult> {
  const result = action === 'switch'
    ? await hostSessionSwitch({ sessionKey: target.sessionKey, runtimeAddress: target.runtimeAddress, limit: 200 })
    : await hostSessionResume({ sessionKey: target.sessionKey, runtimeAddress: target.runtimeAddress });
  const snapshot = await resolveHydratedSessionSnapshot({
    initial: result,
    refetch: async () => await hostSessionWindowFetch({
      sessionKey: target.sessionKey,
      runtimeAddress: target.runtimeAddress,
      mode: 'latest',
      limit: 200,
    }),
  });
  if (!snapshot) {
    throw new Error('session lifecycle request did not return a snapshot');
  }
  return { snapshot };
}

function applyBackendSessionSnapshot(
  input: {
    set: ChatStoreSetFn;
    sessionKey: string;
    snapshot: SessionLoadResult['snapshot'];
  },
): void {
  useTaskSnapshotStore.getState().reportSessionSnapshot(input.snapshot, 'replay');
  input.set((state) => {
    const loadedSessions = patchSessionMeta(
      {
        loadedSessions: patchSessionSnapshot(state, input.sessionKey, input.snapshot),
      },
      input.sessionKey,
      {
        historyStatus: input.snapshot.replayComplete ? 'ready' : 'loading',
      },
    );
    return {
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

export async function executeLoadSessions(input: CreateStoreSessionActionsInput): Promise<void> {
  if (inflightSessionCatalogLoad) {
    await inflightSessionCatalogLoad;
    return;
  }
  const task = executeLoadSessionsNow(input);
  inflightSessionCatalogLoad = task;
  try {
    await task;
  } finally {
    if (inflightSessionCatalogLoad === task) {
      inflightSessionCatalogLoad = null;
    }
  }
}

async function executeLoadSessionsNow(input: CreateStoreSessionActionsInput): Promise<void> {
  const {
    set,
    get,
    defaultSessionKey,
  } = input;
  const stateBeforeLoad = get();
  const previousResource = stateBeforeLoad.sessionCatalogStatus;
  set({
    sessionCatalogStatus: createLoadingResourceStatusState(previousResource),
  });
  const targets = readSessionRuntimeTargets(stateBeforeLoad);
  if (targets.length === 0) {
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
    clearSessionCatalogRetry();
    const message = errors[0] ?? 'Failed to load sessions';
    set((state) => ({
      sessionCatalogStatus: createErrorResourceStatusState(state.sessionCatalogStatus, message),
      error: message,
    }));
    return;
  }

  if (results.some((result) => !result.ready)) {
    scheduleSessionCatalogRetry(() => executeLoadSessions(input));
  } else {
    clearSessionCatalogRetry();
  }

  const stateSnapshot = get();
  const { currentSessionKey } = stateSnapshot;
  let nextSessionKey = currentSessionKey || defaultSessionKey;
  const hasSessionInBackend = (sessionKey: string): boolean => mergedSessions.has(sessionKey);
  let shouldKeepMissingCurrent = false;
  if (!hasSessionInBackend(nextSessionKey)) {
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
    readyResults.map((result) => buildRuntimeScopeKey(result.target.defaultSessionPromptAddress)),
  );
  set((state) => {
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
          currentSessionKey: nextSessionKey,
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
        runtimeScopeKey: buildRuntimeScopeKey(session.runtimeAddress),
        agentId: normalizeCatalogString(session.agentId) ?? currentMeta.agentId,
        protocolId: normalizeCatalogString(session.protocolId) ?? currentMeta.protocolId,
        runtimeEndpointId: normalizeCatalogString(session.runtimeEndpointId) ?? currentMeta.runtimeEndpointId,
        runtimeAddress: session.runtimeAddress,
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
    }

    if (shouldMarkCurrentAsReadyEmpty) {
      loadedSessions = ensureSessionRecordMap(loadedSessions, nextSessionKey);
      loadedSessions = patchSessionMeta({ loadedSessions }, nextSessionKey, { historyStatus: 'ready' });
    }

    const retainedSessionKeys = new Set(Object.keys(loadedSessions));
    return {
      sessionCatalogStatus: createReadyResourceStatusState(loadedAt),
      currentSessionKey: nextSessionKey,
      loadedSessions,
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
  const state = get();
  const preferredSessionKey = resolvePreferredSessionKeyForAgent(
    normalized,
    readSessionsFromState(state),
    state.loadedSessions,
  );
  if (preferredSessionKey) {
    get().switchSession(preferredSessionKey);
    return;
  }
  get().newSession(normalized);
}

export function executeSwitchSession(input: CreateStoreSessionActionsInput, key: string): void {
  const { set, get, historyRuntime } = input;
  const currentState = get();
  if (key === currentState.currentSessionKey) {
    void (async () => {
      try {
        const result = await requestSessionLifecycleSnapshot('resume', resolveOperationTarget(get(), key));
        if (get().currentSessionKey !== key) {
          return;
        }
        applyBackendSessionSnapshot({
          set,
          sessionKey: key,
          snapshot: result.snapshot,
        });
      } catch {
        void get().loadHistory({
          sessionKey: key,
          mode: 'active',
          scope: 'foreground',
          reason: 'switch_session_reselect',
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

  set((stateValue) => ({
    sessionCatalogStatus: stateValue.sessionCatalogStatus,
    currentSessionKey: key,
    error: null,
    loadedSessions: nextloadedSessions,
    ...(leavingEmpty ? {
      pendingApprovalsBySession: Object.fromEntries(
        Object.entries(stateValue.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== currentSessionKey),
      ),
    } : {}),
  }));

  resumeActiveStoreSend({ set, get, sessionKey: key });

  void (async () => {
    try {
      const result = await requestSessionLifecycleSnapshot('switch', resolveOperationTarget(get(), key));
      if (get().currentSessionKey !== key) {
        return;
      }
      applyBackendSessionSnapshot({
        set,
        sessionKey: key,
        snapshot: result.snapshot,
      });
    } catch {
      void get().loadHistory({
        sessionKey: key,
        mode: targetSessionReady ? 'quiet' : 'active',
        scope: 'foreground',
        reason: 'switch_session_reconcile',
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
    try {
      await hostSessionDelete(resolveOperationTarget(get(), key));
    } catch {
      void 0;
    }
    const { currentSessionKey } = get();
    const sessions = readSessionsFromState(get());
    const remainingSessions = sessions.filter((session) => session.key !== key);
    clearSessionHistoryFingerprints(historyRuntime, key);

    if (currentSessionKey === key) {
      clearHistoryPoll();
      clearErrorRecoveryTimer();
      const next = remainingSessions[0];
      set((state) => ({
        loadedSessions: removeSessionRecord(state, key),
        sessionCatalogStatus: state.sessionCatalogStatus,
        pendingApprovalsBySession: Object.fromEntries(
          Object.entries(state.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== key),
        ),
        error: null,
        currentSessionKey: next?.key ?? defaultSessionKey,
      }));
      if (next) {
        void get().loadHistory({
          sessionKey: next.key,
          mode: 'active',
          scope: 'foreground',
          reason: 'delete_session_promote_next',
        });
      }
      return;
    }

    set((state) => ({
      loadedSessions: removeSessionRecord(state, key),
      sessionCatalogStatus: state.sessionCatalogStatus,
      pendingApprovalsBySession: Object.fromEntries(
        Object.entries(state.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== key),
      ),
    }));
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
      runtimeAddress: target.runtimeAddress,
      label: normalizedLabel,
    });
    if (result.success === false) {
      throw new Error(result.error || 'Failed to rename session');
    }
    input.set((state) => ({
      loadedSessions: patchSessionMeta(state, key, {
        label: normalizedLabel,
        titleSource: 'user',
        manualLabel: true,
      }),
    }));
  } finally {
    input.finishMutating();
  }
}

export async function executeNewSession(input: CreateStoreSessionActionsInput, agentId?: string): Promise<void> {
  const {
    set,
    get,
    beginMutating,
    finishMutating,
    historyRuntime,
  } = input;
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
    const runtimeAddress = resolveNewSessionRuntimeAddress(state, agentId);
    const created = await hostSessionNew({ runtimeAddress });
    const newKey = buildSessionRecordKey(created.snapshot.catalog.runtimeAddress, created.sessionKey);
    useTaskSnapshotStore.getState().reportSessionSnapshot(created.snapshot, 'replay');
    set((stateValue) => {
      const baseLoadedSessions = leavingEmpty
        ? removeSessionRecord(stateValue, currentSessionKey)
        : stateValue.loadedSessions;
      const loadedSessions = patchSessionMeta(
        {
          loadedSessions: patchSessionSnapshot(
            { loadedSessions: baseLoadedSessions },
            newKey,
            created.snapshot,
          ),
        },
        newKey,
        {
          historyStatus: created.snapshot.replayComplete ? 'ready' : 'loading',
        },
      );
      return {
        loadedSessions,
        sessionCatalogStatus: stateValue.sessionCatalogStatus,
        currentSessionKey: newKey,
        pendingApprovalsBySession: leavingEmpty
          ? Object.fromEntries(
              Object.entries(stateValue.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== currentSessionKey),
            )
          : stateValue.pendingApprovalsBySession,
        error: null,
      };
    });
  } catch (error) {
    set({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    finishMutating();
  }
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
      sessionCatalogStatus: stateValue.sessionCatalogStatus,
      pendingApprovalsBySession: Object.fromEntries(
        Object.entries(stateValue.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== currentSessionKey),
      ),
    };
  });
}
