import type { SessionRenderRow, SessionRowStatus } from '../../shared/session-adapter-types';
import {
  buildRowsFromTranscriptMessage,
  resolveSessionLaneKey,
  type SessionTranscriptMessage,
} from './transcript-utils';
import { normalizeTaskCompletionEvents } from './task-completion-events';

interface GatewayConversationMessagePayload {
  state?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  sequenceId?: unknown;
  requestId?: unknown;
  uniqueId?: unknown;
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

export interface SessionRowIngressEvent {
  sessionUpdate: 'agent_message_chunk' | 'agent_message';
  sessionKey: string | null;
  runId: string | null;
  laneKey: string;
  rows: SessionRenderRow[];
  _meta?: Record<string, unknown>;
}

export type GatewaySessionIngressEvent =
  | SessionInfoIngressEvent
  | SessionRowIngressEvent;

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

function normalizeSessionRowStatus(value: unknown): SessionRowStatus {
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

function normalizeConversationMessagePayload(
  payload: GatewayConversationMessagePayload,
): { sessionKey: string | null; runId: string | null; sequenceId?: number; message: SessionTranscriptMessage | null; status: SessionRowStatus } {
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
      status: normalizeSessionRowStatus(state),
    };
  }

  const role = normalizeString(rawMessage.role) as SessionTranscriptMessage['role'];
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
    ...(normalizeString(rawMessage.uniqueId ?? payload.uniqueId) ? { uniqueId: normalizeString(rawMessage.uniqueId ?? payload.uniqueId) } : {}),
    ...(normalizeString(rawMessage.requestId ?? payload.requestId) ? { requestId: normalizeString(rawMessage.requestId ?? payload.requestId) } : {}),
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
    status: normalizeSessionRowStatus(state),
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
): { sessionKey: string; runId: string; sequenceId: number; phase: 'start' | 'update' | 'result'; message: SessionTranscriptMessage } | null {
  const phase = normalizeToolLifecyclePhase(payload.phase);
  const runId = normalizeString(payload.runId);
  const sessionKey = normalizeString(payload.sessionKey);
  const sequenceId = normalizeFiniteNumber(payload.sequenceId);
  const timestamp = normalizeFiniteNumber(payload.timestamp);
  const toolCallId = normalizeString(payload.toolCallId);
  const name = normalizeString(payload.name);
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
    existingRows?: SessionRenderRow[];
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
    const toolLifecycle = normalizeToolLifecyclePayload(input.event as GatewayConversationToolLifecyclePayload);
    if (!toolLifecycle) {
      return [];
    }
    const rows = buildRowsFromTranscriptMessage(
      toolLifecycle.sessionKey,
      toolLifecycle.message,
      {
        runId: toolLifecycle.runId,
        sequenceId: toolLifecycle.sequenceId,
        status: toolLifecycle.phase === 'result'
          ? (toolLifecycle.message.isError ? 'error' : 'final')
          : 'streaming',
        index: 0,
        existingRows: options.existingRows,
      },
    );
    if (rows.length === 0) {
      return [];
    }
    return [{
      sessionUpdate: 'agent_message_chunk',
      sessionKey: toolLifecycle.sessionKey,
      runId: toolLifecycle.runId,
      laneKey: rows[0]?.laneKey ?? 'main',
      rows,
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
  const rows = buildRowsFromTranscriptMessage(
    conversation.sessionKey ?? '',
    conversation.message,
    {
      runId: conversation.runId ?? undefined,
      sequenceId: conversation.sequenceId,
      status: conversation.status,
      index: 0,
      existingRows: options.existingRows,
    },
  );
  if (rows.length === 0) {
    return [];
  }
  const meta = buildMemberMeta(normalizeString(conversation.message.agentId));
  if (conversation.status === 'streaming') {
    return [{
      sessionUpdate: 'agent_message_chunk',
      sessionKey: conversation.sessionKey,
      runId: conversation.runId,
      laneKey,
      rows,
      ...(meta ? { _meta: meta } : {}),
    }];
  }
  return [{
    sessionUpdate: 'agent_message',
    sessionKey: conversation.sessionKey,
    runId: conversation.runId,
    laneKey,
    rows,
    ...(meta ? { _meta: meta } : {}),
  }];
}
