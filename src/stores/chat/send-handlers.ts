import { resolveSessionLabelFromMessages } from './message-helpers';
import { reduceRuntimeOverlay } from './overlay-reducer';
import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  getLastChatEventAt,
  setHistoryPollTimer,
  setLastChatEventAt,
} from './timers';
import { hasActiveStreamingRun } from './runtime-stream-state';
import {
  getSessionViewportState,
  getSessionRuntime,
  patchSessionRecord,
  patchSessionViewportState,
  resolveSessionRecord,
} from './store-state-helpers';
import type {
  ChatSendAttachment,
  ChatStoreState,
  PendingUserMessageOverlay,
} from './types';
import {
  appendViewportMessage,
  removeViewportMessageById,
} from './viewport-state';

export type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

export type ChatStoreGetFn = () => ChatStoreState;

export const NO_RESPONSE_RECEIVED_ERROR = 'No response received from the model. The provider may be unavailable or the API key may have insufficient quota. Please check your provider settings.';

interface BuildPendingUserMessageInput {
  clientMessageId: string;
  text: string;
  nowMs: number;
  attachments?: ChatSendAttachment[];
}

export function buildPendingUserMessageOverlay(
  input: BuildPendingUserMessageInput,
): PendingUserMessageOverlay {
  return {
    clientMessageId: input.clientMessageId,
    createdAtMs: input.nowMs,
    message: {
      role: 'user',
      content: input.text || (input.attachments?.length ? '(file attached)' : ''),
      timestamp: input.nowMs / 1000,
      id: input.clientMessageId,
      _attachedFiles: input.attachments?.map((attachment) => ({
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        fileSize: attachment.fileSize,
        preview: attachment.preview,
        filePath: attachment.stagedPath,
      })),
    },
  };
}

interface ApplyStoreSendStartParams {
  set: ChatStoreSetFn;
  sessionKey: string;
  pendingUserMessage: PendingUserMessageOverlay;
  nowMs: number;
}

export function applyStoreSendStart(params: ApplyStoreSendStartParams): void {
  const { set, sessionKey, pendingUserMessage, nowMs } = params;
  set((state) => {
    const record = resolveSessionRecord(state.sessionsByKey[sessionKey]);
    const nextSessionLabel = sessionKey.endsWith(':main')
      ? ''
      : resolveSessionLabelFromMessages([...record.transcript, pendingUserMessage.message]);
    const runtimePatch = reduceRuntimeOverlay(record.runtime, {
      type: 'send_submitted',
      nowMs,
      pendingUserMessage,
    });
    return {
      sessionsByKey: patchSessionRecord(state, sessionKey, {
        meta: {
          ...record.meta,
          label: nextSessionLabel || record.meta.label,
          lastActivityAt: nowMs,
        },
        runtime: runtimePatch === record.runtime
          ? record.runtime
          : { ...record.runtime, ...runtimePatch },
      }),
      viewportBySession: patchSessionViewportState(
        state,
        sessionKey,
        appendViewportMessage(
          getSessionViewportState(state, sessionKey),
          pendingUserMessage.message,
        ),
      ),
    };
  });
}

interface StartStoreSendWatchersParams {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  onSafetyTimeout: () => void;
}

