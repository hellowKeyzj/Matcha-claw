import { hostSessionWindowFetch } from '@/lib/host-api';
import {
  hasPendingPreviewLoads,
  hydrateAttachedFilesFromCache,
  loadMissingPreviews,
} from './attachment-helpers';
import {
  CHAT_HISTORY_FULL_LIMIT,
} from './history-constants';
import {
  fetchHistoryWindow,
  loadCronFallbackMessages,
  type HistoryWindowResult,
} from './history-fetch-helpers';
import { normalizeHistoryMessages } from './history-normalizer-worker-client';
import {
  buildHistoryApplyPatch,
  buildHistoryPreviewHydrationPatch,
  reconcileHistoryWindow,
  resolveHistoryActivityFlags,
} from './history-apply-helpers';
import {
  resolveSessionLabelFromMessages,
  sanitizeCanonicalMessages,
} from './message-helpers';
import { finishChatRunTelemetry } from './telemetry';
import { clearHistoryPoll } from './timers';
import {
  buildHistoryFingerprint,
  buildQuickRawHistoryFingerprint,
  buildRenderMessagesFingerprint,
  getSessionMessages,
  getSessionRuntime,
  getSessionViewportState,
  isSessionHistoryReady,
  patchSessionMessagesAndViewport,
  patchSessionViewportState,
  patchSessionMeta,
  toMs,
} from './store-state-helpers';
import { readSessionsFromState } from './session-helpers';
import {
  isHistoryLoadAbortError,
  throwIfHistoryLoadAborted,
} from './history-abort';
import type { StoreHistoryCache } from './history-cache';
import type { ChatHistoryLoadRequest, ChatStoreState } from './types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

export interface HistoryLoadExecutionDeps {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  historyRuntime: StoreHistoryCache;
  loadingTimeoutMs: number;
}

export interface ViewportWindowLoadRequest {
  sessionKey: string;
  mode: 'older' | 'latest';
}

interface CreateApplyLoadedMessagesInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  historyRuntime: StoreHistoryCache;
  requestedSessionKey: string;
  mode: ChatHistoryLoadRequest['mode'];
  scope: ChatHistoryLoadRequest['scope'];
  abortSignal: AbortSignal;
  shouldAbortHistoryProcessing: () => boolean;
}

function resolveViewportFetchLimit(messageCount: number): number {
  return Math.min(Math.max(messageCount || 80, 40), 200);
}

function resolveViewportWindowRequestState(input: {
  mode: ViewportWindowLoadRequest['mode'];
  beforeViewport: ReturnType<typeof getSessionViewportState>;
  payload: Awaited<ReturnType<typeof hostSessionWindowFetch>>;
}) {
  const { mode, beforeViewport, payload } = input;
  if (mode !== 'older') {
    return {
      windowStartOffset: payload.windowStartOffset,
      windowEndOffset: payload.windowEndOffset,
      hasMore: payload.hasMore,
      hasNewer: payload.hasNewer,
      isAtLatest: payload.isAtLatest,
    };
  }

  const windowStartOffset = payload.windowStartOffset;
  const windowEndOffset = Math.max(beforeViewport.windowEndOffset, payload.windowEndOffset);
  return {
    windowStartOffset,
    windowEndOffset,
    hasMore: windowStartOffset > 0,
    hasNewer: windowEndOffset < payload.totalMessageCount,
    isAtLatest: windowEndOffset >= payload.totalMessageCount,
  };
}

function setViewportLoadingState(input: {
  set: ChatStoreSetFn;
  sessionKey: string;
  mode: ViewportWindowLoadRequest['mode'];
  value: boolean;
}): void {
  const { set, sessionKey, mode, value } = input;
  set((state) => {
    const currentViewport = getSessionViewportState(state, sessionKey);
    return {
      loadedSessions: patchSessionViewportState(state, sessionKey, {
        ...currentViewport,
        ...(mode === 'older'
          ? { isLoadingMore: value }
          : { isLoadingNewer: value }),
      }),
    };
  });
}

