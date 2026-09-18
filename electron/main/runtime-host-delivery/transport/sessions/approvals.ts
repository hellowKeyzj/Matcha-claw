import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';
const UNAVAILABLE = {
  success: false,
  error: 'Session approval is unavailable',
} as const;
const UNSUPPORTED = {
  success: false,
  error: 'Session approval endpoint is unsupported',
} as const;

type NativeEndpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'matcha-agent';
  runtimeInstanceId: 'local';
}>;

type SessionScope = Readonly<{
  kind: 'session';
  endpoint: NativeEndpoint;
  sessionId: string;
}>;

export type SessionApprovalListRequest = Readonly<{
  id: 'session.approval';
  operationId: 'sessions.approvals.list';
  scope: SessionScope;
  target: Readonly<{ kind: 'session' }>;
  input: Readonly<{
    endpoint: NativeEndpoint;
    sessionId: string;
  }>;
}>;

export type SessionApprovalRespondRequest = Readonly<{
  id: 'session.approval';
  operationId: 'sessions.approvals.respond';
  scope: SessionScope;
  target: Readonly<{ kind: 'approval' }>;
  input: Readonly<{
    endpoint: NativeEndpoint;
    sessionId: string;
    approvalId: string;
    optionId: string;
  }>;
}>;

export type PendingApproval = Readonly<{
  approvalId: string;
  optionIds: readonly string[];
}>;

type ApprovalListResponse = Readonly<{ approvals: readonly PendingApproval[] }>
  | Readonly<{ outcome: 'target_rejected' | 'unknown' }>;

type ApprovalRespondResponse = Readonly<{
  outcome: 'responded' | 'target_rejected' | 'unknown';
}>;

type InvalidRequest = Readonly<{
  success: false;
  error: 'Session approval request is invalid';
}>;

const INVALID_REQUEST: InvalidRequest = {
  success: false,
  error: 'Session approval request is invalid',
};

export type SessionApprovalListTransportResponse = Readonly<{
  status: 200 | 400 | 422 | 503;
  body: ApprovalListResponse | InvalidRequest | typeof UNSUPPORTED | typeof UNAVAILABLE;
}>;

export type SessionApprovalRespondTransportResponse = Readonly<{
  status: 200 | 400 | 422 | 503;
  body: ApprovalRespondResponse | InvalidRequest | typeof UNSUPPORTED | typeof UNAVAILABLE;
}>;

export interface SessionApprovalTransport {
  list(request: unknown): Promise<SessionApprovalListTransportResponse>;
  respond(request: unknown): Promise<SessionApprovalRespondTransportResponse>;
}

export function createSessionApprovalTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionApprovalTransport {
  return {
    async list(request: unknown): Promise<SessionApprovalListTransportResponse> {
      if (!isListRequest(request)) return { status: 503, body: UNAVAILABLE };
      return await requestApproval<ApprovalListResponse>(
        runtimeHostTransportPort,
        fetcher,
        issuer,
        '/api/sessions/approvals/list',
        'sessions.approvals.list',
        request,
        isListResponse,
      );
    },
    async respond(request: unknown): Promise<SessionApprovalRespondTransportResponse> {
      if (!isRespondRequest(request)) return { status: 503, body: UNAVAILABLE };
      return await requestApproval<ApprovalRespondResponse>(
        runtimeHostTransportPort,
        fetcher,
        issuer,
        '/api/sessions/approvals/respond',
        'sessions.approvals.respond',
        request,
        isRespondResponse,
      );
    },
  };
}

async function requestApproval<T>(
  port: number,
  fetcher: typeof fetch,
  issuer: RuntimeHostDeliveryIssuer,
  path: string,
  capability: 'sessions.approvals.list' | 'sessions.approvals.respond',
  request: SessionApprovalListRequest | SessionApprovalRespondRequest,
  isResponse: (value: unknown) => value is T,
): Promise<Readonly<{
  status: 200 | 400 | 422 | 503;
  body: T | InvalidRequest | typeof UNSUPPORTED | typeof UNAVAILABLE;
}>> {
  const response = await sendLoopbackJson({
    port,
    path,
    issuer,
    decision: {
      endpoint: path,
      scope: 'sessions:write',
      capability,
      subject: 'session-approval',
    },
    method: 'POST',
    fetcher,
    body: request,
  });
  if (response?.status === 200 && isResponse(response.body)) return { status: 200, body: response.body };
  if (response?.status === 400) return { status: 400, body: INVALID_REQUEST };
  if (response?.status === 422 && isUnsupported(response.body)) return { status: 422, body: UNSUPPORTED };
  return { status: 503, body: UNAVAILABLE };
}

function isUnsupported(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && value.error === UNSUPPORTED.error;
}

function isListRequest(value: unknown): value is SessionApprovalListRequest {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'session.approval'
    && value.operationId === 'sessions.approvals.list'
    && isSessionScope(value.scope)
    && isRecord(value.target)
    && hasExactKeys(value.target, ['kind'])
    && value.target.kind === 'session'
    && isRecord(value.input)
    && hasExactKeys(value.input, ['endpoint', 'sessionId'])
    && isNativeEndpoint(value.input.endpoint)
    && value.input.sessionId === value.scope.sessionId
    && sameEndpoint(value.input.endpoint, value.scope.endpoint);
}

function isRespondRequest(value: unknown): value is SessionApprovalRespondRequest {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'session.approval'
    && value.operationId === 'sessions.approvals.respond'
    && isSessionScope(value.scope)
    && isRecord(value.target)
    && hasExactKeys(value.target, ['kind'])
    && value.target.kind === 'approval'
    && isRecord(value.input)
    && hasExactKeys(value.input, ['endpoint', 'sessionId', 'approvalId', 'optionId'])
    && isNativeEndpoint(value.input.endpoint)
    && value.input.sessionId === value.scope.sessionId
    && sameEndpoint(value.input.endpoint, value.scope.endpoint)
    && isIdentifier(value.input.approvalId)
    && isIdentifier(value.input.optionId);
}

function isListResponse(value: unknown): value is ApprovalListResponse {
  return isRecord(value) && (
    (hasExactKeys(value, ['approvals'])
      && Array.isArray(value.approvals)
      && value.approvals.every((approval) => isPendingApproval(approval)))
    || (hasExactKeys(value, ['outcome'])
      && (value.outcome === 'target_rejected' || value.outcome === 'unknown'))
  );
}

function isRespondResponse(value: unknown): value is ApprovalRespondResponse {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'responded'
      || value.outcome === 'target_rejected'
      || value.outcome === 'unknown');
}

function isPendingApproval(value: unknown): value is PendingApproval {
  return isRecord(value)
    && hasExactKeys(value, ['approvalId', 'optionIds'])
    && isIdentifier(value.approvalId)
    && Array.isArray(value.optionIds)
    && value.optionIds.every((optionId) => isIdentifier(optionId));
}

function isSessionScope(value: unknown): value is SessionScope {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint', 'sessionId'])
    && value.kind === 'session'
    && isNativeEndpoint(value.endpoint)
    && isIdentifier(value.sessionId);
}

function isNativeEndpoint(value: unknown): value is NativeEndpoint {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && value.runtimeAdapterId === 'matcha-agent'
    && value.runtimeInstanceId === 'local';
}

function sameEndpoint(left: NativeEndpoint, right: NativeEndpoint): boolean {
  return left.kind === right.kind
    && left.runtimeAdapterId === right.runtimeAdapterId
    && left.runtimeInstanceId === right.runtimeInstanceId;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}
