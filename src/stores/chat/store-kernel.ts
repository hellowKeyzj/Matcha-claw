import type { StoreHistoryCache, TerminalToolReconcileTarget } from './history-cache';
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
  let historyLoadRunId = 0;
  let mutatingCounter = 0;

  const historyFingerprintBySession = new Map<string, string>();
  const historyRenderFingerprintBySession = new Map<string, string>();
  const historyLoadAbortControllerBySession = new Map<string, AbortController>();
  const terminalHistoryReconcileBySession = new Map<string, TerminalToolReconcileTarget>();
  const historyLoadInFlightBySession = new Map<string, Promise<void>>();
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
    resetTerminalHistoryReconcile: (sessionKey) => {
      terminalHistoryReconcileBySession.delete(sessionKey);
    },
    markTerminalHistoryReconcileNeeded: (target) => {
      const current = terminalHistoryReconcileBySession.get(target.sessionKey);
      const toolCallIds = new Set([
        ...(current?.toolCallIds ?? []),
        ...target.toolCallIds,
      ]);
      terminalHistoryReconcileBySession.set(target.sessionKey, {
        sessionKey: target.sessionKey,
        runId: target.runId ?? current?.runId,
        turnKey: target.turnKey ?? current?.turnKey,
        toolCallIds: Array.from(toolCallIds),
      });
    },
    consumeTerminalHistoryReconcileNeeded: (sessionKey) => {
      const target = terminalHistoryReconcileBySession.get(sessionKey) ?? null;
      terminalHistoryReconcileBySession.delete(sessionKey);
      return target;
    },
    getHistoryLoadInFlight: (sessionKey) => historyLoadInFlightBySession.get(sessionKey) ?? null,
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

  return {
    beginMutating,
    finishMutating,
    historyRuntime,
    sessionRunCache,
  };
}
