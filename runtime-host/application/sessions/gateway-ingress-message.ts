import { normalizeMessageRole } from '../../shared/chat-message-normalization';
import type { SessionTimelineEntry, SessionTimelineEntryStatus } from '../../shared/session-adapter-types';
import {
  buildTimelineEntriesFromTranscriptMessage,
} from './transcript-timeline-materializer';
import {
  resolveSessionLaneKey,
} from './transcript-turn-identity';
import type { SessionTranscriptMessage } from './transcript-types';
import { normalizeTaskCompletionEvents } from './task-completion-events';
import {
  isRecord,
  normalizeFiniteNumber,
  normalizeString,
} from './session-value-normalization';
import type {
  GatewayConversationMessagePayload,
  SessionTimelineIngressEvent,
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
    ...(Array.isArray(rawMessage.toolStatuses) ? { toolStatuses: rawMessage.toolStatuses.map((item) => ({ ...(isRecord(item) ? item : {}) })) } : {}),
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

export function buildMessageIngressEvents(
  payload: GatewayConversationMessagePayload,
  options: {
    existingEntries?: SessionTimelineEntry[];
  } = {},
): SessionTimelineIngressEvent[] {
  const conversation = normalizeConversationMessagePayload(payload);
  if (!conversation.message) {
    return [];
  }
  const laneKey = resolveSessionLaneKey(normalizeString(conversation.message.agentId));
  const entries = buildTimelineEntriesFromTranscriptMessage(
    conversation.sessionKey ?? '',
    conversation.message,
    {
      runId: conversation.runId ?? undefined,
      sequenceId: conversation.sequenceId,
      status: conversation.status,
      index: 0,
      existingRows: options.existingEntries,
    },
  );
  if (entries.length === 0) {
    return [];
  }
  const meta = buildMemberMeta(normalizeString(conversation.message.agentId));
  return [{
    sessionUpdate: conversation.status === 'streaming' ? 'agent_message_chunk' : 'agent_message',
    sessionKey: conversation.sessionKey,
    runId: conversation.runId,
    laneKey,
    entries,
    ...(meta ? { _meta: meta } : {}),
  }];
}
