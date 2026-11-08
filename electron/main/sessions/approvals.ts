import { hasExactKeys, isRecord } from '../runtime-host-delivery/transport/client';
import type { LoopbackJsonResponse as PublicTransportResponse } from '../runtime-host-delivery/transport/client';
import { isApprovalDetails, sameSessionIdentity as sameIdentity, type ApprovalDetails, type SessionIdentity } from '../runtime-host-delivery/transport/sessions/session-contract';
import type { SessionApprovalListRequest, SessionApprovalListTransportResponse, SessionApprovalRespondRequest } from '../runtime-host-delivery/transport/sessions/approvals';
import { hasAllowedKeys, isIdentifier, isSessionIdentity } from './request-validation';

type SessionApprovalListRouteRequest = Readonly<{
  native: SessionApprovalListRequest;
  identity: SessionIdentity;
}>;

export function adaptSessionApprovalListRequest(body: Record<string, unknown>): SessionApprovalListRouteRequest {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'session.approval'
    || body.operationId !== 'approvals.list'
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'identity'])
    || body.scope.kind !== 'session'
    || !isSessionIdentity(body.scope.identity)
    || !isRecord(body.target)
    || !hasExactKeys(body.target, ['kind', 'identity'])
    || body.target.kind !== 'session'
    || !isSessionIdentity(body.target.identity)
    || !sameIdentity(body.scope.identity, body.target.identity)
    || !isRecord(body.input)
    || !hasExactKeys(body.input, ['endpointSessionId', 'sessionIdentity'])
    || !isIdentifier(body.input.endpointSessionId)
    || !isSessionIdentity(body.input.sessionIdentity)
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
      scope: { kind: 'session', endpoint, sessionId, identity },
      target: { kind: 'session' },
      input: { endpoint, sessionId, identity },
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
          ...(approval.details ? { details: approval.details } : {}),
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
  approvals: ReadonlyArray<Readonly<{ approvalId: string; optionIds: readonly string[]; details: ApprovalDetails | null }>>;
}> {
  return isRecord(value)
    && hasExactKeys(value, ['approvals'])
    && Array.isArray(value.approvals)
    && value.approvals.every((approval) => isRecord(approval)
      && hasExactKeys(approval, ['approvalId', 'optionIds', 'details'])
      && isIdentifier(approval.approvalId)
      && Array.isArray(approval.optionIds)
      && approval.optionIds.every((optionId) => isIdentifier(optionId))
      && (approval.details === null || isApprovalDetails(approval.details)));
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

function approvalDecisionToOptionId(decision: 'allow-once' | 'allow-always' | 'deny', endpoint: SessionIdentity['endpoint'], approval?: { request?: Record<string, unknown> }): string {
  const optionIds = approval?.request?.optionIds;
  if (Array.isArray(optionIds)) {
    const nativeOptionId = optionIds.find((optionId): optionId is string => (
      isIdentifier(optionId) && nativeApprovalOptionIdToDecision(optionId) === decision
    ));
    if (nativeOptionId) return nativeOptionId;
  }
  if (endpoint.runtimeAdapterId === 'openclaw') return decision;
  switch (decision) {
    case 'allow-once':
      return 'allow';
    case 'allow-always':
      throw new Error('Matcha Agent does not support allow-always');
    case 'deny':
      return 'deny';
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
    || !isRecord(body.target)
    || !hasExactKeys(body.target, ['kind', 'identity', 'approvalId'])
    || body.target.kind !== 'approval'
    || !isSessionIdentity(body.target.identity)
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
    || !sameIdentity(body.scope.identity, body.input.sessionIdentity)
    || !isApprovalDecision(body.input.decision)) {
    throw new Error('Session approval request is invalid');
  }
  const identity = body.scope.identity;
  const endpoint = identity.endpoint;
  const sessionId = body.input.endpointSessionId as string;
  const approval = body.input as { request?: Record<string, unknown> };
  return {
    id: 'session.approval',
    operationId: 'sessions.approvals.respond',
    scope: { kind: 'session', endpoint, sessionId, identity },
    target: { kind: 'approval' },
    input: {
      endpoint,
      sessionId,
      identity,
      approvalId: body.target.approvalId,
      optionId: approvalDecisionToOptionId(body.input.decision, endpoint, approval),
    },
  };
}

function isApprovalDecision(value: unknown): value is 'allow-once' | 'allow-always' | 'deny' {
  return value === 'allow-once' || value === 'allow-always' || value === 'deny';
}
