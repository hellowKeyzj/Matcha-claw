import { hostSessionWindowFetch } from '@/lib/host-api';
import { normalizeAppError } from '@/lib/error-model';
import {
  buildHydratedAttachmentItemsPatch,
  hasPendingItemPreviewLoads,
  hydrateAttachedFilesFromItems,
  loadMissingItemPreviews,
} from './attachment-helpers';
import {
  CHAT_HISTORY_FULL_LIMIT,
} from './history-constants';
import {
  decodeHistorySessionView,
  fetchHistoryWindow,
  resolveSessionViewError,
  type HistoryWindowResult,
} from './history-fetch-helpers';
import { finishChatRunTelemetry } from './telemetry';
import { clearHistoryPoll } from './timers';
import {
  buildItemHistoryFingerprint,
  applySessionView,
  buildItemRenderFingerprint,
  getSessionItems,
  getSessionViewportState,
  patchSessionMeta,
  patchSessionViewportState,
  projectSessionViewItems,
} from './store-state-helpers';
import { readSessionsFromState, resolveSessionThinkingLevelFromList } from './session-helpers';
import {
  createSessionTraceId,
  logSessionTrace,
  summarizeError,
  summarizeIdentifier,
  summarizeSessionIdentity,
} from '@/lib/session-trace';
import { buildSessionIdentityRecordIndex, resolveSessionOperationTarget, sameRuntimeEndpointScope } from './session-identity';
import { isSessionRuntimeEndpointStarting, useRuntimeEndpointsStore } from '../runtime-endpoints';
import { createHistoryLoadAbortError, isHistoryLoadAbortError, throwIfHistoryLoadAborted } from './history-abort';
import { sessionIdentitiesEqual, type SessionIdentity } from '../../types/desktop/runtime-address';
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
  observeHistory?: (identity: SessionIdentity, options: { timeoutMs?: number; traceId?: string | null }) => Promise<HistoryWindowResult['view'] | null>;
  onObservedViewApplied?: (view: HistoryWindowResult['view']) => void;
  isObservationCurrent?: () => boolean;
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
  onObservedViewApplied?: HistoryLoadExecutionDeps['onObservedViewApplied'];
  abortSignal: AbortSignal;
  shouldAbortHistoryProcessing: () => boolean;
}

const CHAT_HISTORY_STARTUP_REQUEST_TIMEOUT_MS = 35_000;
const CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS = [800, 2_000, 4_000, 8_000] as const;
const CHAT_HISTORY_STARTUP_LOADING_TIMEOUT_MS =
  CHAT_HISTORY_STARTUP_REQUEST_TIMEOUT_MS * (CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS.length + 1)
  + CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)
  + 2_000;

type StartupHistoryRetryErrorKind = 'timeout' | 'runtime_unavailable' | 'runtime_startup';

function isStartupColdHistoryLoad(request: ChatHistoryLoadRequest): boolean {
  return (
    request.mode === 'active'
    && request.scope === 'foreground'
    && request.reason === 'chat_init_cold_start'
  );
}

function resolveForegroundLoadingTimeoutMs(
  request: ChatHistoryLoadRequest,
  defaultTimeoutMs: number,
): number {
  return isStartupColdHistoryLoad(request)
    ? CHAT_HISTORY_STARTUP_LOADING_TIMEOUT_MS
    : defaultTimeoutMs;
}

function classifyStartupHistoryRetryError(error: unknown): StartupHistoryRetryErrorKind | null {
  if (isHistoryLoadAbortError(error)) {
    return null;
  }

  const normalized = normalizeAppError(error);
  const message = normalized.message.toLowerCase();

  if (
    message.includes('unavailable during runtime startup')
    || message.includes('unavailable during gateway startup')
    || message.includes('unavailable during startup')
    || message.includes('not yet ready')
    || message.includes('service not initialized')
  ) {
    return 'runtime_startup';
  }

  if (
    normalized.code === 'TIMEOUT'
    || message.includes('timeout')
    || message.includes('timed out')
    || message.includes('abort')
  ) {
    return 'timeout';
  }

  if (
    normalized.code === 'GATEWAY'
    || normalized.code === 'NETWORK'
    || message.includes('socket')
    || message.includes('handshake')
    || message.includes('fetch failed')
    || message.includes('econnrefused')
    || message.includes('connection refused')
    || message.includes('service unavailable')
    || message.includes('unavailable')
  ) {
    return 'runtime_unavailable';
  }

  return null;
}