export function startStoreSendWatchers(params: StartStoreSendWatchersParams): void {
  const { set, get, onSafetyTimeout } = params;

  setLastChatEventAt(Date.now());
  clearHistoryPoll();
  clearErrorRecoveryTimer();

  const POLL_START_DELAY = 3_000;
  const POLL_INTERVAL = 4_000;
  const pollHistory = () => {
    const state = get();
    const runtime = getSessionRuntime(state, state.currentSessionKey);
    if (!runtime.sending) {
      clearHistoryPoll();
      return;
    }
    if (hasActiveStreamingRun(runtime)) {
      setHistoryPollTimer(setTimeout(pollHistory, POLL_INTERVAL));
      return;
    }
    void state.loadHistory({
      sessionKey: state.currentSessionKey,
      mode: 'quiet',
      scope: 'foreground',
      reason: 'send_poll',
    });
    void state.syncPendingApprovals(state.currentSessionKey);
    setHistoryPollTimer(setTimeout(pollHistory, POLL_INTERVAL));
  };
  setHistoryPollTimer(setTimeout(pollHistory, POLL_START_DELAY));

  const SAFETY_TIMEOUT_MS = 90_000;
  const SAFETY_RETRY_INTERVAL_MS = 10_000;
  const SAFETY_INITIAL_CHECK_DELAY_MS = 30_000;
  const checkStuck = () => {
    const state = get();
    const runtime = getSessionRuntime(state, state.currentSessionKey);
    if (!runtime.sending) return;
    if (hasActiveStreamingRun(runtime)) return;
    if (runtime.pendingFinal) {
      setTimeout(checkStuck, SAFETY_RETRY_INTERVAL_MS);
      return;
    }
    if (Date.now() - getLastChatEventAt() < SAFETY_TIMEOUT_MS) {
      setTimeout(checkStuck, SAFETY_RETRY_INTERVAL_MS);
      return;
    }
    clearHistoryPoll();
    onSafetyTimeout();
    set((current) => {
      const currentRuntime = getSessionRuntime(current, current.currentSessionKey);
      const runtimePatch = reduceRuntimeOverlay(currentRuntime, {
        type: 'send_failed',
        error: NO_RESPONSE_RECEIVED_ERROR,
        clearRun: true,
      });
      const nextViewport = removeViewportMessageById(
        getSessionViewportState(current, current.currentSessionKey),
        currentRuntime.pendingUserMessage?.message.id,
      );
      return {
        sessionsByKey: patchSessionRecord(current, current.currentSessionKey, {
          runtime: runtimePatch === currentRuntime
            ? currentRuntime
            : { ...currentRuntime, ...runtimePatch },
        }),
        viewportBySession: patchSessionViewportState(current, current.currentSessionKey, nextViewport),
      };
    });
  };
  setTimeout(checkStuck, SAFETY_INITIAL_CHECK_DELAY_MS);
}

interface MaybeEnterStoreWaitingApprovalParams {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  sessionKey: string;
}

export async function maybeEnterStoreWaitingApproval(
  params: MaybeEnterStoreWaitingApprovalParams,
): Promise<boolean> {
  const { set, get, sessionKey } = params;
  await get().syncPendingApprovals(sessionKey);
  const pendingApprovals = get().pendingApprovalsBySession[sessionKey] ?? [];
  if (pendingApprovals.length === 0) {
    return false;
  }
  commitStoreSendWaitingApproval(set);
  return true;
}

export function hasStoreApprovalEvidence(
  state: ChatStoreState,
  sessionKey: string,
): boolean {
  const pendingApprovals = state.pendingApprovalsBySession[sessionKey] ?? [];
  const runtime = getSessionRuntime(state, sessionKey);
  return (
    pendingApprovals.length > 0
    || runtime.approvalStatus === 'awaiting_approval'
    || runtime.activeRunId != null
  );
}

export function commitStoreSendWaitingApproval(set: ChatStoreSetFn): void {
  set((state) => {
    const runtime = getSessionRuntime(state, state.currentSessionKey);
    const runtimePatch = reduceRuntimeOverlay(runtime, { type: 'send_waiting_approval' });
    return {
      sessionsByKey: patchSessionRecord(state, state.currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
      }),
    };
  });
}

interface FinalizeStoreSendFailureParams {
  set: ChatStoreSetFn;
  error: string;
  onTelemetryFailure?: () => void;
}

export function finalizeStoreSendFailure(params: FinalizeStoreSendFailureParams): void {
  const { set, error, onTelemetryFailure } = params;
  clearHistoryPoll();
  onTelemetryFailure?.();
  set((state) => {
    const runtime = getSessionRuntime(state, state.currentSessionKey);
    const runtimePatch = reduceRuntimeOverlay(runtime, { type: 'send_failed', error });
    const nextViewport = removeViewportMessageById(
      getSessionViewportState(state, state.currentSessionKey),
      runtime.pendingUserMessage?.message.id,
    );
    return {
      error,
      sessionsByKey: patchSessionRecord(state, state.currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
      }),
      viewportBySession: patchSessionViewportState(state, state.currentSessionKey, nextViewport),
    };
  });
}

interface CommitStoreRunIdBoundParams {
  set: ChatStoreSetFn;
  runId: string;
}

export function commitStoreRunIdBound(params: CommitStoreRunIdBoundParams): void {
  const { set, runId } = params;
  set((state) => {
    const runtime = getSessionRuntime(state, state.currentSessionKey);
    const runtimePatch = reduceRuntimeOverlay(runtime, { type: 'send_run_bound', runId });
    return {
      sessionsByKey: patchSessionRecord(state, state.currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
      }),
    };
  });
}
