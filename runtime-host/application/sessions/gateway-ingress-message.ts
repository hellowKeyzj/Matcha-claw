import {
  isAssistantControlPrefixMessage,
  isInternalAssistantControlMessage,
  normalizeMessageRole,
} from '../../shared/chat-message-normalization';
import type {
  SessionTimelineEntry,
  SessionTimelineEntryStatus,
} from '../../shared/session-adapter-types';
import {
  buildTimelineEntriesFromTranscriptMessage,
} from './transcript-timeline-materializer';
import {
  resolveSessionLaneKey,
} from './transcript-turn-identity';
import type { SessionTranscriptMessage } from './transcript-types';
import { normalizeTaskCompletionEvents } from './task-completion-events';
import {
  normalizeTaskArtifactSnapshot,
  normalizeTaskToolSnapshot,
} from './task-snapshot-normalizer';
import {
  isStateOnlyToolName,
  isToolCallContentType,
  isToolResultContentType,
  resolveToolRecordName,
} from './state-only-tools';
import { isMalformedEmptyToolNameResult } from './tool-event-sanitizer';
import {
  isRecord,
  normalizeFiniteNumber,
  normalizeString,
} from './session-value-normalization';
import {
  extractTaskSnapshotFromTranscriptMessage,
} from './transcript-task-snapshot-replay';
import type {
  GatewayConversationMessagePayload,
  GatewaySessionIngressEvent,
} from './gateway-ingress-types';

export function normalizeTimelineEntryStatus(value: unknown): SessionTimelineEntryStatus {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'delta' || normalized === 'stream' || normalized === 'streaming') {
    return 'streaming';
  }
  if (normalized === 'error' || normalized === 'failed') {
    return 'error';
  }
  if (normalized === 'aborted' || normalized === 'abort' || normalized === 'cancelled' || normalized === 'canceled') {
    return 'aborted';
  }
  if (normalized === 'pending') {
    return 'pending';
  }
  return 'final';
}

function buildMemberMeta(agentId: string): Record<string, unknown> | undefined {
  if (!agentId) {
    return undefined;
  }
  return {
    'codebuddy.ai/memberEvent': agentId,
  };
}

function normalizeConversationMessagePayload(
  payload: GatewayConversationMessagePayload,
): { sessionKey: string | null; runId: string | null; sequenceId?: number; message: SessionTranscriptMessage | null; status: SessionTimelineEntryStatus } {
  const sessionKey = normalizeString(payload.sessionKey) || null;
  const runId = normalizeString(payload.runId) || null;
  const state = normalizeString(payload.state);
  const sequenceId = normalizeFiniteNumber(payload.sequenceId);
  const rawMessage = isRecord(payload.message) ? payload.message : null;
  if (!rawMessage) {
    return {
      sessionKey,
      runId,
      ...(sequenceId != null ? { sequenceId } : {}),
      message: null,
      status: normalizeTimelineEntryStatus(state),
    };
  }

  const role = normalizeMessageRole(rawMessage.role);
  if (!role) {
    return {
      sessionKey,
      runId,
      ...(sequenceId != null ? { sequenceId } : {}),
      message: null,
      status: normalizeTimelineEntryStatus(state),
    };
  }
  const content = Object.prototype.hasOwnProperty.call(rawMessage, 'content')
    ? rawMessage.content
    : '';
  const taskCompletionEvents = normalizeTaskCompletionEvents(rawMessage.taskCompletionEvents);
  const normalizedMessage: SessionTranscriptMessage = {
    role,
    content,
    ...(typeof rawMessage.text === 'string' ? { text: rawMessage.text } : {}),
    ...(normalizeFiniteNumber(rawMessage.timestamp) != null ? { timestamp: normalizeFiniteNumber(rawMessage.timestamp) } : {}),
    ...(normalizeString(rawMessage.id) ? { id: normalizeString(rawMessage.id) } : {}),
    ...(normalizeString(rawMessage.messageId) ? { messageId: normalizeString(rawMessage.messageId) } : {}),
    ...(normalizeString(rawMessage.originMessageId) ? { originMessageId: normalizeString(rawMessage.originMessageId) } : {}),
    ...(normalizeString(rawMessage.clientId) ? { clientId: normalizeString(rawMessage.clientId) } : {}),
    ...(normalizeString(rawMessage.agentId ?? payload.agentId) ? { agentId: normalizeString(rawMessage.agentId ?? payload.agentId) } : {}),
    ...(normalizeString(rawMessage.toolCallId) ? { toolCallId: normalizeString(rawMessage.toolCallId) } : {}),
    ...(normalizeString(rawMessage.toolName ?? rawMessage.name) ? { toolName: normalizeString(rawMessage.toolName ?? rawMessage.name) } : {}),
    ...(Array.isArray(rawMessage.tool_calls) ? { tool_calls: rawMessage.tool_calls.map((item: unknown) => ({ ...(isRecord(item) ? item : {}) })) } : {}),
    ...(Array.isArray(rawMessage.toolCalls) ? { toolCalls: rawMessage.toolCalls.map((item: unknown) => ({ ...(isRecord(item) ? item : {}) })) } : {}),
    ...(Array.isArray(rawMessage.toolStatuses) ? { toolStatuses: rawMessage.toolStatuses.map((item: unknown) => ({ ...(isRecord(item) ? item : {}) })) } : {}),
    ...(taskCompletionEvents ? { taskCompletionEvents } : {}),
    ...(Object.prototype.hasOwnProperty.call(rawMessage, 'details') ? { details: rawMessage.details } : {}),
    ...(Array.isArray(rawMessage._attachedFiles) ? { _attachedFiles: rawMessage._attachedFiles.map((item: unknown) => ({ ...(isRecord(item) ? item : {}) })) } : {}),
    ...(typeof rawMessage.isError === 'boolean' ? { isError: rawMessage.isError } : {}),
  };

  return {
    sessionKey,
    runId,
    ...(sequenceId != null ? { sequenceId } : {}),
    message: normalizedMessage,
    status: normalizeTimelineEntryStatus(state),
  };
}

