import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
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
  sessionApprovalTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionApprovalTransport {
  const baseUrl = `http://127.0.0.1:${sessionApprovalTransportPort}/api/sessions/approvals`;
  return {
    async list(request: unknown): Promise<SessionApprovalListTransportResponse> {
      if (!isListRequest(request)) return { status: 503, body: UNAVAILABLE };
      return await requestApproval<ApprovalListResponse>(
        fetcher,
        issuer,
        `${baseUrl}/list`,
        'sessions.approvals.list',
        request,
        isListResponse,
      );
    },
    async respond(request: unknown): Promise<SessionApprovalRespondTransportResponse> {
      if (!isRespondRequest(request)) return { status: 503, body: UNAVAILABLE };
      return await requestApproval<ApprovalRespondResponse>(
        fetcher,
        issuer,
        `${baseUrl}/respond`,
        'sessions.approvals.respond',
        request,
        isRespondResponse,
      );
    },
  };
}

async function requestApproval<T>(
  fetcher: typeof fetch,
  issuer: RuntimeHostDeliveryIssuer,
  url: string,
  capability: 'sessions.approvals.list' | 'sessions.approvals.respond',
  request: SessionApprovalListRequest | SessionApprovalRespondRequest,
  isResponse: (value: unknown) => value is T,
): Promise<Readonly<{
  status: 200 | 400 | 422 | 503;
  body: T | InvalidRequest | typeof UNSUPPORTED | typeof UNAVAILABLE;
}>> {
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${issuer.signDecision({
          principal: 'electron-main-local',
          endpoint: new URL(url).pathname,
          scope: 'sessions:write',
          capability,
          subject: 'session-approval',
          expiresAt: Date.now() + DECISION_TTL_MS,
          revision: '1',
        })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    const body: unknown = await response.json();
    if (response.status === 200 && isResponse(body)) return { status: 200, body };
    if (response.status === 400) return { status: 400, body: INVALID_REQUEST };
    if (response.status === 422 && isUnsupported(body)) return { status: 422, body: UNSUPPORTED };
  } catch {
    // The delivery contract deliberately suppresses native transport details.
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
