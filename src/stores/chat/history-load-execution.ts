import { createApplyLoadedMessagesPipeline } from './history-apply-pipeline';
import { trackUiTiming } from '@/lib/telemetry';
import {
  createFetchHistoryWindow,
} from './history-fetch-helpers';
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
import { defaultHistoryLoadPipelineStrategy } from './history-pipeline-strategies';
import type {
  ChatStoreGetFn,
  ChatStoreSetFn,
  HistoryLoadPipelineContext,
  HistoryLoadPipelineStrategy,
} from './history-pipeline-types';
import type { StoreHistoryCache } from './history-cache';

export interface HistoryLoadExecutionDeps {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  historyRuntime: StoreHistoryCache;
  loadingTimeoutMs: number;
  optimisticUserReconcileWindowMs: number;
  pipelineStrategy?: HistoryLoadPipelineStrategy;
  pipelineStrategyLabel?: string;
}

interface CreateHistoryLoadExecutionContextInput {
  deps: HistoryLoadExecutionDeps;
  quiet: boolean;
}

interface HistoryLoadExecutionContext extends HistoryLoadPipelineContext {
  historyLoadRunId: number;
  abortController: AbortController;
  loadingSafetyTimer: ReturnType<typeof setTimeout> | null;
  pipelineStrategy: HistoryLoadPipelineStrategy;
}

function createHistoryLoadExecutionContext(
  input: CreateHistoryLoadExecutionContextInput,
): HistoryLoadExecutionContext {
  const {
    deps,
    quiet,
  } = input;
  const {
    set,
    get,
    historyRuntime,
    loadingTimeoutMs,
    optimisticUserReconcileWindowMs,
    pipelineStrategy = defaultHistoryLoadPipelineStrategy,
  } = deps;

  const requestedSessionKey = get().currentSessionKey;
  const abortController = new AbortController();
  const previousAbortController = historyRuntime.replaceHistoryLoadAbortController(
    requestedSessionKey,
    abortController,
  );
  if (previousAbortController && !previousAbortController.signal.aborted) {
    previousAbortController.abort('history_load_superseded');
  }

  const historyLoadRunId = quiet ? 0 : historyRuntime.nextHistoryLoadRunId();
  const loadingSafetyTimer = beginHistoryLoadUiState({
    set,
    get,
    requestedSessionKey,
    quiet,
    historyLoadRunId,
    historyRuntime,
    timeoutMs: loadingTimeoutMs,
  });

  const shouldAbortHistoryProcessing = createHistoryLoadAbortGuard({
    get,
    requestedSessionKey,
    quiet,
    historyLoadRunId,
    historyRuntime,
    abortSignal: abortController.signal,
  });
  const isAborted = (): boolean => shouldAbortHistoryProcessing() || abortController.signal.aborted;

  const fetchHistoryWindowInternal = createFetchHistoryWindow({
    requestedSessionKey,
    getSessions: () => get().sessions,
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
    quiet,
    abortSignal: abortController.signal,
    shouldAbortHistoryProcessing,
    optimisticUserReconcileWindowMs,
  });

  const pipelineContext: HistoryLoadPipelineContext = {
    set,
    get,
    historyRuntime,
    quiet,
    requestedSessionKey,
    abortSignal: abortController.signal,
    isAborted,
    fetchHistoryWindow,
    applyLoadedMessages,
  };

  return {
    ...pipelineContext,
    historyLoadRunId,
    abortController,
    loadingSafetyTimer,
    pipelineStrategy,
  };
}

async function runHistoryLoadExecution(context: HistoryLoadExecutionContext): Promise<void> {
  await context.pipelineStrategy(context);
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
      quiet: context.quiet,
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
    quiet: context.quiet,
    historyLoadRunId: context.historyLoadRunId,
    historyRuntime: context.historyRuntime,
    loadingSafetyTimer: context.loadingSafetyTimer,
  });
}

export interface HistoryLoadExecutor {
  execute: (quiet?: boolean) => Promise<void>;
}

export function createHistoryLoadExecutor(deps: HistoryLoadExecutionDeps): HistoryLoadExecutor {
  return {
    execute: async (quiet = false) => {
      const startedAt = nowMs();
      let failed = false;
      let recovered = false;
      let aborted = false;
      const executionContext = createHistoryLoadExecutionContext({
        deps,
        quiet,
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
          quiet,
          outcome,
          strategy: deps.pipelineStrategyLabel ?? 'default',
        });
      }
    },
  };
}

export type { HistoryLoadPipelineContext, HistoryLoadPipelineStrategy } from './history-pipeline-types';

