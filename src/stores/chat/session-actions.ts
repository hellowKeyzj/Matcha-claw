import { hostApiFetch } from '@/lib/host-api';
import {
  createErrorResourceState,
  createLoadingResourceState,
  createReadyResourceState,
} from '@/lib/resource-state';
import { trackUiEvent } from '@/lib/telemetry';
import { useGatewayStore } from '../gateway';
import {
  getCanonicalPrefixFromSessions,
  isTrulyEmptyNonMainSession,
  parseSessionUpdatedAtMs,
  readSessionsFromState,
  resolveCanonicalPrefixForAgent,
  resolvePreferredSessionKeyForAgent,
  shouldKeepMissingCurrentSession,
} from './session-helpers';
import { disposeActiveStreamPacer } from './stream-pacer';
import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  setHistoryPollTimer,
} from './timers';
import { resetToolSnapshotTxnState } from './tool-snapshot-txn';
import {
  areSessionsEquivalent,
  createEmptySessionRecord,
  getSessionMeta,
  getSessionRuntime,
  patchSessionMeta,
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
      const stateBeforeLoad = get();
      const previousResource = stateBeforeLoad.sessionsResource;
      set({
        sessionsResource: createLoadingResourceState({
          ...previousResource,
          hasLoadedOnce: previousResource.hasLoadedOnce || previousResource.data.length > 0,
        }),
      });
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
          const currentSessions = readSessionsFromState(snapshot);
          const sessionsChanged = !areSessionsEquivalent(currentSessions, sessionsWithCurrent);
          const sessionKeyChanged = snapshot.currentSessionKey !== nextSessionKey;
          const discoveredActivityChanged = Object.entries(discoveredActivity).some(
            ([sessionKey, updatedAt]) => getSessionMeta(snapshot, sessionKey).lastActivityAt !== updatedAt,
          );
          const discoveredLabelsChanged = Object.entries(discoveredLabels).some(
            ([sessionKey, label]) => getSessionMeta(snapshot, sessionKey).label !== label,
          );
          const loadedAt = Date.now();

          if (sessionsChanged || sessionKeyChanged || discoveredActivityChanged || discoveredLabelsChanged) {
            set((state) => {
              let sessionsByKey = { ...state.sessionsByKey };
              for (const [sessionKey, updatedAt] of Object.entries(discoveredActivity)) {
                sessionsByKey = patchSessionMeta({ sessionsByKey }, sessionKey, { lastActivityAt: updatedAt });
              }
              for (const [sessionKey, label] of Object.entries(discoveredLabels)) {
                sessionsByKey = patchSessionMeta({ sessionsByKey }, sessionKey, { label });
              }

              return {
                sessionsResource: createReadyResourceState(
                  sessionsChanged ? sessionsWithCurrent : state.sessionsResource.data,
                  loadedAt,
                ),
                currentSessionKey: sessionKeyChanged ? nextSessionKey : state.currentSessionKey,
                sessionsByKey,
              };
            });
          } else {
            set({
              sessionsResource: createReadyResourceState(get().sessionsResource.data, loadedAt),
            });
          }
          return;
        }
        set({
          sessionsResource: createReadyResourceState(previousResource.data),
        });
      } catch (error) {
        const stateSnapshot = get();
        const message = error instanceof Error ? error.message : 'Failed to load sessions';
        set({
          sessionsResource: createErrorResourceState({
            ...stateSnapshot.sessionsResource,
            hasLoadedOnce: stateSnapshot.sessionsResource.hasLoadedOnce || stateSnapshot.sessionsResource.data.length > 0,
          }, message),
        });
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
        readSessionsFromState(state),
        state.sessionsByKey,
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
      disposeActiveStreamPacer(set, get);
      resetToolSnapshotTxnState();
      const state = get();
      const { currentSessionKey } = state;
      const leavingEmpty = isTrulyEmptyNonMainSession(currentSessionKey, state);
      let nextSessionsByKey = { ...state.sessionsByKey };
      if (leavingEmpty) {
        clearSessionHistoryFingerprints(historyRuntime, currentSessionKey);
        nextSessionsByKey = removeSessionRecord({ sessionsByKey: nextSessionsByKey }, currentSessionKey);
      }
      nextSessionsByKey = ensureSessionRecordMap(nextSessionsByKey, key);
      const targetRecord = resolveSessionRecord(nextSessionsByKey[key]);
      const hasHistoryFingerprint = historyRuntime.historyFingerprintBySession.has(key);
      const targetSessionReady = Boolean(targetRecord.meta.ready) || hasHistoryFingerprint;
      trackUiEvent('chat.session_switch_start', {
        fromSessionKey: currentSessionKey,
        toSessionKey: key,
        targetSessionReady,
        hasHistoryFingerprint,
        targetSending: targetRecord.runtime.sending,
      });

      set((stateValue) => ({
        currentSessionKey: key,
        snapshotReady: stateValue.snapshotReady || targetSessionReady,
        initialLoading: false,
        refreshing: false,
        error: null,
        sessionsByKey: nextSessionsByKey,
        ...(leavingEmpty ? {
          sessionsResource: {
            ...stateValue.sessionsResource,
            data: stateValue.sessionsResource.data.filter((session) => session.key !== currentSessionKey),
          },
          pendingApprovalsBySession: Object.fromEntries(
            Object.entries(stateValue.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== currentSessionKey),
          ),
        } : {}),
      }));

      if (targetRecord.runtime.sending) {
        const POLL_INTERVAL = 4_000;
        const pollHistory = () => {
          const current = get();
          const runtime = getSessionRuntime(current, current.currentSessionKey);
          if (!runtime.sending) {
            clearHistoryPoll();
            return;
          }
          if (!runtime.assistantOverlay) {
            void current.loadHistory({
              sessionKey: current.currentSessionKey,
              mode: 'quiet',
              scope: 'foreground',
              reason: 'switch_session_poll',
            });
          }
          setHistoryPollTimer(setTimeout(pollHistory, POLL_INTERVAL));
        };
        setHistoryPollTimer(setTimeout(pollHistory, 1_000));
      }

      const shouldQuietReload = targetSessionReady;
      const shouldDeferQuietReload = shouldQuietReload && !targetRecord.runtime.sending;
      scheduleNextFrame(() => {
        if (shouldDeferQuietReload) {
          scheduleIdleTask(() => {
            void get().loadHistory({
              sessionKey: key,
              mode: 'quiet',
              scope: 'foreground',
              reason: 'switch_session_idle_reconcile',
            });
          });
          return;
        }
        void get().loadHistory({
          sessionKey: key,
          mode: shouldQuietReload ? 'quiet' : 'active',
          scope: 'foreground',
          reason: 'switch_session_reconcile',
        });
      });
    },

    deleteSession: async (key: string) => {
      disposeActiveStreamPacer(set, get);
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
        const remaining = sessions.filter((session) => session.key !== key);
        clearSessionHistoryFingerprints(historyRuntime, key);

        if (currentSessionKey === key) {
          clearHistoryPoll();
          clearErrorRecoveryTimer();
          const next = remaining[0];
          set((state) => ({
            sessionsByKey: removeSessionRecord(state, key),
            sessionsResource: {
              ...state.sessionsResource,
              data: remaining,
            },
            pendingApprovalsBySession: Object.fromEntries(
              Object.entries(state.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== key),
            ),
            error: null,
            initialLoading: false,
            refreshing: false,
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
        } else {
          set((state) => ({
            sessionsByKey: removeSessionRecord(state, key),
            sessionsResource: {
              ...state.sessionsResource,
              data: remaining,
            },
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
      disposeActiveStreamPacer(set, get);
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
      const newSessionEntry: ChatSession = { key: newKey, displayName: newKey };
      set((stateValue) => ({
        sessionsByKey: {
          ...(leavingEmpty ? removeSessionRecord(stateValue, currentSessionKey) : stateValue.sessionsByKey),
          [newKey]: createEmptySessionRecord(),
        },
        currentSessionKey: newKey,
        sessionsResource: {
          ...stateValue.sessionsResource,
          data: [
            ...(leavingEmpty
              ? stateValue.sessionsResource.data.filter((session) => session.key !== currentSessionKey)
              : stateValue.sessionsResource.data),
            newSessionEntry,
          ],
        },
        pendingApprovalsBySession: leavingEmpty
          ? Object.fromEntries(
              Object.entries(stateValue.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== currentSessionKey),
            )
          : stateValue.pendingApprovalsBySession,
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
        sessionsResource: {
          ...stateValue.sessionsResource,
          data: stateValue.sessionsResource.data.filter((session) => session.key !== currentSessionKey),
        },
        sessionsByKey: removeSessionRecord(stateValue, currentSessionKey),
        pendingApprovalsBySession: Object.fromEntries(
          Object.entries(stateValue.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== currentSessionKey),
        ),
      }));
    },
  };
}
