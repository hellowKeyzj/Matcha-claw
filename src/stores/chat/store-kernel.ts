import type { StoreHistoryCache } from './history-cache';
import type { ChatStoreState } from './types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

export interface ChatStoreKernel {
  beginMutating: () => void;
  finishMutating: () => void;
  historyRuntime: StoreHistoryCache;
}

export function createChatStoreKernel(set: ChatStoreSetFn): ChatStoreKernel {
  let historyLoadRunId = 0;
  let mutatingCounter = 0;

  const historyFingerprintBySession = new Map<string, string>();
  const historyProbeFingerprintBySession = new Map<string, string>();
  const historyQuickFingerprintBySession = new Map<string, string>();
  const historyRenderFingerprintBySession = new Map<string, string>();
  const historyLoadAbortControllerBySession = new Map<string, AbortController>();

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

  const historyRuntime: StoreHistoryCache = {
    getHistoryLoadRunId: () => historyLoadRunId,
    nextHistoryLoadRunId: () => {
      historyLoadRunId += 1;
      return historyLoadRunId;
    },
    replaceHistoryLoadAbortController: (sessionKey, controller) => {
      const previous = historyLoadAbortControllerBySession.get(sessionKey) ?? null;
      historyLoadAbortControllerBySession.set(sessionKey, controller);
      return previous;
    },
    clearHistoryLoadAbortController: (sessionKey, controller) => {
      const current = historyLoadAbortControllerBySession.get(sessionKey);
      if (current === controller) {
        historyLoadAbortControllerBySession.delete(sessionKey);
      }
    },
    historyFingerprintBySession,
    historyProbeFingerprintBySession,
    historyQuickFingerprintBySession,
    historyRenderFingerprintBySession,
  };

  return {
    beginMutating,
    finishMutating,
    historyRuntime,
  };
}


