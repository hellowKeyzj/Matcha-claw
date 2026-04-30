import { getMessageText } from './message-helpers';
import type { ContentBlock, RawMessage } from './types';

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
  const messageId = typeof nextMessage.id === 'string' ? nextMessage.id.trim() : '';
  if (!messageId) {
    return [...messages, nextMessage];
  }
  const existingIndex = messages.findIndex((message) => message.id === messageId);
  if (existingIndex < 0) {
    return [...messages, nextMessage];
  }
  if (messages[existingIndex] === nextMessage) {
    return messages;
  }
  const nextMessages = [...messages];
  nextMessages[existingIndex] = nextMessage;
  return nextMessages;
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
