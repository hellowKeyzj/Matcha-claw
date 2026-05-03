import type {
  SessionTimelineEntry,
  SessionTimelineEntryMessage,
  SessionTimelineEntryStatus,
} from '../../../runtime-host/shared/session-adapter-types';
import { extractMessageText, normalizeOptionalString } from '../../../runtime-host/shared/chat-message-normalization';
import type { MessageTimelineMeta, RawMessage } from './types';

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

export function attachTimelineMetaToMessage(
  message: SessionTimelineEntryMessage | RawMessage,
  entry: SessionTimelineEntry,
): RawMessage {
  const timeline = buildTimelineMeta(entry);
  const rawMessage = message as RawMessage;
  return {
    ...rawMessage,
    ...(entry.agentId && !rawMessage.agentId ? { agentId: entry.agentId } : {}),
    ...(entry.status === 'streaming'
      ? { streaming: true }
      : (rawMessage.streaming ? { streaming: false } : {})),
    _timeline: timeline,
  };
}

export function getMessageTimelineMeta(
  message: RawMessage | null | undefined,
): MessageTimelineMeta | null {
  return message?._timeline ?? null;
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
      toolStatuses: message.toolStatuses.map((toolStatus) => ({ ...toolStatus })) as Array<Record<string, unknown>>,
    } : {}),
    ...(message.isError != null ? { isError: message.isError } : {}),
    ...(message._attachedFiles ? {
      _attachedFiles: message._attachedFiles.map((file) => ({ ...file })) as Array<Record<string, unknown>>,
    } : {}),
  };
}

export function buildTimelineEntryFromMessage(
  sessionKey: string,
  message: RawMessage,
  index: number,
): SessionTimelineEntry {
  const timeline = getMessageTimelineMeta(message);
  if (timeline) {
    return {
      entryId: timeline.entryId,
      sessionKey: timeline.sessionKey || sessionKey,
      laneKey: timeline.laneKey,
      turnKey: timeline.turnKey,
      role: message.role,
      status: timeline.status,
      ...(timeline.timestamp != null ? { timestamp: timeline.timestamp } : (message.timestamp != null ? { timestamp: message.timestamp } : {})),
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

export function materializeTimelineMessages(
  entries: SessionTimelineEntry[],
): RawMessage[] {
  return entries.map((entry) => attachTimelineMetaToMessage(entry.message, entry));
}

export function materializeTimelineEntryMessage(
  entry: SessionTimelineEntry,
): RawMessage {
  return attachTimelineMetaToMessage(entry.message, entry);
}

export function materializeTimelineMessageRange(
  entries: SessionTimelineEntry[],
  start = 0,
  endExclusive = entries.length,
): RawMessage[] {
  const safeStart = Math.max(0, start);
  const safeEnd = Math.max(safeStart, Math.min(endExclusive, entries.length));
  if (safeStart === 0 && safeEnd === entries.length) {
    return materializeTimelineMessages(entries);
  }
  return materializeTimelineMessages(entries.slice(safeStart, safeEnd));
}

export function findLatestAssistantTextFromTimelineEntries(
  entries: SessionTimelineEntry[],
): string {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '';
  }

  let latestAssistant = '';
  for (const entry of entries) {
    if (entry.role !== 'assistant') {
      continue;
    }
    const text = (entry.text || extractMessageText(entry.message.content)).trim();
    if (text) {
      latestAssistant = text;
    }
  }
  if (latestAssistant) {
    return latestAssistant;
  }

  for (const entry of entries) {
    const text = (entry.text || extractMessageText(entry.message.content)).trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function readToolNamesFromEntryMessageBlock(block: unknown): string[] {
  if (!block || typeof block !== 'object') {
    return [];
  }
  const row = block as Record<string, unknown>;
  const type = typeof row.type === 'string' ? row.type.toLowerCase() : '';
  if (type === 'tool_use') {
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    return name ? [name] : [];
  }
  const toolName = typeof row.tool_name === 'string' ? row.tool_name.trim() : '';
  if (toolName) {
    return [toolName];
  }
  if (Array.isArray(row.tool_calls)) {
    return row.tool_calls
      .flatMap((item) => {
        if (!item || typeof item !== 'object') {
          return [];
        }
        const fnName = (item as { function?: { name?: unknown } }).function?.name;
        return typeof fnName === 'string' && fnName.trim().length > 0 ? [fnName.trim()] : [];
      });
  }
  return [];
}

export function findLatestAssistantSnapshotFromTimelineEntries(
  entries: SessionTimelineEntry[],
): { text: string; toolNames: string[] } {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { text: '', toolNames: [] };
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role !== 'assistant') {
      continue;
    }
    const text = (entry.text || extractMessageText(entry.message.content)).trim();
    const toolNames = Array.isArray(entry.message.content)
      ? entry.message.content.flatMap((block) => readToolNamesFromEntryMessageBlock(block))
      : [];
    if (text || toolNames.length > 0) {
      return { text, toolNames };
    }
  }

  return {
    text: findLatestAssistantTextFromTimelineEntries(entries),
    toolNames: [],
  };
}
