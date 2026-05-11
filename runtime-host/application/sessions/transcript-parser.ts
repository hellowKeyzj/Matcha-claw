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

export function parseTranscriptMessages(content: string): SessionTranscriptMessage[] {
  const lines = content.split(/\r?\n/).filter(Boolean);
  const messages: SessionTranscriptMessage[] = [];

  for (const line of lines) {
    let parsed: TranscriptLineShape;
    try {
      parsed = JSON.parse(line) as TranscriptLineShape;
    } catch {
      continue;
    }
    if (!isRecord(parsed.message)) {
      continue;
    }

    const role = normalizeMessageRole(parsed.message.role);
    if (!role) {
      continue;
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

    messages.push({
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
      toolStatuses: Array.isArray(normalized.toolStatuses) ? normalized.toolStatuses as Array<Record<string, unknown>> : undefined,
      taskCompletionEvents: normalizeTaskCompletionEvents(normalized.taskCompletionEvents),
      isError: normalizeOptionalBoolean(normalized.isError ?? normalized.is_error),
    });
  }

  return messages;
}
