import { hostApiFetch, hostGatewayRequest } from '@/lib/host-api';
import type { ChatSendAttachment } from './types';

export const CHAT_SEND_RPC_TIMEOUT_MS = 120_000;
const CHAT_SEND_WITH_MEDIA_FALLBACK_PROMPT = 'Process the attached file(s).';
const CHAT_SEND_DEFAULT_ERROR = 'Failed to send message';

interface ChatSendTransportResultPayload {
  runId?: string;
}

interface ChatSendTransportResponsePayload {
  success: boolean;
  result?: ChatSendTransportResultPayload;
  error?: string;
}

export interface SendChatTransportParams {
  sessionKey: string;
  message: string;
  idempotencyKey: string;
  attachments?: ChatSendAttachment[];
  timeoutMs?: number;
}

export type SendChatTransportResult =
  | { ok: true; runId: string | null }
  | { ok: false; error: string };

export async function sendChatTransport(
  params: SendChatTransportParams,
): Promise<SendChatTransportResult> {
  const timeoutMs = params.timeoutMs ?? CHAT_SEND_RPC_TIMEOUT_MS;
  const attachments = params.attachments ?? [];
  const hasMedia = attachments.length > 0;

  let response: ChatSendTransportResponsePayload;
  if (hasMedia) {
    response = await hostApiFetch<ChatSendTransportResponsePayload>(
      '/api/chat/send-with-media',
      {
        method: 'POST',
        body: JSON.stringify({
          sessionKey: params.sessionKey,
          message: params.message || CHAT_SEND_WITH_MEDIA_FALLBACK_PROMPT,
          deliver: false,
          idempotencyKey: params.idempotencyKey,
          media: attachments.map((attachment) => ({
            filePath: attachment.stagedPath,
            mimeType: attachment.mimeType,
            fileName: attachment.fileName,
          })),
        }),
      },
    );
  } else {
    response = await hostGatewayRequest<ChatSendTransportResultPayload>(
      'chat.send',
      {
        sessionKey: params.sessionKey,
        message: params.message,
        deliver: false,
        idempotencyKey: params.idempotencyKey,
      },
      timeoutMs,
    );
  }

  if (!response.success) {
    return {
      ok: false,
      error: response.error || CHAT_SEND_DEFAULT_ERROR,
    };
  }

  const normalizedRunId = typeof response.result?.runId === 'string'
    ? response.result.runId.trim()
    : '';
  return {
    ok: true,
    runId: normalizedRunId || null,
  };
}
