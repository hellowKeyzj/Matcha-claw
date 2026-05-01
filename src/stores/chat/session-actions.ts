import { hostApiFetch } from '@/lib/host-api';
import {
  createErrorResourceStatusState,
  createLoadingResourceStatusState,
  createReadyResourceStatusState,
} from '@/lib/resource-state';
import {
  getCanonicalPrefixFromSessions,
  isTrulyEmptyNonMainSession,
  parseSessionUpdatedAtMs,
  readSessionsFromState,
  resolveCanonicalPrefixForAgent,
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
import { resetToolSnapshotTxnState } from './tool-snapshot-txn';
import {
  createEmptySessionRecord,
  getSessionMeta,
  getSessionViewportState,
  patchSessionMeta,
  patchSessionViewportState,
  removeSessionRecord,
  resolveSessionRecord,
} from './store-state-helpers';
import type { StoreHistoryCache } from './history-cache';
import type {
  ChatSession,
  ChatStoreState,
} from './types';

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
  defaultCanonicalPrefix: string;
  defaultSessionKey: string;
  historyRuntime: StoreHistoryCache;
}

function clearSessionHistoryFingerprints(
  historyRuntime: StoreHistoryCache,
  sessionKey: string,
): void {
  historyRuntime.historyFingerprintBySession.delete(sessionKey);
  historyRuntime.historyQuickFingerprintBySession.delete(sessionKey);
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

function shouldMarkSessionLoadingOnSwitch(
  sessionKey: string,
  sessionRecord: ReturnType<typeof resolveSessionRecord>,
): boolean {
  if (!sessionKey) {
    return false;
  }
  if (sessionRecord.runtime.sending) {
    return false;
  }
  return sessionRecord.meta.historyStatus !== 'ready' && sessionRecord.messages.length === 0;
}

export async function executeLoadSessions(input: CreateStoreSessionActionsInput): Promise<void> {
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
  try {
    const data = await hostApiFetch<Record<string, unknown>>('/api/sessions/list');
    if (data) {
      const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];
      const sessions: ChatSession[] = rawSessions.map((session: Record<string, unknown>) => ({
        key: String(session.key || ''),
        label: session.label ? String(session.label) : undefined,
        displayName: session.displayName ? String(session.displayName) : undefined,
        thinkingLevel: session.thinkingLevel ? String(session.thinkingLevel) : undefined,
        model: session.model ? String(session.model) : undefined,
        updatedAt: parseSessionUpdatedAtMs(session.updatedAt),
      })).filter((session: ChatSession) => session.key);

      const canonicalBySuffix = new Map<string, string>();
      for (const session of sessions) {
        if (!session.key.startsWith('agent:')) continue;
        const parts = session.key.split(':');
        if (parts.length < 3) continue;
        const suffix = parts.slice(2).join(':');
        if (suffix && !canonicalBySuffix.has(suffix)) {
          canonicalBySuffix.set(suffix, session.key);
        }
      }

      const seen = new Set<string>();
      const dedupedSessions = sessions.filter((session) => {
        if (!session.key.startsWith('agent:') && canonicalBySuffix.has(session.key)) return false;
        if (seen.has(session.key)) return false;
        seen.add(session.key);
        return true;
      });

      const stateSnapshot = get();
      const { currentSessionKey } = stateSnapshot;
      let nextSessionKey = currentSessionKey || defaultSessionKey;
      if (!nextSessionKey.startsWith('agent:')) {
        const canonicalMatch = canonicalBySuffix.get(nextSessionKey);
        if (canonicalMatch) {
          nextSessionKey = canonicalMatch;
        }
      }
      const hasSessionInBackend = (sessionKey: string): boolean => dedupedSessions.some((session) => session.key === sessionKey);
      let shouldKeepMissingCurrent = false;
      if (!hasSessionInBackend(nextSessionKey)) {
        shouldKeepMissingCurrent = shouldKeepMissingCurrentSession(
          nextSessionKey,
          stateSnapshot,
          dedupedSessions.length,
        );
        if (!shouldKeepMissingCurrent && dedupedSessions.length > 0) {
          nextSessionKey = dedupedSessions[0].key;
        }
      }
      const currentExistsInBackend = hasSessionInBackend(nextSessionKey);
      const backendSessions = dedupedSessions;

      const shouldMarkCurrentAsReadyEmpty = (
        !currentExistsInBackend
        && shouldKeepMissingCurrent
        && dedupedSessions.length === 0
        && nextSessionKey.length > 0
      );
      const loadedAt = Date.now();
      set((state) => {
        const backendSessionKeys = new Set(backendSessions.map((session) => session.key));
        let loadedSessions = Object.fromEntries(
          Object.entries(state.loadedSessions).filter(([sessionKey]) => (
            backendSessionKeys.has(sessionKey)
            || shouldRetainLocalSessionRecord(sessionKey, {
              currentSessionKey: nextSessionKey,
              loadedSessions: state.loadedSessions,
              pendingApprovalsBySession: state.pendingApprovalsBySession,
            })
          )),
        );

        for (const session of backendSessions) {
          loadedSessions = ensureSessionRecordMap(loadedSessions, session.key);
          const currentMeta = getSessionMeta({ loadedSessions }, session.key);
          const explicitLabel = normalizeCatalogString(session.label);
          loadedSessions = patchSessionMeta({ loadedSessions }, session.key, {
            label: explicitLabel && explicitLabel !== session.key ? explicitLabel : currentMeta.label,
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
        };
      });
      return;
    }
    set({
      sessionCatalogStatus: createReadyResourceStatusState(),
    });
  } catch (error) {
    const stateSnapshot = get();
    const message = error instanceof Error ? error.message : 'Failed to load sessions';
    set({
      sessionCatalogStatus: createErrorResourceStatusState(stateSnapshot.sessionCatalogStatus, message),
    });
  }
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
    void get().loadHistory({
      sessionKey: key,
      mode: 'active',
      scope: 'foreground',
      reason: 'switch_session_reselect',
    });
    return;
  }
  clearHistoryPoll();
  clearErrorRecoveryTimer();
  resetToolSnapshotTxnState();
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
  const targetSessionReady = targetRecord.meta.historyStatus === 'ready' || targetRecord.messages.length > 0;

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

  void get().loadHistory({
    sessionKey: key,
    mode: targetSessionReady ? 'quiet' : 'active',
    scope: 'foreground',
    reason: 'switch_session_reconcile',
  });
}

export async function executeLoadOlderMessages(
  input: CreateStoreSessionActionsInput,
  sessionKeyHint?: string,
): Promise<void> {
  const { set, get } = input;
  await executeViewportWindowLoad({ set, get }, {
    sessionKey: sessionKeyHint?.trim() || get().currentSessionKey,
    mode: 'older',
  });
}

export async function executeJumpToLatest(
  input: CreateStoreSessionActionsInput,
  sessionKeyHint?: string,
): Promise<void> {
  const { set, get } = input;
  await executeViewportWindowLoad({ set, get }, {
    sessionKey: sessionKeyHint?.trim() || get().currentSessionKey,
    mode: 'latest',
  });
}

export function executeSetViewportLastVisibleMessageId(
  input: CreateStoreSessionActionsInput,
  messageId: string | null,
  sessionKeyHint?: string,
): void {
  const { set, get } = input;
  const sessionKey = sessionKeyHint?.trim() || get().currentSessionKey;
  set((state) => ({
    loadedSessions: patchSessionViewportState(state, sessionKey, {
      ...getSessionViewportState(state, sessionKey),
      lastVisibleMessageId: messageId,
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
      await hostApiFetch<{
        success: boolean;
        error?: string;
      }>('/api/sessions/delete', {
        method: 'POST',
        body: JSON.stringify({ sessionKey: key }),
      });
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

export function executeNewSession(input: CreateStoreSessionActionsInput, agentId?: string): void {
  const {
    set,
    get,
    defaultCanonicalPrefix,
    historyRuntime,
  } = input;
  clearHistoryPoll();
  clearErrorRecoveryTimer();
  const state = get();
  const { currentSessionKey } = state;
  const leavingEmpty = isTrulyEmptyNonMainSession(currentSessionKey, state);
  if (leavingEmpty) {
    clearSessionHistoryFingerprints(historyRuntime, currentSessionKey);
  }
  const prefix = resolveCanonicalPrefixForAgent(agentId)
    ?? getCanonicalPrefixFromSessions(readSessionsFromState(get()), currentSessionKey)
    ?? defaultCanonicalPrefix;
  const newKey = `${prefix}:session-${Date.now()}`;
  const newSessionRecord = createEmptySessionRecord();
  newSessionRecord.meta = {
    ...newSessionRecord.meta,
    historyStatus: 'ready',
  };
  set((stateValue) => {
    const loadedSessions = {
      ...(leavingEmpty ? removeSessionRecord(stateValue, currentSessionKey) : stateValue.loadedSessions),
      [newKey]: newSessionRecord,
    };
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
