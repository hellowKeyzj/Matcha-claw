import { hasExactKeys, isRecord } from '../runtime-host-delivery/transport/client';
import type { LoopbackJsonResponse as PublicTransportResponse } from '../runtime-host-delivery/transport/client';
import { sameSessionIdentity as sameIdentity, type SessionIdentity } from '../runtime-host-delivery/transport/sessions/session-contract';
import type { SessionApprovalListRequest, SessionApprovalListTransportResponse, SessionApprovalRespondRequest } from '../runtime-host-delivery/transport/sessions/approvals';
import { hasAllowedKeys, isIdentifier, isSessionIdentity } from './request-validation';

type SessionApprovalListRouteRequest = Readonly<{
  native: SessionApprovalListRequest;
  identity: SessionIdentity & Readonly<{
    endpoint: Readonly<{
      kind: 'native-runtime';
      runtimeAdapterId: 'matcha-agent';
      runtimeInstanceId: 'local';
    }>;
  }>;
}>;

export function adaptSessionApprovalListRequest(body: Record<string, unknown>): SessionApprovalListRouteRequest {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'session.approval'
    || body.operationId !== 'approvals.list'
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'identity'])
    || body.scope.kind !== 'session'
    || !isSessionIdentity(body.scope.identity)
    || !isMatchaAgentIdentity(body.scope.identity)
    || !isRecord(body.target)
    || !hasExactKeys(body.target, ['kind', 'identity'])
    || body.target.kind !== 'session'
    || !isSessionIdentity(body.target.identity)
    || !isMatchaAgentIdentity(body.target.identity)
    || !sameIdentity(body.scope.identity, body.target.identity)
    || !isRecord(body.input)
    || !hasExactKeys(body.input, ['endpointSessionId', 'sessionIdentity'])
    || !isIdentifier(body.input.endpointSessionId)
    || !isSessionIdentity(body.input.sessionIdentity)
    || !isMatchaAgentIdentity(body.input.sessionIdentity)
    || !sameIdentity(body.scope.identity, body.input.sessionIdentity)) {
    throw new Error('Session approval request is invalid');
  }
  const identity = body.scope.identity;
  const endpoint = identity.endpoint;
  const sessionId = body.input.endpointSessionId as string;
  return {
    identity,
    native: {
      id: 'session.approval',
      operationId: 'sessions.approvals.list',
      scope: { kind: 'session', endpoint, sessionId },
      target: { kind: 'session' },
      input: { endpoint, sessionId },
    },
  };
}

export function projectSessionApprovalListResponse(
  response: SessionApprovalListTransportResponse,
  request: SessionApprovalListRouteRequest,
): PublicTransportResponse {
  if (response.status === 200 && isNativeApprovalListResponse(response.body)) {
    return {
      status: 200,
      body: {
        approvals: response.body.approvals.map((approval) => ({
          id: approval.approvalId,
          sessionKey: request.identity.sessionKey,
          sessionIdentity: request.identity,
          title: 'Approval required',
          allowedDecisions: approval.optionIds.map(nativeApprovalOptionIdToDecision).filter(isPublicApprovalDecision),
          request: { optionIds: approval.optionIds },
          createdAtMs: 0,
        })),
      },
    };
  }
  return response;
}

function isNativeApprovalListResponse(value: unknown): value is Readonly<{
  approvals: ReadonlyArray<Readonly<{ approvalId: string; optionIds: readonly string[] }>>;
}> {
  return isRecord(value)
    && hasExactKeys(value, ['approvals'])
    && Array.isArray(value.approvals)
    && value.approvals.every((approval) => isRecord(approval)
      && hasExactKeys(approval, ['approvalId', 'optionIds'])
      && isIdentifier(approval.approvalId)
      && Array.isArray(approval.optionIds)
      && approval.optionIds.every((optionId) => isIdentifier(optionId)));
}