function shouldRetryStartupHistoryLoad(
  errorKind: StartupHistoryRetryErrorKind | null,
): boolean {
  return errorKind != null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHistoryWindowWithStartupRetry(input: {
  requestedSessionKey: string;
  request: ChatHistoryLoadRequest;
  get: ChatStoreGetFn;
  abortSignal: AbortSignal;
  shouldAbortHistoryProcessing: () => boolean;
  observeHistory: HistoryLoadExecutionDeps['observeHistory'];
  traceId?: string | null;
}): Promise<HistoryWindowResult> {
  const {
    requestedSessionKey,
    request,
    get,
    abortSignal,
    shouldAbortHistoryProcessing,
    traceId,
  } = input;
  const startupColdLoad = isStartupColdHistoryLoad(request);
  const options = { traceId, ...(startupColdLoad ? { timeoutMs: CHAT_HISTORY_STARTUP_REQUEST_TIMEOUT_MS } : {}) };
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS.length; attempt += 1) {
    throwIfHistoryLoadAborted(abortSignal, shouldAbortHistoryProcessing);
    try {
      const target = resolveSessionOperationTarget(get(), requestedSessionKey);
      logSessionTrace('history.target.resolved', traceId, {
        requestedSessionKey: summarizeIdentifier(requestedSessionKey),
        sessionKey: summarizeIdentifier(target.sessionKey),
        endpointSessionId: summarizeIdentifier(target.endpointSessionId),
        sessionIdentity: summarizeSessionIdentity(target.sessionIdentity),
        attempt,
      });
      if (input.observeHistory && target.sessionIdentity.endpoint.kind === 'native-runtime' && target.sessionIdentity.endpoint.runtimeAdapterId === 'openclaw') {
        const view = await input.observeHistory(target.sessionIdentity, options);
        if (!view) throw createHistoryLoadAbortError('observation_released');
        return { view, thinkingLevel: resolveSessionThinkingLevelFromList(readSessionsFromState(get()), requestedSessionKey) };
      }
      return await fetchHistoryWindow({
        recordKey: requestedSessionKey,
        endpointSessionId: target.endpointSessionId,
        sessionIdentity: target.sessionIdentity,
        sessions: readSessionsFromState(get()),
        limit: CHAT_HISTORY_FULL_LIMIT,
        traceId,
        ...(startupColdLoad ? { timeoutMs: CHAT_HISTORY_STARTUP_REQUEST_TIMEOUT_MS } : {}),
      });
    } catch (error) {
      if (isHistoryLoadAbortError(error)) {
        throw error;
      }
      lastError = error;
    }
    throwIfHistoryLoadAborted(abortSignal, shouldAbortHistoryProcessing);
    if (!startupColdLoad || attempt >= CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS.length) {
      break;
    }
    const errorKind = classifyStartupHistoryRetryError(lastError);
    if (!shouldRetryStartupHistoryLoad(errorKind)) {
      break;
    }
    await sleep(CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS[attempt]!);
  }

  throw lastError ?? new Error('Failed to load chat history');
}

function resolveViewportFetchLimit(itemCount: number): number {
  return Math.min(Math.max(itemCount || 80, 40), 200);
}

function isHistorySessionIdentityCurrent(
  state: ChatStoreState,
  recordKey: string,
  identity: SessionIdentity | null | undefined,
): boolean {
  const currentIdentity = state.loadedSessions[recordKey]?.meta.sessionIdentity;
  return !!identity && currentIdentity === identity && sessionIdentitiesEqual(currentIdentity, identity);
}

