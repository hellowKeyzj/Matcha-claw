import type { SessionTimelineEntry, SessionTimelineEntryStatus } from '../../shared/session-adapter-types';
import { normalizeMessageRole } from '../../shared/chat-message-normalization';
import {
  buildTimelineEntriesFromTranscriptMessage,
  resolveSessionLaneKey,
  type SessionTranscriptMessage,
} from './transcript-utils';
import { normalizeTaskCompletionEvents } from './task-completion-events';

interface GatewayConversationMessagePayload {
  state?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  sequenceId?: unknown;
  agentId?: unknown;
  message?: unknown;
}

interface GatewayConversationLifecyclePayload {
  phase?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
}

interface GatewayConversationToolLifecyclePayload {
  phase?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  sequenceId?: unknown;
  timestamp?: unknown;
  toolCallId?: unknown;
  name?: unknown;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: unknown;
}

export interface SessionInfoIngressEvent {
  sessionUpdate: 'session_info_update';
  sessionKey: string | null;
  runId: string | null;
  phase: 'started' | 'final' | 'error' | 'aborted' | 'unknown';
  _meta?: Record<string, unknown>;
}

export interface SessionTimelineIngressEvent {
  sessionUpdate: 'agent_message_chunk' | 'agent_message';
  sessionKey: string | null;
  runId: string | null;
  laneKey: string;
  entries: SessionTimelineEntry[];
  _meta?: Record<string, unknown>;
}

export type GatewaySessionIngressEvent =
  | SessionInfoIngressEvent
  | SessionTimelineIngressEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeSessionPhase(value: unknown): 'started' | 'final' | 'error' | 'aborted' | 'unknown' {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'started' || normalized === 'start') {
    return 'started';
  }
  if (normalized === 'completed' || normalized === 'done' || normalized === 'finished' || normalized === 'final' || normalized === 'end') {
    return 'final';
  }
  if (normalized === 'error' || normalized === 'failed') {
    return 'error';
  }
  if (normalized === 'aborted' || normalized === 'abort' || normalized === 'cancelled' || normalized === 'canceled') {
    return 'aborted';
  }
  return 'unknown';
}

function normalizeTimelineEntryStatus(value: unknown): SessionTimelineEntryStatus {
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

function normalizeToolLifecyclePhase(value: unknown): 'start' | 'update' | 'result' | null {
  const normalized = normalizeString(value);
  if (normalized === 'start' || normalized === 'update' || normalized === 'result') {
    return normalized;
  }
  return null;
}

function resolveToolLifecycleStatus(input: {
  phase: 'start' | 'update' | 'result';
  isError: boolean;
}): 'running' | 'completed' | 'error' {
  if (input.phase !== 'result') {
    return 'running';
  }
  return input.isError ? 'error' : 'completed';
}

function buildMemberMeta(agentId: string): Record<string, unknown> | undefined {
  if (!agentId) {
    return undefined;
  }
  return {
    'codebuddy.ai/memberEvent': agentId,
  };
}

function resolveExistingToolName(
  entries: ReadonlyArray<SessionTimelineEntry> | undefined,
  toolCallId: string,
): string {
  if (!entries || !toolCallId) {
    return '';
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || (entry.kind !== 'message' && entry.kind !== 'tool-activity')) {
      continue;
    }
    const toolName = entry.toolCards.find((tool) => (
      tool.toolCallId === toolCallId || tool.id === toolCallId
    ))?.name;
    if (toolName) {
      return toolName;
    }
    const toolUseName = entry.toolUses.find((toolUse) => (
      toolUse.toolCallId === toolCallId || toolUse.id === toolCallId
    ))?.name;
    if (toolUseName) {
      return toolUseName;
    }
    const toolStatusName = entry.toolStatuses.find((toolStatus) => (
      toolStatus.toolCallId === toolCallId || toolStatus.id === toolCallId
    ))?.name;
    if (toolStatusName) {
      return toolStatusName;
    }
  }
  return '';
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

function buildToolLifecycleMessage(input: {
  runId: string;
  sequenceId: number;
  timestamp: number;
  phase: 'start' | 'update' | 'result';
  toolCallId: string;
  name?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError: boolean;
}): SessionTranscriptMessage {
  const toolStatus = {
    id: input.toolCallId,
    toolCallId: input.toolCallId,
    ...(input.name ? { name: input.name } : {}),
    status: resolveToolLifecycleStatus({
      phase: input.phase,
      isError: input.isError,
    }),
    phase: input.phase,
    ...(Object.prototype.hasOwnProperty.call(input, 'partialResult') ? { partialResult: input.partialResult } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'result') ? { result: input.result } : {}),
    isError: input.isError,
    updatedAt: input.timestamp,
  };

  return {
    role: 'assistant',
    id: `run:${input.runId}:tool:${input.toolCallId}`,
    content: input.phase === 'start'
      ? [{
          type: 'toolCall',
          id: input.toolCallId,
          name: input.name,
          input: input.args,
        }]
      : '',
    timestamp: input.timestamp,
    toolCallId: input.toolCallId,
    ...(input.name ? { toolName: input.name } : {}),
    toolStatuses: [toolStatus],
    isError: input.isError,
  };
}

