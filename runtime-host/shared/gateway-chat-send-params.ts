export interface GatewayChatSendIdentity {
  idempotencyKey?: string;
}

export interface GatewayChatSendParamsInput extends GatewayChatSendIdentity {
  sessionKey: string;
  message: string;
  deliver?: boolean;
  attachments?: Array<Record<string, unknown>>;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function buildGatewayChatSendParams(
  input: GatewayChatSendParamsInput,
): Record<string, unknown> {
  const sessionKey = normalizeOptionalString(input.sessionKey);
  const message = typeof input.message === 'string' ? input.message : '';
  const idempotencyKey = normalizeOptionalString(input.idempotencyKey);
  const attachments = Array.isArray(input.attachments) && input.attachments.length > 0
    ? input.attachments
    : undefined;

  return {
    ...(sessionKey ? { sessionKey } : {}),
    message,
    ...(input.deliver != null ? { deliver: input.deliver } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(attachments ? { attachments } : {}),
  };
}
