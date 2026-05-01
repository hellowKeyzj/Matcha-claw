import {
  extractUserMessageClientId,
  getMessageText,
  normalizeAssistantFinalTextForDedup,
} from './message-helpers';
import type { ContentBlock, RawMessage } from './types';

function normalizeValue(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getAssistantToolCallIds(message: RawMessage): string[] {
  const ids = new Set<string>();
  if (Array.isArray(message.content)) {
    for (const block of message.content as ContentBlock[]) {
      if ((block.type === 'tool_use' || block.type === 'toolCall') && typeof block.id === 'string' && block.id.trim()) {
        ids.add(block.id.trim());
      }
    }
  }
  const toolCalls = message.tool_calls ?? message.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const toolCall of toolCalls) {
      const id = typeof toolCall?.id === 'string' ? toolCall.id.trim() : '';
      if (id) {
        ids.add(id);
      }
    }
  }
  return Array.from(ids).sort();
}

function matchesMessageIdentifier(message: RawMessage, candidateId: string): boolean {
  if (!candidateId) {
    return false;
  }
  return (
    message.id === candidateId
    || message.clientId === candidateId
    || message.messageId === candidateId
    || message.uniqueId === candidateId
  );
}

function collectMessageIdentifierCandidates(message: RawMessage | null | undefined): string[] {
  if (!message) {
    return [];
  }
  const candidates = [
    normalizeValue(message.messageId),
    normalizeValue(message.clientId),
    normalizeValue(message.uniqueId),
    normalizeValue(message.id),
  ].filter(Boolean);
  return Array.from(new Set(candidates));
}

export function buildMessageIdentityKey(message: RawMessage | null | undefined): string | null {
  if (!message) {
    return null;
  }
  const toolCallId = normalizeValue(message.toolCallId);
  if (toolCallId) {
    return `tool:${toolCallId}`;
  }
  const agentId = normalizeValue(message.agentId);
  if (message.role === 'assistant') {
    const toolCallIds = getAssistantToolCallIds(message);
    if (toolCallIds.length > 0) {
      return `tool_calls:${toolCallIds.join(',')}:${agentId}`;
    }
  }
  const messageId = normalizeValue(message.messageId) || normalizeValue(message.id);
  if (messageId) {
    const contentPrefix = (
      message.role === 'assistant'
        ? normalizeAssistantFinalTextForDedup(message.content)
        : getMessageText(message.content).trim()
    ).slice(0, 200);
    return contentPrefix
      ? `message:${message.role}:${messageId}:${agentId}:${contentPrefix}`
      : `message:${message.role}:${messageId}:${agentId}:empty:${normalizeValue(message.id)}`;
  }
  const clientId = normalizeValue(message.clientId);
  if (clientId) {
    return `client:${message.role}:${clientId}:${agentId}`;
  }
  const uniqueId = normalizeValue(message.uniqueId);
  if (uniqueId) {
    return `unique:${message.role}:${uniqueId}:${agentId}`;
  }
  const id = normalizeValue(message.id);
  if (id) {
    return `id:${id}`;
  }
  const fallbackText = getMessageText(message.content).trim().slice(0, 120);
  const timestamp = typeof message.timestamp === 'number' ? String(message.timestamp) : '';
  if (fallbackText || timestamp) {
    return `fallback:${message.role}:${timestamp}:${fallbackText}`;
  }
  return null;
}

export function getMessageIdentityKeys(message: RawMessage | null | undefined): string[] {
  const key = buildMessageIdentityKey(message);
  return key ? [key] : [];
}

export function findMessageIndexByIdentity(messages: RawMessage[], target: RawMessage | null | undefined): number {
  if (!target) {
    return -1;
  }
  const targetKey = buildMessageIdentityKey(target);
  if (!targetKey) {
    return -1;
  }
  for (let index = 0; index < messages.length; index += 1) {
    if (buildMessageIdentityKey(messages[index]) === targetKey) {
      return index;
    }
  }
  return -1;
}

export interface MessageCommitMatchOptions {
  preferredMessageId?: string | null;
}

