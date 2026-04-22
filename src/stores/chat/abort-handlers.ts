import { useGatewayStore } from '../gateway';
import { disposeActiveStreamPacer } from './stream-pacer';
import { reduceRuntimeOverlay } from './overlay-reducer';
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
  const { set, get, onBeginMutating, onFinishMutating, onAbortedTelemetry } = params;
  clearHistoryPoll();
  clearErrorRecoveryTimer();
  disposeActiveStreamPacer(set, get);

  const { sessionKey, pendingApprovals } = getPendingApprovalsForCurrentSession(get());
  onAbortedTelemetry(sessionKey);
  set((state) => reduceRuntimeOverlay(state, { type: 'run_aborted' }));

  onBeginMutating();
  try {
    for (const approval of pendingApprovals) {
      await useGatewayStore.getState().rpc(
        'exec.approval.resolve',
        { id: approval.id, decision: 'deny' },
      );
    }
    set((state) => ({
      pendingApprovalsBySession: {
        ...state.pendingApprovalsBySession,
        [sessionKey]: [],
      },
    }));
    await useGatewayStore.getState().rpc(
      'chat.abort',
      { sessionKey },
    );
  } catch (err) {
    set({ error: String(err) });
  } finally {
    onFinishMutating();
  }
}
