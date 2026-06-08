import { hostSessionAbort } from '@/lib/host-api';
import type { StoreSessionRunCache } from './session-run-cache';
import { buildSessionIdentityRecordIndex, resolveSessionOperationTarget } from './session-identity';
import { getSessionRuntime, patchSessionSnapshot } from './store-state-helpers';
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

export const ABORT_STOPPING_TIMEOUT_ERROR = 'chat.abort.stopping-timeout';

const ABORT_RETRY_INTERVAL_MS = 3_000;
const ABORT_RETRY_TIMEOUT_MS = 15_000;

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

function scheduleAbortRetry(params: {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  sessionKey: string;
  targetSessionKey: string;
  sessionIdentity: ChatStoreState['loadedSessions'][string]['meta']['sessionIdentity'];
  approvalIds: string[];
  startedAtMs: number;
}): void {
  const { set, get, sessionKey, targetSessionKey, sessionIdentity, approvalIds, startedAtMs } = params;
  if (!sessionIdentity) {
    return;
  }
  setTimeout(() => {
    const runtime = getSessionRuntime(get(), sessionKey);
    if (runtime.runPhase !== 'stopping') {
      return;
    }
    if (Date.now() - startedAtMs >= ABORT_RETRY_TIMEOUT_MS) {
      set({ error: ABORT_STOPPING_TIMEOUT_ERROR });
      return;
    }
    void hostSessionAbort({
      sessionKey: targetSessionKey,
      sessionIdentity,
      approvalIds,
    }).then((abortRuntime) => {
      set((state) => {
        const loadedSessions = patchSessionSnapshot(state, sessionKey, abortRuntime.snapshot);
        return {
          loadedSessions,
          sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
        };
      });
      scheduleAbortRetry(params);
    }).catch(() => {
      scheduleAbortRetry(params);
    });
  }, ABORT_RETRY_INTERVAL_MS);
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
    const target = resolveSessionOperationTarget(get(), sessionKey);
    const approvalIds = pendingApprovals.map((approval) => approval.id);
    const abortRuntime = await hostSessionAbort({
      sessionKey: target.sessionKey,
      sessionIdentity: target.sessionIdentity,
      approvalIds,
    });
    set((state) => {
      const loadedSessions = patchSessionSnapshot(state, sessionKey, abortRuntime.snapshot);
      return {
        loadedSessions,
        sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      };
    });
    scheduleAbortRetry({
      set,
      get,
      sessionKey,
      targetSessionKey: target.sessionKey,
      sessionIdentity: target.sessionIdentity,
      approvalIds,
      startedAtMs: Date.now(),
    });
  } catch (err) {
    set({ error: String(err) });
  } finally {
    onFinishMutating();
  }
}
