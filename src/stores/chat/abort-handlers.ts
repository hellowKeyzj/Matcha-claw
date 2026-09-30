import { hostSessionAbort } from '@/lib/host-api';
import {
  createSessionTraceId,
  logSessionTrace,
  summarizeError,
  summarizeIdentifier,
  summarizeSessionIdentity,
} from '@/lib/session-trace';
import type { StoreSessionRunCache } from './session-run-cache';
import { resolveSessionOperationTarget } from './session-identity';
import { getSessionRuntime, patchSessionRecord } from './store-state-helpers';
import { clearErrorRecoveryTimer, clearHistoryPoll } from './timers';
import { isRunActive, type ChatStoreState } from './types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

export const ABORT_STOPPING_TIMEOUT_ERROR = 'chat.abort.stopping-timeout';
export const ABORT_UNKNOWN_ERROR = 'chat.abort.unknown';
export const ABORT_REJECTED_ERROR = 'chat.abort.rejected';
export const ABORT_REQUEST_FAILED_ERROR = 'chat.abort.request-failed';

const ABORT_TERMINAL_WAIT_MS = 15_000;

interface ExecuteStoreAbortRunParams {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  sessionRunCache: StoreSessionRunCache;
  onBeginMutating: () => void;
  onFinishMutating: () => void;
  onAbortedTelemetry: (sessionKey: string) => void;
}

export async function executeStoreAbortRun(params: ExecuteStoreAbortRunParams): Promise<void> {
  const { set, get, sessionRunCache, onBeginMutating, onFinishMutating, onAbortedTelemetry } = params;
  const stateAtClick = get();
  const sessionKey = stateAtClick.currentSessionKey;
  const runtimeAtClick = getSessionRuntime(stateAtClick, sessionKey);
  if (runtimeAtClick.runPhase === 'stopping' || !isRunActive(runtimeAtClick)) return;

  const runId = runtimeAtClick.activeRunId ?? undefined;
  const sendGeneration = sessionRunCache.getSendGeneration(sessionKey);
  const approvalIds = (stateAtClick.pendingApprovalsBySession[sessionKey] ?? []).map((approval) => approval.id);
  const traceId = createSessionTraceId('abort-boundary');
  const startedAtMs = Date.now();
  const stoppingUpdatedAt = Math.max(startedAtMs, (runtimeAtClick.updatedAt ?? 0) + 1);
  const reportFailure = (message: string) => {
    set((state) => {
      const runtime = getSessionRuntime(state, sessionKey);
      if (runtime.runPhase !== 'stopping'
        || runtime.updatedAt !== stoppingUpdatedAt
        || sessionRunCache.getSendGeneration(sessionKey) !== sendGeneration
        || (runId && runtime.activeRunId !== runId)) return state;
      const at = Date.now();
      return {
        loadedSessions: patchSessionRecord(state, sessionKey, {
          runtime: {
            ...runtime,
            runPhase: runtimeAtClick.runPhase,
            lastError: message,
            lastIssue: { message, code: message, source: 'rpc', at, retryable: true },
            updatedAt: at,
          },
        }),
      };
    });
  };

  logSessionTrace('abort.start', traceId, {
    phase: runtimeAtClick.runPhase,
    activeRunId: summarizeIdentifier(runId),
    sessionKey: summarizeIdentifier(sessionKey),
    pendingApprovalCount: approvalIds.length,
  });
  clearHistoryPoll();
  clearErrorRecoveryTimer();
  set((state) => ({
    loadedSessions: patchSessionRecord(state, sessionKey, {
      runtime: { ...runtimeAtClick, runPhase: 'stopping', lastError: null, lastIssue: null, updatedAt: stoppingUpdatedAt },
    }),
  }));

  onBeginMutating();
  try {
    const target = resolveSessionOperationTarget(stateAtClick, sessionKey);
    logSessionTrace('abort.target', traceId, {
      sessionKey: summarizeIdentifier(target.sessionKey),
      endpointSessionId: summarizeIdentifier(target.endpointSessionId),
      sessionIdentity: summarizeSessionIdentity(target.sessionIdentity),
    });
    logSessionTrace('abort.request', traceId, {
      runId: summarizeIdentifier(runId),
      approvalIdsCount: approvalIds.length,
    });
    const response = await hostSessionAbort({
      ...(target.endpointSessionId ? { endpointSessionId: target.endpointSessionId } : {}),
      sessionIdentity: target.sessionIdentity,
      ...(runId ? { runId } : {}),
      ...(approvalIds.length > 0 ? { approvalIds } : {}),
    }, { traceId });
    logSessionTrace('abort.response', traceId, {
      outcome: response.outcome,
      elapsedMs: Date.now() - startedAtMs,
    });
    if (response.outcome !== 'succeeded') {
      reportFailure(response.outcome === 'target_rejected' ? ABORT_REJECTED_ERROR : ABORT_UNKNOWN_ERROR);
      return;
    }
    onAbortedTelemetry(sessionKey);
    // A receipt is not a terminal event; this deadline never resends cancellation.
    setTimeout(() => {
      logSessionTrace('abort.terminal.deadline', traceId, {
        phase: getSessionRuntime(get(), sessionKey).runPhase,
        activeRunId: summarizeIdentifier(getSessionRuntime(get(), sessionKey).activeRunId),
        elapsedMs: Date.now() - startedAtMs,
      });
      reportFailure(ABORT_STOPPING_TIMEOUT_ERROR);
    }, ABORT_TERMINAL_WAIT_MS);
  } catch (err) {
    logSessionTrace('abort.error', traceId, {
      ...summarizeError(err),
      elapsedMs: Date.now() - startedAtMs,
    });
    reportFailure(ABORT_REQUEST_FAILED_ERROR);
  } finally {
    onFinishMutating();
  }
}
