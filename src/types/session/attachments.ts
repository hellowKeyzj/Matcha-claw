// Buffered send capacity; OpenClaw owns its configured attachment and MIME limits.
export const SESSION_ATTACHMENT_TRANSPORT_MAX_BYTES = 20 * 1024 * 1024;
export const SESSION_SEND_REQUEST_MAX_BYTES = Math.ceil(SESSION_ATTACHMENT_TRANSPORT_MAX_BYTES / 3) * 4 + 192 * 1024;
export const MATCHA_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export function sessionAttachmentMaxBytes(runtimeAdapterId?: string): number {
  return runtimeAdapterId === 'openclaw' ? SESSION_ATTACHMENT_TRANSPORT_MAX_BYTES : MATCHA_ATTACHMENT_MAX_BYTES;
}