function stripStateOnlyToolContent(message: SessionTranscriptMessage): SessionTranscriptMessage {
  const content = Array.isArray(message.content)
    ? message.content.filter((block) => (
        !isRecord(block)
        || !isStateOnlyToolName(resolveToolRecordName(block))
        || (!isToolCallContentType(block.type) && !isToolResultContentType(block.type))
      ))
    : message.content;
  return {
    ...message,
    content,
    tool_calls: Array.isArray(message.tool_calls)
      ? message.tool_calls.filter((toolCall) => (
          !isRecord(toolCall) || !isStateOnlyToolName(resolveToolRecordName(toolCall))
        ))
      : message.tool_calls,
    toolCalls: Array.isArray(message.toolCalls)
      ? message.toolCalls.filter((toolCall) => (
          !isRecord(toolCall) || !isStateOnlyToolName(resolveToolRecordName(toolCall))
        ))
      : message.toolCalls,
  };
}

function extractStateOnlyToolStatusSnapshot(
  sessionKey: string,
  message: SessionTranscriptMessage,
) {
  if (!Array.isArray(message.toolStatuses)) {
    return null;
  }
  for (const toolStatus of message.toolStatuses) {
    if (!isRecord(toolStatus)) {
      continue;
    }
    const toolName = resolveToolRecordName(toolStatus);
    if (!isStateOnlyToolName(toolName)) {
      continue;
    }
    const payload = Object.prototype.hasOwnProperty.call(toolStatus, 'result')
      ? toolStatus.result
      : (Object.prototype.hasOwnProperty.call(toolStatus, 'output')
          ? toolStatus.output
          : (Object.prototype.hasOwnProperty.call(toolStatus, 'content')
              ? toolStatus.content
              : (Object.prototype.hasOwnProperty.call(toolStatus, 'details') ? toolStatus.details : toolStatus)));
    const snapshot = normalizeTaskToolSnapshot(toolName, payload, sessionKey);
    if (snapshot) {
      return snapshot;
    }
  }
  return null;
}