export async function executeViewportWindowLoad(
  deps: Pick<HistoryLoadExecutionDeps, 'set' | 'get'>,
  request: ViewportWindowLoadRequest,
): Promise<void> {
  const sessionKey = request.sessionKey.trim();
  if (!sessionKey) {
    return;
  }

  const beforeViewport = getSessionViewportState(deps.get(), sessionKey);
  if (request.mode === 'older') {
    if (!beforeViewport.hasMore || beforeViewport.isLoadingMore) {
      return;
    }
  } else if (beforeViewport.isLoadingNewer && beforeViewport.isAtLatest) {
    return;
  }

  setViewportLoadingState({
    set: deps.set,
    sessionKey,
    mode: request.mode,
    value: true,
  });

  try {
    const currentState = deps.get();
    const currentMessages = getSessionMessages(currentState, sessionKey);
    const payload = await hostSessionWindowFetch({
      sessionKey,
      mode: request.mode,
      limit: resolveViewportFetchLimit(currentMessages.length),
      ...(request.mode === 'older' ? { offset: beforeViewport.windowStartOffset } : {}),
      includeCanonical: true,
    });
    const canonicalMessages = sanitizeCanonicalMessages(
      Array.isArray(payload.canonicalMessages) && payload.canonicalMessages.length > 0
        ? payload.canonicalMessages
        : payload.messages,
    );
    const nextViewportRequestState = resolveViewportWindowRequestState({
      mode: request.mode,
      beforeViewport,
      payload,
    });
    const nextWindow = reconcileHistoryWindow({
      currentMessages,
      currentViewport: beforeViewport,
      canonicalMessages,
      totalMessageCount: payload.totalMessageCount,
      windowStartOffset: nextViewportRequestState.windowStartOffset,
      windowEndOffset: nextViewportRequestState.windowEndOffset,
      hasMore: nextViewportRequestState.hasMore,
      hasNewer: nextViewportRequestState.hasNewer,
      isAtLatest: nextViewportRequestState.isAtLatest,
      runtime: getSessionRuntime(currentState, sessionKey),
    });
    deps.set((state) => ({
      loadedSessions: patchSessionMessagesAndViewport(
        state,
        sessionKey,
        nextWindow.messages,
        nextWindow.viewport,
      ),
    }));
  } catch {
    setViewportLoadingState({
      set: deps.set,
      sessionKey,
      mode: request.mode,
      value: false,
    });
  }
}

function shouldSkipForegroundApply(
  get: ChatStoreGetFn,
  scope: ChatHistoryLoadRequest['scope'],
  requestedSessionKey: string,
): boolean {
  return scope === 'foreground' && get().currentSessionKey !== requestedSessionKey;
}