export function findMessageIndexForCommit(
  messages: RawMessage[],
  incomingMessage: RawMessage | null | undefined,
  options: MessageCommitMatchOptions = {},
): number {
  if (!incomingMessage) {
    return -1;
  }

  const preferredMessageId = normalizeValue(options.preferredMessageId);
  if (preferredMessageId) {
    const preferredIndex = messages.findIndex((message) => matchesMessageIdentifier(message, preferredMessageId));
    if (preferredIndex >= 0) {
      return preferredIndex;
    }
  }

  const normalizedUserClientId = normalizeValue(extractUserMessageClientId(incomingMessage.content) ?? undefined);
  if (normalizedUserClientId) {
    const extractedClientMatchIndex = messages.findIndex((message) => matchesMessageIdentifier(message, normalizedUserClientId));
    if (extractedClientMatchIndex >= 0) {
      return extractedClientMatchIndex;
    }
  }

  for (const candidateId of collectMessageIdentifierCandidates(incomingMessage)) {
    const directIdentifierMatchIndex = messages.findIndex((message) => matchesMessageIdentifier(message, candidateId));
    if (directIdentifierMatchIndex >= 0) {
      return directIdentifierMatchIndex;
    }
  }

  const identityIndex = findMessageIndexByIdentity(messages, incomingMessage);
  if (identityIndex >= 0) {
    return identityIndex;
  }

  return -1;
}

export function mergeMessagesPreservingLocalIdentity(
  localMessage: RawMessage,
  incomingMessage: RawMessage,
): RawMessage {
  const localId = normalizeValue(localMessage.id);
  const localClientId = normalizeValue(localMessage.clientId);
  const localUniqueId = normalizeValue(localMessage.uniqueId);
  const localMessageId = normalizeValue(localMessage.messageId);
  const incomingMessageId = normalizeValue(incomingMessage.messageId);
  const incomingId = normalizeValue(incomingMessage.id);
  const shouldLiftIncomingIdToMessageId = (
    Boolean(localId)
    && Boolean(incomingId)
    && localId !== incomingId
    && !localMessageId
    && !incomingMessageId
  );
  return {
    ...incomingMessage,
    ...(localId ? { id: localMessage.id } : {}),
    ...(localClientId ? { clientId: localMessage.clientId } : {}),
    ...(localUniqueId ? { uniqueId: localMessage.uniqueId } : {}),
    ...(localMessageId
      ? { messageId: localMessage.messageId }
      : (shouldLiftIncomingIdToMessageId ? { messageId: incomingId } : {})),
    _attachedFiles: incomingMessage._attachedFiles?.length
      ? incomingMessage._attachedFiles
      : localMessage._attachedFiles,
  };
}

export function commitMessageToTranscript(
  messages: RawMessage[],
  incomingMessage: RawMessage,
  options: MessageCommitMatchOptions = {},
): RawMessage[] {
  const existingIndex = findMessageIndexForCommit(messages, incomingMessage, options);
  if (existingIndex < 0) {
    return [...messages, incomingMessage];
  }
  const currentMessage = messages[existingIndex]!;
  if (currentMessage === incomingMessage) {
    return messages;
  }
  const nextMessages = [...messages];
  nextMessages[existingIndex] = mergeMessagesPreservingLocalIdentity(currentMessage, incomingMessage);
  return nextMessages;
}

function isToolBlock(block: ContentBlock): boolean {
  return (
    block.type === 'tool_use'
    || block.type === 'tool_result'
    || block.type === 'toolCall'
    || block.type === 'toolResult'
  );
}

function replaceMessageTextContent(
  content: unknown,
  text: string,
): unknown {
  if (!Array.isArray(content)) {
    return text;
  }

  const nextBlocks: ContentBlock[] = [];
  let insertedText = false;
  for (const block of content as ContentBlock[]) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    if (isToolBlock(block)) {
      nextBlocks.push(block);
      continue;
    }
    if (block.type === 'text') {
      if (!insertedText && text.length > 0) {
        nextBlocks.push({ ...block, text });
        insertedText = true;
      }
      continue;
    }
    nextBlocks.push(block);
  }

  if (!insertedText && text.length > 0) {
    nextBlocks.unshift({ type: 'text', text });
  }

  return nextBlocks.length > 0 ? nextBlocks : text;
}

