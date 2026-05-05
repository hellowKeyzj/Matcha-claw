import { asRecord } from './value';

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
  | ChatApprovalRequestedDomainEvent
  | ChatApprovalResolvedDomainEvent;

function normalizeIdentifier(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
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
