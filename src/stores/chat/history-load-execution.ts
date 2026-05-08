import { hostSessionWindowFetch } from '@/lib/host-api';
import { normalizeAppError } from '@/lib/error-model';
import {
  hasPendingItemPreviewLoads,
  hydrateAttachedFilesFromItems,
  loadMissingItemPreviews,
} from './attachment-helpers';
import {
  CHAT_HISTORY_FULL_LIMIT,
} from './history-constants';
import {
  fetchHistoryWindow,
  type HistoryWindowResult,
} from './history-fetch-helpers';
import { finishChatRunTelemetry } from './telemetry';
import { clearHistoryPoll } from './timers';
import {
  buildItemHistoryFingerprint,
  buildItemRenderFingerprint,
  getSessionItems,
  getSessionRuntime,
  getSessionViewportState,
  patchSessionMeta,
  patchSessionRecord,
  patchSessionSnapshot,
  patchSessionViewportState,
} from './store-state-helpers';
import { readSessionsFromState } from './session-helpers';
import { isHistoryLoadAbortError, throwIfHistoryLoadAborted } from './history-abort';
import type { StoreHistoryCache } from './history-cache';
import type { ChatHistoryLoadRequest, ChatStoreState } from './types';
import type { SessionRenderItem } from '../../../runtime-host/shared/session-adapter-types';
import type { GatewayStatus } from '@/types/gateway';

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
  getGatewayStatus?: () => GatewayStatus | undefined;
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

const CHAT_HISTORY_STARTUP_REQUEST_TIMEOUT_MS = 35_000;
const CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS = [800, 2_000, 4_000, 8_000] as const;
const CHAT_HISTORY_STARTUP_CONNECTION_GRACE_MS = 30_000;
const CHAT_HISTORY_STARTUP_RUNNING_WINDOW_MS =
  CHAT_HISTORY_STARTUP_REQUEST_TIMEOUT_MS + CHAT_HISTORY_STARTUP_CONNECTION_GRACE_MS;
const CHAT_HISTORY_STARTUP_LOADING_TIMEOUT_MS =
  CHAT_HISTORY_STARTUP_REQUEST_TIMEOUT_MS * (CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS.length + 1)
  + CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)
  + 2_000;

type StartupHistoryRetryErrorKind = 'timeout' | 'gateway_unavailable' | 'gateway_startup';

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
    message.includes('unavailable during gateway startup')
    || message.includes('unavailable during startup')
    || message.includes('not yet ready')
    || message.includes('service not initialized')
  ) {
    return 'gateway_startup';
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
    || message.includes('gateway')
    || message.includes('socket')
    || message.includes('handshake')
    || message.includes('fetch failed')
    || message.includes('econnrefused')
    || message.includes('connection refused')
    || message.includes('service unavailable')
    || message.includes('unavailable')
  ) {
    return 'gateway_unavailable';
  }

  return null;
}

