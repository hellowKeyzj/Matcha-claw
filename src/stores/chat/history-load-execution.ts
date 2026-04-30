import { createApplyLoadedMessagesPipeline } from './history-apply-pipeline';
import { trackUiTiming } from '@/lib/telemetry';
import {
  createFetchHistoryWindow,
  type HistoryWindowResult,
  loadHistoryWindow,
} from './history-fetch-helpers';
import { readSessionsFromState } from './session-helpers';
import { handleHistoryLoadFailure } from './history-failure-helpers';
import {
  isHistoryLoadAbortError,
  throwIfHistoryLoadAborted,
} from './history-abort';
import {
  beginHistoryLoadUiState,
  createHistoryLoadAbortGuard,
  finalizeHistoryLoadUiState,
} from './history-loading-helpers';
import { nowMs } from './store-state-helpers';
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

interface CreateHistoryLoadExecutionContextInput {
  deps: HistoryLoadExecutionDeps;
  request: ChatHistoryLoadRequest;
}

interface HistoryLoadExecutionContext {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  historyRuntime: StoreHistoryCache;
  mode: ChatHistoryLoadRequest['mode'];
  scope: ChatHistoryLoadRequest['scope'];
  requestedSessionKey: string;
  abortSignal: AbortSignal;
  isAborted: () => boolean;
  fetchHistoryWindow: (limit: number) => Promise<HistoryWindowResult>;
  applyLoadedMessages: (window: HistoryWindowResult) => Promise<void>;
  historyLoadRunId: number;
  abortController: AbortController;
  loadingSafetyTimer: ReturnType<typeof setTimeout> | null;
}

function createHistoryLoadExecutionContext(
  input: CreateHistoryLoadExecutionContextInput,
): HistoryLoadExecutionContext {
  const {
    deps,
    request,
  } = input;
  const {
    set,
    get,
    historyRuntime,
    loadingTimeoutMs,
  } = deps;

  const requestedSessionKey = request.sessionKey;
  const mode = request.mode;
  const scope = request.scope;
  const abortController = new AbortController();
  const previousAbortController = historyRuntime.replaceHistoryLoadAbortController(
    requestedSessionKey,
    abortController,
  );
  if (previousAbortController && !previousAbortController.signal.aborted) {
    previousAbortController.abort('history_load_superseded');
  }

  const historyLoadRunId = scope === 'foreground' ? historyRuntime.nextHistoryLoadRunId() : 0;
  const loadingSafetyTimer = beginHistoryLoadUiState({
    set,
    get,
    requestedSessionKey,
    mode,
    scope,
    historyLoadRunId,
    historyRuntime,
    timeoutMs: loadingTimeoutMs,
  });

  const shouldAbortHistoryProcessing = createHistoryLoadAbortGuard({
    get,
    requestedSessionKey,
    mode,
    scope,
    historyLoadRunId,
    historyRuntime,
    abortSignal: abortController.signal,
  });
  const isAborted = (): boolean => shouldAbortHistoryProcessing() || abortController.signal.aborted;

  const fetchHistoryWindowInternal = createFetchHistoryWindow({
    requestedSessionKey,
    getSessions: () => readSessionsFromState(get()),
  });
  const fetchHistoryWindow = async (limit: number) => {
    throwIfHistoryLoadAborted(abortController.signal, isAborted);
    const window = await fetchHistoryWindowInternal(limit);
    throwIfHistoryLoadAborted(abortController.signal, isAborted);
    return window;
  };

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

  return {
    set,
    get,
    historyRuntime,
    mode,
    scope,
    requestedSessionKey,
    abortSignal: abortController.signal,
    isAborted,
    fetchHistoryWindow,
    applyLoadedMessages,
    historyLoadRunId,
    abortController,
    loadingSafetyTimer,
  };
}

async function runHistoryLoadExecution(context: HistoryLoadExecutionContext): Promise<void> {
  await loadHistoryWindow({
    ...context,
    getState: context.get,
  });
}

async function recoverHistoryLoadExecution(
  context: HistoryLoadExecutionContext,
  error: unknown,
): Promise<void> {
  if (isHistoryLoadAbortError(error)) {
    return;
  }
  try {
    await handleHistoryLoadFailure({
      set: context.set,
      get: context.get,
      requestedSessionKey: context.requestedSessionKey,
      mode: context.mode,
      scope: context.scope,
      historyRuntime: context.historyRuntime,
      error,
      applyLoadedMessages: context.applyLoadedMessages,
    });
  } catch (recoveryError) {
    if (isHistoryLoadAbortError(recoveryError)) {
      return;
    }
    throw recoveryError;
  }
}

function finalizeHistoryLoadExecution(context: HistoryLoadExecutionContext): void {
  context.historyRuntime.clearHistoryLoadAbortController(
    context.requestedSessionKey,
    context.abortController,
  );
  finalizeHistoryLoadUiState({
    set: context.set,
    scope: context.scope,
    requestedSessionKey: context.requestedSessionKey,
    historyLoadRunId: context.historyLoadRunId,
    historyRuntime: context.historyRuntime,
    loadingSafetyTimer: context.loadingSafetyTimer,
  });
}

export interface HistoryLoadExecutor {
  execute: (request: ChatHistoryLoadRequest) => Promise<void>;
}

export function createHistoryLoadExecutor(deps: HistoryLoadExecutionDeps): HistoryLoadExecutor {
  return {
    execute: async (request: ChatHistoryLoadRequest) => {
      const startedAt = nowMs();
      let failed = false;
      let recovered = false;
      let aborted = false;
      const executionContext = createHistoryLoadExecutionContext({
        deps,
        request,
      });

      try {
        await runHistoryLoadExecution(executionContext);
      } catch (err) {
        if (isHistoryLoadAbortError(err)) {
          aborted = true;
        } else {
          failed = true;
          await recoverHistoryLoadExecution(executionContext, err);
          recovered = true;
        }
      } finally {
        const outcome: 'success' | 'recovered' | 'failed' | 'aborted' = aborted
          ? 'aborted'
          : (failed ? (recovered ? 'recovered' : 'failed') : 'success');
        finalizeHistoryLoadExecution(executionContext);
        trackUiTiming('chat.history_load_total', Math.max(0, nowMs() - startedAt), {
          sessionKey: executionContext.requestedSessionKey,
          mode: executionContext.mode,
          scope: executionContext.scope,
          outcome,
        });
      }
    },
  };
}