function stripMalformedEmptyToolContent(message: SessionTranscriptMessage): SessionTranscriptMessage {
  const content = Array.isArray(message.content)
    ? message.content.filter((block) => (
        !isRecord(block)
        || resolveToolRecordName(block)
        || (!isToolCallContentType(block.type) && !isToolResultContentType(block.type))
      ))
    : message.content;
  return {
    ...message,
    content,
    tool_calls: Array.isArray(message.tool_calls)
      ? message.tool_calls.filter((toolCall) => !isRecord(toolCall) || resolveToolRecordName(toolCall))
      : message.tool_calls,
    toolCalls: Array.isArray(message.toolCalls)
      ? message.toolCalls.filter((toolCall) => !isRecord(toolCall) || resolveToolRecordName(toolCall))
      : message.toolCalls,
  };
}

function hasRenderableMessagePayload(message: SessionTranscriptMessage): boolean {
  if (normalizeString(message.text)) {
    return true;
  }
  if (Array.isArray(message.content)) {
    return message.content.length > 0;
  }
  if (typeof message.content === 'string') {
    return message.content.trim().length > 0;
  }
  if (message.content != null) {
    return true;
  }
  return (
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
    || (Array.isArray(message.toolCalls) && message.toolCalls.length > 0)
  );
}

function hasRenderableTimelineOutput(entry: SessionTimelineEntry): boolean {
  if (entry.kind === 'assistant-turn') {
    return entry.text.trim().length > 0 || entry.segments.length > 0;
  }
  if (entry.kind === 'user-message') {
    return entry.text.trim().length > 0 || entry.attachedFiles.length > 0;
  }
  return true;
}

export function buildMessageIngressEvents(
  payload: GatewayConversationMessagePayload,
  options: {
    existingEntries?: SessionTimelineEntry[];
  } = {},
): GatewaySessionIngressEvent[] {
  const conversation = normalizeConversationMessagePayload(payload);
  if (!conversation.message) {
    return [];
  }
  if (
    isInternalAssistantControlMessage(conversation.message)
    || (
      conversation.status === 'streaming'
      && isAssistantControlPrefixMessage(conversation.message)
    )
  ) {
    return [];
  }
  const artifactSnapshot = normalizeTaskArtifactSnapshot(conversation.message.content, conversation.sessionKey);
  if (artifactSnapshot) {
    return [{
      sessionUpdate: 'plan',
      sessionKey: artifactSnapshot.sessionKey,
      runId: conversation.runId,
      taskSnapshot: artifactSnapshot,
    }];
  }
  const taskSnapshot = extractTaskSnapshotFromTranscriptMessage(
    conversation.sessionKey ?? '',
    conversation.message,
  ) ?? extractStateOnlyToolStatusSnapshot(conversation.sessionKey ?? '', conversation.message);
  const sanitizedMessage = stripMalformedEmptyToolContent(conversation.message);
  if (
    isMalformedEmptyToolNameResult(conversation.message)
    || !hasRenderableMessagePayload(sanitizedMessage)
  ) {
    return taskSnapshot
      ? [{
          sessionUpdate: 'plan',
          sessionKey: taskSnapshot.sessionKey,
          runId: conversation.runId,
          taskSnapshot,
        }]
      : [];
  }
  const timelineMessage = taskSnapshot
    ? stripStateOnlyToolContent(sanitizedMessage)
    : sanitizedMessage;
  const laneKey = resolveSessionLaneKey(normalizeString(conversation.message.agentId));
  const entries = buildTimelineEntriesFromTranscriptMessage(
    conversation.sessionKey ?? '',
    timelineMessage,
    {
      runId: conversation.runId ?? undefined,
      sequenceId: conversation.sequenceId,
      status: conversation.status,
      index: 0,
      existingRows: options.existingEntries,
    },
  );
  const visibleEntries = taskSnapshot
    ? entries.filter(hasRenderableTimelineOutput)
    : entries;
  const events: GatewaySessionIngressEvent[] = [];
  if (taskSnapshot) {
    events.push({
      sessionUpdate: 'plan',
      sessionKey: taskSnapshot.sessionKey,
      runId: conversation.runId,
      taskSnapshot,
    });
  }
  if (visibleEntries.length === 0) {
    return events;
  }
  const meta = buildMemberMeta(normalizeString(conversation.message.agentId));
  events.push({
    sessionUpdate: conversation.status === 'streaming' ? 'agent_message_chunk' : 'agent_message',
    sessionKey: conversation.sessionKey,
    runId: conversation.runId,
    laneKey,
    entries: visibleEntries,
    ...(meta ? { _meta: meta } : {}),
  });
  return events;
}
