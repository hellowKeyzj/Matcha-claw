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
  getSessionItems,
} from './store-state-helpers';
import { buildSessionIdentityRecordIndex, resolveSessionOperationTarget } from './session-identity';
import type { ChatSendAttachment, ChatSendResult, ChatStoreState } from './types';
import { isRunActive, isWaitingTool } from './types';

export type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

export type ChatStoreGetFn = () => ChatStoreState;

export const NO_RESPONSE_RECEIVED_ERROR = 'No response received from the model. The provider may be unavailable or the API key may have insufficient quota. Please check your provider settings.';

function hasAssistantProgress(items: ReturnType<typeof getSessionItems>): boolean {
  return items.some((item) => item.kind === 'assistant-turn' && (
    item.status === 'streaming'
    || item.status === 'waiting_tool'
    || item.segments.length > 0
    || item.tools.length > 0
    || item.thinking != null
    || item.text.trim().length > 0
    || item.images.length > 0
    || item.attachedFiles.length > 0
  ));
}

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
    if (hasAssistantProgress(getSessionItems(state, sessionKey))) {
      setLastChatEventAt(Date.now());
      if (state.error === NO_RESPONSE_RECEIVED_ERROR) {
        set({ error: null });
      }
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
      return {
        error: NO_RESPONSE_RECEIVED_ERROR,
      };
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

export async function executeStoreSend(params: ExecuteStoreSendParams): Promise<ChatSendResult> {
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
    return { accepted: false, reason: 'empty' };
  }

  const stateBeforeSend = get();
  if (stateBeforeSend.mutating === true) {
    return { accepted: false, reason: 'mutating' };
  }
  const { currentSessionKey } = stateBeforeSend;
  const runtimeBeforeSend = getSessionRuntime(stateBeforeSend, currentSessionKey);
  let target;
  try {
    target = resolveSessionOperationTarget(stateBeforeSend, currentSessionKey);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    set({ error: errorMessage });
    return { accepted: false, reason: 'missing-session', error: errorMessage };
  }
  if (isRunActive(runtimeBeforeSend)) {
    return { accepted: false, reason: runtimeBeforeSend.runPhase === 'stopping' ? 'stopping' : 'active' };
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
      sessionKey: target.sessionKey,
      endpointSessionId: target.endpointSessionId,
      sessionIdentity: target.sessionIdentity,
      message: trimmed,
      idempotencyKey: clientMessageId,
      attachments,
      timeoutMs: CHAT_SEND_RPC_TIMEOUT_MS,
    });

    if (sendGeneration !== sessionRunCache.getSendGeneration(currentSessionKey)) {
      return { accepted: true };
    }

    if (!sendResult.ok) {
      const errorMsg = sendResult.error;
      if (isRecoverableChatSendTimeout(errorMsg)) {
        if (await maybeEnterStoreWaitingApproval({
          get,
          sessionKey: currentSessionKey,
        })) {
          return { accepted: true };
        }
        return { accepted: true };
      }
      if (await maybeEnterStoreWaitingApproval({
        get,
        sessionKey: currentSessionKey,
      })) {
        return { accepted: true };
      }
      finalizeStoreSendFailure({
        set,
        error: errorMsg,
      });
      return { accepted: true };
    }

    set((state) => {
      const loadedSessions = patchSessionSnapshot(state, currentSessionKey, sendResult.snapshot);
      return {
        loadedSessions,
        sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      };
    });
    return { accepted: true };
  } catch (error) {
    if (sendGeneration !== sessionRunCache.getSendGeneration(currentSessionKey)) {
      return { accepted: true };
    }
    const errorMsg = String(error);
    if (isRecoverableChatSendTimeout(errorMsg)) {
      if (await maybeEnterStoreWaitingApproval({
        get,
        sessionKey: currentSessionKey,
      })) {
        return { accepted: true };
      }
      return { accepted: true };
    }
    const timeoutSignal = hasTimeoutSignal(error);
    if (timeoutSignal) {
      await get().syncPendingApprovals(currentSessionKey);
    }
    const state = get();
    if (timeoutSignal && hasStoreApprovalEvidence(state, currentSessionKey)) {
      return { accepted: true };
    }
    finalizeStoreSendFailure({
      set,
      error: errorMsg,
    });
    return { accepted: true };
  } finally {
    finishMutating();
  }
}
