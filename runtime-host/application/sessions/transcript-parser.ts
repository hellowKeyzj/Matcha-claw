import {
  normalizeMessageRole,
  normalizeOptionalString,
  normalizeRawChatMessage,
} from '../../shared/chat-message-normalization';
import { normalizeTaskCompletionEvents } from './task-completion-events';
import {
  isRecord,
  normalizeOptionalBoolean,
  normalizeTimestamp,
  type SessionTranscriptMessage,
  type TranscriptLineShape,
} from './transcript-types';

function readTranscriptMessageShape(parsed: TranscriptLineShape): Record<string, unknown> | null {
  if (isRecord(parsed.message)) {
    return parsed.message as Record<string, unknown>;
  }
  const record = isRecord(parsed) ? parsed as Record<string, unknown> : null;
  return record && normalizeMessageRole(record.role) ? record : null;
}

function parseTranscriptLine(line: string): SessionTranscriptMessage | null {
  let parsed: TranscriptLineShape;
  try {
    parsed = JSON.parse(line) as TranscriptLineShape;
  } catch {
    return null;
  }
  const rawMessage = readTranscriptMessageShape(parsed);
  if (!rawMessage) {
    return null;
  }

  const role = normalizeMessageRole(rawMessage.role);
  if (!role) {
    return null;
  }

  const normalized = normalizeRawChatMessage({
    ...rawMessage,
    role,
    content: Object.prototype.hasOwnProperty.call(rawMessage, 'content')
      ? rawMessage.content
      : '',
    timestamp: normalizeTimestamp(parsed.timestamp ?? rawMessage.timestamp),
    id: normalizeOptionalString(parsed.id ?? rawMessage.id),
    parentMessageId: normalizeOptionalString(rawMessage.parentMessageId ?? rawMessage.parent_message_id ?? parsed.parentId ?? parsed.parent_id),
  }, {
    fallbackMessageIdToId: false,
    fallbackOriginMessageIdToParentMessageId: true,
  });

  return {
    role,
    content: Object.prototype.hasOwnProperty.call(normalized, 'content')
      ? normalized.content
      : '',
    timestamp: normalizeTimestamp(normalized.timestamp),
    id: normalizeOptionalString(normalized.id),
    messageId: normalizeOptionalString(normalized.messageId),
    originMessageId: normalizeOptionalString(normalized.originMessageId),
    clientId: normalizeOptionalString(normalized.clientId),
    status: normalized.status as SessionTranscriptMessage['status'],
    streaming: typeof normalized.streaming === 'boolean' ? normalized.streaming : undefined,
    agentId: normalizeOptionalString(normalized.agentId),
    toolCallId: normalizeOptionalString(normalized.toolCallId),
    tool_calls: Array.isArray(normalized.tool_calls) ? normalized.tool_calls as Array<Record<string, unknown>> : undefined,
    toolCalls: Array.isArray(normalized.toolCalls) ? normalized.toolCalls as Array<Record<string, unknown>> : undefined,
    toolName: normalizeOptionalString(normalized.toolName),
    metadata: isRecord(normalized.metadata) ? normalized.metadata : undefined,
    name: normalizeOptionalString(normalized.name),
    details: normalized.details,
    taskCompletionEvents: normalizeTaskCompletionEvents(rawMessage.taskCompletionEvents ?? normalized.taskCompletionEvents),
    _attachedFiles: Array.isArray(rawMessage._attachedFiles)
      ? rawMessage._attachedFiles as Array<Record<string, unknown>>
      : undefined,
    isError: normalizeOptionalBoolean(normalized.isError ?? normalized.is_error),
  };
}

function* iterateTranscriptContentLines(content: string): Generator<string> {
  let start = 0;
  for (let index = 0; index <= content.length; index += 1) {
    if (index < content.length && content.charCodeAt(index) !== 10) {
      continue;
    }
    const end = index > start && content.charCodeAt(index - 1) === 13 ? index - 1 : index;
    if (end > start) {
      yield content.slice(start, end);
    }
    start = index + 1;
  }
}

export function* iterateTranscriptMessages(content: string | Iterable<string>): Generator<SessionTranscriptMessage> {
  const lines = typeof content === 'string' ? iterateTranscriptContentLines(content) : content;
  for (const line of lines) {
    if (!line) {
      continue;
    }
    const message = parseTranscriptLine(line);
    if (message) {
      yield message;
    }
  }
}

export async function* iterateTranscriptMessagesAsync(content: string | Iterable<string> | AsyncIterable<string>): AsyncGenerator<SessionTranscriptMessage> {
  if (typeof content === 'string' || Symbol.iterator in Object(content)) {
    yield* iterateTranscriptMessages(content as string | Iterable<string>);
    return;
  }
  for await (const line of content) {
    if (!line) {
      continue;
    }
    const message = parseTranscriptLine(line);
    if (message) {
      yield message;
    }
  }
}

export async function* iterateTranscriptMessagesFromChunksAsync(chunks: AsyncIterable<string>): AsyncGenerator<SessionTranscriptMessage> {
  let pending = '';
  for await (const chunk of chunks) {
    pending += chunk;
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = pending.slice(0, newlineIndex > 0 && pending.charCodeAt(newlineIndex - 1) === 13 ? newlineIndex - 1 : newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      const message = line ? parseTranscriptLine(line) : null;
      if (message) {
        yield message;
      }
      newlineIndex = pending.indexOf('\n');
    }
  }
  const line = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
  const message = line ? parseTranscriptLine(line) : null;
  if (message) {
    yield message;
  }
}

export function parseTranscriptMessages(content: string): SessionTranscriptMessage[] {
  return Array.from(iterateTranscriptMessages(content));
}
