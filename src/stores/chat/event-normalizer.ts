import {
  normalizeRawChatMessage,
  resolveNormalizedMessageIdentity,
} from '../../../runtime-host/shared/chat-message-normalization';
import { asRecord } from './value';
import type { ChatRuntimeEventPhase } from './types';

export type GatewayConversationRunPhase = 'started' | 'completed' | 'error' | 'aborted';
export type ChatRuntimePhase = ChatRuntimeEventPhase;

export interface ChatMessageDomainEvent {
  kind: 'chat.message';
  source: 'chat.message';
  phase: ChatRuntimePhase;
  runId: string | null;
  sessionKey: string | null;
  event: Record<string, unknown>;
}

export interface ChatRuntimeLifecycleDomainEvent {
  kind: 'chat.runtime.lifecycle';
  source: 'run.phase';
  phase: ChatRuntimePhase;
  runId: string | null;
  sessionKey: string | null;
  event: Record<string, unknown>;
}

export interface ChatApprovalRequestedDomainEvent {
  kind: 'chat.approval.requested';
  runId: string | null;
  sessionKey: string | null;
  payload: Record<string, unknown>;
}

export interface ChatApprovalResolvedDomainEvent {
  kind: 'chat.approval.resolved';
  runId: string | null;
  sessionKey: string | null;
  payload: Record<string, unknown>;
}

export type ChatDomainEvent =
  | ChatMessageDomainEvent
  | ChatRuntimeLifecycleDomainEvent
  | ChatApprovalRequestedDomainEvent
  | ChatApprovalResolvedDomainEvent;

export interface NormalizedConversationIngressEvent {
  kind: 'chat.message' | 'chat.runtime.lifecycle';
  phase: ChatRuntimePhase;
  runId: string;
  sessionKey: string | null;
  event: Record<string, unknown>;
  message: unknown;
}

const RUNTIME_INGRESS_MESSAGE_NORMALIZE_OPTIONS = {
  fallbackOriginMessageIdToParentMessageId: true,
  fallbackRequestIdToClientId: true,
} as const;
function normalizeRunPhase(phaseRaw: unknown): GatewayConversationRunPhase | null {
  const phase = typeof phaseRaw === 'string' ? phaseRaw.trim().toLowerCase() : '';
  if (!phase) {
    return null;
  }
  if (phase === 'started' || phase === 'start') {
    return 'started';
  }
  if (phase === 'completed' || phase === 'done' || phase === 'finished' || phase === 'end') {
    return 'completed';
  }
  if (phase === 'error' || phase === 'failed') {
    return 'error';
  }
  if (phase === 'aborted' || phase === 'abort' || phase === 'cancelled' || phase === 'canceled') {
    return 'aborted';
  }
  return null;
}

function normalizeChatEventState(rawState: string): string {
  const normalized = rawState.trim().toLowerCase();
  if (!normalized) {
    return normalized;
  }
  if (normalized === 'completed' || normalized === 'done' || normalized === 'finished' || normalized === 'end') {
    return 'final';
  }
  return normalized;
}

function resolveRuntimePhaseFromState(state: string): ChatRuntimePhase {
  const normalized = normalizeChatEventState(state);
  if (normalized === 'started' || normalized === 'delta' || normalized === 'final' || normalized === 'error' || normalized === 'aborted') {
    return normalized;
  }
  return 'unknown';
}

function normalizeIdentifier(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeSequenceLaneRole(role: unknown): 'user' | 'assistant' | 'system' | null {
  const normalized = typeof role === 'string' ? role.trim().toLowerCase() : '';
  if (normalized === 'toolresult' || normalized === 'tool_result' || normalized === 'assistant') {
    return 'assistant';
  }
  if (normalized === 'user' || normalized === 'system') {
    return normalized;
  }
  return null;
}

function normalizeSequenceId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = Number(value.trim());
    return Number.isFinite(normalized) ? normalized : null;
  }
  return null;
}