function normalizeToolLifecyclePayload(
  payload: GatewayConversationToolLifecyclePayload,
  options: {
    existingEntries?: ReadonlyArray<SessionTimelineEntry>;
  } = {},
): { sessionKey: string; runId: string; sequenceId: number; phase: 'start' | 'update' | 'result'; message: SessionTranscriptMessage } | null {
  const phase = normalizeToolLifecyclePhase(payload.phase);
  const runId = normalizeString(payload.runId);
  const sessionKey = normalizeString(payload.sessionKey);
  const sequenceId = normalizeFiniteNumber(payload.sequenceId);
  const timestamp = normalizeFiniteNumber(payload.timestamp);
  const toolCallId = normalizeString(payload.toolCallId);
  const name = normalizeString(payload.name)
    || resolveExistingToolName(options.existingEntries, toolCallId);
  if (!phase || !runId || !sessionKey || sequenceId == null || timestamp == null || !toolCallId) {
    return null;
  }
  if (phase === 'start' && !name) {
    return null;
  }

  const message = buildToolLifecycleMessage({
    runId,
    sequenceId,
    timestamp,
    phase,
    toolCallId,
    ...(name ? { name } : {}),
    ...(Object.prototype.hasOwnProperty.call(payload, 'args') ? { args: payload.args } : {}),
    ...(Object.prototype.hasOwnProperty.call(payload, 'partialResult') ? { partialResult: payload.partialResult } : {}),
    ...(Object.prototype.hasOwnProperty.call(payload, 'result') ? { result: payload.result } : {}),
    isError: payload.isError === true,
  });

  return {
    sessionKey,
    runId,
    sequenceId,
    phase,
    message,
  };
}

export function buildSessionUpdateEventsFromGatewayConversationEvent(
  payload: unknown,
  options: {
    existingEntries?: SessionTimelineEntry[];
  } = {},
): GatewaySessionIngressEvent[] {
  const input = isRecord(payload) ? payload : null;
  if (!input) {
    return [];
  }

  if (input.type === 'run.phase') {
    const lifecyclePayload = input as GatewayConversationLifecyclePayload;
    const sessionKey = normalizeString(lifecyclePayload.sessionKey) || null;
    const runId = normalizeString(lifecyclePayload.runId) || null;
    const phase = normalizeSessionPhase(lifecyclePayload.phase);
    return [{
      sessionUpdate: 'session_info_update',
      sessionKey,
      runId,
      phase,
    }];
  }

  if (input.type === 'tool.lifecycle') {
    const toolLifecycle = normalizeToolLifecyclePayload(input.event as GatewayConversationToolLifecyclePayload, {
      existingEntries: options.existingEntries,
    });
    if (!toolLifecycle) {
      return [];
    }
    const entries = buildTimelineEntriesFromTranscriptMessage(
      toolLifecycle.sessionKey,
      toolLifecycle.message,
      {
        runId: toolLifecycle.runId,
        sequenceId: toolLifecycle.sequenceId,
        status: toolLifecycle.phase === 'result'
          ? (toolLifecycle.message.isError ? 'error' : 'final')
          : 'streaming',
        index: 0,
        existingRows: options.existingEntries,
      },
    );
    if (entries.length === 0) {
      return [];
    }
    return [{
      sessionUpdate: 'agent_message_chunk',
      sessionKey: toolLifecycle.sessionKey,
      runId: toolLifecycle.runId,
      laneKey: entries[0]?.laneKey ?? 'main',
      entries,
    }];
  }

  if (input.type !== 'chat.message') {
    return [];
  }

  const conversation = normalizeConversationMessagePayload(input.event as GatewayConversationMessagePayload);
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
  if (conversation.status === 'streaming') {
    return [{
      sessionUpdate: 'agent_message_chunk',
      sessionKey: conversation.sessionKey,
      runId: conversation.runId,
      laneKey,
      entries,
      ...(meta ? { _meta: meta } : {}),
    }];
  }
  return [{
    sessionUpdate: 'agent_message',
    sessionKey: conversation.sessionKey,
    runId: conversation.runId,
    laneKey,
    entries,
    ...(meta ? { _meta: meta } : {}),
  }];
}