export function createApplyLoadedMessagesPipeline(
  input: CreateApplyLoadedMessagesInput,
): (window: HistoryWindowResult) => Promise<void> {
  const {
    set,
    get,
    historyRuntime,
    requestedSessionKey,
    scope,
    abortSignal,
    shouldAbortHistoryProcessing,
  } = input;
  const isForeground = scope === 'foreground';

  return async (window: HistoryWindowResult) => {
    const canonicalRawMessages = sanitizeCanonicalMessages(window.canonicalRawMessages ?? window.rawMessages);
    const quickFingerprint = buildQuickRawHistoryFingerprint(canonicalRawMessages, window.thinkingLevel);
    const previousQuickFingerprint = historyRuntime.historyQuickFingerprintBySession.get(requestedSessionKey) ?? null;
    const currentStateForQuickPath = get();
    const currentMessages = getSessionMessages(currentStateForQuickPath, requestedSessionKey);
    const currentMeta = currentStateForQuickPath.loadedSessions[requestedSessionKey]?.meta;
    const canSkipWithQuickFingerprint = (
      previousQuickFingerprint === quickFingerprint
      && (currentMessages.length > 0 || isSessionHistoryReady(currentMeta?.historyStatus))
      && (currentMeta?.thinkingLevel ?? null) === window.thinkingLevel
    );
    if (canSkipWithQuickFingerprint) {
      if (!historyRuntime.historyRenderFingerprintBySession.has(requestedSessionKey)) {
        historyRuntime.historyRenderFingerprintBySession.set(
          requestedSessionKey,
          buildRenderMessagesFingerprint(currentMessages),
        );
      }
      if (!isSessionHistoryReady(currentMeta?.historyStatus)) {
        set((state) => ({
          loadedSessions: patchSessionMeta(state, requestedSessionKey, { historyStatus: 'ready' }),
        }));
      }
      return;
    }
    historyRuntime.historyQuickFingerprintBySession.set(requestedSessionKey, quickFingerprint);

    if (shouldAbortHistoryProcessing()) {
      return;
    }
    throwIfHistoryLoadAborted(abortSignal, shouldAbortHistoryProcessing);

    const normalizedMessages = window.normalizedMessages ?? canonicalRawMessages;
    if (shouldAbortHistoryProcessing()) {
      return;
    }
    throwIfHistoryLoadAborted(abortSignal, shouldAbortHistoryProcessing);
    const enrichedMessages = hydrateAttachedFilesFromCache(normalizedMessages);
    if (shouldAbortHistoryProcessing()) {
      return;
    }
    throwIfHistoryLoadAborted(abortSignal, shouldAbortHistoryProcessing);

    const runtimeState = get();
    const currentSessionMessages = getSessionMessages(runtimeState, requestedSessionKey);
    const currentViewport = getSessionViewportState(runtimeState, requestedSessionKey);
    const currentRuntime = getSessionRuntime(runtimeState, requestedSessionKey);
    const nextWindow = reconcileHistoryWindow({
      currentMessages: currentSessionMessages,
      currentViewport,
      canonicalMessages: enrichedMessages,
      totalMessageCount: window.totalMessageCount,
      windowStartOffset: window.windowStartOffset,
      windowEndOffset: window.windowEndOffset,
      hasMore: window.hasMore,
      hasNewer: window.hasNewer,
      isAtLatest: window.isAtLatest,
      runtime: runtimeState.currentSessionKey === requestedSessionKey ? currentRuntime : undefined,
    });
    const finalMessages = nextWindow.messages;
    if (shouldAbortHistoryProcessing()) {
      return;
    }
    throwIfHistoryLoadAborted(abortSignal, shouldAbortHistoryProcessing);

    const isMainSession = requestedSessionKey.endsWith(':main');
    const resolvedLabel = !isMainSession
      ? resolveSessionLabelFromMessages(finalMessages)
      : '';
    const lastMsg = finalMessages[finalMessages.length - 1];
    const lastAt = lastMsg?.timestamp ? toMs(lastMsg.timestamp) : null;
    const viewportWindowStart = nextWindow.viewport.windowStartOffset;
    const viewportWindowEnd = nextWindow.viewport.windowEndOffset;
    const viewportMessages = nextWindow.viewportMessages;
    const renderFingerprint = buildRenderMessagesFingerprint(viewportMessages);
    const previousRenderFingerprint = historyRuntime.historyRenderFingerprintBySession.get(requestedSessionKey) ?? null;

    const activityRuntimeState = get();
    const activityRuntime = getSessionRuntime(activityRuntimeState, requestedSessionKey);
    const shouldResolveHistoryActivity = (
      isForeground
      && activityRuntimeState.currentSessionKey === requestedSessionKey
    );
    const historyActivityFlags = shouldResolveHistoryActivity
      ? resolveHistoryActivityFlags({
          normalizedMessages,
          isSendingNow: activityRuntime.sending,
          pendingFinal: activityRuntime.pendingFinal,
          lastUserMessageAt: activityRuntime.lastUserMessageAt,
        })
      : {
          hasRecentAssistantActivity: false,
          hasRecentFinalAssistantMessage: false,
        };

    let didMessageListChange = false;
    set((state) => {
      const applyPatchResult = buildHistoryApplyPatch(state, {
        requestedSessionKey,
        scope,
        finalMessages,
        viewportMessages,
        thinkingLevel: window.thinkingLevel,
        totalMessageCount: window.totalMessageCount,
        windowStartOffset: viewportWindowStart,
        windowEndOffset: viewportWindowEnd,
        hasMore: window.hasMore,
        hasNewer: window.hasNewer,
        isAtLatest: window.isAtLatest,
        resolvedLabel,
        lastAt,
        previousRenderFingerprint,
        renderFingerprint,
        flags: historyActivityFlags,
      });
      didMessageListChange = applyPatchResult.didMessageListChange;
      return applyPatchResult.patch ?? state;
    });
    historyRuntime.historyRenderFingerprintBySession.set(requestedSessionKey, renderFingerprint);

    if (isForeground && historyActivityFlags.hasRecentFinalAssistantMessage) {
      finishChatRunTelemetry(requestedSessionKey, 'completed', { stage: 'history_applied' });
      clearHistoryPoll();
    }

    if ((didMessageListChange || scope === 'background') && hasPendingPreviewLoads(viewportMessages)) {
      void loadMissingPreviews(viewportMessages).then((updated) => {
        if (!updated) {
          return;
        }
        if (abortSignal.aborted || shouldAbortHistoryProcessing()) {
          return;
        }
        set((state) => buildHistoryPreviewHydrationPatch(
          state,
          requestedSessionKey,
          viewportMessages,
        ));
      });
    }
  };
}

