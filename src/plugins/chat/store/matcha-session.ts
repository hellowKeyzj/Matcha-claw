import { buildSessionIdentityKey } from '@/types/desktop/runtime-address';
import { currentSessionSend, isSendPending } from '@/plugins/chat/store/send-state';
import { bindSessionInputReceipts, isPendingUserItem, reconcileSessionItems } from '@/plugins/chat/store/session-item-reconciliation';
import type { SessionRenderUserMessageItem } from '@/types/session/render-item';
import type { SessionMessageModel, SessionTextModel } from '@/plugins/chat/store/session-presentation';
import { isRunActive, type ChatSessionRecord, type ChatSessionRuntimeState } from '@/plugins/chat/store/types';

export const text: SessionTextModel = {
  user: (text) => text,
  assistant: (text) => text,
};

export const reconcileItems: SessionMessageModel['reconcileItems'] = (current, next, receipts, sourceItems) => {
  const bound = bindSessionInputReceipts(current, next, receipts, sourceItems);
  if (bound === current && current === next) return current;
  const attachmentReceipts = new Map<string, SessionRenderUserMessageItem>();
  for (const item of bound) {
    if (item.kind === 'user-message' && item.messageId
      && (item.rendererReceiptRunId || item.clientId && item.attachedFiles.length > 0)) {
      attachmentReceipts.set(item.messageId, item);
    }
  }
  const canonical = next.filter((item) => !isPendingUserItem(item)).map((item) => {
    if (item.kind !== 'user-message' || !item.messageId) return item;
    const receipt = attachmentReceipts.get(item.messageId);
    if (!receipt) return item;
    // Native history omits media; only this exact message may inherit its local attachment receipt.
    const attachments = receipt.attachedFiles.filter((file) => !file.attachmentStatus);
    const retainAttachments = attachments.length > 0 && item.images.length === 0
      && !item.attachedFiles.some((file) => !file.attachmentStatus);
    return {
      ...item,
      clientId: receipt.clientId,
      rendererReceiptRunId: receipt.rendererReceiptRunId,
      ...(retainAttachments ? {
        attachedFiles: [...attachments, ...item.attachedFiles.filter((file) => file.attachmentStatus !== 'unsafe-media-omitted')],
      } : {}),
    };
  });
  return reconcileSessionItems(bound, canonical, null);
};

export { pendingSessionInputIds as inputIds } from '@/plugins/chat/store/session-item-reconciliation';

export const startSend: SessionMessageModel['startSend'] = (record) => ({ items: record.items, runtime: record.runtime, abort: null });

export const confirmSend: SessionMessageModel['confirmSend'] = (record, send, runId, admission, retainReceipt, nextSend) => ({
  items: record.items.map((item) => item.kind === 'user-message' && item.clientId === send.clientId ? {
    ...item,
    key: retainReceipt && isPendingUserItem(item) ? `renderer-receipt:${runId}` : item.key,
    runId,
    ...(retainReceipt ? { rendererReceiptRunId: runId } : {}),
  } : item),
  runtime: record.runtime,
  abort: (admission === 'queued' || admission === 'started') && nextSend === null
    && record.abort?.sendGeneration === send.generation ? null : record.abort ?? null,
});

export const removeSend: SessionMessageModel['removeSend'] = (record, clientId) => ({
  items: record.items.filter((item) => item.kind !== 'user-message' || item.clientId !== clientId),
  runtime: record.runtime,
  abort: record.abort ?? null,
});

export const prepareProjectionItems: SessionMessageModel['prepareProjectionItems'] = (_record, items) => items;

export const projectMessages: SessionMessageModel['projectMessages'] = (record, items, projection) => {
  const abort = record.abort ?? null;
  const send = currentSessionSend(record);
  return {
    items,
    runtime: projection.runtime ?? record.runtime,
    abort: abort?.identityKey === projection.identityKey
      && (abort.runId !== null && (projection.terminalRunIds.includes(abort.runId)
          || projection.runtime?.activeRunId != null && projection.runtime.activeRunId !== abort.runId)
        || send !== null && projection.send === null && abort.sendGeneration === send.generation) ? null : abort,
  };
};

export const startAbort: SessionMessageModel['startAbort'] = (record) => record.runtime;

export const failAbort: SessionMessageModel['failAbort'] = (record) => record.runtime;

export const hasPendingSend: SessionMessageModel['hasPendingSend'] = (record) => isSendPending(currentSessionSend(record));

export const messageReplacementIndex: SessionMessageModel['messageReplacementIndex'] = (items, incoming) => (
  items.findIndex((item) => item.itemId === incoming.itemId)
);

export function deriveRuntime(record: ChatSessionRecord): ChatSessionRuntimeState {
  const abort = record.abort && record.meta.sessionIdentity
    && record.abort.identityKey === buildSessionIdentityKey(record.meta.sessionIdentity) ? record.abort : null;
  return !abort ? record.runtime : {
    ...record.runtime,
    ...(abort.phase === 'stopping' ? { runPhase: 'stopping' as const, updatedAt: abort.startedAt } : {}),
    ...(abort.issue ? { lastError: abort.issue.message, lastIssue: abort.issue, updatedAt: abort.issue.at } : {}),
  };
}

export const resolveAbortRunId: SessionMessageModel['resolveAbortRunId'] = (record) => record.runtime.activeRunId ?? undefined;

export const terminalRunIds: SessionMessageModel['terminalRunIds'] = (exactRunIds) => exactRunIds;

export const createPending: SessionMessageModel['createPending'] = (record) => {
  if (!record.window.isAtLatest) return null;
  const send = currentSessionSend(record);
  const awaitingOutput = send?.receipt.phase === 'awaiting-receipt' || send?.receipt.phase === 'accepted';
  const active = isRunActive(record.runtime);
  if (!awaitingOutput && !active) return null;
  // This is session-tail presentation, never evidence of a message's run ownership.
  for (let index = record.items.length - 1; index >= 0; index -= 1) {
    const item = record.items[index];
    if (item.kind === 'assistant-turn') return null;
    if (item.kind === 'user-message') break;
  }
  const mode = record.runtime.runtimeActivity === 'compacting' ? 'compacting'
    : record.runtime.runPhase === 'waiting_tool' ? 'activity' : 'typing';
  return { kind: 'activity', mode };
};