export function normalizeConversationMessageSequenceId(value: unknown): number | null {
  return normalizeSequenceId(value);
}
function normalizeStructuredChatMessageEvent(data: unknown): Record<string, unknown> | null {
  const candidate = asRecord(data);
  if (!candidate) {
    return null;
  }
  const rawState = typeof candidate.state === 'string' ? candidate.state : '';
  const state = normalizeChatEventState(rawState);
  if (!state) {
    return null;
  }

  const rawMessage = candidate.message;
  if (rawMessage !== undefined && (typeof rawMessage !== 'object' || rawMessage == null || Array.isArray(rawMessage))) {
    return null;
  }

  const runId = typeof candidate.runId === 'string' ? candidate.runId.trim() : '';
  const sessionKey = typeof candidate.sessionKey === 'string' ? candidate.sessionKey.trim() : '';
  const sequenceId = normalizeSequenceId(candidate.sequenceId ?? candidate.sequence_id);
  const requestId = normalizeIdentifier(candidate.requestId ?? candidate.request_id);
  const uniqueId = normalizeIdentifier(candidate.uniqueId ?? candidate.unique_id);
  const agentId = normalizeIdentifier(candidate.agentId ?? candidate.agent_id);
  const normalizedMessage = rawMessage
    ? normalizeRawChatMessage({
        ...(rawMessage as Record<string, unknown>),
        ...(requestId ? { requestId } : {}),
        ...(uniqueId ? { uniqueId } : {}),
        ...(agentId ? { agentId } : {}),
      }, RUNTIME_INGRESS_MESSAGE_NORMALIZE_OPTIONS)
    : rawMessage;

  return {
    ...candidate,
    state,
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(sequenceId != null ? { sequenceId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(uniqueId ? { uniqueId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(normalizedMessage ? { message: normalizedMessage } : {}),
  };
}

export function buildConversationMessageSequenceKey(event: Record<string, unknown>, message: unknown): string | null {
  const eventRecord = event as Record<string, unknown>;
  const messageRecord = (message && typeof message === 'object' && !Array.isArray(message))
    ? message as Record<string, unknown>
    : null;
  const sessionKey = normalizeIdentifier(eventRecord.sessionKey);
  const normalizedMessage = messageRecord
    ? normalizeRawChatMessage({
        ...messageRecord,
        ...(normalizeIdentifier(eventRecord.requestId ?? eventRecord.request_id)
          ? { requestId: normalizeIdentifier(eventRecord.requestId ?? eventRecord.request_id) }
          : {}),
        ...(normalizeIdentifier(eventRecord.uniqueId ?? eventRecord.unique_id)
          ? { uniqueId: normalizeIdentifier(eventRecord.uniqueId ?? eventRecord.unique_id) }
          : {}),
        ...(normalizeIdentifier(eventRecord.agentId ?? eventRecord.agent_id)
          ? { agentId: normalizeIdentifier(eventRecord.agentId ?? eventRecord.agent_id) }
          : {}),
      }, RUNTIME_INGRESS_MESSAGE_NORMALIZE_OPTIONS)
    : null;
  const identity = resolveNormalizedMessageIdentity(normalizedMessage ?? undefined, {
    fallbackMessageIdToId: true,
    fallbackOriginMessageIdToParentMessageId: true,
    fallbackRequestIdToClientId: true,
  });
  const sequenceIdentity = identity.uniqueId || identity.clientId || identity.requestId || identity.messageId || identity.id;
  const laneRole = normalizeSequenceLaneRole(normalizedMessage?.role ?? eventRecord.role);
  if (!sessionKey || !sequenceIdentity || !laneRole) {
    return null;
  }
  return [sessionKey, laneRole, sequenceIdentity, identity.agentId ?? ''].join('|');
}

function mapRunPhaseToChatEvent(
  input: Record<string, unknown>,
  phase: GatewayConversationRunPhase,
  runId?: string,
  sessionKey?: string,
): Record<string, unknown> {
  const state = phase === 'completed' ? 'final' : phase;
  const errorMessage = phase === 'error'
    ? (typeof input.errorMessage === 'string' ? input.errorMessage : (typeof input.message === 'string' ? input.message : undefined))
    : undefined;
  return {
    state,
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

export type ChatConversationDomainEvent =
  | ChatMessageDomainEvent
  | ChatRuntimeLifecycleDomainEvent;

export function normalizeConversationIngressDomainEvent(
  payload: unknown,
): NormalizedConversationIngressEvent | null {
  const input = asRecord(payload);
  if (!input) {
    return null;
  }
  const kind = input.kind;
  if (kind !== 'chat.message' && kind !== 'chat.runtime.lifecycle') {
    return null;
  }
  const phase = input.phase;
  if (
    phase !== 'started'
    && phase !== 'delta'
    && phase !== 'final'
    && phase !== 'error'
    && phase !== 'aborted'
    && phase !== 'unknown'
  ) {
    return null;
  }
  const event = asRecord(input.event);
  if (!event) {
    return null;
  }
  const runId = normalizeIdentifier(input.runId) ?? '';
  const sessionKey = normalizeIdentifier(input.sessionKey);
  const normalizedEvent = kind === 'chat.message'
    ? normalizeStructuredChatMessageEvent(event)
    : {
        ...event,
        ...(typeof event.state === 'string' ? { state: normalizeChatEventState(event.state) } : {}),
        ...(runId ? { runId } : {}),
        ...(sessionKey ? { sessionKey } : {}),
      };
  if (!normalizedEvent) {
    return null;
  }
  return {
    kind,
    phase,
    runId,
    sessionKey,
    event: normalizedEvent,
    message: normalizedEvent.message,
  };
}

export function normalizeBufferedConversationMessageEvent(
  event: Record<string, unknown>,
): NormalizedConversationIngressEvent | null {
  const normalizedEvent = normalizeStructuredChatMessageEvent(event);
  if (!normalizedEvent) {
    return null;
  }
  const runId = normalizeIdentifier(normalizedEvent.runId) ?? '';
  const sessionKey = normalizeIdentifier(normalizedEvent.sessionKey);
  const eventState = typeof normalizedEvent.state === 'string' ? normalizedEvent.state : '';
  return {
    kind: 'chat.message',
    phase: resolveRuntimePhaseFromState(eventState),
    runId,
    sessionKey,
    event: normalizedEvent,
    message: normalizedEvent.message,
  };
}
export function normalizeGatewayConversationEvent(payload: unknown): ChatConversationDomainEvent | null {
  const input = asRecord(payload);
  if (!input) {
    return null;
  }

  if (input.type === 'chat.message') {
    const event = normalizeStructuredChatMessageEvent(input.event);
    if (!event) {
      return null;
    }
    const runId = normalizeIdentifier(event.runId);
    const sessionKey = normalizeIdentifier(event.sessionKey);
    const eventState = typeof event.state === 'string' ? event.state : '';
    return {
      kind: 'chat.message',
      source: 'chat.message',
      phase: resolveRuntimePhaseFromState(eventState),
      runId,
      sessionKey,
      event,
    };
  }

  if (input.type === 'run.phase') {
    const phase = normalizeRunPhase(input.phase);
    if (!phase) {
      return null;
    }
    const runId = normalizeIdentifier(input.runId);
    const sessionKey = normalizeIdentifier(input.sessionKey);
    if (phase === 'started' && (!runId || !sessionKey)) {
      return null;
    }
    const event = mapRunPhaseToChatEvent(input, phase, runId ?? undefined, sessionKey ?? undefined);
    return {
      kind: 'chat.runtime.lifecycle',
      source: 'run.phase',
      phase: phase === 'completed' ? 'final' : phase,
      runId,
      sessionKey,
      event,
    };
  }

  return null;
}

function normalizeApprovalPayload(inputParams: Record<string, unknown>): Record<string, unknown> {
  const request = (inputParams.request && typeof inputParams.request === 'object')
    ? inputParams.request as Record<string, unknown>
    : undefined;
  const data = (inputParams.data && typeof inputParams.data === 'object')
    ? inputParams.data as Record<string, unknown>
    : undefined;
  const sessionKey = inputParams.sessionKey ?? data?.sessionKey ?? request?.sessionKey;
  const runId = inputParams.runId ?? data?.runId ?? request?.runId;
  const toolName = inputParams.toolName ?? data?.toolName ?? request?.toolName;
  const createdAt = inputParams.createdAt ?? data?.createdAt ?? request?.createdAt;
  const expiresAt = inputParams.expiresAt ?? data?.expiresAt ?? request?.expiresAt;
  return {
    ...inputParams,
    ...(request ? { request } : {}),
    ...(sessionKey != null ? { sessionKey } : {}),
    ...(runId != null ? { runId } : {}),
    ...(toolName != null ? { toolName } : {}),
    ...(createdAt != null ? { createdAt } : {}),
    ...(expiresAt != null ? { expiresAt } : {}),
  };
}

export function normalizeGatewayNotificationEvent(payload: unknown): ChatDomainEvent | null {
  const input = asRecord(payload);
  if (!input) {
    return null;
  }
  const method = typeof input.method === 'string' ? input.method : '';
  const params = asRecord(input.params);
  if (!method || !params) {
    return null;
  }
  if (method === 'exec.approval.requested') {
    const normalizedPayload = normalizeApprovalPayload(params);
    return {
      kind: 'chat.approval.requested',
      runId: normalizeIdentifier(normalizedPayload.runId),
      sessionKey: normalizeIdentifier(normalizedPayload.sessionKey),
      payload: normalizedPayload,
    };
  }
  if (method === 'exec.approval.resolved') {
    const normalizedPayload = normalizeApprovalPayload(params);
    return {
      kind: 'chat.approval.resolved',
      runId: normalizeIdentifier(normalizedPayload.runId),
      sessionKey: normalizeIdentifier(normalizedPayload.sessionKey),
      payload: normalizedPayload,
    };
  }
  return null;
}
