import { clearHistoryPoll } from './timers';
import { reduceRuntimeOverlay } from './overlay-reducer';
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
  const hasPendingApprovals = (get().pendingApprovalsBySession[get().currentSessionKey] ?? []).length > 0;
  set((state) => reduceRuntimeOverlay(state, {
    type: 'final_history_refresh_requested',
    hasPendingApprovals,
  }));
  void get().loadHistory({
    sessionKey: get().currentSessionKey,
    mode: 'quiet',
    scope: 'foreground',
    reason: 'final_event_reconcile',
  });
}