function shouldRetryStartupHistoryLoad(
  gatewayStatus: GatewayStatus | undefined,
  errorKind: StartupHistoryRetryErrorKind | null,
): boolean {
  if (!gatewayStatus || !errorKind) {
    return false;
  }

  if (errorKind === 'gateway_startup') {
    return true;
  }

  if (
    gatewayStatus.processState === 'starting'
    || gatewayStatus.processState === 'control_connecting'
    || gatewayStatus.processState === 'reconnecting'
  ) {
    return true;
  }

  if (gatewayStatus.processState !== 'running') {
    return false;
  }

  if (!gatewayStatus.gatewayReady || gatewayStatus.transportState !== 'connected') {
    return true;
  }

  if (gatewayStatus.connectedAt == null) {
    return true;
  }

  return Date.now() - gatewayStatus.connectedAt <= CHAT_HISTORY_STARTUP_RUNNING_WINDOW_MS;
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
  getGatewayStatus?: () => GatewayStatus | undefined;
}): Promise<HistoryWindowResult> {
  const {
    requestedSessionKey,
    request,
    get,
    abortSignal,
    shouldAbortHistoryProcessing,
    getGatewayStatus,
  } = input;
  const startupColdLoad = isStartupColdHistoryLoad(request);
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS.length; attempt += 1) {
    throwIfHistoryLoadAborted(abortSignal, shouldAbortHistoryProcessing);
    try {
      return await fetchHistoryWindow({
        requestedSessionKey,
        sessions: readSessionsFromState(get()),
        limit: CHAT_HISTORY_FULL_LIMIT,
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
    if (!shouldRetryStartupHistoryLoad(getGatewayStatus?.(), errorKind)) {
      break;
    }
    await sleep(CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS[attempt]!);
  }

  throw lastError ?? new Error('Failed to load chat history');
}

function shouldPreserveActiveForegroundItems(input: {
  state: ChatStoreState;
  requestedSessionKey: string;
  snapshot: HistoryWindowResult['snapshot'];
}): boolean {
  const { state, requestedSessionKey, snapshot } = input;
  if (!snapshot || state.currentSessionKey !== requestedSessionKey) {
    return false;
  }
  const currentRuntime = getSessionRuntime(state, requestedSessionKey);
  const snapshotRuntime = snapshot.runtime;
  if (!currentRuntime.sending || !snapshotRuntime.sending) {
    return false;
  }
  if (!currentRuntime.activeRunId || currentRuntime.activeRunId !== snapshotRuntime.activeRunId) {
    return false;
  }
  if (snapshot.items.length > 0) {
    return false;
  }
  return true;
}

function resolveViewportFetchLimit(itemCount: number): number {
  return Math.min(Math.max(itemCount || 80, 40), 200);
}

function resolveViewportWindowRequestState(input: {
  payload: Awaited<ReturnType<typeof hostSessionWindowFetch>>;
}) {
  const window = input.payload.snapshot.window;
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
    const currentItems = getSessionItems(currentState, sessionKey);
    const payload = await hostSessionWindowFetch({
      sessionKey,
      mode: request.mode,
      limit: resolveViewportFetchLimit(currentItems.length),
      ...(request.mode === 'older' ? { offset: beforeViewport.windowStartOffset } : {}),
      includeCanonical: true,
    });
    const nextViewportRequestState = resolveViewportWindowRequestState({ payload });
    deps.set((state) => ({
      loadedSessions: patchSessionSnapshot(state, sessionKey, {
        ...payload.snapshot,
        items: hydrateAttachedFilesFromItems(payload.snapshot.items),
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

function shouldSuppressStartupForegroundError(input: {
  request: ChatHistoryLoadRequest;
  error: unknown;
}): boolean {
  return (
    isStartupColdHistoryLoad(input.request)
    && classifyStartupHistoryRetryError(input.error) === 'gateway_startup'
  );
}

function buildHistoryPreviewHydrationPatch(
  state: ChatStoreState,
  requestedSessionKey: string,
  hydratedItems: SessionRenderItem[],
): Partial<ChatStoreState> | ChatStoreState {
  const currentItems = getSessionItems(state, requestedSessionKey);
  if (currentItems === hydratedItems) {
    return state;
  }
  return {
    loadedSessions: patchSessionRecord(state, requestedSessionKey, {
      items: hydratedItems,
    }),
  };
}

export function createApplyLoadedMessagesPipeline(
  input: CreateApplyLoadedMessagesInput,
): (window: HistoryWindowResult) => Promise<void> {
  const {
    set,
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

    const hydratedItems = hydrateAttachedFilesFromItems(snapshot.items);
    const renderFingerprint = buildItemRenderFingerprint(hydratedItems);
    const previousRenderFingerprint = historyRuntime.historyRenderFingerprintBySession.get(requestedSessionKey) ?? null;
    const didMessageListChange = previousRenderFingerprint !== renderFingerprint;

    set((state) => {
      const nextSnapshot = shouldPreserveActiveForegroundItems({
        state,
        requestedSessionKey,
        snapshot,
      })
        ? {
            ...snapshot,
            items: getSessionItems(state, requestedSessionKey),
          }
        : {
            ...snapshot,
            items: hydratedItems,
          };

      return {
        loadedSessions: patchSessionMeta(
          {
            loadedSessions: patchSessionSnapshot(state, requestedSessionKey, nextSnapshot),
          },
          requestedSessionKey,
          {
            historyStatus: 'ready',
            thinkingLevel: window.thinkingLevel,
          },
        ),
      };
    });
    historyRuntime.historyRenderFingerprintBySession.set(requestedSessionKey, renderFingerprint);

    if (
      isForeground
      && snapshot.runtime.runPhase === 'done'
      && hydratedItems.some((item) => item.kind === 'assistant-turn')
    ) {
      finishChatRunTelemetry(requestedSessionKey, 'completed', { stage: 'history_applied' });
      clearHistoryPoll();
    }

    if ((didMessageListChange || scope === 'background') && hasPendingItemPreviewLoads(hydratedItems)) {
      void loadMissingItemPreviews(hydratedItems, abortSignal).then((updatedItems) => {
        if (!updatedItems || abortSignal.aborted || shouldAbortHistoryProcessing()) {
          return;
        }
        set((state) => buildHistoryPreviewHydrationPatch(
          state,
          requestedSessionKey,
          updatedItems,
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
    getGatewayStatus,
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
    }, resolveForegroundLoadingTimeoutMs(request, loadingTimeoutMs));
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
    const window = await fetchHistoryWindowWithStartupRetry({
      requestedSessionKey,
      request,
      get,
      abortSignal: abortController.signal,
      shouldAbortHistoryProcessing,
      getGatewayStatus,
    });
    throwIfHistoryLoadAborted(abortController.signal, shouldAbortHistoryProcessing);
    if (shouldSkipForegroundApply(get, scope, requestedSessionKey)) {
      return;
    }
    const snapshotItems = window.snapshot?.items ?? [];
    historyRuntime.historyFingerprintBySession.set(
      requestedSessionKey,
      buildItemHistoryFingerprint(snapshotItems, window.thinkingLevel),
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
        buildItemHistoryFingerprint([], null),
      );
      historyRuntime.historyRenderFingerprintBySession.set(
        requestedSessionKey,
        buildItemRenderFingerprint([]),
      );
      if (scope === 'foreground') {
        if (shouldSuppressStartupForegroundError({ request, error: err })) {
          set({
            loadedSessions: patchSessionMeta(get(), requestedSessionKey, {
              historyStatus: 'ready',
            }),
            error: null,
          });
          recovered = true;
          return;
        }
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
