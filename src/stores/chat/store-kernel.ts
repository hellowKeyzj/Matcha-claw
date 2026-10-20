import { createStoreHistoryCache, type StoreHistoryCache } from './history-cache';
import { createStoreSessionRunCache, type StoreSessionRunCache } from './session-run-cache';
import type { ChatStoreState } from './types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

export interface ChatStoreKernel {
  beginMutating: () => void;
  finishMutating: () => void;
  historyRuntime: StoreHistoryCache;
  sessionRunCache: StoreSessionRunCache;
}

export function createChatStoreKernel(set: ChatStoreSetFn): ChatStoreKernel {
  let mutatingCounter = 0;
  const historyRuntime = createStoreHistoryCache();
  const sessionRunCache = createStoreSessionRunCache();

  const beginMutating = (): void => {
    mutatingCounter += 1;
    if (mutatingCounter === 1) {
      set({ mutating: true });
    }
  };

  const finishMutating = (): void => {
    if (mutatingCounter === 0) {
      return;
    }
    mutatingCounter -= 1;
    if (mutatingCounter === 0) {
      set({ mutating: false });
    }
  };

  return {
    beginMutating,
    finishMutating,
    historyRuntime,
    sessionRunCache,
  };
}
