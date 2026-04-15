import { hostApiFetch } from '@/lib/host-api';
import { useGatewayStore } from '../gateway';
import {
  getCanonicalPrefixFromSessions,
  isTrulyEmptyNonMainSession,
  parseSessionUpdatedAtMs,
  resolveCanonicalPrefixForAgent,
  resolvePreferredSessionKeyForAgent,
  shouldKeepMissingCurrentSession,
} from './session-helpers';
import { clearPendingDeltaBatch } from './delta-frame-helpers';
import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  setHistoryPollTimer,
} from './timers';
import { resetToolSnapshotTxnState } from './tool-snapshot-txn';
import {
  areSessionsEquivalent,
  createEmptySessionRuntime,
  resolveSessionRuntime,
  snapshotCurrentSessionRuntime,
} from './store-state-helpers';
import { reduceRuntimeOverlay } from './overlay-reducer';
import type { StoreHistoryCache } from './history-cache';
import type {
  ChatSession,
  ChatStoreState,
  SessionRuntimeSnapshot,
} from './types';

const SESSION_RUNTIME_CACHE_MAX_SESSIONS = 48;

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

type StoreSessionActions = Pick<
  ChatStoreState,
  'loadSessions' | 'openAgentConversation' | 'switchSession' | 'deleteSession' | 'newSession' | 'cleanupEmptySession'
>;

function scheduleNextFrame(task: () => void): void {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => task());
    return;
  }
  setTimeout(task, 16);
}

function scheduleIdleTask(task: () => void, timeoutMs = 1000): void {
  if (typeof window !== 'undefined') {
    const win = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    };
    if (typeof win.requestIdleCallback === 'function') {
      win.requestIdleCallback(() => task(), { timeout: timeoutMs });
      return;
    }
  }
  setTimeout(task, 80);
}

function clearSessionHistoryFingerprints(
  historyRuntime: StoreHistoryCache,
  sessionKey: string,
): void {
  historyRuntime.historyFingerprintBySession.delete(sessionKey);
  historyRuntime.historyProbeFingerprintBySession.delete(sessionKey);
  historyRuntime.historyQuickFingerprintBySession.delete(sessionKey);
  historyRuntime.historyRenderFingerprintBySession.delete(sessionKey);
}

function touchSessionRuntimeSnapshot(
  runtimeByKey: Record<string, SessionRuntimeSnapshot>,
  sessionKey: string,
  snapshot?: SessionRuntimeSnapshot,
): void {
  if (!sessionKey) {
    return;
  }
  const value = snapshot ?? runtimeByKey[sessionKey];
  if (!value) {
    return;
  }
  if (Object.prototype.hasOwnProperty.call(runtimeByKey, sessionKey)) {
    delete runtimeByKey[sessionKey];
  }
  runtimeByKey[sessionKey] = value;
}

function trimSessionRuntimeSnapshots(
  runtimeByKey: Record<string, SessionRuntimeSnapshot>,
  keepSessionKeys: string[],
): void {
  const keys = Object.keys(runtimeByKey);
  if (keys.length <= SESSION_RUNTIME_CACHE_MAX_SESSIONS) {
    return;
  }

  const keepSet = new Set(keepSessionKeys.filter((key) => typeof key === 'string' && key.trim().length > 0));
  for (const [sessionKey, runtime] of Object.entries(runtimeByKey)) {
    if (runtime?.sending) {
      keepSet.add(sessionKey);
    }
  }

  let overflow = keys.length - SESSION_RUNTIME_CACHE_MAX_SESSIONS;
  for (const sessionKey of keys) {
    if (overflow <= 0) {
      break;
    }
    if (keepSet.has(sessionKey)) {
      continue;
    }
    delete runtimeByKey[sessionKey];
    overflow -= 1;
  }

  if (overflow <= 0) {
    return;
  }

  const hardKeepSet = new Set(keepSessionKeys.filter((key) => typeof key === 'string' && key.trim().length > 0));
  for (const sessionKey of Object.keys(runtimeByKey)) {
    if (overflow <= 0) {
      break;
    }
    if (hardKeepSet.has(sessionKey)) {
      continue;
    }
    delete runtimeByKey[sessionKey];
    overflow -= 1;
  }
}

