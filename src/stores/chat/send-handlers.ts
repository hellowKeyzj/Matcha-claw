import { cacheSendAttachments } from './attachment-helpers';
import { hasActiveStreamingRun } from './runtime-stream-state';
import type { StoreSessionRunCache } from './session-run-cache';
import {
  CHAT_SEND_RPC_TIMEOUT_MS,
  resolveChatSendTransportPayload,
  sendChatTransport,
} from './send-transport';
import { selectCurrentChatSendGate } from './selectors';
import { resolveChatSendGateForPayload } from './send-gate';
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
import {
  createSessionTraceId,
  logSessionTrace,
  summarizeIdentifier,
  summarizeSessionIdentity,
} from '@/lib/session-trace';
import { CHAT_INLINE_ATTACHMENT_MAX_BYTES, type ChatSendAttachment, type ChatSendResult, type ChatSessionRuntimeState, type ChatStoreState } from './types';
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

function isDirectoryAttachment(attachment: ChatSendAttachment): boolean {
  return attachment.entryKind === 'directory' || attachment.mimeType === 'application/x-directory';
}

function readableAttachments(attachments: ChatSendAttachment[] | undefined): ChatSendAttachment[] | undefined {
  const readable = attachments?.filter((attachment) => !isDirectoryAttachment(attachment)
    && (attachment.fileSize <= CHAT_INLINE_ATTACHMENT_MAX_BYTES || Boolean(attachment.sourcePath)));
  return readable && readable.length > 0 ? readable : undefined;
}

function attachmentReselectionRequired(attachments: ChatSendAttachment[] | undefined): true | undefined {
  return readableAttachments(attachments)?.some((attachment) => attachment.fileSize <= CHAT_INLINE_ATTACHMENT_MAX_BYTES) ? true : undefined;
}

