export interface TerminalToolReconcileTarget {
  sessionKey: string;
  runId?: string;
  turnKey?: string;
  toolCallIds: string[];
}

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
  resetTerminalHistoryReconcile: (sessionKey: string) => void;
  markTerminalHistoryReconcileNeeded: (target: TerminalToolReconcileTarget) => void;
  consumeTerminalHistoryReconcileNeeded: (sessionKey: string) => TerminalToolReconcileTarget | null;
  getHistoryLoadInFlight: (sessionKey: string) => Promise<void> | null;
  setHistoryLoadInFlight: (sessionKey: string, task: Promise<void>) => void;
  clearHistoryLoadInFlight: (sessionKey: string, task: Promise<void>) => void;
  historyFingerprintBySession: Map<string, string>;
  historyRenderFingerprintBySession: Map<string, string>;
}
