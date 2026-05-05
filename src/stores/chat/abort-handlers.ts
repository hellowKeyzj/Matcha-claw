import { hostSessionAbortRuntime } from '@/lib/host-api';
import { useGatewayStore } from '../gateway';
import { reduceSessionRuntime } from './runtime-state-reducer';
import { getSessionRuntime, patchSessionRecord, patchSessionSnapshot } from './store-state-helpers';
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

  const { sessionKey, pendingApprovals } = getPendingApprovalsForCurrentSession(get());
  onAbortedTelemetry(sessionKey);
  set((state) => {
    const runtime = getSessionRuntime(state, sessionKey);
    const runtimePatch = reduceSessionRuntime(runtime, { type: 'run_aborted' });
    return {
      loadedSessions: patchSessionRecord(state, sessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
      }),
    };
  });

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
    const abortRuntime = await hostSessionAbortRuntime({ sessionKey });
    set((state) => ({
      loadedSessions: patchSessionSnapshot(state, sessionKey, abortRuntime.snapshot),
    }));
  } catch (err) {
    set({ error: String(err) });
  } finally {
    onFinishMutating();
  }
}
