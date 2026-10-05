import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';
import { logSessionTrace, summarizeIdentifier, traceHeader } from './trace';

const ROUTE = '/api/sessions/abort';
const MAX_RUN_ID_BYTES = 4096;
const MAX_ENDPOINT_SESSION_ID_BYTES = 4096;
const MAX_APPROVAL_IDS = 32;
const MAX_APPROVAL_ID_BYTES = 4096;

export type SessionAbortOutcome = 'succeeded' | 'target_rejected' | 'unknown';

import { isSessionIdentity, sameSessionIdentity, type SessionIdentity } from './session-contract';

export type SessionAbortRequest = Readonly<{
  id: 'session.abort';
  operationId: 'sessions.abort';
  scope: Readonly<{
    kind: 'session';
    identity: SessionIdentity;
  }>;
  target: Readonly<{ kind: 'session'; identity: SessionIdentity }>;
  input: Readonly<{
    identity: SessionIdentity;
    endpointSessionId?: string;
    runId?: string;
    approvalIds?: readonly string[];
  }>;
}>;

export type SessionAbortTransportResponse = Readonly<{
  status: 200;
  body: Readonly<{ outcome: SessionAbortOutcome }>;
}>;

export interface SessionAbortTransport {
  abort(request: unknown, traceId?: string | null): Promise<SessionAbortTransportResponse>;
}

export function createSessionAbortTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionAbortTransport {
  return {
    async abort(request: unknown, traceId?: string | null): Promise<SessionAbortTransportResponse> {
      const startedAt = Date.now();
      if (!isSessionAbortRequest(request)) {
        const input = isRecord(request) && isRecord(request.input) ? request.input : null;
        logSessionTrace('electron.abort.rejected', traceId, {
          reason: 'request-validation',
          approvalIdsCount: Array.isArray(input?.approvalIds) ? input.approvalIds.length : null,
          emptyApprovalIds: Array.isArray(input?.approvalIds) && input.approvalIds.length === 0,
          publicOutcome: 'unknown',
          elapsedMs: Date.now() - startedAt,
        });
        return unknownOutcome();
      }
      logSessionTrace('electron.abort.request', traceId, {
        adapter: request.input.identity.endpoint.runtimeAdapterId,
        sessionKey: summarizeIdentifier(request.input.identity.sessionKey),
        endpointSessionId: summarizeIdentifier(request.input.endpointSessionId),
        runId: summarizeIdentifier(request.input.runId),
        approvalIdsCount: request.input.approvalIds?.length ?? null,
        emptyApprovalIds: request.input.approvalIds?.length === 0,
      });
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE,
        issuer,
        decision: {
          endpoint: ROUTE,
          scope: 'sessions:write',
          capability: 'sessions.abort',
          subject: 'session-abort',
        },
        method: 'POST',
        fetcher,
        body: request,
        headers: traceHeader(traceId),
      });
      const result: SessionAbortTransportResponse = response?.status === 200 && isSessionAbortResponse(response.body)
        ? { status: 200, body: response.body }
        : unknownOutcome();
      logSessionTrace('electron.abort.response', traceId, {
        upstreamStatus: response?.status ?? null,
        contract: isSessionAbortResponse(response?.body) ? 'valid' : 'invalid',
        publicOutcome: result.body.outcome,
        approvalIdsCount: request.input.approvalIds?.length ?? null,
        emptyApprovalIds: request.input.approvalIds?.length === 0,
        elapsedMs: Date.now() - startedAt,
      });
      return result;
    },
  };
}

function unknownOutcome(): SessionAbortTransportResponse {
  return { status: 200, body: { outcome: 'unknown' } };
}

function isSessionAbortResponse(value: unknown): value is Readonly<{ outcome: SessionAbortOutcome }> {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'succeeded' || value.outcome === 'target_rejected' || value.outcome === 'unknown');
}

function isSessionAbortRequest(value: unknown): value is SessionAbortRequest {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'session.abort'
    || value.operationId !== 'sessions.abort'
    || !isSessionScope(value.scope)
    || !isRecord(value.target)
    || !hasExactKeys(value.target, ['kind', 'identity'])
    || value.target.kind !== 'session' || !isSessionIdentity(value.target.identity)
    || !isSessionAbortInput(value.input)
    || !sameSessionIdentity(value.scope.identity, value.input.identity)
    || !sameSessionIdentity(value.scope.identity, value.target.identity)) {
    return false;
  }
  return true;
}

function isSessionScope(value: unknown): value is SessionAbortRequest['scope'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session'
    && isSessionIdentity(value.identity);
}

function isSessionAbortInput(value: unknown): value is SessionAbortRequest['input'] {
  return isRecord(value)
    && Object.hasOwn(value, 'identity')
    && Object.keys(value).every((key) => ['identity', 'endpointSessionId', 'runId', 'approvalIds'].includes(key))
    && isSessionIdentity(value.identity)
    && (value.endpointSessionId === undefined
      || isIdentity(value.endpointSessionId, MAX_ENDPOINT_SESSION_ID_BYTES))
    && (value.runId === undefined || isIdentity(value.runId, MAX_RUN_ID_BYTES))
    && (value.approvalIds === undefined
      || (Array.isArray(value.approvalIds)
        && value.approvalIds.length > 0 && value.approvalIds.length <= MAX_APPROVAL_IDS
        && value.approvalIds.every(isApprovalId)));
}

function isApprovalId(value: unknown): value is string {
  return isIdentity(value, MAX_APPROVAL_ID_BYTES);
}

function isIdentity(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && value.trim() === value
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159);
    });
}
