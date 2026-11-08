import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionRenderItem, SessionRenderUserMessageItem } from '@/types/session/render-item';
import type { SessionInputReceipt, SessionWireItem } from '@/types/session/snapshot';
import * as openclaw from '@/plugins/chat/store/openclaw-session';
import * as matcha from '@/plugins/chat/store/matcha-session';
import { reconcileSessionItems } from '@/plugins/chat/store/session-item-reconciliation';
import type { ChatSendAttachment, ChatSessionAbortState, ChatSessionPending, ChatSessionRecord, ChatSessionRuntimeState, ChatSessionSendAdmission, ChatSessionSendState } from '@/plugins/chat/store/types';

export type SessionMessageState = Pick<ChatSessionRecord, 'items' | 'runtime'> & {
  abort: ChatSessionAbortState | null;
};

export interface SessionMessageProjection {
  identityKey: string;
  runtime: ChatSessionRuntimeState | null;
  terminalRunIds: readonly string[];
  terminatedRunIds: readonly string[];
  retiredItemIds: ReadonlySet<string>;
  send: ChatSessionSendState | null;
}

export interface SessionTextModel {
  user(text: string): string;
  assistant(text: string): string;
}

export interface SessionMessageModel {
  text: SessionTextModel;
  reconcileItems(current: SessionRenderItem[], next: SessionRenderItem[], receipts?: readonly SessionInputReceipt[], sourceItems?: readonly SessionWireItem[]): SessionRenderItem[];
  inputIds(record: ChatSessionRecord): string[];
  startSend(record: ChatSessionRecord, send: ChatSessionSendState, sessionKey: string): SessionMessageState;
  confirmSend(record: ChatSessionRecord, send: ChatSessionSendState, runId: string, admission: ChatSessionSendAdmission, retainReceipt: boolean, nextSend: ChatSessionSendState | null): SessionMessageState;
  removeSend(record: ChatSessionRecord, clientId: string): SessionMessageState;
  prepareProjectionItems(record: ChatSessionRecord, items: SessionRenderItem[], terminatedRunIds: readonly string[]): SessionRenderItem[];
  projectMessages(record: ChatSessionRecord, items: SessionRenderItem[], projection: SessionMessageProjection): SessionMessageState;
  startAbort(record: ChatSessionRecord, abort: ChatSessionAbortState): ChatSessionRuntimeState;
  failAbort(record: ChatSessionRecord, abort: ChatSessionAbortState, runtimeAtClick: ChatSessionRuntimeState): ChatSessionRuntimeState | null;
  hasPendingSend(record: ChatSessionRecord): boolean;
  messageReplacementIndex(items: SessionWireItem[], incoming: SessionWireItem): number;
  deriveRuntime(record: ChatSessionRecord): ChatSessionRuntimeState;
  resolveAbortRunId(record: ChatSessionRecord): string | undefined;
  terminalRunIds(exactRunIds: readonly string[], observedRunIds: readonly string[]): readonly string[];
  settleReceipts(record: ChatSessionRecord): ChatSessionRecord;
  createPending(record: ChatSessionRecord, sessionKey: string): ChatSessionPending | null;
}

const openclawMessages: SessionMessageModel = openclaw;
const matchaMessages: SessionMessageModel = matcha;

function sessionModel(identity: SessionIdentity): SessionMessageModel {
  if (identity.endpoint.kind === 'native-runtime') {
    switch (identity.endpoint.runtimeAdapterId) {
      case 'openclaw': return openclawMessages;
      case 'matcha-agent': return matchaMessages;
    }
  }
  throw new Error('Unsupported session message model');
}

const unformattedText: SessionTextModel = {
  user: (text) => text,
  assistant: (text) => text,
};

export function getSessionTextModel(identity?: SessionIdentity): SessionTextModel {
  return identity ? sessionModel(identity).text : unformattedText;
}

function messageModel(record: ChatSessionRecord): SessionMessageModel {
  if (!record.meta.sessionIdentity) throw new Error('Session identity is unavailable');
  return sessionModel(record.meta.sessionIdentity);
}

export function reconcileSessionMessageItems(identity: SessionIdentity | undefined, current: SessionRenderItem[], next: SessionRenderItem[], receipts?: readonly SessionInputReceipt[], sourceItems?: readonly SessionWireItem[]): SessionRenderItem[] {
  return identity ? sessionModel(identity).reconcileItems(current, next, receipts, sourceItems) : reconcileSessionItems(current, next);
}

export function getSessionInputIds(record: ChatSessionRecord | undefined): string[] {
  return record?.meta.sessionIdentity ? messageModel(record).inputIds(record) : [];
}

