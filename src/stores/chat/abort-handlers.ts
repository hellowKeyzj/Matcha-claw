import { hostSessionAbort } from '@/lib/host-api';
import type { StoreSessionRunCache } from './session-run-cache';
import { patchSessionSnapshot } from './store-state-helpers';
import { clearErrorRecoveryTimer, clearHistoryPoll } from './timers';
import type {
  ApprovalItem,
  ChatStoreState,
} from './types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface ExecuteStoreAbortRunParams {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  sessionRunCache: StoreSessionRunCache;
  onBeginMutating: () => void;
  onFinishMutating: () => void;
  onAbortedTelemetry: (sessionKey: string) => void;
}

function getPendingApprovalsForCurrentSession(
  state: ChatStoreState,
): { sessionKey: string; pendingApprovals: ApprovalItem[] } {
  const sessionKey = state.currentSessionKey;
  const pendingApprovals = state.pendingApprovalsBySession[sessionKey] ?? [];
  return { sessionKey, pendingApprovals };
}

export async function executeStoreAbortRun(params: ExecuteStoreAbortRunParams): Promise<void> {
  const { set, get, sessionRunCache, onBeginMutating, onFinishMutating, onAbortedTelemetry } = params;
  clearHistoryPoll();
  clearErrorRecoveryTimer();

  const { sessionKey, pendingApprovals } = getPendingApprovalsForCurrentSession(get());
  sessionRunCache.nextSendGeneration(sessionKey);
  onAbortedTelemetry(sessionKey);

  onBeginMutating();
  try {
    set((state) => ({
      pendingApprovalsBySession: {
        ...state.pendingApprovalsBySession,
        [sessionKey]: [],
      },
    }));
    const abortRuntime = await hostSessionAbort({
      sessionKey,
      approvalIds: pendingApprovals.map((approval) => approval.id),
    });
    set((state) => ({
      loadedSessions: patchSessionSnapshot(state, sessionKey, abortRuntime.snapshot),
    }));
  } catch (err) {
    set({ error: String(err) });
  } finally {
    onFinishMutating();
  }
}
