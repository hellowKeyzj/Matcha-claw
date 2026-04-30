import { hostApiFetch, hostSessionWindowFetch } from '@/lib/host-api';
import {
  createErrorResourceStatusState,
  createLoadingResourceStatusState,
  createReadyResourceStatusState,
} from '@/lib/resource-state';
import { trackUiEvent } from '@/lib/telemetry';
import { prewarmAssistantMarkdownBodies } from '@/lib/chat-markdown-body';
import { prewarmStaticRowsForMessages } from '@/pages/Chat/chat-rows-cache';
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
import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  setHistoryPollTimer,
} from './timers';
import { resetToolSnapshotTxnState } from './tool-snapshot-txn';
import {
  mergeMessageReferences,
  createEmptySessionRecord,
  createEmptySessionViewportState,
  getSessionRuntime,
  getSessionMeta,
  getSessionViewportState,
  patchSessionMeta,
  patchSessionViewportState,
  removeSessionRecord,
  resolveSessionRecord,
} from './store-state-helpers';
import { createViewportWindowState } from './viewport-state';
import { appendViewportMessage } from './viewport-state';
import {
  findCurrentStreamingMessage,
  upsertMessageById,
} from './streaming-message';
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

function reuseViewportMessageReferences(
  currentViewport: ReturnType<typeof createEmptySessionViewportState>,
  payload: {
    messages: RawMessage[];
    windowStartOffset: number;
    windowEndOffset: number;
  },
): RawMessage[] {
  const currentMessages = currentViewport.messages;
  const nextMessages = payload.messages;
  if (currentMessages.length === 0 || nextMessages.length === 0) {
    return nextMessages;
  }

  const overlapStart = Math.max(currentViewport.windowStartOffset, payload.windowStartOffset);
  const overlapEnd = Math.min(currentViewport.windowEndOffset, payload.windowEndOffset);
  if (overlapEnd <= overlapStart) {
    return nextMessages;
  }

  const currentOverlapStart = overlapStart - currentViewport.windowStartOffset;
  const currentOverlapEnd = overlapEnd - currentViewport.windowStartOffset;
  const nextOverlapStart = overlapStart - payload.windowStartOffset;
  const nextOverlapEnd = overlapEnd - payload.windowStartOffset;
  const currentOverlap = currentMessages.slice(currentOverlapStart, currentOverlapEnd);
  const nextOverlap = nextMessages.slice(nextOverlapStart, nextOverlapEnd);
  const mergedOverlap = mergeMessageReferences(currentOverlap, nextOverlap);

  if (mergedOverlap === nextOverlap) {
    return nextMessages;
  }
  if (nextOverlapStart === 0 && nextOverlapEnd === nextMessages.length) {
    return mergedOverlap;
  }

  const mergedMessages = nextMessages.slice();
  mergedMessages.splice(nextOverlapStart, mergedOverlap.length, ...mergedOverlap);
  return mergedMessages;
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
  const stitchedMessages = reuseViewportMessageReferences(currentViewport, {
    messages: payload.messages,
    windowStartOffset: payload.windowStartOffset,
    windowEndOffset: payload.windowEndOffset,
  });
  let nextViewport = createViewportWindowState({
    ...currentViewport,
    messages: stitchedMessages,
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
  const streamingMessage = runtimeState?.streamingMessageId
    ? findCurrentStreamingMessage(currentViewport.messages, runtimeState.streamingMessageId)
    : null;
  if (streamingMessage) {
    nextViewport = {
      ...nextViewport,
      messages: upsertMessageById(nextViewport.messages, streamingMessage),
    };
  }
  return nextViewport;
}

function prewarmViewportWindow(sessionKey: string, messages: RawMessage[]): void {
  prewarmAssistantMarkdownBodies(messages, 'settled');
  prewarmStaticRowsForMessages(sessionKey, messages);
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
  return sessionRecord.meta.historyStatus !== 'ready' && sessionRecord.window.messages.length === 0;
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
        state.loadedSessions,
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
      const hasHistoryFingerprint = historyRuntime.historyFingerprintBySession.has(key);
      const targetSessionReady = targetRecord.meta.historyStatus === 'ready' || targetRecord.window.messages.length > 0;
      trackUiEvent('chat.session_switch_start', {
        fromSessionKey: currentSessionKey,
        toSessionKey: key,
        targetSessionReady,
        hasHistoryFingerprint,
        targetSending: targetRecord.runtime.sending,
      });

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

      if (targetRecord.runtime.sending) {
        const POLL_INTERVAL = 4_000;
        const pollHistory = () => {
          const current = get();
          const runtime = getSessionRuntime(current, current.currentSessionKey);
          if (!runtime.sending) {
            clearHistoryPoll();
            return;
          }
          if (!runtime.streamingMessageId) {
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
        loadedSessions: patchSessionViewportState(state, sessionKey, {
          ...getSessionViewportState(state, sessionKey),
          isLoadingMore: true,
        }),
      }));

      try {
        const payload = await hostSessionWindowFetch({
          sessionKey,
          mode: 'older',
          limit: resolveViewportFetchLimit(beforeViewport.messages.length),
          offset: beforeViewport.windowStartOffset,
        });
        const nextViewport = buildViewportFromWindowPayload(beforeViewport, {
          messages: payload.messages as RawMessage[],
          totalMessageCount: payload.totalMessageCount,
          windowStartOffset: payload.windowStartOffset,
          windowEndOffset: payload.windowEndOffset,
          hasMore: payload.hasMore,
          hasNewer: payload.hasNewer,
          isAtLatest: payload.isAtLatest,
        }, resolveSessionRecord(get().loadedSessions[sessionKey]).runtime);
        prewarmViewportWindow(sessionKey, nextViewport.messages);
        set((state) => ({
          loadedSessions: patchSessionViewportState(
            state,
            sessionKey,
            nextViewport,
          ),
        }));
      } catch {
        set((state) => ({
          loadedSessions: patchSessionViewportState(state, sessionKey, {
            ...getSessionViewportState(state, sessionKey),
            isLoadingMore: false,
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
        loadedSessions: patchSessionViewportState(state, sessionKey, {
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
        const nextViewport = buildViewportFromWindowPayload(beforeViewport, {
          messages: payload.messages as RawMessage[],
          totalMessageCount: payload.totalMessageCount,
          windowStartOffset: payload.windowStartOffset,
          windowEndOffset: payload.windowEndOffset,
          hasMore: payload.hasMore,
          hasNewer: payload.hasNewer,
          isAtLatest: payload.isAtLatest,
        }, resolveSessionRecord(get().loadedSessions[sessionKey]).runtime);
        prewarmViewportWindow(sessionKey, nextViewport.messages);
        set((state) => ({
          loadedSessions: patchSessionViewportState(
            state,
            sessionKey,
            nextViewport,
          ),
        }));
      } catch {
        set((state) => ({
          loadedSessions: patchSessionViewportState(state, sessionKey, {
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
        });
        return {
          loadedSessions: patchSessionViewportState(state, sessionKey, nextViewport),
        };
      });
    },

    setViewportLastVisibleMessageId: (messageId: string | null, sessionKeyHint?: string) => {
      const sessionKey = sessionKeyHint?.trim() || get().currentSessionKey;
      set((state) => ({
        loadedSessions: patchSessionViewportState(state, sessionKey, {
          ...getSessionViewportState(state, sessionKey),
          lastVisibleMessageId: messageId,
        }),
      }));
    },

    deleteSession: async (key: string) => {
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
        } else {
          set((state) => ({
            loadedSessions: removeSessionRecord(state, key),
            sessionCatalogStatus: state.sessionCatalogStatus,
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
    },

    cleanupEmptySession: () => {
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
    },
  };
}
