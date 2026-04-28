import { hostApiFetch, hostSessionWindowFetch } from '@/lib/host-api';
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
import { resolveSessionLabelFromMessages } from './message-helpers';
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
  createEmptySessionViewportState,
  getSessionRuntime,
  getSessionMeta,
  getSessionViewportState,
  patchSessionMeta,
  patchSessionViewportState,
  removeSessionRecord,
  removeSessionViewportState,
  resolveSessionRecord,
} from './store-state-helpers';
import { selectStreamingRenderMessage } from './stream-overlay-message';
import { createViewportWindowState } from './viewport-state';
import { appendViewportMessage, upsertViewportMessage } from './viewport-state';
import type { StoreHistoryCache } from './history-cache';
import type {
  ChatSession,
  ChatStoreState,
  RawMessage,
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
  | 'loadSessions'
  | 'openAgentConversation'
  | 'switchSession'
  | 'deleteSession'
  | 'newSession'
  | 'cleanupEmptySession'
  | 'loadOlderMessages'
  | 'jumpToLatest'
  | 'trimTopMessages'
  | 'setViewportLastVisibleMessageId'
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

function resolveViewportFetchLimit(messageCount: number): number {
  return Math.min(Math.max(messageCount || 80, 40), 200);
}

const SESSION_LABEL_HYDRATE_LIMIT = 200;

function readMessagesFromSessionPayload(payload: Record<string, unknown> | null | undefined): RawMessage[] {
  if (!payload || !Array.isArray(payload.messages)) {
    return [];
  }
  return payload.messages as RawMessage[];
}

async function fetchSessionLabelSummary(sessionKey: string): Promise<string | null> {
  try {
    const sessionsGetPayload = await useGatewayStore.getState().rpc<Record<string, unknown>>('sessions.get', {
      key: sessionKey,
      limit: SESSION_LABEL_HYDRATE_LIMIT,
    });
    const sessionMessages = readMessagesFromSessionPayload(sessionsGetPayload);
    if (sessionMessages.length > 0) {
      return resolveSessionLabelFromMessages(sessionMessages);
    }
  } catch {
    void 0;
  }

  try {
    const historyPayload = await useGatewayStore.getState().rpc<Record<string, unknown>>('chat.history', {
      sessionKey,
      limit: SESSION_LABEL_HYDRATE_LIMIT,
    });
    return resolveSessionLabelFromMessages(readMessagesFromSessionPayload(historyPayload));
  } catch {
    return null;
  }
}

function buildViewportFromWindowPayload(
  currentViewport: ReturnType<typeof createEmptySessionViewportState>,
  payload: {
    messages: RawMessage[];
    totalMessageCount: number;
    windowStartOffset: number;
    windowEndOffset: number;
    hasMore: boolean;
    hasNewer: boolean;
    isAtLatest: boolean;
  },
  runtimeState?: ReturnType<typeof getSessionRuntime>,
) {
  let nextViewport = createViewportWindowState({
    ...currentViewport,
    messages: payload.messages,
    totalMessageCount: payload.totalMessageCount,
    windowStartOffset: payload.windowStartOffset,
    windowEndOffset: payload.windowEndOffset,
    hasMore: payload.hasMore,
    hasNewer: payload.hasNewer,
    isLoadingMore: false,
    isLoadingNewer: false,
    isAtLatest: payload.isAtLatest,
  });
  const pendingUserMessage = runtimeState?.pendingUserMessage?.message ?? null;
  if (pendingUserMessage) {
    nextViewport = appendViewportMessage(nextViewport, pendingUserMessage);
  }
  const streamingMessage = runtimeState ? selectStreamingRenderMessage(runtimeState) : null;
  if (streamingMessage) {
    nextViewport = upsertViewportMessage(nextViewport, streamingMessage);
  }
  return nextViewport;
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
                const explicit = (session.label || '').trim();
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
                viewportBySession: sessionKeyChanged && !state.viewportBySession[nextSessionKey]
                  ? {
                      ...state.viewportBySession,
                      [nextSessionKey]: createEmptySessionViewportState(),
                    }
                  : state.viewportBySession,
              };
            });
          } else {
            set({
              sessionsResource: createReadyResourceState(get().sessionsResource.data, loadedAt),
            });
          }
          const sessionLabelHydrationTargets = sessionsWithCurrent.filter((session) => {
            const explicitLabel = (session.label || '').trim();
            if (explicitLabel) {
              return false;
            }
            const currentMeta = getSessionMeta(snapshot, session.key);
            const displayName = session.displayName?.trim() ?? '';
            const activityAt = discoveredActivity[session.key];
            const labelPromotedFromDisplayName = displayName.length > 0 && currentMeta.label === displayName;
            const activityChanged = typeof activityAt === 'number' && currentMeta.lastActivityAt !== activityAt;
            return labelPromotedFromDisplayName || !currentMeta.label || activityChanged;
          });

          if (sessionLabelHydrationTargets.length > 0) {
            const hydratedLabels = await Promise.all(
              sessionLabelHydrationTargets.map(async (session) => (
                [session.key, await fetchSessionLabelSummary(session.key)] as const
              )),
            );
            set((state) => {
              let sessionsByKey = state.sessionsByKey;
              let changed = false;
              const currentSessionByKey = new Map(
                readSessionsFromState(state).map((session) => [session.key, session] as const),
              );

              for (const [sessionKey, hydratedLabel] of hydratedLabels) {
                const currentSession = currentSessionByKey.get(sessionKey);
                if ((currentSession?.label || '').trim()) {
                  continue;
                }
                const currentLabel = getSessionMeta(state, sessionKey).label;
                const nextLabel = hydratedLabel ?? null;
                if (currentLabel === nextLabel) {
                  continue;
                }
                sessionsByKey = patchSessionMeta({ sessionsByKey }, sessionKey, { label: nextLabel });
                changed = true;
              }

              return changed ? { sessionsByKey } : state;
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
      const currentState = get();
      if (key === currentState.currentSessionKey) {
        scheduleNextFrame(() => {
          void get().loadHistory({
            sessionKey: key,
            mode: 'active',
            scope: 'foreground',
            reason: 'switch_session_reselect',
          });
        });
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
      let nextViewportBySession = state.viewportBySession;
      if (leavingEmpty) {
        clearSessionHistoryFingerprints(historyRuntime, currentSessionKey);
        nextSessionsByKey = removeSessionRecord({ sessionsByKey: nextSessionsByKey }, currentSessionKey);
        nextViewportBySession = removeSessionViewportState(
          { viewportBySession: nextViewportBySession },
          currentSessionKey,
        );
      }
      nextSessionsByKey = ensureSessionRecordMap(nextSessionsByKey, key);
      if (!nextViewportBySession[key]) {
        nextViewportBySession = {
          ...nextViewportBySession,
          [key]: createEmptySessionViewportState(),
        };
      }
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
        viewportBySession: nextViewportBySession,
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

    loadOlderMessages: async (sessionKeyHint?: string) => {
      const sessionKey = sessionKeyHint?.trim() || get().currentSessionKey;
      const beforeViewport = getSessionViewportState(get(), sessionKey);
      if (!beforeViewport.hasMore || beforeViewport.isLoadingMore) {
        return;
      }

      set((state) => ({
        viewportBySession: patchSessionViewportState(state, sessionKey, {
          ...getSessionViewportState(state, sessionKey),
          isLoadingMore: true,
          anchorRestore: beforeViewport.messages[0]?.id ? { messageId: beforeViewport.messages[0].id! } : null,
        }),
      }));

      try {
        const payload = await hostSessionWindowFetch({
          sessionKey,
          mode: 'older',
          limit: resolveViewportFetchLimit(beforeViewport.messages.length),
          offset: beforeViewport.windowStartOffset,
        });
        set((state) => ({
          viewportBySession: patchSessionViewportState(
            state,
            sessionKey,
            buildViewportFromWindowPayload(getSessionViewportState(state, sessionKey), {
              messages: payload.messages as RawMessage[],
              totalMessageCount: payload.totalMessageCount,
              windowStartOffset: payload.windowStartOffset,
              windowEndOffset: payload.windowEndOffset,
              hasMore: payload.hasMore,
              hasNewer: payload.hasNewer,
              isAtLatest: payload.isAtLatest,
            }, resolveSessionRecord(state.sessionsByKey[sessionKey]).runtime),
          ),
        }));
      } catch {
        set((state) => ({
          viewportBySession: patchSessionViewportState(state, sessionKey, {
            ...getSessionViewportState(state, sessionKey),
            isLoadingMore: false,
            anchorRestore: null,
          }),
        }));
      }
    },

    jumpToLatest: async (sessionKeyHint?: string) => {
      const sessionKey = sessionKeyHint?.trim() || get().currentSessionKey;
      const beforeViewport = getSessionViewportState(get(), sessionKey);
      if (beforeViewport.isLoadingNewer && beforeViewport.isAtLatest) {
        return;
      }
      set((state) => ({
        viewportBySession: patchSessionViewportState(state, sessionKey, {
          ...getSessionViewportState(state, sessionKey),
          isLoadingNewer: true,
        }),
      }));

      try {
        const payload = await hostSessionWindowFetch({
          sessionKey,
          mode: 'latest',
          limit: resolveViewportFetchLimit(beforeViewport.messages.length),
        });
        set((state) => ({
          viewportBySession: patchSessionViewportState(
            state,
            sessionKey,
            buildViewportFromWindowPayload(getSessionViewportState(state, sessionKey), {
              messages: payload.messages as RawMessage[],
              totalMessageCount: payload.totalMessageCount,
              windowStartOffset: payload.windowStartOffset,
              windowEndOffset: payload.windowEndOffset,
              hasMore: payload.hasMore,
              hasNewer: payload.hasNewer,
              isAtLatest: payload.isAtLatest,
            }, resolveSessionRecord(state.sessionsByKey[sessionKey]).runtime),
          ),
        }));
      } catch {
        set((state) => ({
          viewportBySession: patchSessionViewportState(state, sessionKey, {
            ...getSessionViewportState(state, sessionKey),
            isLoadingNewer: false,
          }),
        }));
      }
    },

    trimTopMessages: (sessionKeyHint?: string, keep = 120) => {
      const sessionKey = sessionKeyHint?.trim() || get().currentSessionKey;
      set((state) => {
        const viewport = getSessionViewportState(state, sessionKey);
        if (viewport.messages.length <= keep) {
          return state;
        }
        const nextMessages = viewport.messages.slice(-keep);
        const removedCount = viewport.messages.length - nextMessages.length;
        const nextViewport = createViewportWindowState({
          ...viewport,
          messages: nextMessages,
          windowStartOffset: viewport.windowStartOffset + removedCount,
          windowEndOffset: viewport.windowEndOffset,
          hasMore: true,
          anchorRestore: null,
        });
        return {
          viewportBySession: patchSessionViewportState(state, sessionKey, nextViewport),
        };
      });
    },

    setViewportLastVisibleMessageId: (messageId: string | null, sessionKeyHint?: string) => {
      const sessionKey = sessionKeyHint?.trim() || get().currentSessionKey;
      set((state) => ({
        viewportBySession: patchSessionViewportState(state, sessionKey, {
          ...getSessionViewportState(state, sessionKey),
          lastVisibleMessageId: messageId,
        }),
      }));
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
            viewportBySession: removeSessionViewportState(state, key),
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
            viewportBySession: removeSessionViewportState(state, key),
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
        viewportBySession: {
          ...(leavingEmpty
            ? removeSessionViewportState(stateValue, currentSessionKey)
            : stateValue.viewportBySession),
          [newKey]: createEmptySessionViewportState(),
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
        viewportBySession: removeSessionViewportState(stateValue, currentSessionKey),
        pendingApprovalsBySession: Object.fromEntries(
          Object.entries(stateValue.pendingApprovalsBySession).filter(([sessionKey]) => sessionKey !== currentSessionKey),
        ),
      }));
    },
  };
}
