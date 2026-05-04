export type NormalizedChatMessageRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'toolresult'
  | 'tool_result';

type ContentTextBlock = {
  type?: unknown;
  text?: unknown;
};

type ChatMessageRecord = Record<string, unknown>;

export interface NormalizeRawChatMessageOptions {
  sanitizeCanonicalUser?: boolean;
  fallbackMessageIdToId?: boolean;
  fallbackOriginMessageIdToParentMessageId?: boolean;
  fallbackUniqueIdToId?: boolean;
  fallbackRequestIdToClientId?: boolean;
}

export interface NormalizedChatMessageIdentity {
  id?: string;
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
  uniqueId?: string;
  requestId?: string;
  agentId?: string;
  toolCallId?: string;
  toolName?: string;
}

const CANONICAL_CHAT_MESSAGE_NORMALIZE_OPTIONS: NormalizeRawChatMessageOptions = {
  fallbackMessageIdToId: true,
  fallbackOriginMessageIdToParentMessageId: true,
  fallbackRequestIdToClientId: true,
};

function isRecord(value: unknown): value is ChatMessageRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeMessageRole(value: unknown): NormalizedChatMessageRole | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (
    normalized === 'user'
    || normalized === 'assistant'
    || normalized === 'system'
    || normalized === 'toolresult'
    || normalized === 'tool_result'
  ) {
    return normalized;
  }
  return undefined;
}

export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block): block is ContentTextBlock => isRecord(block))
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n');
}

function stripLeadingUntrustedMetadataBlocks(text: string): string {
  const fencedPattern = /^\s*(?:[^\n:]{1,80}\s*\(\s*untrusted metadata\s*\):\s*)?```[a-z]*\n[\s\S]*?```\s*/i;
  const inlineJsonPattern = /^\s*(?:[^\n:]{1,80}\s*\(\s*untrusted metadata\s*\):\s*)?\{[\s\S]*?\}\s*/i;

  let output = text;
  while (true) {
    const next = output
      .replace(fencedPattern, '')
      .replace(inlineJsonPattern, '');
    if (next === output) {
      break;
    }
    output = next;
  }
  return output;
}

function stripLeadingInternalPromptArtifacts(text: string): string {
  let output = text;
  while (true) {
    const next = output
      .replace(/^\s*<relevant-memories>\s*[\s\S]*?<\/relevant-memories>\s*/i, '')
      .replace(/^\s*\[UNTRUSTED DATA[^\n]*\][\s\S]*?\[END UNTRUSTED DATA\]\s*/i, '');
    if (next === output) {
      break;
    }
    output = next;
  }
  return output;
}

function stripLeadingConversationEnvelopeArtifacts(text: string): string {
  let output = text;
  while (true) {
    const next = output
      .replace(
        /^\s*(?:Conversation info|Sender|Forwarded message context)\s*\([^)]*\):\s*(?:```[a-z]*\n[\s\S]*?```\s*|\{[\s\S]*?\}\s*)/i,
        '',
      )
      .replace(/^\s*(?:Conversation info|Sender|Forwarded message context)\s*\([^)]*\):\s*/i, '')
      .replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]+\]\s*/i, '');
    if (next === output) {
      break;
    }
    output = next;
  }
  return output;
}

function stripLeadingDisplayEnvelopeArtifacts(text: string): string {
  return stripLeadingConversationEnvelopeArtifacts(stripLeadingInternalPromptArtifacts(text));
}

export function sanitizeCanonicalUserText(text: string): string {
  const cleaned = stripLeadingDisplayEnvelopeArtifacts(text)
    .replace(/\s*\[media attached:[^\]]*\]/gi, '');
  return stripLeadingUntrustedMetadataBlocks(cleaned).trim();
}

export function sanitizeCanonicalUserContent(content: unknown): unknown {
  if (typeof content === 'string') {
    return sanitizeCanonicalUserText(content);
  }
  if (!Array.isArray(content)) {
    return content;
  }

  let changed = false;
  const nextContent = content.map((block) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
      return block;
    }
    const nextText = sanitizeCanonicalUserText(block.text);
    if (nextText === block.text) {
      return block;
    }
    changed = true;
    return {
      ...block,
      text: nextText,
    };
  });

  return changed ? nextContent : content;
}

export function stripAssistantReplyDirectivePrefix(text: string): string {
  return text
    .replace(/^\s*(?:\[\[reply_to(?:[:_][a-z0-9:_-]+)?\]\]\s*)+/ig, '')
    .trim();
}

export function sanitizeAssistantDisplayText(content: unknown): string {
  const text = typeof content === 'string' ? content : extractMessageText(content);
  return stripLeadingDisplayEnvelopeArtifacts(stripAssistantReplyDirectivePrefix(text))
    .replace(/\s*\[media attached:[^\]]*\]/gi, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

export function normalizeAssistantFinalText(content: unknown): string {
  return sanitizeAssistantDisplayText(content)
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

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
  const uniqueId = normalizeOptionalString(message.uniqueId ?? message.unique_id)
    ?? (options.fallbackUniqueIdToId ? id : undefined);
  const requestId = normalizeOptionalString(message.requestId ?? message.request_id)
    ?? (options.fallbackRequestIdToClientId ? clientId : undefined);
  const agentId = normalizeOptionalString(message.agentId ?? message.agent_id);
  const toolCallId = normalizeOptionalString(message.toolCallId ?? message.tool_call_id);
  const toolName = normalizeOptionalString(message.toolName ?? message.tool_name ?? message.name);

  return {
    ...(id ? { id } : {}),
    ...(messageId ? { messageId } : {}),
    ...(originMessageId ? { originMessageId } : {}),
    ...(clientId ? { clientId } : {}),
    ...(uniqueId ? { uniqueId } : {}),
    ...(requestId ? { requestId } : {}),
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

export function isInternalAssistantControlMessage(value: unknown): boolean {
  const message = isRecord(value) ? value : {};
  if (normalizeMessageRole(message.role) !== 'assistant') {
    return false;
  }
  const text = extractMessageText(message.content ?? message.text).trim();
  return /^(HEARTBEAT_OK|NO_REPLY)$/.test(text);
}

export function isCanonicalSystemNoticeMessage(value: unknown): boolean {
  const message = isRecord(value) ? value : {};
  if (normalizeMessageRole(message.role) !== 'system') {
    return false;
  }
  return extractMessageText(message.content ?? message.text).trim().length > 0;
}

export function shouldPreserveCanonicalTranscriptMessage(value: unknown): boolean {
  const message = isRecord(value) ? value : {};
  const role = normalizeMessageRole(message.role);
  if (!role) {
    return false;
  }
  if (isCanonicalSystemNoticeMessage(message)) {
    return true;
  }
  if (role === 'toolresult' || role === 'tool_result') {
    return false;
  }
  return !isInternalAssistantControlMessage(message);
}