function createFallbackStreamingMessage(
  messageId: string,
  targetText: string,
  lastUserMessageAt: number | null,
): RawMessage {
  return {
    id: messageId,
    role: 'assistant',
    content: targetText,
    timestamp: lastUserMessageAt != null ? (lastUserMessageAt / 1000) : (Date.now() / 1000),
    streaming: true,
  };
}

function mergeBaseStreamingMessage(
  previousMessage: RawMessage | null,
  incomingMessage: RawMessage | null,
): RawMessage | null {
  if (!previousMessage) {
    return incomingMessage;
  }
  if (!incomingMessage) {
    return previousMessage;
  }

  return {
    ...previousMessage,
    ...incomingMessage,
    content: Array.isArray(incomingMessage.content)
      ? incomingMessage.content
      : previousMessage.content,
    _attachedFiles: incomingMessage._attachedFiles ?? previousMessage._attachedFiles,
  };
}

export function appendMonotonicText(currentText: string, incomingText: string): string {
  if (!incomingText) {
    return currentText;
  }
  if (!currentText) {
    return incomingText;
  }
  if (incomingText.startsWith(currentText)) {
    return incomingText;
  }
  if (currentText.startsWith(incomingText)) {
    return currentText;
  }

  const maxOverlap = Math.min(currentText.length, incomingText.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (currentText.endsWith(incomingText.slice(0, size))) {
      return `${currentText}${incomingText.slice(size)}`;
    }
  }

  return `${currentText}${incomingText}`;
}

export function resolveNextStreamingText(
  currentText: string,
  input: {
    text: string;
    textMode: 'append' | 'snapshot' | 'keep';
  },
): string {
  switch (input.textMode) {
    case 'keep':
      return currentText;
    case 'snapshot':
      return input.text.length >= currentText.length ? input.text : currentText;
    case 'append':
      return appendMonotonicText(currentText, input.text);
    default:
      return currentText;
  }
}

export function resolveStreamingMessage(input: {
  previousMessage: RawMessage | null;
  incomingMessage?: RawMessage | null;
  messageId: string;
  targetText: string;
  lastUserMessageAt: number | null;
}): RawMessage {
  const base = mergeBaseStreamingMessage(
    input.previousMessage,
    input.incomingMessage ?? null,
  ) ?? createFallbackStreamingMessage(input.messageId, input.targetText, input.lastUserMessageAt);

  return {
    ...base,
    id: input.messageId,
    role: 'assistant',
    content: replaceMessageTextContent(base.content, input.targetText),
    timestamp: base.timestamp ?? (input.lastUserMessageAt != null ? (input.lastUserMessageAt / 1000) : (Date.now() / 1000)),
    streaming: true,
  };
}

export function findMessageById(messages: RawMessage[], messageId: string | null | undefined): RawMessage | null {
  const normalizedId = typeof messageId === 'string' ? messageId.trim() : '';
  if (!normalizedId) {
    return null;
  }
  return messages.find((message) => message.id === normalizedId) ?? null;
}

export function findCurrentStreamingMessage(
  messages: RawMessage[],
  streamingMessageId: string | null | undefined,
): RawMessage | null {
  const byId = findMessageById(messages, streamingMessageId);
  if (byId) {
    return byId;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.streaming) {
      return message;
    }
  }
  return null;
}

export function upsertMessageById(
  messages: RawMessage[],
  nextMessage: RawMessage,
): RawMessage[] {
  return commitMessageToTranscript(messages, nextMessage, {
    preferredMessageId: nextMessage.id ?? nextMessage.messageId ?? null,
  });
}

export function removeMessageById(
  messages: RawMessage[],
  messageId: string | null | undefined,
): RawMessage[] {
  const normalizedId = typeof messageId === 'string' ? messageId.trim() : '';
  if (!normalizedId) {
    return messages;
  }
  const nextMessages = messages.filter((message) => message.id !== normalizedId);
  return nextMessages.length === messages.length ? messages : nextMessages;
}

export function settleMessage(message: RawMessage): RawMessage {
  if (!message.streaming) {
    return message;
  }
  return {
    ...message,
    streaming: false,
  };
}

export function getStreamingMessageText(message: RawMessage | null | undefined): string {
  return message ? getMessageText(message.content) : '';
}
