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
  applySessionDelta,
  applySessionView,
  getSessionMeta,
  getSessionRuntime,
  patchSessionMeta,
  hasTimeoutSignal,
  isRecoverableChatSendTimeout,
  getSessionItems,
  patchSessionRecord,
} from './store-state-helpers';
import { resolveSessionOperationTarget } from './session-identity';
import {
  createSessionTraceId,
  logSessionTrace,
  summarizeIdentifier,
  summarizeSessionIdentity,
} from '@/lib/session-trace';
import type { ChatSendAttachment, ChatSendResult, ChatStoreState } from './types';
import { isRunActive, isWaitingTool } from './types';
import type {
  SessionAssistantTurnItem,
  SessionRenderUserMessageItem,
} from '../../types/session/render-item';

export type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

export type ChatStoreGetFn = () => ChatStoreState;

export const NO_RESPONSE_RECEIVED_ERROR = 'No response received from the model. The provider may be unavailable or the API key may have insufficient quota. Please check your provider settings.';

function hasAssistantProgress(items: ReturnType<typeof getSessionItems>): boolean {
  return items.some((item) => item.kind === 'assistant-turn' && (
    item.segments.length > 0
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

function attachmentReselectionRequired(attachments: ChatSendAttachment[] | undefined): true | undefined {
  return attachments && attachments.length > 0 ? true : undefined;
}

function cachedAttachmentReceiptFiles(attachments: ChatSendAttachment[]) {
  return attachments
    .filter((attachment) => !attachment.mimeType.startsWith('image/'))
    .map((attachment) => ({
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
      preview: null,
    }));
}

function cachedAttachmentReceiptImages(attachments: ChatSendAttachment[]) {
  return attachments
    .filter((attachment) => attachment.mimeType.startsWith('image/') && attachment.preview?.startsWith('blob:'))
    .map((attachment) => ({
      url: attachment.preview!,
      mimeType: attachment.mimeType,
    }));
}

function appendOptimisticSendItems(params: {
  set: ChatStoreSetFn;
  sessionKey: string;
  clientId: string;
  text: string;
  attachments: ChatSendAttachment[] | undefined;
  createdAt: number;
}): void {
  const { set, sessionKey, clientId, text, attachments, createdAt } = params;
  set((state) => {
    const current = state.loadedSessions[sessionKey];
    if (!current) return state;
    const userItem: SessionRenderUserMessageItem = {
      key: `renderer-user:${clientId}`,
      kind: 'user-message',
      role: 'user',
      sessionKey,
      text,
      clientId,
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
      images: cachedAttachmentReceiptImages(attachments ?? []),
      attachedFiles: cachedAttachmentReceiptFiles(attachments ?? []),
    };
    const assistantItem: SessionAssistantTurnItem = {
      key: `renderer-assistant:${clientId}`,
      kind: 'assistant-turn',
      role: 'assistant',
      sessionKey,
      identitySource: 'client',
      identityMode: 'client',
      identityConfidence: 'strong',
      status: 'streaming',
      segments: [],
      thinking: null,
      tools: [],
      text: '',
      images: [],
      attachedFiles: [],
      pendingState: 'typing',
      createdAt,
      updatedAt: createdAt,
    };
    return {
      loadedSessions: patchSessionRecord(state, sessionKey, {
        items: [...current.items, userItem, assistantItem],
      }),
    };
  });
}

function confirmOptimisticSendItems(params: {
  set: ChatStoreSetFn;
  sessionKey: string;
  clientId: string;
  runId: string;
  retainReceipt: boolean;
}): void {
  const { set, sessionKey, clientId, runId, retainReceipt } = params;
  const clientAssistantKey = `renderer-assistant:${clientId}`;
  const runAssistantKey = `renderer-assistant:${runId}`;
  set((state) => {
    const current = state.loadedSessions[sessionKey];
    if (!current) return state;
    let changed = false;
    let lastUserMessageAt = current.runtime.lastUserMessageAt;
    const hasRunAssistant = current.items.some((item) => (
      item.kind === 'assistant-turn'
      && item.runId === runId
      && item.key !== clientAssistantKey
    ));
    const items = current.items.filter((item) => {
      if (hasRunAssistant && item.kind === 'assistant-turn' && item.key === clientAssistantKey) {
        changed = true;
        return false;
      }
      return true;
    }).map((item) => {
      if (item.kind === 'user-message' && item.clientId === clientId) {
        changed = true;
        lastUserMessageAt = item.createdAt ?? lastUserMessageAt;
        return {
          ...item,
          key: retainReceipt ? `renderer-receipt:${runId}` : item.key,
          runId,
          ...(retainReceipt ? { rendererReceiptRunId: runId } : {}),
        };
      }
      if (item.kind === 'assistant-turn' && item.key === clientAssistantKey) {
        changed = true;
        return {
          ...item,
          key: runAssistantKey,
          runId,
          identitySource: 'run' as const,
          identityMode: 'run' as const,
        };
      }
      return item;
    });
    return changed ? {
      loadedSessions: patchSessionRecord(state, sessionKey, {
        items,
        runtime: {
          ...current.runtime,
          activeRunId: runId,
          runPhase: 'submitted',
          activeTurnItemKey: null,
          pendingTurnKey: runAssistantKey,
          pendingTurnLaneKey: 'main',
          lastUserMessageAt,
          lastError: null,
          lastIssue: null,
          updatedAt: Date.now(),
        },
      }),
    } : state;
  });
}

function removeOptimisticAssistantPlaceholder(params: {
  set: ChatStoreSetFn;
  sessionKey: string;
  clientId: string;
}): void {
  const { set, sessionKey, clientId } = params;
  set((state) => {
    const current = state.loadedSessions[sessionKey];
    if (!current) return state;
    const key = `renderer-assistant:${clientId}`;
    const items = current.items.filter((item) => !(item.kind === 'assistant-turn' && item.key === key));
    return items.length === current.items.length ? state : {
      loadedSessions: patchSessionRecord(state, sessionKey, { items }),
    };
  });
}

function removeOptimisticSendItems(params: {
  set: ChatStoreSetFn;
  sessionKey: string;
  clientId: string;
}): void {
  const { set, sessionKey, clientId } = params;
  set((state) => {
    const current = state.loadedSessions[sessionKey];
    if (!current) return state;
    const items = current.items.filter((item) => !(
      (item.kind === 'user-message' && item.clientId === clientId)
      || (item.kind === 'assistant-turn' && item.key === `renderer-assistant:${clientId}`)
    ));
    return items.length === current.items.length ? state : {
      loadedSessions: patchSessionRecord(state, sessionKey, { items }),
    };
  });
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
  const traceId = createSessionTraceId('send-boundary');
  if (!trimmed && (!attachments || attachments.length === 0)) {
    logSessionTrace('send.rejected', traceId, { reason: 'empty' });
    return { accepted: false, reason: 'empty' };
  }

  const stateBeforeSend = get();
  logSessionTrace('send.start', traceId, {
    currentSessionKey: summarizeIdentifier(stateBeforeSend.currentSessionKey),
    mutating: stateBeforeSend.mutating,
    messageLength: trimmed.length,
    attachmentCount: attachments?.length ?? 0,
  });
  if (stateBeforeSend.mutating === true) {
    logSessionTrace('send.rejected', traceId, { reason: 'mutating' });
    return { accepted: false, reason: 'mutating' };
  }
  const { currentSessionKey } = stateBeforeSend;
  const runtimeBeforeSend = getSessionRuntime(stateBeforeSend, currentSessionKey);
  let target;
  try {
    target = resolveSessionOperationTarget(stateBeforeSend, currentSessionKey);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const targetErrorReason = errorMessage.startsWith('SessionIdentity is required:')
      ? 'missing-session-identity'
      : 'unexpected';
    logSessionTrace('send.target.error', traceId, { reason: targetErrorReason });
    set({ error: errorMessage });
    return { accepted: false, reason: 'missing-session', error: errorMessage };
  }
  logSessionTrace('send.target.resolved', traceId, {
    sessionKey: summarizeIdentifier(target.sessionKey),
    endpointSessionId: summarizeIdentifier(target.endpointSessionId),
    sessionIdentity: summarizeSessionIdentity(target.sessionIdentity),
    runPhase: runtimeBeforeSend.runPhase,
    activeRunId: summarizeIdentifier(runtimeBeforeSend.activeRunId),
  });
  if (isRunActive(runtimeBeforeSend)) {
    const reason = runtimeBeforeSend.runPhase === 'stopping' ? 'stopping' : 'active';
    logSessionTrace('send.rejected', traceId, { reason, runPhase: runtimeBeforeSend.runPhase });
    return { accepted: false, reason };
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
  appendOptimisticSendItems({
    set,
    sessionKey: currentSessionKey,
    clientId: clientMessageId,
    text: trimmed,
    attachments,
    createdAt: nowMs,
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
      endpointSessionId: target.endpointSessionId,
      sessionIdentity: target.sessionIdentity,
      message: trimmed,
      idempotencyKey: clientMessageId,
      attachments,
      timeoutMs: CHAT_SEND_RPC_TIMEOUT_MS,
      traceId,
    });

    if (sendGeneration !== sessionRunCache.getSendGeneration(currentSessionKey)) {
      removeOptimisticSendItems({
        set,
        sessionKey: currentSessionKey,
        clientId: clientMessageId,
      });
      return { accepted: true };
    }

    if (!sendResult.ok) {
      const errorMsg = sendResult.error;
      logSessionTrace('send.result.error', traceId, {
        category: isRecoverableChatSendTimeout(errorMsg) ? 'recoverable-timeout' : 'transport-error',
        attachmentReselectionRequired: Boolean(attachmentReselectionRequired(attachments)),
      });
      if (isRecoverableChatSendTimeout(errorMsg)) {
        if (attachmentReselectionRequired(attachments)) {
          removeOptimisticSendItems({
            set,
            sessionKey: currentSessionKey,
            clientId: clientMessageId,
          });
          finalizeStoreSendFailure({
            set,
            error: errorMsg,
          });
          return {
            accepted: false,
            reason: 'error',
            error: errorMsg,
            attachmentReselectionRequired: true,
          };
        }
        removeOptimisticAssistantPlaceholder({
          set,
          sessionKey: currentSessionKey,
          clientId: clientMessageId,
        });
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
        removeOptimisticAssistantPlaceholder({
          set,
          sessionKey: currentSessionKey,
          clientId: clientMessageId,
        });
        return { accepted: true };
      }
      removeOptimisticSendItems({
        set,
        sessionKey: currentSessionKey,
        clientId: clientMessageId,
      });
      finalizeStoreSendFailure({
        set,
        error: errorMsg,
      });
      return {
        accepted: false,
        reason: 'error',
        error: errorMsg,
        attachmentReselectionRequired: attachmentReselectionRequired(attachments),
      };
    }

    logSessionTrace('send.result.accepted', traceId, {
      runId: summarizeIdentifier(sendResult.runId),
      hasProjection: Boolean(sendResult.projection),
    });
    confirmOptimisticSendItems({
      set,
      sessionKey: currentSessionKey,
      clientId: clientMessageId,
      runId: sendResult.runId,
      retainReceipt: (attachments?.length ?? 0) > 0,
    });
    if (sendResult.projection) {
      if (sendResult.projection.kind === 'view') {
        applySessionView({ set, get }, sendResult.projection.view);
      } else {
        applySessionDelta({ set, get }, sendResult.projection.delta);
      }
    }
    return { accepted: true };
  } catch (error) {
    if (sendGeneration !== sessionRunCache.getSendGeneration(currentSessionKey)) {
      removeOptimisticSendItems({
        set,
        sessionKey: currentSessionKey,
        clientId: clientMessageId,
      });
      return { accepted: true };
    }
    const errorMsg = String(error);
    logSessionTrace('send.exception', traceId, {
      errorName: error instanceof Error ? error.name : typeof error,
      timeoutSignal: hasTimeoutSignal(error),
    });
    if (isRecoverableChatSendTimeout(errorMsg)) {
      if (attachmentReselectionRequired(attachments)) {
        removeOptimisticSendItems({
          set,
          sessionKey: currentSessionKey,
          clientId: clientMessageId,
        });
        finalizeStoreSendFailure({
          set,
          error: errorMsg,
        });
        return {
          accepted: false,
          reason: 'error',
          error: errorMsg,
          attachmentReselectionRequired: true,
        };
      }
      removeOptimisticAssistantPlaceholder({
        set,
        sessionKey: currentSessionKey,
        clientId: clientMessageId,
      });
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
      removeOptimisticAssistantPlaceholder({
        set,
        sessionKey: currentSessionKey,
        clientId: clientMessageId,
      });
      return { accepted: true };
    }
    removeOptimisticSendItems({
      set,
      sessionKey: currentSessionKey,
      clientId: clientMessageId,
    });
    finalizeStoreSendFailure({
      set,
      error: errorMsg,
    });
    return {
      accepted: false,
      reason: 'error',
      error: errorMsg,
      attachmentReselectionRequired: attachmentReselectionRequired(attachments),
    };
  } finally {
    finishMutating();
  }
}
