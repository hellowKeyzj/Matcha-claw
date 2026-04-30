import { clearHistoryPoll } from './timers';
import { reduceSessionRuntime } from './runtime-state-reducer';
import { getSessionRuntime, patchSessionRecord } from './store-state-helpers';
import type { ChatStoreState } from './types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

export function requestFinalHistoryRefresh(
  set: ChatStoreSetFn,
  get: ChatStoreGetFn,
  onBeginFinalToHistory: () => void,
): void {
  onBeginFinalToHistory();
  clearHistoryPoll();
  const sessionKey = get().currentSessionKey;
  const hasPendingApprovals = (get().pendingApprovalsBySession[sessionKey] ?? []).length > 0;
  set((state) => {
    const runtime = getSessionRuntime(state, sessionKey);
    const runtimePatch = reduceSessionRuntime(runtime, {
      type: 'final_history_refresh_requested',
      hasPendingApprovals,
    });
    return {
      loadedSessions: patchSessionRecord(state, sessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
      }),
    };
  });
  void get().loadHistory({
    sessionKey,
    mode: 'quiet',
    scope: 'background',
    reason: 'final_event_reconcile',
  });
}