const viewportRequestsByStore = new WeakMap<ChatStoreGetFn, Map<string, symbol>>();

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

  const currentState = deps.get();
  const identity = currentState.loadedSessions[sessionKey]?.meta.sessionIdentity;
  if (!identity) return;
  const beforeViewport = getSessionViewportState(currentState, sessionKey);
  if (request.mode === 'older') {
    if (!beforeViewport.hasMore || beforeViewport.isLoadingMore) {
      return;
    }
  } else if (beforeViewport.isLoadingNewer) {
    return;
  }

  let requests = viewportRequestsByStore.get(deps.get);
  if (!requests) {
    requests = new Map();
    viewportRequestsByStore.set(deps.get, requests);
  }
  const requestId = Symbol();
  requests.set(sessionKey, requestId);
  const isCurrent = (state: ChatStoreState) => (
    requests.get(sessionKey) === requestId
    && isHistorySessionIdentityCurrent(state, sessionKey, identity)
  );
  setViewportLoadingState({
    set: deps.set,
    sessionKey,
    mode: request.mode,
    value: true,
  });

  const traceId = createSessionTraceId('session.window.readback');
  const traceContext = traceId ? {
    recordKey: summarizeIdentifier(sessionKey),
    sessionIdentity: summarizeSessionIdentity(identity),
    mode: request.mode,
    requestedOffset: request.mode === 'older' ? beforeViewport.windowStartOffset : null,
    pendingTurnHash: summarizeIdentifier(currentState.loadedSessions[sessionKey].runtime.pendingTurnKey).hash,
  } : null;
  let readbackStage = 'target';
  try {
    const target = resolveSessionOperationTarget(currentState, sessionKey);
    const limit = request.mode === 'latest'
      ? CHAT_HISTORY_FULL_LIMIT
      : resolveViewportFetchLimit(getSessionItems(currentState, sessionKey).length);
    if (traceId) logSessionTrace('session.window.readback.request', traceId, {
      ...traceContext,
      targetIdentity: summarizeSessionIdentity(target.sessionIdentity),
      limit,
    });
    readbackStage = 'request';
    const rawView = await hostSessionWindowFetch({
      ...(target.endpointSessionId ? { endpointSessionId: target.endpointSessionId } : {}),
      sessionIdentity: target.sessionIdentity,
      mode: request.mode,
      limit,
      ...(request.mode === 'older' ? { offset: beforeViewport.windowStartOffset } : {}),
      includeCanonical: true,
    });
    readbackStage = 'response';
    if (traceId) logSessionTrace('session.window.readback.response', traceId, {
      ...traceContext,
      rawType: rawView && typeof rawView === 'object' ? 'object' : typeof rawView,
    });
    const responseState = deps.get();
    if (!isCurrent(responseState)
      || (request.mode === 'older' && getSessionViewportState(responseState, sessionKey).windowStartOffset !== beforeViewport.windowStartOffset)
      || (request.mode === 'latest' && responseState.loadedSessions[sessionKey].runtime.pendingTurnKey
        && responseState.loadedSessions[sessionKey].runtime.pendingTurnKey !== currentState.loadedSessions[sessionKey].runtime.pendingTurnKey)) {
      if (traceId) logSessionTrace('session.window.readback.drop', traceId, {
        ...traceContext,
        reason: requests.get(sessionKey) !== requestId ? 'request-superseded'
          : !isHistorySessionIdentityCurrent(responseState, sessionKey, identity) ? 'identity-changed'
            : request.mode === 'older' ? 'offset-changed' : 'pending-turn-changed',
        requestCurrent: requests.get(sessionKey) === requestId,
        currentIdentity: summarizeSessionIdentity(responseState.loadedSessions[sessionKey]?.meta.sessionIdentity),
        currentOffset: getSessionViewportState(responseState, sessionKey).windowStartOffset,
        currentPendingTurnHash: summarizeIdentifier(responseState.loadedSessions[sessionKey]?.runtime.pendingTurnKey).hash,
      });
      return;
    }
    readbackStage = 'decode';
    const view = decodeHistorySessionView(rawView);
    if (traceId) logSessionTrace('session.window.readback.decoded', traceId, {
      ...traceContext,
      responseIdentity: summarizeSessionIdentity(view.identity),
      epoch: view.epoch, seq: view.seq, cursor: view.cursor,
      identityMatches: sessionIdentitiesEqual(view.identity, identity),
    });
    readbackStage = 'identity';
    if (!sessionIdentitiesEqual(view.identity, identity)) {
      throw new Error('Session view identity mismatch');
    }
    readbackStage = 'apply';
    const projectionResult = applySessionView({
      set: deps.set,
      get: deps.get,
    }, view, { windowOnly: true, direction: request.mode });
    if (traceId) logSessionTrace('session.window.readback.apply', traceId, {
      ...traceContext,
      epoch: view.epoch, seq: view.seq, cursor: view.cursor,
      outcome: projectionResult.status,
      ...('reason' in projectionResult ? { reason: summarizeIdentifier(projectionResult.reason) } : {}),
    });
    if (projectionResult.status !== 'applied') return;
    readbackStage = 'hydrate';
    deps.set((state) => isCurrent(state) ? buildHydratedAttachmentItemsPatch(
      state,
      sessionKey,
      hydrateAttachedFilesFromItems(getSessionItems(state, sessionKey)),
    ) : state);
  } catch (error) {
    if (traceId) logSessionTrace('session.window.readback.error', traceId, {
      ...traceContext,
      readbackStage,
      requestCurrent: requests.get(sessionKey) === requestId,
      ...summarizeError(error),
    });
    // Keep the current window when its read fails.
  } finally {
    if (isCurrent(deps.get())) {
      deps.set((state) => isCurrent(state) ? {
        loadedSessions: patchSessionViewportState(state, sessionKey, {
          ...getSessionViewportState(state, sessionKey),
          isLoadingMore: false,
          isLoadingNewer: false,
        }),
      } : state);
    }
    if (requests.get(sessionKey) === requestId) requests.delete(sessionKey);
  }
}

