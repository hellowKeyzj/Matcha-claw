import { hostSessionAbort } from '@/lib/host-api';
import {
  createSessionTraceId,
  logSessionTrace,
  summarizeError,
  summarizeIdentifier,
  summarizeSessionIdentity,
} from '@/lib/session-trace';
import { buildSessionIdentityKey } from '../../types/desktop/runtime-address';
import type { StoreSessionRunCache } from './session-run-cache';
import { resolveSessionOperationTarget } from './session-identity';
import { failSessionAbort, resolveSessionAbortRunId, startSessionAbort } from './session-presentation';
import { getSessionRuntime, patchSessionRecord } from './store-state-helpers';
import { clearErrorRecoveryTimer, clearHistoryPoll } from './timers';
import { isRunActive, type ChatSessionAbortState, type ChatStoreState } from './types';

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
  const record = stateAtClick.loadedSessions[sessionKey];
  const runtimeAtClick = getSessionRuntime(stateAtClick, sessionKey);
  if (!record?.meta.sessionIdentity || runtimeAtClick.runPhase === 'stopping' || !isRunActive(runtimeAtClick)) return;

  const runId = resolveSessionAbortRunId(record);
  const identityKey = buildSessionIdentityKey(record.meta.sessionIdentity);
  const sendGeneration = sessionRunCache.getSendGeneration(sessionKey);
  const approvalIds = (stateAtClick.pendingApprovalsBySession[sessionKey] ?? []).map((approval) => approval.id);
  const traceId = createSessionTraceId('abort-boundary');
  const startedAtMs = Date.now();
  const abort: ChatSessionAbortState = {
    identityKey, sendGeneration, runId: runId ?? null,
    startedAt: Math.max(startedAtMs, (runtimeAtClick.updatedAt ?? 0) + 1), phase: 'stopping', issue: null,
  };
  const reportFailure = (message: string) => {
    set((state) => {
      const current = state.loadedSessions[sessionKey];
      if (!current?.meta.sessionIdentity || buildSessionIdentityKey(current.meta.sessionIdentity) !== identityKey
        || current.abort !== abort || sessionRunCache.getSendGeneration(sessionKey) !== sendGeneration) return state;
      const at = Date.now();
      const failed: ChatSessionAbortState = {
        ...abort, phase: 'failed', issue: { message, code: message, source: 'rpc', at, retryable: true },
      };
      const runtime = failSessionAbort(current, failed, runtimeAtClick);
      return runtime === null ? state : {
        loadedSessions: patchSessionRecord(state, sessionKey, { runtime, abort: failed }),
      };
    });
  };

  logSessionTrace('abort.start', traceId, () => ({
    phase: runtimeAtClick.runPhase,
    activeRunId: summarizeIdentifier(runId),
    sessionKey: summarizeIdentifier(sessionKey),
    pendingApprovalCount: approvalIds.length,
  }));
  clearHistoryPoll();
  clearErrorRecoveryTimer();
  set((state) => ({ loadedSessions: patchSessionRecord(state, sessionKey, {
    abort, runtime: startSessionAbort(record, abort),
  }) }));

  onBeginMutating();
  try {
    const target = resolveSessionOperationTarget(stateAtClick, sessionKey);
    logSessionTrace('abort.target', traceId, () => ({
      sessionKey: summarizeIdentifier(target.sessionKey),
      endpointSessionId: summarizeIdentifier(target.endpointSessionId),
      sessionIdentity: summarizeSessionIdentity(target.sessionIdentity),
    }));
    logSessionTrace('abort.request', traceId, () => ({
      runId: summarizeIdentifier(runId),
      approvalIdsCount: approvalIds.length,
    }));
    const response = await hostSessionAbort({
      ...(target.endpointSessionId ? { endpointSessionId: target.endpointSessionId } : {}),
      sessionIdentity: target.sessionIdentity,
      ...(runId ? { runId } : {}),
      ...(approvalIds.length > 0 ? { approvalIds } : {}),
    }, { traceId });
    logSessionTrace('abort.response', traceId, () => ({
      outcome: response.outcome,
      elapsedMs: Date.now() - startedAtMs,
    }));
    if (response.outcome !== 'succeeded') {
      reportFailure(response.outcome === 'target_rejected' ? ABORT_REJECTED_ERROR : ABORT_UNKNOWN_ERROR);
      return;
    }
    onAbortedTelemetry(sessionKey);
    // A receipt is not a terminal event; this deadline never resends cancellation.
    setTimeout(() => {
      logSessionTrace('abort.terminal.deadline', traceId, () => ({
        phase: getSessionRuntime(get(), sessionKey).runPhase,
        activeRunId: summarizeIdentifier(get().loadedSessions[sessionKey]?.runtime.activeRunId),
        elapsedMs: Date.now() - startedAtMs,
      }));
      reportFailure(ABORT_STOPPING_TIMEOUT_ERROR);
    }, ABORT_TERMINAL_WAIT_MS);
  } catch (err) {
    logSessionTrace('abort.error', traceId, () => ({
      ...summarizeError(err),
      elapsedMs: Date.now() - startedAtMs,
    }));
    reportFailure(ABORT_REQUEST_FAILED_ERROR);
  } finally {
    onFinishMutating();
  }
}
