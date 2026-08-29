import { hostSessionPrompt } from '@/lib/host-api';
import {
  logSessionTrace,
  summarizeIdentifier,
} from '@/lib/session-trace';
import type {
  SessionIdentity,
} from '../../../electron/desktop-contract/runtime-address';
import { decodeSessionProjectionEvent, type SessionProjectionEvent } from '../../types/session/update-event';
import type { ChatSendAttachment } from './types';

export const CHAT_SEND_RPC_TIMEOUT_MS = 120_000;
const CHAT_SEND_WITH_MEDIA_FALLBACK_PROMPT = 'Process the attached file(s).';
const CHAT_SEND_DEFAULT_ERROR = 'Failed to send message';

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
  logSessionTrace('send.transport.request', params.traceId, {
    sessionKey: summarizeIdentifier(params.sessionIdentity.sessionKey),
    endpointSessionId: summarizeIdentifier(params.endpointSessionId),
    sessionIdentity: {
      endpoint: {
        runtimeAdapterId: params.sessionIdentity.endpoint.runtimeAdapterId,
        runtimeInstanceId: params.sessionIdentity.endpoint.runtimeInstanceId,
      },
      agentId: summarizeIdentifier(params.sessionIdentity.agentId),
      sessionKey: summarizeIdentifier(params.sessionIdentity.sessionKey),
    },
    idempotencyKey: summarizeIdentifier(params.idempotencyKey),
    messageLength: params.message.length,
    attachmentCount: attachments.length,
    attachmentBytes: attachments.reduce((sum, attachment) => sum + attachment.fileSize, 0),
    timeoutMs: params.timeoutMs ?? null,
  });
  const payload = {
    ...(params.endpointSessionId ? { endpointSessionId: params.endpointSessionId } : {}),
    sessionIdentity: params.sessionIdentity,
    message: params.message || (attachments.length > 0 ? CHAT_SEND_WITH_MEDIA_FALLBACK_PROMPT : ''),
    idempotencyKey: params.idempotencyKey,
    deliver: false,
    ...(attachments.length > 0
      ? {
          attachments: attachments.map((attachment) => ({
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
