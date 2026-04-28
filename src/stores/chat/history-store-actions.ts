import {
  CHAT_HISTORY_LOADING_TIMEOUT_MS,
} from './history-fetch-helpers';
import {
  createHistoryLoadExecutor,
} from './history-load-execution';
import type { StoreHistoryCache } from './history-cache';
import type {
  ChatHistoryLoadRequest,
  ChatStoreState,
} from './types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface CreateStoreHistoryActionsInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  historyRuntime: StoreHistoryCache;
}

type StoreHistoryActions = Pick<ChatStoreState, 'loadHistory'>;

export function createStoreHistoryActions(
  input: CreateStoreHistoryActionsInput,
): StoreHistoryActions {
  const {
    set,
    get,
    historyRuntime,
  } = input;

  return {
    loadHistory: (request: ChatHistoryLoadRequest) => {
      const normalizedSessionKey = request.sessionKey.trim();
      if (!normalizedSessionKey) {
        return Promise.resolve();
      }
      const normalizedRequest: ChatHistoryLoadRequest = {
        ...request,
        sessionKey: normalizedSessionKey,
      };
      return createHistoryLoadExecutor({
        set,
        get,
        historyRuntime,
        loadingTimeoutMs: CHAT_HISTORY_LOADING_TIMEOUT_MS,
      }).execute(normalizedRequest);
    },
  };
}
