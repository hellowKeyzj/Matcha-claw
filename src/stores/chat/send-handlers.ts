import { resolveSessionLabelFromMessages } from './message-helpers';
import {
  reduceRuntimeOverlay,
} from './overlay-reducer';
import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  getLastChatEventAt,
  setHistoryPollTimer,
  setLastChatEventAt,
} from './timers';
import type { ChatSendAttachment, ChatStoreState, RawMessage } from './types';

export type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

export type ChatStoreGetFn = () => ChatStoreState;

export const NO_RESPONSE_RECEIVED_ERROR = 'No response received from the model. The provider may be unavailable or the API key may have insufficient quota. Please check your provider settings.';

interface BuildOptimisticUserMessageInput {
  text: string;
  nowMs: number;
  attachments?: ChatSendAttachment[];
}

export function buildOptimisticUserMessage(input: BuildOptimisticUserMessageInput): RawMessage {
  return {
    role: 'user',
    content: input.text || (input.attachments?.length ? '(file attached)' : ''),
    timestamp: input.nowMs / 1000,
    id: crypto.randomUUID(),
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
  message: RawMessage;
  nowMs: number;
}

export function applyStoreSendStart(params: ApplyStoreSendStartParams): void {
  const { set, sessionKey, message, nowMs } = params;
  set((state) => {
    const nextMessages = [...state.messages, message];
    const nextSessionLabel = sessionKey.endsWith(':main')
      ? ''
      : resolveSessionLabelFromMessages(nextMessages);
    const patch: Partial<ChatStoreState> = {
      messages: nextMessages,
      ...reduceRuntimeOverlay(state, {
        type: 'send_submitted',
        nowMs,
      }),
      sessionLastActivity: { ...state.sessionLastActivity, [sessionKey]: nowMs },
    };
    if (nextSessionLabel && !state.sessionLabels[sessionKey]) {
      patch.sessionLabels = { ...state.sessionLabels, [sessionKey]: nextSessionLabel };
    }
    return patch;
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
    if (!state.sending) {
      clearHistoryPoll();
      return;
    }
    if (state.streamingMessage) {
      setHistoryPollTimer(setTimeout(pollHistory, POLL_INTERVAL));
      return;
    }
    void state.loadHistory(true);
    void state.syncPendingApprovals(state.currentSessionKey);
    setHistoryPollTimer(setTimeout(pollHistory, POLL_INTERVAL));
  };
  setHistoryPollTimer(setTimeout(pollHistory, POLL_START_DELAY));

  const SAFETY_TIMEOUT_MS = 90_000;
  const SAFETY_RETRY_INTERVAL_MS = 10_000;
  const SAFETY_INITIAL_CHECK_DELAY_MS = 30_000;
  const checkStuck = () => {
    const state = get();
    if (!state.sending) return;
    if (state.streamingMessage || state.streamingText) return;
    if (state.pendingFinal) {
      setTimeout(checkStuck, SAFETY_RETRY_INTERVAL_MS);
      return;
    }
    if (Date.now() - getLastChatEventAt() < SAFETY_TIMEOUT_MS) {
      setTimeout(checkStuck, SAFETY_RETRY_INTERVAL_MS);
      return;
    }
    clearHistoryPoll();
    onSafetyTimeout();
    set((state) => reduceRuntimeOverlay(state, {
      type: 'send_failed',
      error: NO_RESPONSE_RECEIVED_ERROR,
      clearRun: true,
    }));
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
  return (
    pendingApprovals.length > 0
    || state.approvalStatus === 'awaiting_approval'
    || state.activeRunId != null
  );
}

export function commitStoreSendWaitingApproval(set: ChatStoreSetFn): void {
  set((state) => reduceRuntimeOverlay(state, { type: 'send_waiting_approval' }));
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
  set((state) => reduceRuntimeOverlay(state, { type: 'send_failed', error }));
}

interface CommitStoreRunIdBoundParams {
  set: ChatStoreSetFn;
  runId: string;
}

export function commitStoreRunIdBound(params: CommitStoreRunIdBoundParams): void {
  const { set, runId } = params;
  set((state) => reduceRuntimeOverlay(state, { type: 'send_run_bound', runId }));
}

