import { hostSessionPrompt } from '@/lib/host-api';
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
  idempotencyKey: string;
  attachments?: ChatSendAttachment[];
  timeoutMs?: number;
  traceId?: string | null;
}

export type SendChatTransportResult =
  | { ok: true; runId: string; projection: SessionProjectionEvent | null }
  | { ok: false; error: string };

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
    routeKey: summarizeIdentifier(response.routeKey),
    errorPresent: typeof response.error === 'string' && response.error.trim().length > 0,
  });
  const normalizedRunId = typeof response.runId === 'string'
    ? response.runId.trim()
    : '';
  const accepted = normalizedRunId.length > 0 && (
    response.success === true
    || response.outcome === 'queued'
    || response.outcome === 'succeeded'
  );
  if (!accepted) {
    const failureMessage = typeof response.error === 'string'
      ? response.error.trim()
      : '';
    return {
      ok: false,
      error: failureMessage
        ? failureMessage
        : CHAT_SEND_DEFAULT_ERROR,
    };
  }
  return {
    ok: true,
    runId: normalizedRunId,
    projection: decodeSessionProjectionEvent(response.projection ?? response.snapshot),
  };
}
