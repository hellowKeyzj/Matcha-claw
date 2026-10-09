import { hostSessionPrompt } from '@/lib/host-api';
import type { SessionGoalOutcome, SessionSendIntent } from '@/types/session-goal';
import {
  logSessionTrace,
  summarizeIdentifier,
  summarizeSessionIdentity,
} from '@/lib/session-trace';
import type {
  SessionIdentity,
} from '../../types/desktop/runtime-address';
import { decodeSessionProjectionEvent, type SessionProjectionEvent } from '../../types/session/update-event';
import { CHAT_INLINE_ATTACHMENT_MAX_BYTES, type ChatSendAttachment } from './types';

export const CHAT_SEND_RPC_TIMEOUT_MS = 120_000;
const CHAT_SEND_WITH_MEDIA_FALLBACK_PROMPT = 'Process the attached file(s).';
const CHAT_SEND_DEFAULT_ERROR = 'Failed to send message';

function isDirectoryAttachment(attachment: Pick<ChatSendAttachment, 'entryKind' | 'mimeType'>): boolean {
  return attachment.entryKind === 'directory' || attachment.mimeType === 'application/x-directory';
}

function localPathAttachments(attachments: readonly ChatSendAttachment[]): ChatSendAttachment[] {
  return attachments.filter((attachment) => !isDirectoryAttachment(attachment)
    && attachment.fileSize > CHAT_INLINE_ATTACHMENT_MAX_BYTES
    && Boolean(attachment.sourcePath));
}

function inlineAttachments(attachments: readonly ChatSendAttachment[]): ChatSendAttachment[] {
  return attachments.filter((attachment) => !isDirectoryAttachment(attachment)
    && attachment.fileSize <= CHAT_INLINE_ATTACHMENT_MAX_BYTES
    && Boolean(attachment.stagedAttachmentId));
}

function appendLocalPathAttachmentPrompt(message: string, attachments: readonly ChatSendAttachment[]): string {
  const pathAttachments = localPathAttachments(attachments);
  if (pathAttachments.length === 0) {
    return message;
  }
  const pathBlock = ['Read files:', ...pathAttachments.map((attachment) => `- ${attachment.sourcePath}`)].join('\n');
  return message.trim() ? `${message}\n\n${pathBlock}` : pathBlock;
}

export function resolveChatSendTransportPayload(
  message: string,
  attachments: readonly ChatSendAttachment[],
): { message: string; attachments: ChatSendAttachment[] } {
  const attachmentsToInline = inlineAttachments(attachments);
  return {
    message: appendLocalPathAttachmentPrompt(
      message || (attachmentsToInline.length > 0 ? CHAT_SEND_WITH_MEDIA_FALLBACK_PROMPT : ''),
      attachments,
    ),
    attachments: attachmentsToInline,
  };
}

export interface SendChatTransportParams {
  endpointSessionId?: string;
  sessionIdentity: SessionIdentity;
  message: string;
  intent?: SessionSendIntent;
  idempotencyKey: string;
  attachments?: ChatSendAttachment[];
  timeoutMs?: number;
  traceId?: string | null;
}

export type SendChatTransportResult =
  | ({ ok: true; runId: string; replayed?: true; projection: SessionProjectionEvent | null } & (
    | { outcome: 'queued' }
    | { outcome: 'succeeded'; status: 'started' | 'in_flight' | 'ok' }
  ))
  | { ok: false; error: string; outcome?: Exclude<SessionGoalOutcome['outcome'], 'succeeded'> };

export async function sendChatTransport(
  params: SendChatTransportParams,
): Promise<SendChatTransportResult> {
  const attachments = params.attachments ?? [];
  const payloadInput = resolveChatSendTransportPayload(params.message, attachments);
  const message = payloadInput.message;
  const attachmentsToInline = payloadInput.attachments;
  logSessionTrace('send.transport.request', params.traceId, {
    sessionKey: summarizeIdentifier(params.sessionIdentity.sessionKey),
    endpointSessionId: summarizeIdentifier(params.endpointSessionId),
    sessionIdentity: summarizeSessionIdentity(params.sessionIdentity),
    idempotencyKey: summarizeIdentifier(params.idempotencyKey),
    messageLength: message.length,
    attachmentCount: attachmentsToInline.length,
    attachmentBytes: attachmentsToInline.reduce((sum, attachment) => sum + attachment.fileSize, 0),
    timeoutMs: params.timeoutMs ?? null,
  });
  const payload = {
    ...(params.endpointSessionId ? { endpointSessionId: params.endpointSessionId } : {}),
    sessionIdentity: params.sessionIdentity,
    message,
    ...(params.intent ? { intent: params.intent } : {}),
    idempotencyKey: params.idempotencyKey,
    deliver: false,
    ...(attachmentsToInline.length > 0
      ? {
          attachments: attachmentsToInline.map((attachment) => ({
            stagedAttachmentId: attachment.stagedAttachmentId,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            fileSize: attachment.fileSize,
          })),
        }
      : {}),
  };
  const response = params.traceId === undefined
    ? await hostSessionPrompt(payload)
    : await hostSessionPrompt(payload, { traceId: params.traceId });
  logSessionTrace('send.transport.response', params.traceId, {
    success: response.success ?? null,
    outcome: response.outcome ?? null,
    status: response.status ?? null,
    runId: summarizeIdentifier(response.runId),
    errorPresent: typeof response.error === 'string' && response.error.trim().length > 0,
  });
  const normalizedRunId = typeof response.runId === 'string'
    ? response.runId.trim()
    : '';
  const admission = response.outcome === 'queued'
    ? { outcome: 'queued' as const }
    : response.outcome === 'succeeded'
      && (response.status === 'started' || response.status === 'in_flight' || response.status === 'ok')
      ? { outcome: 'succeeded' as const, status: response.status }
      : null;
  if (!admission || !normalizedRunId || params.intent && (response.outcome !== 'succeeded' || response.status !== 'started' || !response.goal || response.goal.action !== 'start'
    || response.goal.status !== 'started' || response.goal.runId !== normalizedRunId
    || response.goal.operationId !== params.idempotencyKey
    || params.endpointSessionId && response.goal.sessionId !== params.endpointSessionId)) {
    const failureMessage = typeof response.error === 'string'
      ? response.error.trim()
      : '';
    return {
      ok: false,
      ...(response.outcome === 'target_rejected' || response.outcome === 'unavailable' || response.outcome === 'unsupported' || response.outcome === 'unknown'
        ? { outcome: response.outcome }
        : response.outcome === 'queued' || response.outcome === 'succeeded' || response.success === true ? { outcome: 'unknown' as const } : {}),
      error: failureMessage
        ? failureMessage
        : CHAT_SEND_DEFAULT_ERROR,
    };
  }
  return {
    ok: true,
    ...admission,
    runId: normalizedRunId,
    ...(params.intent && response.goal?.replayed ? { replayed: true as const } : {}),
    projection: decodeSessionProjectionEvent(response.projection ?? response.snapshot),
  };
}
