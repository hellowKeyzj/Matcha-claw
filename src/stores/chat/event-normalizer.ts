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

  return {
    ...candidate,
    state,
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function normalizeIdentifier(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
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
