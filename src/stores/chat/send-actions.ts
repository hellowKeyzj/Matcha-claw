import { cacheSendAttachments } from './attachment-helpers';
import {
  applyStoreSendStart,
  buildOptimisticUserMessage,
  commitStoreRunIdBound,
  commitStoreSendWaitingApproval,
  finalizeStoreSendFailure,
  hasStoreApprovalEvidence,
  maybeEnterStoreWaitingApproval,
  startStoreSendWatchers,
} from './send-handlers';
import {
  CHAT_SEND_RPC_TIMEOUT_MS,
  sendChatTransport,
} from './send-transport';
import {
  beginChatRunTelemetry,
  bindChatRunIdTelemetry,
  finishChatRunTelemetry,
} from './telemetry';
import {
  hasTimeoutSignal,
  isRecoverableChatSendTimeout,
} from './store-state-helpers';
import type { ChatSendAttachment, ChatStoreState } from './types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface CreateStoreSendActionsInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  beginMutating: () => void;
  finishMutating: () => void;
}

type StoreSendActions = Pick<ChatStoreState, 'sendMessage'>;

export function createStoreSendActions(input: CreateStoreSendActionsInput): StoreSendActions {
  const { set, get, beginMutating, finishMutating } = input;

  return {
    sendMessage: async (text: string, attachments?: ChatSendAttachment[]) => {
      const trimmed = text.trim();
      if (!trimmed && (!attachments || attachments.length === 0)) return;

      const { currentSessionKey } = get();
      beginChatRunTelemetry(currentSessionKey, {
        hasText: Boolean(trimmed),
        attachmentCount: attachments?.length ?? 0,
      });

      // Add user message optimistically (with local file metadata for UI display)
      const nowMs = Date.now();
      const userMsg = buildOptimisticUserMessage({
        text: trimmed,
        nowMs,
        attachments,
      });
      applyStoreSendStart({
        set,
        sessionKey: currentSessionKey,
        message: userMsg,
        nowMs,
      });

      // Start the history poll and safety timeout IMMEDIATELY (before the
      // RPC await) because the gateway's chat.send RPC may block until the
      // entire agentic conversation finishes — the poll must run in parallel.
      startStoreSendWatchers({
        set,
        get,
        onSafetyTimeout: () => {
          finishChatRunTelemetry(currentSessionKey, 'failed', { stage: 'safety_timeout' });
        },
      });

      beginMutating();
      try {
        const idempotencyKey = crypto.randomUUID();
        const hasMedia = attachments && attachments.length > 0;

        // Cache image attachments BEFORE the IPC call to avoid race condition:
        // history may reload (via Gateway event) before the RPC returns.
        // Keyed by staged file path which appears in [media attached: <path> ...].
        if (hasMedia && attachments) {
          cacheSendAttachments(attachments);
        }

        const sendResult = await sendChatTransport({
          sessionKey: currentSessionKey,
          message: trimmed,
          idempotencyKey,
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
            onTelemetryFailure: () => {
              finishChatRunTelemetry(currentSessionKey, 'failed', { stage: 'send_result', error: errorMsg });
            },
          });
        } else if (sendResult.runId) {
          bindChatRunIdTelemetry(currentSessionKey, sendResult.runId);
          commitStoreRunIdBound({
            set,
            runId: sendResult.runId,
          });
        }
      } catch (err) {
        const errMsg = String(err);
        if (isRecoverableChatSendTimeout(errMsg)) {
          set({ error: errMsg });
          return;
        }
        const timeoutSignal = hasTimeoutSignal(err);
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
          error: errMsg,
          onTelemetryFailure: () => {
            finishChatRunTelemetry(currentSessionKey, 'failed', { stage: 'send_exception', error: errMsg });
          },
        });
      } finally {
        finishMutating();
      }
    },
  };
}


