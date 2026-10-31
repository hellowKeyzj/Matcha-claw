import { releaseStagedAttachments } from '../attachments/staging';

export function sessionSendStagedAttachmentIds(body: unknown, path: string, method: string): string[] {
  if (method !== 'POST' || path.split(/[?#]/, 1)[0] !== '/api/capabilities/execute') return [];
  const parsed = typeof body === 'string' ? parseHostApiJson(body) : body;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const { id, operationId, input } = parsed as Record<string, unknown>;
  if (id !== 'session.prompt' || (operationId !== 'sessions.prompt' && operationId !== 'sessions.sendWithMedia')
    || !input || typeof input !== 'object' || Array.isArray(input)) return [];
  const { attachments } = input as Record<string, unknown>;
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((attachment) => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return [];
    const { stagedAttachmentId } = attachment as Record<string, unknown>;
    return typeof stagedAttachmentId === 'string' && stagedAttachmentId.length > 0 ? [stagedAttachmentId] : [];
  });
}

export async function releaseSessionSendStagedAttachments(ids: readonly string[]): Promise<void> {
  if (ids.length > 0) await releaseStagedAttachments([...ids]);
}

function parseHostApiJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