function shouldSkipForegroundApply(
  get: ChatStoreGetFn,
  scope: ChatHistoryLoadRequest['scope'],
  requestedSessionKey: string,
): boolean {
  return scope === 'foreground' && get().currentSessionKey !== requestedSessionKey;
}

function resolveHistoryLoadErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('incomplete')
    ? 'Session timeline is incomplete'
    : 'Session timeline is unavailable';
}

function shouldSuppressStartupForegroundError(input: {
  request: ChatHistoryLoadRequest;
  error: unknown;
}): boolean {
  return (
    isStartupColdHistoryLoad(input.request)
    && classifyStartupHistoryRetryError(input.error) === 'runtime_startup'
  );
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


export function createApplyLoadedMessagesPipeline(
  input: CreateApplyLoadedMessagesInput,
): (window: HistoryWindowResult) => Promise<'applied' | 'ignored'> {
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
  const requestedRecord = get().loadedSessions[requestedSessionKey];
  const requestedIdentity = requestedRecord?.meta.sessionIdentity;
  const isCurrent = (state: ChatStoreState) => (
    !abortSignal.aborted && !shouldAbortHistoryProcessing()
    && isHistorySessionIdentityCurrent(state, requestedSessionKey, requestedIdentity)
    && (!state.loadedSessions[requestedSessionKey]?.runtime.pendingTurnKey
      || state.loadedSessions[requestedSessionKey].runtime.pendingTurnKey === requestedRecord?.runtime.pendingTurnKey)
  );

  return async (window: HistoryWindowResult) => {
    if (!isCurrent(get())) {
      return 'ignored';
    }
    throwIfHistoryLoadAborted(abortSignal, shouldAbortHistoryProcessing);
    const view = window.view;
    if (!view) {
      throw new Error('Session view is unavailable');
    }
    if (view.completeness === 'unavailable' || view.completeness === 'unknown') {
      throw new Error('Session view is unavailable');
    }
    if (!requestedIdentity || !sessionIdentitiesEqual(view.identity, requestedIdentity)) {
      throw new Error('Session view identity mismatch');
    }
    const projectionResult = applySessionView({ set, get }, view);
    if (projectionResult.status !== 'applied'
      && !(projectionResult.status === 'duplicate' && typeof view.items === 'object' && typeof view.window === 'object')) {
      if (projectionResult.status === 'unavailable' || projectionResult.status === 'epoch-mismatch') {
        throw new Error('Session view is unavailable');
      }
      return 'ignored';
    }

    set((state) => {
      if (!isCurrent(state)) return state;
      const loadedSessions = patchSessionMeta(state, requestedSessionKey, {
        historyStatus: 'ready',
        thinkingLevel: window.thinkingLevel,
      });
      return {
        loadedSessions,
        sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      };
    });
    if (!isCurrent(get())) return 'ignored';
    input.onObservedViewApplied?.(view);
    if (projectionResult.status === 'duplicate') return 'ignored';
    const sourceItems = projectSessionViewItems(view);
    const hydratedItems = hydrateAttachedFilesFromItems(sourceItems);
    const renderFingerprint = buildItemRenderFingerprint(hydratedItems);
    const previousRenderFingerprint = historyRuntime.historyRenderFingerprintBySession.get(requestedSessionKey) ?? null;
    const didMessageListChange = previousRenderFingerprint !== renderFingerprint;
    historyRuntime.historyFingerprintBySession.set(
      requestedSessionKey,
      buildItemHistoryFingerprint(sourceItems, window.thinkingLevel),
    );
    historyRuntime.historyRenderFingerprintBySession.set(requestedSessionKey, renderFingerprint);

    if (
      isForeground
      && get().loadedSessions[requestedSessionKey]?.runtime.runPhase === 'done'
      && hydratedItems.some((item) => item.kind === 'assistant-turn')
    ) {
      finishChatRunTelemetry(requestedSessionKey, 'completed', { stage: 'history_applied' });
      clearHistoryPoll();
    }

    if ((didMessageListChange || scope === 'background') && hasPendingItemPreviewLoads(hydratedItems)) {
      void loadMissingItemPreviews(hydratedItems, {
        sessionIdentity: requestedIdentity,
      }, abortSignal).then((updatedItems) => {
        if (!updatedItems || !isCurrent(get())) {
          return;
        }
        set((state) => isCurrent(state) ? buildHydratedAttachmentItemsPatch(
          state,
          requestedSessionKey,
          updatedItems,
        ) : state);
      });
    }
    return 'applied';
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
  const requestedRecord = get().loadedSessions[requestedSessionKey];
  const requestedIdentity = requestedRecord?.meta.sessionIdentity;
  if (!requestedIdentity) return;
  const mode = request.mode;
  const scope = request.scope;
  const traceId = request.traceId ?? createSessionTraceId(`history:${request.reason ?? mode}`);
  logSessionTrace('history.start', traceId, {
    requestedSessionKey: summarizeIdentifier(requestedSessionKey),
    mode,
    scope,
    reason: request.reason ?? null,
  });
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
          !isHistorySessionIdentityCurrent(state, requestedSessionKey, requestedIdentity)
          || historyLoadRunId !== historyRuntime.getHistoryLoadRunId()
          || state.foregroundHistorySessionKey !== requestedSessionKey
        ) {
          return state;
        }
        return { foregroundHistorySessionKey: null };
      });
    }, resolveForegroundLoadingTimeoutMs(request, loadingTimeoutMs));
  }
  const shouldAbortHistoryProcessing = () => (
    abortController.signal.aborted
    || (deps.isObservationCurrent !== undefined && !deps.isObservationCurrent())
    || !isHistorySessionIdentityCurrent(get(), requestedSessionKey, requestedIdentity)
    || (!!get().loadedSessions[requestedSessionKey]?.runtime.pendingTurnKey
      && get().loadedSessions[requestedSessionKey].runtime.pendingTurnKey !== requestedRecord?.runtime.pendingTurnKey)
    || (scope === 'foreground' && get().currentSessionKey !== requestedSessionKey)
    || (scope === 'foreground' && historyLoadRunId !== historyRuntime.getHistoryLoadRunId())
  );
  const applyLoadedMessages = createApplyLoadedMessagesPipeline({
    set,
    get,
    historyRuntime,
    requestedSessionKey,
    scope,
    onObservedViewApplied: deps.onObservedViewApplied,
    abortSignal: abortController.signal,
    shouldAbortHistoryProcessing,
  });

  try {
    throwIfHistoryLoadAborted(abortController.signal, shouldAbortHistoryProcessing);
    const window = await fetchHistoryWindowWithStartupRetry({
      requestedSessionKey,
      request,
      get,
      abortSignal: abortController.signal,
      shouldAbortHistoryProcessing,
      observeHistory: deps.observeHistory,
      traceId,
    });
    throwIfHistoryLoadAborted(abortController.signal, shouldAbortHistoryProcessing);
    if (shouldSkipForegroundApply(get, scope, requestedSessionKey)) {
      return;
    }
    const applyStatus = await applyLoadedMessages(window);
    logSessionTrace(applyStatus === 'applied' ? 'history.applied' : 'history.ignored', traceId, {
      requestedSessionKey: summarizeIdentifier(requestedSessionKey),
      itemCount: projectSessionViewItems(window.view).length,
      thinkingLevel: window.thinkingLevel,
    });
  } catch (err) {
    if (isHistoryLoadAbortError(err) || shouldAbortHistoryProcessing()) {
      aborted = true;
      logSessionTrace('history.aborted', traceId, {
        requestedSessionKey: summarizeIdentifier(requestedSessionKey),
      });
    } else {
      failed = true;
      logSessionTrace('history.error', traceId, {
        requestedSessionKey: summarizeIdentifier(requestedSessionKey),
        ...summarizeError(err),
      });
      if (mode === 'quiet') {
        recovered = true;
        return;
      }
      historyRuntime.historyFingerprintBySession.set(
        requestedSessionKey,
        buildItemHistoryFingerprint([], null),
      );
      historyRuntime.historyRenderFingerprintBySession.set(
        requestedSessionKey,
        buildItemRenderFingerprint([]),
      );
      if (scope === 'foreground') {
        const endpointStarting = isSessionEndpointStarting(get(), requestedSessionKey);
        if (endpointStarting || shouldSuppressStartupForegroundError({ request, error: err })) {
          set((state) => {
            const loadedSessions = patchSessionMeta(state, requestedSessionKey, {
              historyStatus: endpointStarting ? 'loading' : 'ready',
            });
            return {
              loadedSessions,
              sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
              error: null,
            };
          });
          recovered = true;
          return;
        }
        set((state) => {
          const switching = request.reason === 'same_session_refresh';
          const loadedSessions = patchSessionMeta(state, requestedSessionKey, {
            historyStatus: switching && (requestedRecord?.meta.historyStatus === 'ready' || requestedRecord?.items.length) ? 'ready' : 'error',
          });
          return {
            loadedSessions,
            sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
            error: switching ? resolveSessionViewError(err).message : resolveHistoryLoadErrorMessage(err),
          };
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
          !isHistorySessionIdentityCurrent(state, requestedSessionKey, requestedIdentity)
          || historyLoadRunId !== historyRuntime.getHistoryLoadRunId()
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
