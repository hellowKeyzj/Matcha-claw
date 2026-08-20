import {
  isRecord,
  type ChatMessageRecord,
  normalizeMessageRole,
  normalizeOptionalString,
} from './message-content';
import {
  sanitizeCanonicalUserContent,
  sanitizeCanonicalUserText,
} from './message-display';

export interface NormalizeRawChatMessageOptions {
  sanitizeCanonicalUser?: boolean;
  fallbackMessageIdToId?: boolean;
  fallbackOriginMessageIdToParentMessageId?: boolean;
}

export interface NormalizedChatMessageIdentity {
  id?: string;
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
  agentId?: string;
  toolCallId?: string;
  toolName?: string;
}

const CANONICAL_CHAT_MESSAGE_NORMALIZE_OPTIONS: NormalizeRawChatMessageOptions = {
  fallbackMessageIdToId: true,
  fallbackOriginMessageIdToParentMessageId: true,
};

export function resolveNormalizedMessageIdentity(
  value: unknown,
  options: NormalizeRawChatMessageOptions = {},
): NormalizedChatMessageIdentity {
  const message = isRecord(value) ? value : {};
  const role = normalizeMessageRole(message.role);
  const id = normalizeOptionalString(message.id);
  const messageId = normalizeOptionalString(message.messageId ?? message.message_id)
    ?? (options.fallbackMessageIdToId ? id : undefined);
  const clientId = normalizeOptionalString(
    message.clientId
    ?? message.client_id
    ?? message.idempotencyKey
    ?? message.idempotency_key,
  ) ?? undefined;
  const originMessageId = normalizeOptionalString(message.originMessageId ?? message.origin_message_id)
    ?? (
      options.fallbackOriginMessageIdToParentMessageId
        ? normalizeOptionalString(message.parentMessageId ?? message.parent_message_id)
        : undefined
    );
  const agentId = normalizeOptionalString(message.agentId ?? message.agent_id);
  const toolCallId = normalizeOptionalString(message.toolCallId ?? message.tool_call_id);
  const toolName = normalizeOptionalString(message.toolName ?? message.tool_name ?? message.name);

  return {
    ...(id ? { id } : {}),
    ...(messageId ? { messageId } : {}),
    ...(originMessageId ? { originMessageId } : {}),
    ...(clientId ? { clientId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(role === 'assistant' && toolCallId ? { toolCallId } : {}),
  };
}

export function normalizeRawChatMessage<T extends ChatMessageRecord>(
  value: T,
  options: NormalizeRawChatMessageOptions = {},
): T & ChatMessageRecord {
  const role = normalizeMessageRole(value.role);
  const identity = resolveNormalizedMessageIdentity(value, options);
  const nextContent = options.sanitizeCanonicalUser && role === 'user'
    ? sanitizeCanonicalUserContent(value.content)
    : value.content;
  const nextText = options.sanitizeCanonicalUser && role === 'user' && typeof value.text === 'string'
    ? sanitizeCanonicalUserText(value.text)
    : value.text;

  return {
    ...value,
    ...(role ? { role } : {}),
    ...(nextContent !== undefined ? { content: nextContent } : {}),
    ...(typeof nextText === 'string' ? { text: nextText } : {}),
    ...identity,
  };
}

export function normalizeCanonicalChatMessage<T extends ChatMessageRecord>(
  value: T,
): T & ChatMessageRecord {
  return normalizeRawChatMessage(value, CANONICAL_CHAT_MESSAGE_NORMALIZE_OPTIONS);
}