export function buildPendingUserMessageItem(input: {
  clientId: string;
  sessionKey: string;
  text: string;
  createdAt: number;
  attachments: readonly ChatSendAttachment[];
}): SessionRenderUserMessageItem {
  return {
    key: `renderer-user:${input.clientId}`,
    kind: 'user-message',
    role: 'user',
    sessionKey: input.sessionKey,
    text: input.text,
    clientId: input.clientId,
    status: 'pending',
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    images: [],
    attachedFiles: input.attachments
      .filter((attachment) => !attachment.mimeType.startsWith('image/') || attachment.sourcePath || attachment.preview)
      .map((attachment) => ({
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        fileSize: attachment.fileSize,
        preview: !attachment.sourcePath && attachment.mimeType.startsWith('image/') ? attachment.preview : null,
        ...(attachment.sourcePath ? { filePath: attachment.sourcePath, source: 'user-upload' as const } : {}),
      })),
  };
}

export function startSessionSend(record: ChatSessionRecord, send: ChatSessionSendState, sessionKey: string): SessionMessageState {
  return messageModel(record).startSend(record, send, sessionKey);
}

export function confirmSessionSend(record: ChatSessionRecord, send: ChatSessionSendState, runId: string, admission: ChatSessionSendAdmission, retainReceipt: boolean, nextSend: ChatSessionSendState | null): SessionMessageState {
  return messageModel(record).confirmSend(record, send, runId, admission, retainReceipt, nextSend);
}

export function removeSessionSend(record: ChatSessionRecord, clientId: string): SessionMessageState {
  return messageModel(record).removeSend(record, clientId);
}

export function prepareSessionProjectionItems(record: ChatSessionRecord, items: SessionRenderItem[], terminatedRunIds: readonly string[]): SessionRenderItem[] {
  return messageModel(record).prepareProjectionItems(record, items, terminatedRunIds);
}

export function projectSessionMessages(record: ChatSessionRecord, items: SessionRenderItem[], projection: SessionMessageProjection): SessionMessageState {
  return messageModel(record).projectMessages(record, items, projection);
}

export function startSessionAbort(record: ChatSessionRecord, abort: ChatSessionAbortState): ChatSessionRuntimeState {
  return messageModel(record).startAbort(record, abort);
}

export function failSessionAbort(record: ChatSessionRecord, abort: ChatSessionAbortState, runtimeAtClick: ChatSessionRuntimeState): ChatSessionRuntimeState | null {
  return messageModel(record).failAbort(record, abort, runtimeAtClick);
}

export function hasPendingSessionSend(record: ChatSessionRecord): boolean {
  return record.meta.sessionIdentity ? messageModel(record).hasPendingSend(record) : false;
}

export function getSessionMessageReplacementIndex(identity: SessionIdentity, items: SessionWireItem[], incoming: SessionWireItem): number {
  return sessionModel(identity).messageReplacementIndex(items, incoming);
}

const displayRuntimeByRecord = new WeakMap<ChatSessionRecord, ChatSessionRuntimeState>();
const displayRecordByRecord = new WeakMap<ChatSessionRecord, ChatSessionRecord>();

export function deriveSessionRuntime(record: ChatSessionRecord): ChatSessionRuntimeState {
  const cached = displayRuntimeByRecord.get(record);
  if (cached) return cached;
  const runtime = record.meta.sessionIdentity ? messageModel(record).deriveRuntime(record) : record.runtime;
  displayRuntimeByRecord.set(record, runtime);
  return runtime;
}

export function deriveSessionRecord(record: ChatSessionRecord): ChatSessionRecord {
  const runtime = deriveSessionRuntime(record);
  if (runtime === record.runtime) return record;
  let display = displayRecordByRecord.get(record);
  if (!display) {
    display = { ...record, runtime };
    displayRecordByRecord.set(record, display);
  }
  return display;
}

export function sessionTerminalRunIds(record: ChatSessionRecord, exactRunIds: readonly string[], observedRunIds: readonly string[]): readonly string[] {
  return record.meta.sessionIdentity ? messageModel(record).terminalRunIds(exactRunIds, observedRunIds) : exactRunIds;
}

export function settleSessionReceipts(record: ChatSessionRecord): ChatSessionRecord {
  return record.meta.sessionIdentity ? messageModel(record).settleReceipts(record) : record;
}

export function resolveSessionAbortRunId(record: ChatSessionRecord): string | undefined {
  return record.meta.sessionIdentity ? messageModel(record).resolveAbortRunId(record) : undefined;
}

export function createSessionPending(record: ChatSessionRecord, sessionKey: string): ChatSessionPending | null {
  return record.meta.sessionIdentity ? messageModel(record).createPending(record, sessionKey) : null;
}
