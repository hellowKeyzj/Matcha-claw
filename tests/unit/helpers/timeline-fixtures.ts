import type {
  SessionTaskCompletionEvent,
  SessionTimelineEntry,
  SessionTimelineEntryMessage,
  SessionTimelineEntryStatus,
} from '../../../runtime-host/shared/session-adapter-types';
import { extractMessageText, normalizeOptionalString } from '../../../runtime-host/shared/chat-message-normalization';

export interface MessageTimelineMeta {
  entryId: string;
  sessionKey: string;
  laneKey: string;
  turnKey: string;
  status: SessionTimelineEntryStatus;
  timestamp?: number;
  runId?: string;
  agentId?: string;
  sequenceId?: number;
}

export interface RawMessage {
  role: 'user' | 'assistant' | 'system' | 'toolresult' | 'tool_result';
  content: unknown;
  timestamp?: number;
  id?: string;
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
  uniqueId?: string;
  status?: 'sending' | 'sent' | 'timeout' | 'error';
  streaming?: boolean;
  toolCallId?: string;
  tool_calls?: Array<Record<string, unknown>>;
  toolCalls?: Array<Record<string, unknown>>;
  toolName?: string;
  agentId?: string;
  parentMessageId?: string;
  metadata?: Record<string, unknown>;
  name?: string;
  requestId?: string;
  details?: unknown;
  toolStatuses?: Array<Record<string, unknown>>;
  taskCompletionEvents?: SessionTaskCompletionEvent[];
  isError?: boolean;
  _timeline?: MessageTimelineMeta;
  _attachedFiles?: Array<Record<string, unknown>>;
}

function buildTimelineMeta(entry: SessionTimelineEntry): MessageTimelineMeta {
  return {
    entryId: entry.entryId,
    sessionKey: entry.sessionKey,
    laneKey: entry.laneKey,
    turnKey: entry.turnKey,
    status: entry.status,
    ...(entry.timestamp != null ? { timestamp: entry.timestamp } : {}),
    ...(entry.runId ? { runId: entry.runId } : {}),
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    ...(entry.sequenceId != null ? { sequenceId: entry.sequenceId } : {}),
  };
}

function normalizeIdentifier(value: string | null | undefined): string {
  return normalizeOptionalString(value) ?? '';
}

function resolveTimelineEntryStatus(message: RawMessage): SessionTimelineEntryStatus {
  if (message.streaming) {
    return 'streaming';
  }
  if (message.isError || message.status === 'error') {
    return 'error';
  }
  if (message.status === 'sending' || message.status === 'timeout') {
    return 'pending';
  }
  return 'final';
}

function resolveTimelineEntryId(message: RawMessage, index: number): string {
  return normalizeIdentifier(
    message.messageId
    ?? message.id
    ?? message.uniqueId
    ?? message.requestId
    ?? message.clientId,
  ) || `entry-${index}`;
}

function resolveTimelineLaneKey(message: RawMessage): string {
  const agentId = normalizeIdentifier(message.agentId);
  return agentId ? `member:${agentId}` : 'main';
}

function resolveTimelineTurnKey(message: RawMessage, entryId: string): string {
  const turnIdentity = normalizeIdentifier(
    message.uniqueId
    ?? message.requestId
    ?? message.clientId
    ?? message.messageId
    ?? message.id
    ?? message.originMessageId,
  );
  return turnIdentity || `entry:${entryId}`;
}

function toTimelineEntryMessage(message: RawMessage): SessionTimelineEntryMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
    ...(message.id ? { id: message.id } : {}),
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(message.originMessageId ? { originMessageId: message.originMessageId } : {}),
    ...(message.clientId ? { clientId: message.clientId } : {}),
    ...(message.uniqueId ? { uniqueId: message.uniqueId } : {}),
    ...(message.requestId ? { requestId: message.requestId } : {}),
    ...(message.status ? { status: message.status } : {}),
    ...(message.streaming != null ? { streaming: message.streaming } : {}),
    ...(message.agentId ? { agentId: message.agentId } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(message.metadata ? { metadata: message.metadata } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(message.details !== undefined ? { details: message.details } : {}),
    ...(message.toolStatuses ? {
      toolStatuses: message.toolStatuses.map((toolStatus) => ({ ...toolStatus })),
    } : {}),
    ...(message.taskCompletionEvents ? {
      taskCompletionEvents: message.taskCompletionEvents.map((event) => ({ ...event })),
    } : {}),
    ...(message.isError != null ? { isError: message.isError } : {}),
    ...(message._attachedFiles ? {
      _attachedFiles: message._attachedFiles.map((file) => ({ ...file })),
    } : {}),
  };
}

export function buildTimelineEntryFromMessage(
  sessionKey: string,
  message: RawMessage,
  index: number,
): SessionTimelineEntry {
  const timeline = message._timeline ?? null;
  if (timeline) {
    return {
      entryId: timeline.entryId,
      sessionKey: timeline.sessionKey || sessionKey,
      laneKey: timeline.laneKey,
      turnKey: timeline.turnKey,
      role: message.role,
      status: timeline.status,
      ...(timeline.timestamp != null
        ? { timestamp: timeline.timestamp }
        : (message.timestamp != null ? { timestamp: message.timestamp } : {})),
      ...(timeline.runId ? { runId: timeline.runId } : {}),
      ...(timeline.agentId ? { agentId: timeline.agentId } : (message.agentId ? { agentId: message.agentId } : {})),
      ...(timeline.sequenceId != null ? { sequenceId: timeline.sequenceId } : {}),
      text: extractMessageText(message.content),
      message: toTimelineEntryMessage(message),
    };
  }

  const entryId = resolveTimelineEntryId(message, index);
  const laneKey = resolveTimelineLaneKey(message);
  return {
    entryId,
    sessionKey,
    laneKey,
    turnKey: resolveTimelineTurnKey(message, entryId),
    role: message.role,
    status: resolveTimelineEntryStatus(message),
    ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
    ...(message.agentId ? { agentId: message.agentId } : {}),
    text: extractMessageText(message.content),
    message: toTimelineEntryMessage(message),
  };
}

export function buildTimelineEntriesFromMessages(
  sessionKey: string,
  messages: RawMessage[],
): SessionTimelineEntry[] {
  return messages.map((message, index) => buildTimelineEntryFromMessage(sessionKey, message, index));
}

export function materializeTimelineMessage(entry: SessionTimelineEntry): RawMessage {
  return {
    ...entry.message,
    ...(entry.agentId && !entry.message.agentId ? { agentId: entry.agentId } : {}),
    ...(entry.status === 'streaming'
      ? { streaming: true }
      : (entry.message.streaming ? { streaming: false } : {})),
    _timeline: buildTimelineMeta(entry),
  };
}

export function materializeTimelineMessages(
  entries: SessionTimelineEntry[],
): RawMessage[] {
  return entries.map((entry) => materializeTimelineMessage(entry));
}