export async function executeHistoryLoad(
  deps: HistoryLoadExecutionDeps,
  request: ChatHistoryLoadRequest,
): Promise<void> {
  const {
    set,
    get,
    historyRuntime,
    loadingTimeoutMs,
  } = deps;
  const requestedSessionKey = request.sessionKey;
  const mode = request.mode;
  const scope = request.scope;
  let failed = false;
  let recovered = false;
  let aborted = false;
  const abortController = new AbortController();
  const previousAbortController = historyRuntime.replaceHistoryLoadAbortController(
    requestedSessionKey,
    abortController,
  );
  if (previousAbortController && !previousAbortController.signal.aborted) {
    previousAbortController.abort('history_load_superseded');
  }
  const historyLoadRunId = scope === 'foreground' ? historyRuntime.nextHistoryLoadRunId() : 0;
  let loadingSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  if (scope === 'foreground') {
    set({
      foregroundHistorySessionKey: requestedSessionKey,
      error: null,
      ...(mode === 'active'
        ? {
            loadedSessions: patchSessionMeta(get(), requestedSessionKey, {
              historyStatus: 'loading',
            }),
          }
        : {}),
    });
    loadingSafetyTimer = setTimeout(() => {
      set((state) => {
        if (
          historyLoadRunId !== historyRuntime.getHistoryLoadRunId()
          || state.foregroundHistorySessionKey !== requestedSessionKey
        ) {
          return state;
        }
        return { foregroundHistorySessionKey: null };
      });
    }, loadingTimeoutMs);
  }
  const shouldAbortHistoryProcessing = () => (
    abortController.signal.aborted
    || (scope === 'foreground' && get().currentSessionKey !== requestedSessionKey)
    || (scope === 'foreground' && historyLoadRunId !== historyRuntime.getHistoryLoadRunId())
  );
  const applyLoadedMessages = createApplyLoadedMessagesPipeline({
    set,
    get,
    historyRuntime,
    requestedSessionKey,
    mode,
    scope,
    abortSignal: abortController.signal,
    shouldAbortHistoryProcessing,
  });

  try {
    throwIfHistoryLoadAborted(abortController.signal, shouldAbortHistoryProcessing);
    const window = await fetchHistoryWindow({
      requestedSessionKey,
      sessions: readSessionsFromState(get()),
      limit: CHAT_HISTORY_FULL_LIMIT,
    });
    throwIfHistoryLoadAborted(abortController.signal, shouldAbortHistoryProcessing);
    if (shouldSkipForegroundApply(get, scope, requestedSessionKey)) {
      return;
    }
    const canonicalRawMessages = window.canonicalRawMessages ?? window.rawMessages;
    const normalizedMessages = await normalizeHistoryMessages(
      canonicalRawMessages,
      { abortSignal: abortController.signal },
    );
    throwIfHistoryLoadAborted(abortController.signal, shouldAbortHistoryProcessing);
    historyRuntime.historyFingerprintBySession.set(
      requestedSessionKey,
      buildHistoryFingerprint(canonicalRawMessages, window.thinkingLevel),
    );
    await applyLoadedMessages({
      ...window,
      canonicalRawMessages,
      normalizedMessages,
    });
  } catch (err) {
    if (isHistoryLoadAbortError(err)) {
      aborted = true;
    } else {
      failed = true;
      try {
        const fallbackMessages = await loadCronFallbackMessages(requestedSessionKey, CHAT_HISTORY_FULL_LIMIT);
        if (scope === 'foreground' && get().currentSessionKey !== requestedSessionKey) {
          recovered = true;
          return;
        }
        if (fallbackMessages.length > 0) {
          historyRuntime.historyFingerprintBySession.set(
            requestedSessionKey,
            buildHistoryFingerprint(fallbackMessages, null),
          );
          await applyLoadedMessages({
            rawMessages: fallbackMessages,
            canonicalRawMessages: fallbackMessages,
            thinkingLevel: null,
            totalMessageCount: fallbackMessages.length,
            windowStartOffset: 0,
            windowEndOffset: fallbackMessages.length,
            hasMore: false,
            hasNewer: false,
            isAtLatest: true,
          });
          recovered = true;
          return;
        }
        if (mode === 'quiet') {
          recovered = true;
          return;
        }
        historyRuntime.historyFingerprintBySession.set(requestedSessionKey, buildHistoryFingerprint([], null));
        historyRuntime.historyQuickFingerprintBySession.set(
          requestedSessionKey,
          buildQuickRawHistoryFingerprint([], null),
        );
        historyRuntime.historyRenderFingerprintBySession.set(
          requestedSessionKey,
          buildRenderMessagesFingerprint([]),
        );
        if (scope === 'foreground') {
          set({
            loadedSessions: patchSessionMeta(get(), requestedSessionKey, {
              historyStatus: 'error',
            }),
            error: err instanceof Error ? err.message : String(err),
          });
        }
        recovered = true;
      } catch (recoveryError) {
        if (isHistoryLoadAbortError(recoveryError)) {
          aborted = true;
        } else {
          throw recoveryError;
        }
      }
    }
  } finally {
    historyRuntime.clearHistoryLoadAbortController(requestedSessionKey, abortController);
    if (loadingSafetyTimer) {
      clearTimeout(loadingSafetyTimer);
    }
    if (scope === 'foreground') {
      set((state) => {
        if (
          historyLoadRunId !== historyRuntime.getHistoryLoadRunId()
          || state.foregroundHistorySessionKey !== requestedSessionKey
        ) {
          return state;
        }
        return { foregroundHistorySessionKey: null };
      });
    }
    void failed;
    void recovered;
    void aborted;
  }
}
