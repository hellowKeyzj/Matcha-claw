import type {
  SessionMessageRole,
  SessionRenderItem,
  SessionTimelineEntry,
  SessionTimelineEntryStatus,
  SessionTaskCompletionEvent,
  SessionTurnBindingConfidence,
  SessionTurnBindingSource,
  SessionTurnIdentityConfidence,
  SessionTurnIdentityMode,
} from '../../../runtime-host/shared/session-adapter-types';
import { extractMessageText, normalizeOptionalString } from '../../../runtime-host/shared/chat-message-normalization';
import { buildCanonicalReplayEventsFromTranscriptMessages } from '../../../runtime-host/application/sessions/canonical/canonical-transcript-replay';
import { buildRenderItemsFromCanonicalState, buildTimelineEntriesFromCanonicalState } from '../../../runtime-host/application/sessions/canonical/canonical-projection';
import { createEmptyCanonicalSessionState, reduceCanonicalSessionEvents } from '../../../runtime-host/application/sessions/canonical/canonical-reducer';
import { createOpenClawTestRuntimeContext, openClawTestRuntimeIdentity } from './runtime-address-fixtures';
import type { SessionTranscriptMessage } from '../../../runtime-host/application/sessions/transcript-types';

export interface MessageTimelineMeta {
  entryId: string;
  sessionKey: string;
  laneKey: string;
  turnKey: string;
  turnBindingSource: SessionTurnBindingSource;
  turnBindingConfidence: SessionTurnBindingConfidence;
  turnIdentityMode: SessionTurnIdentityMode;
  turnIdentityConfidence: SessionTurnIdentityConfidence;
  status: SessionTimelineEntryStatus;
  timestamp?: number;
  runId?: string;
  agentId?: string;
  sequenceId?: number;
}

export interface RawMessage {
  role: SessionMessageRole;
  content: unknown;
  timestamp?: number;
  id?: string;
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
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
  details?: unknown;
  taskCompletionEvents?: SessionTaskCompletionEvent[];
  isError?: boolean;
  _timeline?: MessageTimelineMeta;
  _attachedFiles?: Array<Record<string, unknown>>;
}

export interface TimelineFixtureEntry {
  entryId: string;
  sessionKey: string;
  laneKey: string;
  turnKey: string;
  turnBindingSource?: SessionTurnBindingSource;
  turnBindingConfidence?: SessionTurnBindingConfidence;
  turnIdentityMode?: SessionTurnIdentityMode;
  turnIdentityConfidence?: SessionTurnIdentityConfidence;
  role: SessionMessageRole;
  status: SessionTimelineEntryStatus;
  timestamp?: number;
  runId?: string;
  agentId?: string;
  sequenceId?: number;
  text: string;
  message: RawMessage;
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
    ?? message.clientId,
  ) || `entry-${index}`;
}

function resolveTimelineLaneKey(message: RawMessage): string {
  const agentId = normalizeIdentifier(message.agentId);
  return agentId ? `member:${agentId}` : 'main';
}

function resolveTimelineTurnBinding(message: RawMessage): {
  key: string;
  source: SessionTurnBindingSource;
  confidence: SessionTurnIdentityConfidence;
  mode: SessionTurnIdentityMode;
} {
  const runId = normalizeIdentifier(message._timeline?.runId);
  if (runId) {
    return { key: runId, source: 'run', mode: 'run', confidence: 'strong' };
  }
  const messageId = normalizeIdentifier(message.messageId);
  if (messageId) {
    return { key: messageId, source: 'message', mode: 'message', confidence: 'strong' };
  }
  const originMessageId = normalizeIdentifier(message.originMessageId);
  if (originMessageId) {
    return { key: originMessageId, source: 'origin', mode: 'origin', confidence: 'fallback' };
  }
  const clientId = normalizeIdentifier(message.clientId);
  if (clientId) {
    return { key: clientId, source: 'client', mode: 'client', confidence: 'fallback' };
  }
  return { key: '', source: 'heuristic', mode: 'heuristic', confidence: 'fallback' };
}

function resolveTimelineTurnKey(message: RawMessage, entryId: string): string {
  const binding = resolveTimelineTurnBinding(message);
  return binding.key ? binding.key : `entry:${entryId}`;
}

