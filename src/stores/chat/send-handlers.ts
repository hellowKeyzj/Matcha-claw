import { cacheSendAttachments } from './attachment-helpers';
import { hasActiveStreamingRun } from './runtime-stream-state';
import type { StoreSessionRunCache } from './session-run-cache';
import {
  CHAT_SEND_RPC_TIMEOUT_MS,
  sendChatTransport,
} from './send-transport';
import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  clearSendSafetyTimer,
  getLastChatEventAt,
  setLastChatEventAt,
  setSendSafetyTimer,
} from './timers';
import {
  patchSessionSnapshot,
  getSessionMeta,
  getSessionRuntime,
  patchSessionMeta,
  hasTimeoutSignal,
  isRecoverableChatSendTimeout,
} from './store-state-helpers';
import type { ChatSendAttachment, ChatStoreState } from './types';
import { isRunActive, isWaitingTool } from './types';

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
    return {
      loadedSessions: patchSessionMeta(
        state,
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
  onSafetyTimeout: () => void;
}

async function reconcileStuckRunClosure(input: {
  get: ChatStoreGetFn;
  sessionKey: string;
}): Promise<boolean> {
  const state = input.get();
  const runtime = getSessionRuntime(state, input.sessionKey);
  return await state.reconcileRunClosure({
    sessionKey: input.sessionKey,
    ...(runtime.activeRunId ? { runId: runtime.activeRunId } : {}),
    ...(runtime.pendingTurnKey ? { turnKey: runtime.pendingTurnKey } : {}),
  });
}

export function startStoreSendWatchers(params: StartStoreSendWatchersParams): void {
  const {
    set,
    get,
    sessionKey,
    onSafetyTimeout,
  } = params;

  setLastChatEventAt(Date.now());
  clearHistoryPoll();
  clearErrorRecoveryTimer();
  clearSendSafetyTimer();

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
    if (!isRunActive(runtime)) {
      clearSendSafetyTimer();
      return;
    }
    if (hasActiveStreamingRun(runtime) || isWaitingTool(runtime)) {
      setSendSafetyTimer(setTimeout(checkStuck, SAFETY_RETRY_INTERVAL_MS));
      return;
    }
    if (Date.now() - getLastChatEventAt() < SAFETY_TIMEOUT_MS) {
      setSendSafetyTimer(setTimeout(checkStuck, SAFETY_RETRY_INTERVAL_MS));
      return;
    }

    clearHistoryPoll();
    clearSendSafetyTimer();
    void reconcileStuckRunClosure({ get, sessionKey })
      .then((closed) => {
        if (closed) {
          return;
        }
        onSafetyTimeout();
        set((current) => {
          if (current.currentSessionKey !== sessionKey) {
            return current;
          }
          return {
            error: NO_RESPONSE_RECEIVED_ERROR,
          };
        });
      })
      .catch(() => {
        onSafetyTimeout();
        set((current) => {
          if (current.currentSessionKey !== sessionKey) {
            return current;
          }
          return {
            error: NO_RESPONSE_RECEIVED_ERROR,
          };
        });
      });
  };
  setSendSafetyTimer(setTimeout(checkStuck, SAFETY_INITIAL_DELAY_MS));
}

export function resumeActiveStoreSend(
  params: Pick<StartStoreSendWatchersParams, 'set' | 'get' | 'sessionKey'>,
): void {
  const state = params.get();
  if (!isRunActive(getSessionRuntime(state, params.sessionKey))) {
    return;
  }
  startStoreSendWatchers({
    ...params,
    onSafetyTimeout: () => {},
  });
}

interface MaybeEnterStoreWaitingApprovalParams {
  get: ChatStoreGetFn;
  sessionKey: string;
}

async function maybeEnterStoreWaitingApproval(
  params: MaybeEnterStoreWaitingApprovalParams,
): Promise<boolean> {
  const { get, sessionKey } = params;
  await get().syncPendingApprovals(sessionKey);
  const pendingApprovals = get().pendingApprovalsBySession[sessionKey] ?? [];
  if (pendingApprovals.length === 0) {
    return false;
  }
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

interface FinalizeStoreSendFailureParams {
  set: ChatStoreSetFn;
  error: string;
}

function finalizeStoreSendFailure(params: FinalizeStoreSendFailureParams): void {
  const { set, error } = params;
  clearHistoryPoll();
  set({ error });
}

interface ExecuteStoreSendParams {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  sessionRunCache: StoreSessionRunCache;
  beginMutating: () => void;
  finishMutating: () => void;
  text: string;
  attachments?: ChatSendAttachment[];
}

export async function executeStoreSend(params: ExecuteStoreSendParams): Promise<void> {
  const {
    set,
    get,
    sessionRunCache,
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
  if (isRunActive(runtimeBeforeSend)) {
    return;
  }
  const nowMs = Date.now();
  const clientMessageId = crypto.randomUUID();
  const sendGeneration = sessionRunCache.nextSendGeneration(currentSessionKey);
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

    if (sendGeneration !== sessionRunCache.getSendGeneration(currentSessionKey)) {
      return;
    }

      if (!sendResult.ok) {
        const errorMsg = sendResult.error;
        if (isRecoverableChatSendTimeout(errorMsg)) {
          if (await maybeEnterStoreWaitingApproval({
            get,
            sessionKey: currentSessionKey,
          })) {
            return;
          }
          return;
        }
      if (await maybeEnterStoreWaitingApproval({
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

    set((state) => ({
      loadedSessions: patchSessionSnapshot(state, currentSessionKey, sendResult.snapshot),
    }));
  } catch (error) {
    if (sendGeneration !== sessionRunCache.getSendGeneration(currentSessionKey)) {
      return;
    }
    const errorMsg = String(error);
    if (isRecoverableChatSendTimeout(errorMsg)) {
      if (await maybeEnterStoreWaitingApproval({
        get,
        sessionKey: currentSessionKey,
      })) {
        return;
      }
      return;
    }
    const timeoutSignal = hasTimeoutSignal(error);
    if (timeoutSignal) {
      await get().syncPendingApprovals(currentSessionKey);
    }
    const state = get();
    if (timeoutSignal && hasStoreApprovalEvidence(state, currentSessionKey)) {
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
