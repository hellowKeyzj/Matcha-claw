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
  historyFingerprintBySession: Map<string, string>;
  historyRenderFingerprintBySession: Map<string, string>;
}
