import { hostSessionPrompt } from '@/lib/host-api';
import type { SessionIdentity } from '../../../runtime-host/shared/runtime-address';
import type { SessionStateSnapshot } from '../../../runtime-host/shared/session-adapter-types';
import type { ChatSendAttachment } from './types';

export const CHAT_SEND_RPC_TIMEOUT_MS = 120_000;
const CHAT_SEND_WITH_MEDIA_FALLBACK_PROMPT = 'Process the attached file(s).';
const CHAT_SEND_DEFAULT_ERROR = 'Failed to send message';

export interface SendChatTransportParams {
  sessionKey: string;
  endpointSessionId?: string;
  sessionIdentity: SessionIdentity;
  message: string;
  idempotencyKey: string;
  attachments?: ChatSendAttachment[];
  timeoutMs?: number;
}

export type SendChatTransportResult =
  | { ok: true; runId: string | null; snapshot: SessionStateSnapshot }
  | { ok: false; error: string };

export async function sendChatTransport(
  params: SendChatTransportParams,
): Promise<SendChatTransportResult> {
  const attachments = params.attachments ?? [];
  const response = await hostSessionPrompt({
    sessionKey: params.sessionKey,
    ...(params.endpointSessionId ? { endpointSessionId: params.endpointSessionId } : {}),
    sessionIdentity: params.sessionIdentity,
    message: params.message || (attachments.length > 0 ? CHAT_SEND_WITH_MEDIA_FALLBACK_PROMPT : ''),
    idempotencyKey: params.idempotencyKey,
    deliver: false,
    ...(attachments.length > 0
      ? {
          media: attachments.map((attachment) => ({
            filePath: attachment.stagedPath,
            mimeType: attachment.mimeType,
            fileName: attachment.fileName,
            fileSize: attachment.fileSize,
            preview: attachment.preview,
          })),
        }
      : {}),
  });
  if (!response.success) {
    const failureMessage = typeof (response as { error?: unknown }).error === 'string'
      ? (response as { error?: string }).error?.trim()
      : '';
    return {
      ok: false,
      error: failureMessage
        ? failureMessage
        : CHAT_SEND_DEFAULT_ERROR,
    };
  }
  const normalizedRunId = typeof response.runId === 'string'
    ? response.runId.trim()
    : '';
  return {
    ok: true,
    runId: normalizedRunId || null,
    snapshot: response.snapshot,
  };
}
