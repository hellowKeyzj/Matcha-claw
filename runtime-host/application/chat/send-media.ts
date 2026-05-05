import { access, readFile } from 'node:fs/promises';
import type { OpenClawBridge } from '../../openclaw-bridge';
import { buildGatewayChatSendParams } from '../../shared/gateway-chat-send-params';

const VISION_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/bmp',
  'image/webp',
]);

export type SendWithMediaInput = {
  sessionKey: string;
  message: string;
  deliver?: boolean;
  idempotencyKey: string;
  media?: Array<{
    filePath: string;
    mimeType: string;
    fileName: string;
    fileSize?: number;
    preview?: string | null;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeSendWithMediaInput(value: unknown): SendWithMediaInput | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.sessionKey !== 'string'
    || typeof value.message !== 'string'
    || typeof value.idempotencyKey !== 'string'
  ) {
    return null;
  }

  const media = Array.isArray(value.media)
    ? value.media.filter((item): item is SendWithMediaInput['media'][number] => {
      return isRecord(item)
        && typeof item.filePath === 'string'
        && typeof item.mimeType === 'string'
        && typeof item.fileName === 'string';
    })
    : undefined;

  return {
    sessionKey: value.sessionKey,
    message: value.message,
    idempotencyKey: value.idempotencyKey,
    ...(typeof value.deliver === 'boolean' ? { deliver: value.deliver } : {}),
    ...(media ? { media } : {}),
  };
}

async function buildSendWithMediaGatewayParams(input: SendWithMediaInput): Promise<Record<string, unknown>> {
  let message = input.message;
  const imageAttachments: Array<Record<string, string>> = [];
  const fileReferences: string[] = [];

  if (Array.isArray(input.media) && input.media.length > 0) {
    for (const item of input.media) {
      fileReferences.push(`[media attached: ${item.filePath} (${item.mimeType}) | ${item.filePath}]`);
      if (!VISION_MIME_TYPES.has(item.mimeType)) {
        continue;
      }

      try {
        await access(item.filePath);
        const fileBuffer = await readFile(item.filePath);
        imageAttachments.push({
          content: fileBuffer.toString('base64'),
          mimeType: item.mimeType,
          fileName: item.fileName,
        });
      } catch {
        // 保持尽力发送语义，单个附件失败不阻断整个请求
      }
    }
  }

  if (fileReferences.length > 0) {
    const refs = fileReferences.join('\n');
    message = message ? `${message}\n\n${refs}` : refs;
  }

  return buildGatewayChatSendParams({
    sessionKey: input.sessionKey,
    message,
    deliver: input.deliver ?? false,
    idempotencyKey: input.idempotencyKey,
    attachments: imageAttachments.length > 0 ? imageAttachments : undefined,
  });
}

export async function sendWithMediaViaOpenClawBridge(
  openclawBridge: Pick<OpenClawBridge, 'chatSend'>,
  input: SendWithMediaInput,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    const rpcParams = await buildSendWithMediaGatewayParams(input);
    const result = await openclawBridge.chatSend(rpcParams);
    return {
      success: true,
      result,
    };
  } catch (error) {
    return {
      success: false,
      error: String(error),
    };
  }
}
