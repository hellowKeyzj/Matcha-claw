import { cacheSendAttachments } from './attachment-helpers';
import { reduceSessionRuntime } from './runtime-state-reducer';
import { hasActiveStreamingRun } from './runtime-stream-state';
import {
  CHAT_SEND_RPC_TIMEOUT_MS,
  sendChatTransport,
} from './send-transport';
import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  clearSendSafetyTimer,
  getLastChatEventAt,
  setHistoryPollTimer,
  setLastChatEventAt,
  setSendSafetyTimer,
} from './timers';
import {
  patchSessionRecord,
  patchSessionSnapshot,
  getSessionMeta,
  getSessionRuntime,
  patchSessionMeta,
  hasTimeoutSignal,
  isRecoverableChatSendTimeout,
} from './store-state-helpers';
import type { ChatSendAttachment, ChatStoreState } from './types';

export type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

export type ChatStoreGetFn = () => ChatStoreState;

export const NO_RESPONSE_RECEIVED_ERROR = 'No response received from the model. The provider may be unavailable or the API key may have insufficient quota. Please check your provider settings.';

interface ApplyStoreSendStartParams {
  set: ChatStoreSetFn;
  sessionKey: string;
  text: string;
  nowMs: number;
}

export function applyStoreSendStart(params: ApplyStoreSendStartParams): void {
  const { set, sessionKey, text, nowMs } = params;
  set((state) => {
    const sessionMeta = getSessionMeta(state, sessionKey);
    const nextSessionLabel = sessionMeta.kind === 'main' || sessionMeta.preferred
      ? null
      : text;
    const runtime = getSessionRuntime(state, sessionKey);
    const runtimePatch = reduceSessionRuntime(runtime, {
      type: 'send_submitted',
      nowMs,
    });
    return {
      loadedSessions: patchSessionMeta(
        {
          loadedSessions: patchSessionRecord(state, sessionKey, {
            runtime: runtimePatch === runtime
              ? runtime
              : { ...runtime, ...runtimePatch },
          }),
        },
        sessionKey,
        {
          label: nextSessionLabel ?? state.loadedSessions[sessionKey]?.meta.label ?? null,
          lastActivityAt: nowMs,
        },
      ),
    };
  });
}

interface StartStoreSendWatchersParams {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  sessionKey: string;
  source: 'send' | 'resume';
  onSafetyTimeout: () => void;
}

export function startStoreSendWatchers(params: StartStoreSendWatchersParams): void {
  const {
    set,
    get,
    sessionKey,
    source,
    onSafetyTimeout,
  } = params;
  const pollReason = source === 'resume' ? 'switch_session_poll' : 'send_poll';

  setLastChatEventAt(Date.now());
  clearHistoryPoll();
  clearErrorRecoveryTimer();
  clearSendSafetyTimer();

  const POLL_START_DELAY_MS = 3_000;
  const POLL_INTERVAL_MS = 4_000;
  const pollHistory = () => {
    const state = get();
    if (state.currentSessionKey !== sessionKey) {
      clearHistoryPoll();
      return;
    }
    const runtime = getSessionRuntime(state, sessionKey);
    if (!runtime.sending) {
      clearHistoryPoll();
      return;
    }
    if (hasActiveStreamingRun(runtime)) {
      setHistoryPollTimer(setTimeout(pollHistory, POLL_INTERVAL_MS));
      return;
    }
    void state.loadHistory({
      sessionKey,
      mode: 'quiet',
      scope: 'foreground',
      reason: pollReason,
    });
    void state.syncPendingApprovals(sessionKey);
    setHistoryPollTimer(setTimeout(pollHistory, POLL_INTERVAL_MS));
  };
  setHistoryPollTimer(setTimeout(pollHistory, POLL_START_DELAY_MS));

  const SAFETY_TIMEOUT_MS = 90_000;
  const SAFETY_RETRY_INTERVAL_MS = 10_000;
  const SAFETY_INITIAL_DELAY_MS = 30_000;
  const checkStuck = () => {
    const state = get();
    if (state.currentSessionKey !== sessionKey) {
      clearSendSafetyTimer();
      return;
    }
    const runtime = getSessionRuntime(state, sessionKey);
    if (!runtime.sending) {
      clearSendSafetyTimer();
      return;
    }
    if (hasActiveStreamingRun(runtime) || runtime.pendingFinal) {
      setSendSafetyTimer(setTimeout(checkStuck, SAFETY_RETRY_INTERVAL_MS));
      return;
    }
    if (Date.now() - getLastChatEventAt() < SAFETY_TIMEOUT_MS) {
      setSendSafetyTimer(setTimeout(checkStuck, SAFETY_RETRY_INTERVAL_MS));
      return;
    }

    clearHistoryPoll();
    clearSendSafetyTimer();
    onSafetyTimeout();
    set((current) => {
      if (current.currentSessionKey !== sessionKey) {
        return current;
      }
      const currentRuntime = getSessionRuntime(current, sessionKey);
      const runtimePatch = reduceSessionRuntime(currentRuntime, {
        type: 'send_failed',
        error: NO_RESPONSE_RECEIVED_ERROR,
        clearRun: true,
      });
      return {
        loadedSessions: patchSessionRecord(current, sessionKey, {
          runtime: runtimePatch === currentRuntime
            ? currentRuntime
            : { ...currentRuntime, ...runtimePatch },
        }),
      };
    });
  };
  setSendSafetyTimer(setTimeout(checkStuck, SAFETY_INITIAL_DELAY_MS));
}