function toTranscriptMessage(message: RawMessage): SessionTranscriptMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
    ...(message.id ? { id: message.id } : {}),
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(message.originMessageId ? { originMessageId: message.originMessageId } : {}),
    ...(message.clientId ? { clientId: message.clientId } : {}),
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
): TimelineFixtureEntry {
  const timeline = message._timeline ?? null;
  if (timeline) {
    return {
      entryId: timeline.entryId,
      sessionKey: timeline.sessionKey || sessionKey,
      laneKey: timeline.laneKey,
      turnKey: timeline.turnKey,
      turnBindingSource: timeline.turnBindingSource,
      turnBindingConfidence: timeline.turnBindingConfidence,
      turnIdentityMode: timeline.turnIdentityMode,
      turnIdentityConfidence: timeline.turnIdentityConfidence,
      role: message.role,
      status: timeline.status,
      ...(timeline.timestamp != null
        ? { timestamp: timeline.timestamp }
        : (message.timestamp != null ? { timestamp: message.timestamp } : {})),
      ...(timeline.runId ? { runId: timeline.runId } : {}),
      ...(timeline.agentId ? { agentId: timeline.agentId } : (message.agentId ? { agentId: message.agentId } : {})),
      ...(timeline.sequenceId != null ? { sequenceId: timeline.sequenceId } : {}),
      text: extractMessageText(message.content),
      message: { ...message },
    };
  }

  const entryId = resolveTimelineEntryId(message, index);
  const laneKey = resolveTimelineLaneKey(message);
  const binding = resolveTimelineTurnBinding(message);
  return {
    entryId,
    sessionKey,
    laneKey,
    turnKey: resolveTimelineTurnKey(message, entryId),
    turnBindingSource: binding.source,
    turnBindingConfidence: binding.confidence,
    turnIdentityMode: binding.mode,
    turnIdentityConfidence: binding.confidence,
    role: message.role,
    status: resolveTimelineEntryStatus(message),
    ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
    ...(message.agentId ? { agentId: message.agentId } : {}),
    text: extractMessageText(message.content),
    message: { ...message },
  };
}

export function buildTimelineEntriesFromMessages(
  sessionKey: string,
  messages: RawMessage[],
): TimelineFixtureEntry[] {
  return messages.map((message, index) => buildTimelineEntryFromMessage(sessionKey, message, index));
}

export function materializeTimelineMessage(entry: TimelineFixtureEntry): RawMessage {
  const timelineMeta: MessageTimelineMeta = {
    entryId: entry.entryId,
    sessionKey: entry.sessionKey,
    laneKey: entry.laneKey,
    turnKey: entry.turnKey,
    turnBindingSource: entry.turnBindingSource ?? 'heuristic',
    turnBindingConfidence: entry.turnBindingConfidence ?? 'fallback',
    turnIdentityMode: entry.turnIdentityMode ?? 'heuristic',
    turnIdentityConfidence: entry.turnIdentityConfidence ?? 'fallback',
    status: entry.status,
    ...(entry.timestamp != null ? { timestamp: entry.timestamp } : {}),
    ...(entry.runId ? { runId: entry.runId } : {}),
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    ...(entry.sequenceId != null ? { sequenceId: entry.sequenceId } : {}),
  };
  return {
    ...entry.message,
    ...(entry.agentId && !entry.message.agentId ? { agentId: entry.agentId } : {}),
    ...(entry.status === 'streaming'
      ? { streaming: true }
      : (entry.message.streaming ? { streaming: false } : {})),
    _timeline: timelineMeta,
  };
}

export function materializeTimelineMessages(
  entries: TimelineFixtureEntry[],
): RawMessage[] {
  return entries.map((entry) => materializeTimelineMessage(entry));
}

function buildCanonicalStateFromMessages(sessionKey: string, messages: RawMessage[]) {
  const state = createEmptyCanonicalSessionState(sessionKey, createOpenClawTestRuntimeContext(sessionKey));
  reduceCanonicalSessionEvents(
    state,
    buildCanonicalReplayEventsFromTranscriptMessages(sessionKey, messages.map((message) => toTranscriptMessage(message)), openClawTestRuntimeIdentity),
  );
  return state;
}

export function buildRenderableTimelineEntriesFromMessages(
  sessionKey: string,
  messages: RawMessage[],
): SessionTimelineEntry[] {
  return buildTimelineEntriesFromCanonicalState(buildCanonicalStateFromMessages(sessionKey, messages));
}

export function buildRenderItemsFromMessages(
  sessionKey: string,
  messages: RawMessage[],
): SessionRenderItem[] {
  return buildRenderItemsFromCanonicalState({
    state: buildCanonicalStateFromMessages(sessionKey, messages),
    executionGraphItems: [],
  });
}
