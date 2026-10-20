export interface StoreHistoryCache {
  getHistoryLoadRunId: () => number;
  nextHistoryLoadRunId: () => number;
  replaceHistoryLoadAbortController: (
    sessionKey: string,
    controller: AbortController,
  ) => AbortController | null;
  clearHistoryLoadAbortController: (
    sessionKey: string,
    controller: AbortController,
  ) => void;
  setHistoryLoadInFlight: (sessionKey: string, task: Promise<void>) => void;
  clearHistoryLoadInFlight: (sessionKey: string, task: Promise<void>) => void;
  historyFingerprintBySession: Map<string, string>;
  historyRenderFingerprintBySession: Map<string, string>;
}

export function createStoreHistoryCache(): StoreHistoryCache {
  let historyLoadRunId = 0;
  const historyFingerprintBySession = new Map<string, string>();
  const historyRenderFingerprintBySession = new Map<string, string>();
  const historyLoadAbortControllerBySession = new Map<string, AbortController>();
  const historyLoadInFlightBySession = new Map<string, Promise<void>>();

  return {
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
    setHistoryLoadInFlight: (sessionKey, task) => {
      historyLoadInFlightBySession.set(sessionKey, task);
    },
    clearHistoryLoadInFlight: (sessionKey, task) => {
      if (historyLoadInFlightBySession.get(sessionKey) === task) {
        historyLoadInFlightBySession.delete(sessionKey);
      }
    },
    historyFingerprintBySession,
    historyRenderFingerprintBySession,
  };
}
