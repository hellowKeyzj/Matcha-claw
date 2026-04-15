import {
  CHAT_HISTORY_LOADING_TIMEOUT_MS,
} from './history-fetch-helpers';
import { trackUiEvent } from '@/lib/telemetry';
import {
  createHistoryLoadExecutor,
} from './history-load-execution';
import {
  readHistoryLoadPipelineStrategyKey,
  resolveHistoryLoadPipelineStrategyKey,
  resolveHistoryLoadPipelineStrategy,
} from './history-pipeline-strategies';
import type { HistoryLoadPipelineStrategy } from './history-pipeline-types';
import type { StoreHistoryCache } from './history-cache';
import type { ChatStoreState } from './types';

const OPTIMISTIC_USER_RECONCILE_WINDOW_MS = 15_000;

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface CreateStoreHistoryActionsInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  historyRuntime: StoreHistoryCache;
  pipelineStrategy?: HistoryLoadPipelineStrategy;
  pipelineStrategyKey?: string | null;
  readPipelineStrategyKey?: () => string | null | undefined;
}

type StoreHistoryActions = Pick<ChatStoreState, 'loadHistory'>;

export function createStoreHistoryActions(
  input: CreateStoreHistoryActionsInput,
): StoreHistoryActions {
  const {
    set,
    get,
    historyRuntime,
    pipelineStrategy,
    pipelineStrategyKey,
    readPipelineStrategyKey,
  } = input;

  function resolvePipelineStrategySelection(): {
    strategy: HistoryLoadPipelineStrategy;
    strategyKey: string;
    source: 'injected' | 'input' | 'dynamic' | 'storage' | 'fallback';
  } {
    if (pipelineStrategy) {
      return {
        strategy: pipelineStrategy,
        strategyKey: 'custom',
        source: 'injected',
      };
    }

    let source: 'input' | 'dynamic' | 'storage' | 'fallback' = 'fallback';
    let rawKey: string | null | undefined = pipelineStrategyKey;
    if (rawKey != null) {
      source = 'input';
    } else {
      rawKey = readPipelineStrategyKey?.();
      if (rawKey != null) {
        source = 'dynamic';
      } else {
        rawKey = readHistoryLoadPipelineStrategyKey();
        if (rawKey != null) {
          source = 'storage';
        }
      }
    }

    return {
      strategy: resolveHistoryLoadPipelineStrategy(rawKey),
      strategyKey: resolveHistoryLoadPipelineStrategyKey(rawKey),
      source,
    };
  }

  return {
    loadHistory: (quiet = false) => {
      const selection = resolvePipelineStrategySelection();
      trackUiEvent('chat.history_load_strategy_selected', {
        sessionKey: get().currentSessionKey,
        quiet,
        strategy: selection.strategyKey,
        source: selection.source,
      });
      return createHistoryLoadExecutor({
        set,
        get,
        historyRuntime,
        loadingTimeoutMs: CHAT_HISTORY_LOADING_TIMEOUT_MS,
        optimisticUserReconcileWindowMs: OPTIMISTIC_USER_RECONCILE_WINDOW_MS,
        pipelineStrategy: selection.strategy,
        pipelineStrategyLabel: selection.strategyKey,
      }).execute(quiet);
    },
  };
}