function cachedAttachmentReceiptFiles(attachments: ChatSendAttachment[]) {
  return attachments
    .filter((attachment) => !attachment.mimeType.startsWith('image/') || attachment.sourcePath)
    .map((attachment) => ({
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
      preview: null,
      ...(attachment.sourcePath ? { filePath: attachment.sourcePath, source: 'user-upload' as const } : {}),
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
    const assistantItemKey = `renderer-assistant:${clientId}`;
    return {
      loadedSessions: patchSessionRecord(state, sessionKey, {
        items: [...current.items, userItem, assistantItem],
        runtime: {
          ...current.runtime,
          runPhase: 'submitted',
          pendingTurnKey: assistantItemKey,
          pendingTurnLaneKey: 'main',
          runProgress: null,
          imageGeneration: undefined,
          lastUserMessageAt: createdAt,
          lastError: null,
          lastIssue: null,
          updatedAt: createdAt,
        },
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
      if ((hasRunAssistant || !isRunActive(current.runtime)
        || (current.runtime.activeRunId !== null && current.runtime.activeRunId !== runId))
        && item.kind === 'assistant-turn' && item.key === clientAssistantKey) {
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
        // Only the still-pending client turn may acquire the receipt's run identity.
        runtime: current.runtime.activeRunId === null
          && current.runtime.pendingTurnKey === clientAssistantKey
          && isRunActive(current.runtime) ? {
            ...current.runtime,
            activeRunId: runId,
            pendingTurnKey: runAssistantKey,
            lastUserMessageAt,
            updatedAt: current.runtime.runPhase === 'stopping' || current.runtime.lastIssue ? current.runtime.updatedAt : Date.now(),
          } : current.runtime,
      }),
    } : state;
  });
}

function clearOptimisticRuntimeState(
  runtime: ChatSessionRuntimeState,
  optimisticAssistantItemKey: string,
): ChatSessionRuntimeState {
  // Send failure cannot settle a concurrent stop before its native terminal event.
  if (runtime.runPhase === 'stopping') return runtime;
  const ownsPendingTurn = runtime.pendingTurnKey === optimisticAssistantItemKey;
  const ownsActiveTurn = runtime.activeTurnItemKey === optimisticAssistantItemKey;
  const ownsSubmittedPhase = runtime.runPhase === 'submitted' && runtime.activeRunId == null;
  if (!ownsPendingTurn && !ownsActiveTurn && !ownsSubmittedPhase) {
    return runtime;
  }
  return {
    ...runtime,
    ...(ownsSubmittedPhase ? { activeRunId: null, runPhase: 'idle' as const, lastError: null, lastIssue: null } : {}),
    activeTurnItemKey: ownsActiveTurn ? null : runtime.activeTurnItemKey,
    pendingTurnKey: ownsPendingTurn ? null : runtime.pendingTurnKey,
    pendingTurnLaneKey: ownsPendingTurn ? null : runtime.pendingTurnLaneKey,
    runProgress: null,
    imageGeneration: undefined,
    updatedAt: Date.now(),
  };
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
    const runtime = clearOptimisticRuntimeState(current.runtime, key);
    return items.length === current.items.length && runtime === current.runtime ? state : {
      loadedSessions: patchSessionRecord(state, sessionKey, { items, runtime }),
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
    const assistantItemKey = `renderer-assistant:${clientId}`;
    const items = current.items.filter((item) => !(
      (item.kind === 'user-message' && item.clientId === clientId)
      || (item.kind === 'assistant-turn' && item.key === assistantItemKey)
    ));
    const runtime = clearOptimisticRuntimeState(current.runtime, assistantItemKey);
    return items.length === current.items.length && runtime === current.runtime ? state : {
      loadedSessions: patchSessionRecord(state, sessionKey, { items, runtime }),
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
  const readableSendAttachments = readableAttachments(attachments);
  const attachmentCount = readableSendAttachments?.length ?? 0;
  const transportPayload = resolveChatSendTransportPayload(trimmed, readableSendAttachments ?? []);
  const stateBeforeSend = get();
  const gate = resolveChatSendGateForPayload(selectCurrentChatSendGate(stateBeforeSend), {
    text,
    attachmentCount,
  });
  logSessionTrace('send.start', traceId, {
    currentSessionKey: summarizeIdentifier(stateBeforeSend.currentSessionKey),
    canSend: gate.canSend,
    reason: gate.canSend ? null : gate.reason,
    messageLength: trimmed.length,
    attachmentCount,
  });
  if (!gate.canSend) {
    logSessionTrace('send.rejected', traceId, {
      reason: gate.reason,
      currentSessionKey: summarizeIdentifier(stateBeforeSend.currentSessionKey),
      messageLength: trimmed.length,
      attachmentCount,
    });
    return { accepted: false, reason: gate.reason, error: gate.error };
  }
  if (gate.kind !== 'session') {
    logSessionTrace('send.rejected', traceId, {
      reason: 'missing-session',
      currentSessionKey: summarizeIdentifier(stateBeforeSend.currentSessionKey),
      gateKind: gate.kind,
    });
    return { accepted: false, reason: 'missing-session' };
  }
  const { sessionKey, endpointSessionId, sessionIdentity } = gate;
  const currentSessionKey = sessionKey;
  const runtimeBeforeSend = getSessionRuntime(stateBeforeSend, currentSessionKey);
  logSessionTrace('send.target.resolved', traceId, {
    sessionKey: summarizeIdentifier(sessionKey),
    endpointSessionId: summarizeIdentifier(endpointSessionId),
    sessionIdentity: summarizeSessionIdentity(sessionIdentity),
    runPhase: runtimeBeforeSend.runPhase,
    activeRunId: summarizeIdentifier(runtimeBeforeSend.activeRunId),
  });
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
    text: transportPayload.message,
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
    if (readableSendAttachments) {
      cacheSendAttachments(readableSendAttachments);
    }

    const sendResult = await sendChatTransport({
      endpointSessionId,
      sessionIdentity,
      message: transportPayload.message,
      idempotencyKey: clientMessageId,
      attachments: transportPayload.attachments,
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
