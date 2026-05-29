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

function parseTranscriptLine(line: string): SessionTranscriptMessage | null {
  let parsed: TranscriptLineShape;
  try {
    parsed = JSON.parse(line) as TranscriptLineShape;
  } catch {
    return null;
  }
  if (!isRecord(parsed.message)) {
    return null;
  }

  const role = normalizeMessageRole(parsed.message.role);
  if (!role) {
    return null;
  }

  const normalized = normalizeRawChatMessage({
    ...parsed.message,
    role,
    content: Object.prototype.hasOwnProperty.call(parsed.message, 'content')
      ? parsed.message.content
      : '',
    timestamp: normalizeTimestamp(parsed.timestamp ?? parsed.message.timestamp),
    id: normalizeOptionalString(parsed.id ?? parsed.message.id),
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
    metadata: normalized.metadata as Record<string, unknown> | undefined,
    name: normalizeOptionalString(normalized.name),
    details: normalized.details,
    taskCompletionEvents: normalizeTaskCompletionEvents(parsed.message.taskCompletionEvents ?? normalized.taskCompletionEvents),
    _attachedFiles: Array.isArray(parsed.message._attachedFiles)
      ? parsed.message._attachedFiles as Array<Record<string, unknown>>
      : undefined,
    isError: normalizeOptionalBoolean(normalized.isError ?? normalized.is_error),
  };
}

export function* iterateTranscriptMessages(content: string): Generator<SessionTranscriptMessage> {
  let start = 0;
  for (let index = 0; index <= content.length; index += 1) {
    if (index < content.length && content.charCodeAt(index) !== 10) {
      continue;
    }
    const end = index > start && content.charCodeAt(index - 1) === 13 ? index - 1 : index;
    if (end > start) {
      const message = parseTranscriptLine(content.slice(start, end));
      if (message) {
        yield message;
      }
    }
    start = index + 1;
  }
}

export function parseTranscriptMessages(content: string): SessionTranscriptMessage[] {
  return Array.from(iterateTranscriptMessages(content));
}
