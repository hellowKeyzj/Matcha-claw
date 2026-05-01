import { cacheSendAttachments } from './attachment-helpers';
import { buildUserTransportMessage } from './message-helpers';
import { resolveSessionLabelFromMessages } from './message-helpers';
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
  getSessionMessages,
  getSessionRuntime,
  patchSessionMessagesAndViewport,
  patchSessionRecord,
  resolveSessionRecord,
  hasTimeoutSignal,
  isRecoverableChatSendTimeout,
} from './store-state-helpers';
import type { ChatSendAttachment, ChatStoreState, RawMessage } from './types';

export type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

export type ChatStoreGetFn = () => ChatStoreState;

export const NO_RESPONSE_RECEIVED_ERROR = 'No response received from the model. The provider may be unavailable or the API key may have insufficient quota. Please check your provider settings.';

interface BuildLocalUserMessageInput {
  clientMessageId: string;
  text: string;
  nowMs: number;
  attachments?: ChatSendAttachment[];
}

export function buildLocalUserMessage(input: BuildLocalUserMessageInput): RawMessage {
  return {
    id: input.clientMessageId,
    clientId: input.clientMessageId,
    messageId: input.clientMessageId,
    role: 'user',
    status: 'sending',
    content: input.text || (input.attachments?.length ? '(file attached)' : ''),
    timestamp: input.nowMs / 1000,
    _attachedFiles: input.attachments?.map((attachment) => ({
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
      preview: attachment.preview,
      filePath: attachment.stagedPath,
    })),
  };
}

interface ApplyStoreSendStartParams {
  set: ChatStoreSetFn;
  sessionKey: string;
  localUserMessage: RawMessage;
  nowMs: number;
}

function buildSendViewportPatch(
  messageCountBeforeAppend: number,
  messageCountAfterAppend: number,
  window: ReturnType<typeof resolveSessionRecord>['window'],
) {
  const visibleCount = Math.max(1, window.windowEndOffset - window.windowStartOffset);
  const detachedFromLatest = !window.isAtLatest || window.hasNewer || window.windowEndOffset < messageCountBeforeAppend;
  if (detachedFromLatest) {
    const windowEndOffset = messageCountAfterAppend;
    const windowStartOffset = Math.max(0, windowEndOffset - visibleCount);
    return {
      totalMessageCount: messageCountAfterAppend,
      windowStartOffset,
      windowEndOffset,
      hasMore: windowStartOffset > 0,
      hasNewer: false,
      isAtLatest: true,
    };
  }
  return {
    totalMessageCount: messageCountAfterAppend,
    windowEndOffset: window.windowEndOffset + 1,
    hasNewer: false,
    isAtLatest: true,
  };
}

export function applyStoreSendStart(params: ApplyStoreSendStartParams): void {
  const { set, sessionKey, localUserMessage, nowMs } = params;
  set((state) => {
    const record = resolveSessionRecord(state.loadedSessions[sessionKey]);
    const nextMessages = [...record.messages, localUserMessage];
    const nextViewportPatch = buildSendViewportPatch(
      record.messages.length,
      nextMessages.length,
      record.window,
    );
    const nextSessionLabel = sessionKey.endsWith(':main')
      ? ''
      : resolveSessionLabelFromMessages(nextMessages);
    const runtimePatch = reduceSessionRuntime(record.runtime, {
      type: 'send_submitted',
      nowMs,
    });
    const nextLoadedSessions = patchSessionMessagesAndViewport(state, sessionKey, nextMessages, nextViewportPatch);
    return {
      loadedSessions: patchSessionRecord(
        { loadedSessions: nextLoadedSessions },
        sessionKey,
        {
          meta: {
            ...record.meta,
            label: nextSessionLabel || record.meta.label,
            lastActivityAt: nowMs,
          },
          runtime: runtimePatch === record.runtime
            ? record.runtime
            : { ...record.runtime, ...runtimePatch },
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
      const currentMessages = getSessionMessages(current, sessionKey);
      const nextMessages = removeLastSendingUser(currentMessages);
      return {
        loadedSessions: patchSessionRecord(
          {
            loadedSessions: patchSessionMessagesAndViewport(current, sessionKey, nextMessages, {
              totalMessageCount: Math.max(
                current.loadedSessions[sessionKey]?.window.totalMessageCount ?? 0,
                nextMessages.length,
              ),
              windowEndOffset: (current.loadedSessions[sessionKey]?.window.windowStartOffset ?? 0) + nextMessages.length,
            }),
          },
          sessionKey,
          {
            runtime: runtimePatch === currentRuntime
              ? currentRuntime
              : { ...currentRuntime, ...runtimePatch },
          },
        ),
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

function removeLastSendingUser(messages: RawMessage[]): RawMessage[] {
  const nextMessages = [...messages];
  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index];
    if (message.role === 'user' && message.status === 'sending') {
      nextMessages.splice(index, 1);
      return nextMessages;
    }
  }
  return messages;
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
    const currentMessages = getSessionMessages(state, state.currentSessionKey);
    const nextMessages = removeLastSendingUser(currentMessages);
    return {
      error,
      loadedSessions: patchSessionRecord(
        { loadedSessions: patchSessionMessagesAndViewport(state, state.currentSessionKey, nextMessages, {
          totalMessageCount: Math.max(state.loadedSessions[state.currentSessionKey]?.window.totalMessageCount ?? 0, nextMessages.length),
          windowEndOffset: (state.loadedSessions[state.currentSessionKey]?.window.windowStartOffset ?? 0) + nextMessages.length,
        }) },
        state.currentSessionKey,
        {
          runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
        },
      ),
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

  const { currentSessionKey } = get();
  const nowMs = Date.now();
  const clientMessageId = crypto.randomUUID();
  const localUserMessage = buildLocalUserMessage({
    clientMessageId,
    text: trimmed,
    nowMs,
    attachments,
  });
  applyStoreSendStart({
    set,
    sessionKey: currentSessionKey,
    localUserMessage,
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
      message: buildUserTransportMessage(trimmed, clientMessageId),
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
        const runtime = getSessionRuntime(state, state.currentSessionKey);
        const runtimePatch = reduceSessionRuntime(runtime, { type: 'send_run_bound', runId: sendResult.runId });
        return {
          loadedSessions: patchSessionRecord(state, state.currentSessionKey, {
            runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
          }),
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
