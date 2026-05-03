import { hostSessionWindowFetch } from '@/lib/host-api';
import {
  hasPendingTimelineEntryPreviewLoads,
  hydrateAttachedFilesFromTimelineEntries,
  loadMissingTimelineEntryPreviews,
} from './attachment-helpers';
import {
  CHAT_HISTORY_FULL_LIMIT,
} from './history-constants';
import {
  fetchHistoryWindow,
  type HistoryWindowResult,
} from './history-fetch-helpers';
import {
  resolveSessionLabelFromTimelineEntries,
} from './message-helpers';
import {
} from './timeline-message';
import { finishChatRunTelemetry } from './telemetry';
import { clearHistoryPoll } from './timers';
import {
  buildTimelineHistoryFingerprint,
  buildTimelineRenderFingerprint,
  getSessionTimelineEntries,
  getSessionViewportState,
  patchSessionSnapshot,
  patchSessionMeta,
  patchSessionRecord,
  patchSessionViewportState,
  toMs,
} from './store-state-helpers';
import { readSessionsFromState } from './session-helpers';
import { isHistoryLoadAbortError, throwIfHistoryLoadAborted } from './history-abort';
import type { StoreHistoryCache } from './history-cache';
import type { ChatHistoryLoadRequest, ChatStoreState } from './types';
import type { SessionTimelineEntry } from '../../../runtime-host/shared/session-adapter-types';

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
  scope: ChatHistoryLoadRequest['scope'];
  abortSignal: AbortSignal;
  shouldAbortHistoryProcessing: () => boolean;
}

function resolveViewportFetchLimit(messageCount: number): number {
  return Math.min(Math.max(messageCount || 80, 40), 200);
}

function hydrateTimelineEntriesFromCache(
  entries: SessionTimelineEntry[],
): SessionTimelineEntry[] {
  return hydrateAttachedFilesFromTimelineEntries(entries);
}

function resolveViewportWindowRequestState(input: {
  mode: ViewportWindowLoadRequest['mode'];
  beforeViewport: ReturnType<typeof getSessionViewportState>;
  payload: Awaited<ReturnType<typeof hostSessionWindowFetch>>;
}) {
  const { payload } = input;
  const window = payload.snapshot.window;
  return {
    windowStartOffset: window.windowStartOffset,
    windowEndOffset: window.windowEndOffset,
    hasMore: window.hasMore,
    hasNewer: window.hasNewer,
    isAtLatest: window.isAtLatest,
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
    const currentEntries = getSessionTimelineEntries(currentState, sessionKey);
    const payload = await hostSessionWindowFetch({
      sessionKey,
      mode: request.mode,
      limit: resolveViewportFetchLimit(currentEntries.length),
      ...(request.mode === 'older' ? { offset: beforeViewport.windowStartOffset } : {}),
      includeCanonical: true,
    });
    const nextViewportRequestState = resolveViewportWindowRequestState({
      mode: request.mode,
      beforeViewport,
      payload,
    });
    deps.set((state) => ({
      loadedSessions: patchSessionSnapshot(state, sessionKey, {
        ...payload.snapshot,
        window: {
          ...payload.snapshot.window,
          ...nextViewportRequestState,
        },
      }),
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

function buildHistoryPreviewHydrationPatch(
  state: ChatStoreState,
  requestedSessionKey: string,
  hydratedEntries: SessionTimelineEntry[],
): Partial<ChatStoreState> | ChatStoreState {
  const currentEntries = getSessionTimelineEntries(state, requestedSessionKey);
  if (currentEntries === hydratedEntries) {
    return state;
  }
  return {
    loadedSessions: patchSessionRecord(state, requestedSessionKey, {
      timelineEntries: hydratedEntries,
    }),
  };
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
    if (shouldAbortHistoryProcessing()) {
      return;
    }
    throwIfHistoryLoadAborted(abortSignal, shouldAbortHistoryProcessing);
    const snapshot = window.snapshot;
    if (!snapshot) {
      return;
    }

    const hydratedEntries = hydrateTimelineEntriesFromCache(snapshot.entries);
    const renderFingerprint = buildTimelineRenderFingerprint(hydratedEntries);
    const previousRenderFingerprint = historyRuntime.historyRenderFingerprintBySession.get(requestedSessionKey) ?? null;
    const currentState = get();
    const currentMeta = currentState.loadedSessions[requestedSessionKey]?.meta;
    const isMainSession = requestedSessionKey.endsWith(':main');
    const resolvedLabel = !isMainSession
      ? resolveSessionLabelFromTimelineEntries(hydratedEntries)
      : '';
    const lastEntry = hydratedEntries[hydratedEntries.length - 1];
    const lastAt = lastEntry?.timestamp ? toMs(lastEntry.timestamp) : null;
    const didMessageListChange = previousRenderFingerprint !== renderFingerprint;

    set((state) => ({
      loadedSessions: patchSessionMeta(
        {
          loadedSessions: patchSessionSnapshot(state, requestedSessionKey, {
            ...snapshot,
            entries: hydratedEntries,
          }),
        },
        requestedSessionKey,
        {
          historyStatus: 'ready',
          thinkingLevel: window.thinkingLevel,
          label: resolvedLabel || currentMeta?.label || null,
          lastActivityAt: lastAt ?? currentMeta?.lastActivityAt ?? null,
        },
      ),
    }));
    historyRuntime.historyRenderFingerprintBySession.set(requestedSessionKey, renderFingerprint);

    if (
      isForeground
      && snapshot.runtime.runPhase === 'done'
      && hydratedEntries.some((entry) => entry.role === 'assistant')
    ) {
      finishChatRunTelemetry(requestedSessionKey, 'completed', { stage: 'history_applied' });
      clearHistoryPoll();
    }

    if ((didMessageListChange || scope === 'background') && hasPendingTimelineEntryPreviewLoads(hydratedEntries)) {
      void loadMissingTimelineEntryPreviews(hydratedEntries).then((updatedEntries) => {
        if (!updatedEntries || abortSignal.aborted || shouldAbortHistoryProcessing()) {
          return;
        }
        set((state) => buildHistoryPreviewHydrationPatch(
          state,
          requestedSessionKey,
          updatedEntries,
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
    const snapshotEntries = window.snapshot?.entries ?? [];
    historyRuntime.historyFingerprintBySession.set(
      requestedSessionKey,
      buildTimelineHistoryFingerprint(snapshotEntries, window.thinkingLevel),
    );
    await applyLoadedMessages(window);
  } catch (err) {
    if (isHistoryLoadAbortError(err)) {
      aborted = true;
    } else {
      failed = true;
      if (mode === 'quiet') {
        recovered = true;
        return;
      }
      historyRuntime.historyFingerprintBySession.set(
        requestedSessionKey,
        buildTimelineHistoryFingerprint([], null),
      );
      historyRuntime.historyRenderFingerprintBySession.set(
        requestedSessionKey,
        buildTimelineRenderFingerprint([]),
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
