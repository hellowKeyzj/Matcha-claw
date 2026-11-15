import { hostSessionAbort } from '@/lib/host-api';
import {
  createSessionTraceId,
  logSessionTrace,
  summarizeError,
  summarizeIdentifier,
  summarizeSessionIdentity,
} from '@/lib/session-trace';
import { buildSessionIdentityKey } from '@/types/desktop/runtime-address';
import { sessionImageGenerationTask } from '@/types/session/render-item';
import type { StoreSessionRunCache } from '@/plugins/chat/store/session-run-cache';
import { resolveSessionOperationTarget } from '@/plugins/chat/store/session-identity';
import { failSessionAbort, isSessionAbortPending, resolveSessionAbortRunId, startSessionAbort } from '@/plugins/chat/store/session-presentation';
import { projectionStore } from '@/plugins/chat/store/session-projection-state';
import { getSessionRuntime, patchSessionRecord } from '@/plugins/chat/store/store-state-helpers';
import { clearErrorRecoveryTimer, clearHistoryPoll } from '@/plugins/chat/store/timers';
import { isRunActive, type ChatSessionAbortState, type ChatStoreState } from '@/plugins/chat/store/types';

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
  if (!record?.meta.sessionIdentity || isSessionAbortPending(record)
    || !isRunActive(runtimeAtClick) && !runtimeAtClick.imageGeneration?.active) return;

  const runId = resolveSessionAbortRunId(record);
  if (runtimeAtClick.imageGeneration?.active && !runId) return;
  const imageTaskIds = record.items.flatMap((item) => item.kind === 'assistant-turn'
    ? item.tools.flatMap((tool) => {
      const task = sessionImageGenerationTask(tool);
      return task && (task.status === 'queued' || task.status === 'running')
        && (tool.runId === runId || task.runId === runId) ? [task.taskId] : [];
    }) : []);
  const identity = record.meta.sessionIdentity;
  const identityKey = buildSessionIdentityKey(identity);
  const sendGeneration = sessionRunCache.getSendGeneration(sessionKey);
  const retry = identity.endpoint.kind === 'native-runtime' && identity.endpoint.runtimeAdapterId === 'matcha-agent'
    && record.abort?.phase === 'failed' && record.abort.identityKey === identityKey
    && record.abort.sendGeneration === sendGeneration && record.abort.runId === (runId ?? null);
  const approvalIds = (stateAtClick.pendingApprovalsBySession[sessionKey] ?? []).map((approval) => approval.id);
  const traceId = createSessionTraceId('abort-boundary');
  const startedAtMs = Date.now();
  const abort: ChatSessionAbortState = {
    identityKey, sendGeneration, runId: runId ?? null,
    ...(imageTaskIds.length ? { imageTaskIds } : {}),
    startedAt: Math.max(startedAtMs, (runtimeAtClick.updatedAt ?? 0) + 1), phase: 'stopping', issue: null,
  };
  const isCurrentAbort = (state: ChatStoreState) => {
    const current = state.loadedSessions[sessionKey];
    return current?.meta.sessionIdentity === identity && buildSessionIdentityKey(identity) === identityKey
      && current.abort === abort && sessionRunCache.getSendGeneration(sessionKey) === sendGeneration;
  };
  const reportFailure = (message: string) => {
    set((state) => {
      if (!isCurrentAbort(state)) return state;
      const current = state.loadedSessions[sessionKey];
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
    if (!isCurrentAbort(get())) return;
    if (retry) {
      const projection = projectionStore(get).get(identityKey);
      if (!projection) {
        reportFailure(ABORT_REQUEST_FAILED_ERROR);
        return;
      }
      const view = await get().resyncSession({ identity, epoch: projection.epoch, seq: projection.seq });
      const refreshed = get();
      if (!isCurrentAbort(refreshed)) return;
      if (!view || buildSessionIdentityKey(view.identity) !== identityKey || typeof view.runtime !== 'object'
        || !('complete' in view.runtime) || view.runtime.complete.issue !== null) {
        reportFailure(ABORT_REQUEST_FAILED_ERROR);
        return;
      }
      const current = refreshed.loadedSessions[sessionKey];
      const runtime = getSessionRuntime(refreshed, sessionKey);
      if (refreshed.currentSessionKey !== sessionKey || refreshed.currentConversation !== stateAtClick.currentConversation
        || view.runtime.complete.activeRunId !== runId || resolveSessionAbortRunId(current) !== runId
        || view.runtime.complete.phase !== 'queued' && view.runtime.complete.phase !== 'started'
          && view.runtime.complete.phase !== 'waiting_for_approval' && view.runtime.complete.phase !== 'cancellation_requested'
        || !isRunActive(runtime) && !runtime.imageGeneration?.active) {
        reportFailure(ABORT_STOPPING_TIMEOUT_ERROR);
        return;
      }
    }
    const target = resolveSessionOperationTarget(get(), sessionKey);
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
    if (!isCurrentAbort(get())) return;
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
