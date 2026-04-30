import type { RawMessage } from '@/stores/chat';
import { extractText } from './message-utils';

export interface ChatMessageRow {
  key: string;
  kind: 'message';
  message: RawMessage;
  role: 'user' | 'assistant' | 'system';
  text: string;
}

export type ChatRow = ChatMessageRow;

interface BuildStaticChatRowsInput {
  sessionKey: string;
  messages: RawMessage[];
}

interface BuildStaticChatRowsResult {
  rows: ChatMessageRow[];
  renderableCount: number;
}

const anonymousMessageKeyByRef = new WeakMap<RawMessage, string>();

function hashStringDjb2(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function serializeContentForAnonymousKey(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim().slice(0, 512);
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const type = typeof block.type === 'string' ? block.type : '';
    if (type === 'text' && typeof block.text === 'string') {
      parts.push(`t:${block.text.trim()}`);
      continue;
    }
    if ((type === 'tool_use' || type === 'toolCall')) {
      const id = typeof block.id === 'string' ? block.id : '';
      const name = typeof block.name === 'string' ? block.name : '';
      parts.push(`u:${id}:${name}`);
      continue;
    }
    if ((type === 'tool_result' || type === 'toolResult')) {
      const toolUseId = typeof block.tool_use_id === 'string'
        ? block.tool_use_id
        : (typeof block.toolUseId === 'string' ? block.toolUseId : '');
      parts.push(`r:${toolUseId}`);
      continue;
    }
    if (type) {
      parts.push(`x:${type}`);
    }
  }
  return parts.join('|').slice(0, 512);
}

export function isRenderableChatMessage(message: RawMessage): boolean {
  const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
  return role !== 'toolresult' && role !== 'tool_result';
}

function resolveRenderableMessageRole(message: RawMessage): ChatMessageRow['role'] {
  return message.role === 'user' || message.role === 'system' ? message.role : 'assistant';
}

function buildMessageRow(
  sessionKey: string,
  message: RawMessage,
  renderableIndex: number,
  usedRowKeys: Set<string>,
): ChatMessageRow {
  const baseKey = resolveMessageRowKey(sessionKey, message, renderableIndex);
  let messageRowKey = baseKey;
  let duplicateOrdinal = 1;
  while (usedRowKeys.has(messageRowKey)) {
    messageRowKey = `${baseKey}|dup:${duplicateOrdinal}`;
    duplicateOrdinal += 1;
  }
  usedRowKeys.add(messageRowKey);
  return {
    key: messageRowKey,
    kind: 'message',
    message,
    role: resolveRenderableMessageRole(message),
    text: extractText(message),
  };
}

export function canAppendMessageList(
  previous: RawMessage[],
  next: RawMessage[],
): boolean {
  if (previous.length > next.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) {
      return false;
    }
  }
  return true;
}

export function canPrependMessageList(
  previous: RawMessage[],
  next: RawMessage[],
): boolean {
  if (previous.length > next.length) {
    return false;
  }
  const offset = next.length - previous.length;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[offset + index]) {
      return false;
    }
  }
  return true;
}

export function appendMessageRows(
  sessionKey: string,
  baseRows: ChatMessageRow[],
  messages: RawMessage[],
  fromIndex: number,
  startRenderableIndex: number,
): {
  rows: ChatMessageRow[];
  renderableCount: number;
} {
  if (fromIndex >= messages.length) {
    return {
      rows: baseRows,
      renderableCount: startRenderableIndex,
    };
  }

  const rows = [...baseRows];
  const usedRowKeys = new Set(rows.map((row) => row.key));
  let renderableIndex = startRenderableIndex;
  for (let index = fromIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isRenderableChatMessage(message)) {
      continue;
    }
    rows.push(buildMessageRow(sessionKey, message, renderableIndex, usedRowKeys));
    renderableIndex += 1;
  }

  return {
    rows,
    renderableCount: renderableIndex,
  };
}

export function prependMessageRows(
  sessionKey: string,
  baseRows: ChatMessageRow[],
  messages: RawMessage[],
  toIndexExclusive: number,
  startRenderableCount: number,
): {
  rows: ChatMessageRow[];
  renderableCount: number;
} {
  if (toIndexExclusive <= 0) {
    return {
      rows: baseRows,
      renderableCount: startRenderableCount,
    };
  }

  const prependedRows: ChatMessageRow[] = [];
  const usedRowKeys = new Set(baseRows.map((row) => row.key));
  let prependedRenderableCount = 0;
  for (let index = 0; index < toIndexExclusive; index += 1) {
    const message = messages[index];
    if (!isRenderableChatMessage(message)) {
      continue;
    }
    prependedRows.push(buildMessageRow(sessionKey, message, prependedRenderableCount, usedRowKeys));
    prependedRenderableCount += 1;
  }

  return {
    rows: prependedRows.length > 0 ? [...prependedRows, ...baseRows] : baseRows,
    renderableCount: startRenderableCount + prependedRenderableCount,
  };
}

function resolveAnonymousMessageRowKey(sessionKey: string, message: RawMessage): string {
  const role = typeof message.role === 'string' ? message.role : 'unknown';
  const timestamp = typeof message.timestamp === 'number'
    ? String(message.timestamp)
    : 'na';
  const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
  const contentSignature = hashStringDjb2(serializeContentForAnonymousKey(message.content));
  const deterministic = `session:${sessionKey}|anon:${role}:${timestamp}:${toolCallId}:${contentSignature}`;

  // Preserve old WeakMap fast-path for repeated renders of the same object ref.
  const existing = anonymousMessageKeyByRef.get(message);
  if (existing === deterministic) {
    return existing;
  }
  anonymousMessageKeyByRef.set(message, deterministic);
  return deterministic;
}

export function resolveMessageRowKey(sessionKey: string, message: RawMessage, _index: number): string {
  if (typeof message.id === 'string' && message.id.trim()) {
    return `session:${sessionKey}|id:${message.id}`;
  }
  return resolveAnonymousMessageRowKey(sessionKey, message);
}

export function buildStaticChatRows({
  sessionKey,
  messages,
}: BuildStaticChatRowsInput): ChatMessageRow[] {
  return buildMessageRowsWithMeta({
    sessionKey,
    messages,
  }).rows;
}

export function buildMessageRowsWithMeta({
  sessionKey,
  messages,
}: Pick<BuildStaticChatRowsInput, 'sessionKey' | 'messages'>): BuildStaticChatRowsResult {
  const rows: ChatMessageRow[] = [];
  const usedRowKeys = new Set<string>();
  let renderableCount = 0;
  for (const message of messages) {
    if (!isRenderableChatMessage(message)) {
      continue;
    }
    rows.push(buildMessageRow(sessionKey, message, renderableCount, usedRowKeys));
    renderableCount += 1;
  }
  return {
    rows,
    renderableCount,
  };
}