export function resumeActiveStoreSend(
  params: Pick<StartStoreSendWatchersParams, 'set' | 'get' | 'sessionKey'>,
): void {
  const state = params.get();
  if (!getSessionRuntime(state, params.sessionKey).sending) {
    return;
  }
  startStoreSendWatchers({
    ...params,
    source: 'resume',
    onSafetyTimeout: () => {},
  });
}

interface MaybeEnterStoreWaitingApprovalParams {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  sessionKey: string;
}

async function maybeEnterStoreWaitingApproval(
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

function hasStoreApprovalEvidence(
  state: ChatStoreState,
  sessionKey: string,
): boolean {
  const pendingApprovals = state.pendingApprovalsBySession[sessionKey] ?? [];
  const runtime = getSessionRuntime(state, sessionKey);
  return (
    pendingApprovals.length > 0
    || runtime.activeRunId != null
  );
}

function commitStoreSendWaitingApproval(set: ChatStoreSetFn): void {
  set((state) => {
    const runtime = getSessionRuntime(state, state.currentSessionKey);
    const runtimePatch = reduceSessionRuntime(runtime, { type: 'send_waiting_approval' });
    return {
      loadedSessions: patchSessionRecord(state, state.currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
      }),
    };
  });
}

interface FinalizeStoreSendFailureParams {
  set: ChatStoreSetFn;
  error: string;
}

function finalizeStoreSendFailure(params: FinalizeStoreSendFailureParams): void {
  const { set, error } = params;
  clearHistoryPoll();
  set((state) => {
    const runtime = getSessionRuntime(state, state.currentSessionKey);
    const runtimePatch = reduceSessionRuntime(runtime, { type: 'send_failed', error });
    return {
      error,
      loadedSessions: patchSessionRecord(state, state.currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
      }),
    };
  });
}

interface ExecuteStoreSendParams {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  beginMutating: () => void;
  finishMutating: () => void;
  text: string;
  attachments?: ChatSendAttachment[];
}

export async function executeStoreSend(params: ExecuteStoreSendParams): Promise<void> {
  const {
    set,
    get,
    beginMutating,
    finishMutating,
    text,
    attachments,
  } = params;
  const trimmed = text.trim();
  if (!trimmed && (!attachments || attachments.length === 0)) {
    return;
  }

  const stateBeforeSend = get();
  const { currentSessionKey } = stateBeforeSend;
  const runtimeBeforeSend = getSessionRuntime(stateBeforeSend, currentSessionKey);
  if (runtimeBeforeSend.sending || runtimeBeforeSend.pendingFinal) {
    return;
  }
  const nowMs = Date.now();
  const clientMessageId = crypto.randomUUID();
  applyStoreSendStart({
    set,
    sessionKey: currentSessionKey,
    text: trimmed,
    nowMs,
  });

  startStoreSendWatchers({
    set,
    get,
    sessionKey: currentSessionKey,
    source: 'send',
    onSafetyTimeout: () => {},
  });

  beginMutating();
  try {
    if (attachments && attachments.length > 0) {
      cacheSendAttachments(attachments);
    }

    const sendResult = await sendChatTransport({
      sessionKey: currentSessionKey,
      message: trimmed,
      idempotencyKey: clientMessageId,
      attachments,
      timeoutMs: CHAT_SEND_RPC_TIMEOUT_MS,
    });

    if (!sendResult.ok) {
      const errorMsg = sendResult.error;
      if (isRecoverableChatSendTimeout(errorMsg)) {
        set({ error: errorMsg });
        return;
      }
      if (await maybeEnterStoreWaitingApproval({
        set,
        get,
        sessionKey: currentSessionKey,
      })) {
        return;
      }
      finalizeStoreSendFailure({
        set,
        error: errorMsg,
      });
      return;
    }

    if (sendResult.runId) {
      set((state) => {
        const runtime = getSessionRuntime(state, currentSessionKey);
        const runtimePatch = reduceSessionRuntime(runtime, { type: 'send_run_bound', runId: sendResult.runId });
        return {
          loadedSessions: patchSessionRecord(
            {
              loadedSessions: patchSessionSnapshot(state, currentSessionKey, sendResult.snapshot),
            },
            currentSessionKey,
            {
              runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
            },
          ),
        };
      });
    } else {
      set((state) => {
        return {
          loadedSessions: patchSessionSnapshot(state, currentSessionKey, sendResult.snapshot),
        };
      });
    }
  } catch (error) {
    const errorMsg = String(error);
    if (isRecoverableChatSendTimeout(errorMsg)) {
      set({ error: errorMsg });
      return;
    }
    const timeoutSignal = hasTimeoutSignal(error);
    if (timeoutSignal) {
      await get().syncPendingApprovals(currentSessionKey);
    }
    const state = get();
    if (timeoutSignal && hasStoreApprovalEvidence(state, currentSessionKey)) {
      commitStoreSendWaitingApproval(set);
      return;
    }
    finalizeStoreSendFailure({
      set,
      error: errorMsg,
    });
  } finally {
    finishMutating();
  }
}