function isPublicApprovalDecision(value: unknown): value is 'allow-once' | 'allow-always' | 'deny' {
  return value === 'allow-once' || value === 'allow-always' || value === 'deny';
}

function nativeApprovalOptionIdToDecision(optionId: string): 'allow-once' | 'allow-always' | 'deny' | null {
  switch (optionId) {
    case 'allow':
    case 'allow-once':
    case 'allow_once':
      return 'allow-once';
    case 'allow-always':
    case 'allow_always':
      return 'allow-always';
    case 'deny':
    case 'deny-once':
    case 'reject-once':
    case 'reject_once':
      return 'deny';
    default:
      return null;
  }
}

function approvalDecisionToOptionId(decision: 'allow-once' | 'allow-always' | 'deny', approval?: { request?: Record<string, unknown> }): string {
  const optionIds = approval?.request?.optionIds;
  if (Array.isArray(optionIds)) {
    const nativeOptionId = optionIds.find((optionId): optionId is string => (
      isIdentifier(optionId) && nativeApprovalOptionIdToDecision(optionId) === decision
    ));
    if (nativeOptionId) return nativeOptionId;
  }
  switch (decision) {
    case 'allow-once':
      return 'allow-once';
    case 'allow-always':
      return 'allow-always';
    case 'deny':
      return 'deny-once';
  }
}

export function adaptSessionApprovalRespondRequest(body: Record<string, unknown>): SessionApprovalRespondRequest {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'session.approval'
    || body.operationId !== 'approvals.resolve'
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'identity'])
    || body.scope.kind !== 'session'
    || !isSessionIdentity(body.scope.identity)
    || !isMatchaAgentIdentity(body.scope.identity)
    || !isRecord(body.target)
    || !hasExactKeys(body.target, ['kind', 'identity', 'approvalId'])
    || body.target.kind !== 'approval'
    || !isSessionIdentity(body.target.identity)
    || !isMatchaAgentIdentity(body.target.identity)
    || !sameIdentity(body.scope.identity, body.target.identity)
    || !isIdentifier(body.target.approvalId)
    || !isRecord(body.input)
    || !hasAllowedKeys(body.input, ['id', 'sessionKey', 'endpointSessionId', 'sessionIdentity', 'decision'], ['request'])
    || !isIdentifier(body.input.id)
    || !isIdentifier(body.input.sessionKey)
    || !isIdentifier(body.input.endpointSessionId)
    || body.input.id !== body.target.approvalId
    || body.input.sessionKey !== body.scope.identity.sessionKey
    || (body.input.request !== undefined && !isRecord(body.input.request))
    || !isSessionIdentity(body.input.sessionIdentity)
    || !isMatchaAgentIdentity(body.input.sessionIdentity)
    || !sameIdentity(body.scope.identity, body.input.sessionIdentity)
    || !isApprovalDecision(body.input.decision)) {
    throw new Error('Session approval request is invalid');
  }
  const endpoint = body.scope.identity.endpoint;
  const sessionId = body.input.endpointSessionId as string;
  const approval = body.input as { request?: Record<string, unknown> };
  return {
    id: 'session.approval',
    operationId: 'sessions.approvals.respond',
    scope: { kind: 'session', endpoint, sessionId },
    target: { kind: 'approval' },
    input: {
      endpoint,
      sessionId,
      approvalId: body.target.approvalId,
      optionId: approvalDecisionToOptionId(body.input.decision, approval),
    },
  };
}

function isMatchaAgentIdentity(
  value: SessionIdentity,
): value is SessionIdentity & Readonly<{
  endpoint: Readonly<{
    kind: 'native-runtime';
    runtimeAdapterId: 'matcha-agent';
    runtimeInstanceId: 'local';
  }>;
}> {
  return value.endpoint.runtimeAdapterId === 'matcha-agent';
}

function isApprovalDecision(value: unknown): value is 'allow-once' | 'allow-always' | 'deny' {
  return value === 'allow-once' || value === 'allow-always' || value === 'deny';
}