export function createStoreSessionActions(input: CreateStoreSessionActionsInput): StoreSessionActions {
  const {
    set,
    get,
    beginMutating,
    finishMutating,
    defaultCanonicalPrefix,
    defaultSessionKey,
    historyRuntime,
  } = input;

  return {
    loadSessions: async () => {
      try {
        const data = await useGatewayStore.getState().rpc<Record<string, unknown>>('sessions.list', {});
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
          const sessionsWithCurrent = !currentExistsInBackend && shouldKeepMissingCurrent && nextSessionKey
            ? [
              ...dedupedSessions,
              { key: nextSessionKey, displayName: nextSessionKey },
            ]
            : dedupedSessions;

          const discoveredActivity = Object.fromEntries(
            sessionsWithCurrent
              .filter((session) => typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt))
              .map((session) => [session.key, session.updatedAt!]),
          );
          const discoveredLabels = Object.fromEntries(
            sessionsWithCurrent
              .map((session) => {
                const explicit = (session.label || session.displayName || '').trim();
                if (!explicit || explicit === session.key) {
                  return null;
                }
                return [session.key, explicit] as const;
              })
              .filter((entry): entry is readonly [string, string] => entry != null),
          );

          const snapshot = get();
          const sessionsChanged = !areSessionsEquivalent(snapshot.sessions, sessionsWithCurrent);
          const sessionKeyChanged = snapshot.currentSessionKey !== nextSessionKey;
          const discoveredActivityChanged = Object.entries(discoveredActivity).some(
            ([sessionKey, updatedAt]) => snapshot.sessionLastActivity[sessionKey] !== updatedAt,
          );
          const discoveredLabelsChanged = Object.entries(discoveredLabels).some(
            ([sessionKey, label]) => snapshot.sessionLabels[sessionKey] !== label,
          );

          if (sessionsChanged || sessionKeyChanged || discoveredActivityChanged || discoveredLabelsChanged) {
            set((state) => {
              const next: Partial<ChatStoreState> = {};

              if (sessionsChanged) {
                next.sessions = sessionsWithCurrent;
              }
              if (sessionKeyChanged) {
                next.currentSessionKey = nextSessionKey;
              }
              if (discoveredActivityChanged) {
                next.sessionLastActivity = {
                  ...state.sessionLastActivity,
                  ...discoveredActivity,
                };
              }
              if (discoveredLabelsChanged) {
                next.sessionLabels = {
                  ...state.sessionLabels,
                  ...discoveredLabels,
                };
              }

              return next;
            });
          }
        }
      } catch {
        void 0;
      }
    },

    openAgentConversation: (agentId: string) => {
      const normalized = agentId.trim();
      if (!normalized) {
        return;
      }
      const state = get();
      const preferredSessionKey = resolvePreferredSessionKeyForAgent(
        normalized,
        state.sessions,
        state.sessionLastActivity,
      );
      if (preferredSessionKey) {
        get().switchSession(preferredSessionKey);
        return;
      }
      get().newSession(normalized);
    },

    switchSession: (key: string) => {
      if (key === get().currentSessionKey) {
        return;
      }
      clearHistoryPoll();
      clearErrorRecoveryTimer();
      clearPendingDeltaBatch();
      resetToolSnapshotTxnState();
      const state = get();
      const { currentSessionKey } = state;
      const leavingEmpty = isTrulyEmptyNonMainSession(currentSessionKey, state);
      if (leavingEmpty) {
        clearSessionHistoryFingerprints(historyRuntime, currentSessionKey);
      }
      const nextSessionRuntimeByKey = { ...state.sessionRuntimeByKey };

      if (leavingEmpty) {
        delete nextSessionRuntimeByKey[currentSessionKey];
      } else {
        touchSessionRuntimeSnapshot(
          nextSessionRuntimeByKey,
          currentSessionKey,
          snapshotCurrentSessionRuntime(state),
        );
      }
      touchSessionRuntimeSnapshot(nextSessionRuntimeByKey, key);
      trimSessionRuntimeSnapshots(nextSessionRuntimeByKey, [currentSessionKey, key]);
      const hasTargetRuntimeSnapshot = Object.prototype.hasOwnProperty.call(nextSessionRuntimeByKey, key);
      const targetRuntime = resolveSessionRuntime(nextSessionRuntimeByKey[key]);
      const targetPendingApprovals = state.pendingApprovalsBySession[key] ?? [];
      const targetRuntimePatch = reduceRuntimeOverlay(state, {
        type: 'session_runtime_restored',
        targetRuntime,
        currentPendingApprovals: targetPendingApprovals.length,
      });
      const targetSessionReady = Boolean(state.sessionReadyByKey[key])
        || hasTargetRuntimeSnapshot
        || historyRuntime.historyFingerprintBySession.has(key);
      const nextSessionReadyByKey = (() => {
        const next = { ...state.sessionReadyByKey };
        if (leavingEmpty) {
          delete next[currentSessionKey];
        }
        if (targetSessionReady) {
          next[key] = true;
        }
        return next;
      })();

      set((stateValue) => ({
        currentSessionKey: key,
        messages: targetRuntime.messages,
        snapshotReady: state.snapshotReady || targetSessionReady,
        initialLoading: false,
        refreshing: false,
        ...targetRuntimePatch,
        error: null,
        sessionReadyByKey: nextSessionReadyByKey,
        sessionRuntimeByKey: nextSessionRuntimeByKey,
        ...(leavingEmpty ? {
          sessions: stateValue.sessions.filter((session) => session.key !== currentSessionKey),
          sessionLabels: Object.fromEntries(
            Object.entries(stateValue.sessionLabels).filter(([sessionKey]) => sessionKey !== currentSessionKey),
          ),
          sessionLastActivity: Object.fromEntries(
            Object.entries(stateValue.sessionLastActivity).filter(([sessionKey]) => sessionKey !== currentSessionKey),
          ),
        } : {}),
      }));
      if (targetRuntime.sending) {
        const POLL_INTERVAL = 4_000;
        const pollHistory = () => {
          const current = get();
          if (!current.sending) {
            clearHistoryPoll();
            return;
          }
          if (!current.streamingMessage) {
            void current.loadHistory(true);
          }
          setHistoryPollTimer(setTimeout(pollHistory, POLL_INTERVAL));
        };
        setHistoryPollTimer(setTimeout(pollHistory, 1_000));
      }
      const shouldQuietReload = targetSessionReady;
      const shouldDeferQuietReload = shouldQuietReload && !targetRuntime.sending;
      scheduleNextFrame(() => {
        if (shouldDeferQuietReload) {
          scheduleIdleTask(() => {
            void get().loadHistory(true);
          });
          return;
        }
        void get().loadHistory(shouldQuietReload);
      });
    },

    deleteSession: async (key: string) => {
      clearPendingDeltaBatch();
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
        const { currentSessionKey, sessions } = get();
        const remaining = sessions.filter((session) => session.key !== key);
        clearSessionHistoryFingerprints(historyRuntime, key);

        if (currentSessionKey === key) {
          clearHistoryPoll();
          clearErrorRecoveryTimer();
          const next = remaining[0];
          set((state) => ({
            ...(function buildNextState() {
              const runtimeMap = Object.fromEntries(
                Object.entries(state.sessionRuntimeByKey).filter(([sessionKey]) => sessionKey !== key),
              );
              const nextRuntime = resolveSessionRuntime(runtimeMap[next?.key ?? '']);
              const nextPendingApprovalsCount = next?.key
                ? (state.pendingApprovalsBySession[next.key] ?? []).length
                : 0;
              const nextRuntimePatch = reduceRuntimeOverlay(state, {
                type: 'session_runtime_restored',
                targetRuntime: nextRuntime,
                currentPendingApprovals: nextPendingApprovalsCount,
              });
              return {
                sessionRuntimeByKey: runtimeMap,
                messages: nextRuntime.messages,
                ...nextRuntimePatch,
              };
            })(),
            sessions: remaining,
            sessionLabels: Object.fromEntries(Object.entries(state.sessionLabels).filter(([sessionKey]) => sessionKey !== key)),
            sessionLastActivity: Object.fromEntries(Object.entries(state.sessionLastActivity).filter(([sessionKey]) => sessionKey !== key)),
            sessionReadyByKey: Object.fromEntries(Object.entries(state.sessionReadyByKey).filter(([sessionKey]) => sessionKey !== key)),
            pendingApprovalsBySession: Object.fromEntries(
              Object.entries(state.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== key),
            ),
            error: null,
            initialLoading: false,
            refreshing: false,
            currentSessionKey: next?.key ?? defaultSessionKey,
          }));
          if (next) {
            get().loadHistory();
          }
        } else {
          set((state) => ({
            sessions: remaining,
            sessionLabels: Object.fromEntries(Object.entries(state.sessionLabels).filter(([sessionKey]) => sessionKey !== key)),
            sessionLastActivity: Object.fromEntries(Object.entries(state.sessionLastActivity).filter(([sessionKey]) => sessionKey !== key)),
            sessionReadyByKey: Object.fromEntries(Object.entries(state.sessionReadyByKey).filter(([sessionKey]) => sessionKey !== key)),
            sessionRuntimeByKey: Object.fromEntries(Object.entries(state.sessionRuntimeByKey).filter(([sessionKey]) => sessionKey !== key)),
            pendingApprovalsBySession: Object.fromEntries(
              Object.entries(state.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== key),
            ),
          }));
        }
      } finally {
        finishMutating();
      }
    },

    newSession: (agentId?: string) => {
      clearHistoryPoll();
      clearErrorRecoveryTimer();
      clearPendingDeltaBatch();
      const state = get();
      const { currentSessionKey } = state;
      const leavingEmpty = isTrulyEmptyNonMainSession(currentSessionKey, state);
      if (leavingEmpty) {
        clearSessionHistoryFingerprints(historyRuntime, currentSessionKey);
      }
      const prefix = resolveCanonicalPrefixForAgent(agentId)
        ?? getCanonicalPrefixFromSessions(get().sessions, currentSessionKey)
        ?? defaultCanonicalPrefix;
      const newKey = `${prefix}:session-${Date.now()}`;
      const newSessionEntry: ChatSession = { key: newKey, displayName: newKey };
      set((stateValue) => ({
        sessionRuntimeByKey: (() => {
          const next = { ...stateValue.sessionRuntimeByKey };
          if (leavingEmpty) {
            delete next[currentSessionKey];
          } else {
            touchSessionRuntimeSnapshot(next, currentSessionKey, snapshotCurrentSessionRuntime(stateValue));
          }
          delete next[newKey];
          trimSessionRuntimeSnapshots(next, [currentSessionKey, newKey]);
          return next;
        })(),
        currentSessionKey: newKey,
        sessions: [
          ...(leavingEmpty ? stateValue.sessions.filter((session) => session.key !== currentSessionKey) : stateValue.sessions),
          newSessionEntry,
        ],
        sessionLabels: leavingEmpty
          ? Object.fromEntries(Object.entries(stateValue.sessionLabels).filter(([sessionKey]) => sessionKey !== currentSessionKey))
          : stateValue.sessionLabels,
        sessionLastActivity: leavingEmpty
          ? Object.fromEntries(Object.entries(stateValue.sessionLastActivity).filter(([sessionKey]) => sessionKey !== currentSessionKey))
          : stateValue.sessionLastActivity,
        sessionReadyByKey: (() => {
          const next = { ...stateValue.sessionReadyByKey };
          if (leavingEmpty) {
            delete next[currentSessionKey];
          }
          next[newKey] = true;
          return next;
        })(),
        pendingApprovalsBySession: (() => {
          if (!leavingEmpty) return stateValue.pendingApprovalsBySession;
          return Object.fromEntries(
            Object.entries(stateValue.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== currentSessionKey),
          );
        })(),
        ...createEmptySessionRuntime(),
        snapshotReady: true,
        initialLoading: false,
        refreshing: false,
        error: null,
      }));
    },

    cleanupEmptySession: () => {
      const state = get();
      const { currentSessionKey } = state;
      const isEmptyNonMain = isTrulyEmptyNonMainSession(currentSessionKey, state);
      if (!isEmptyNonMain) return;
      clearSessionHistoryFingerprints(historyRuntime, currentSessionKey);
      set((stateValue) => ({
        sessions: stateValue.sessions.filter((session) => session.key !== currentSessionKey),
        sessionLabels: Object.fromEntries(
          Object.entries(stateValue.sessionLabels).filter(([sessionKey]) => sessionKey !== currentSessionKey),
        ),
        sessionLastActivity: Object.fromEntries(
          Object.entries(stateValue.sessionLastActivity).filter(([sessionKey]) => sessionKey !== currentSessionKey),
        ),
        sessionReadyByKey: Object.fromEntries(
          Object.entries(stateValue.sessionReadyByKey).filter(([sessionKey]) => sessionKey !== currentSessionKey),
        ),
        sessionRuntimeByKey: Object.fromEntries(
          Object.entries(stateValue.sessionRuntimeByKey).filter(([sessionKey]) => sessionKey !== currentSessionKey),
        ),
        pendingApprovalsBySession: Object.fromEntries(
          Object.entries(stateValue.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== currentSessionKey),
        ),
      }));
    },
  };
}


