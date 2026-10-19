import { buildSessionIdentityKey } from '../../types/desktop/runtime-address';
import { currentSessionSend, isSendPending } from './send-state';
import type { SessionMessageModel, SessionTextModel } from './session-presentation';
import { isRunActive, type ChatSessionRecord, type ChatSessionRuntimeState } from './types';

export const text: SessionTextModel = {
  user: (text) => text,
  assistant: (text) => text,
};

export const startSend: SessionMessageModel['startSend'] = (record) => ({ items: record.items, runtime: record.runtime, abort: null });

export const confirmSend: SessionMessageModel['confirmSend'] = (record, send, runId, admission, retainReceipt, nextSend) => ({
  items: record.items.map((item) => item.kind === 'user-message' && item.clientId === send.clientId ? {
    ...item,
    key: retainReceipt ? `renderer-receipt:${runId}` : item.key,
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
