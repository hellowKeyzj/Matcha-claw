import type { SessionObservationResult } from '../../../../../src/types/session/snapshot';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';
import { decodeSessionView, isSessionIdentity, sameSessionIdentity, type SessionIdentity, type SessionView } from './session-contract';
import { isSessionTraceEnabled, logSessionTrace, summarizeIdentifier, summarizeSessionIdentity, summarizeSessionView, traceHeader } from './trace';

const UNAVAILABLE = { success: false, error: 'Session observation is unavailable' } as const;
const INVALID = { success: false, error: 'Session observation request is invalid' } as const;

export type SessionObservationRequest = Readonly<{
  id: 'session.management';
  operationId: 'sessions.observe' | 'sessions.release';
  scope: Readonly<{ kind: 'session'; identity: SessionIdentity }>;
  target: Readonly<{ kind: 'session'; identity: SessionIdentity }>;
  input: Readonly<{ sessionIdentity: SessionIdentity; sessionKey: string; leaseId: string; limit?: number }>;
}>;
export type SessionObservationResponse = Readonly<{
  status: 200 | 400 | 503;
  body: SessionObservationResult<SessionView>
    | Readonly<{ outcome: 'released' | 'not-found' }> | typeof UNAVAILABLE | typeof INVALID;
}>;
export interface SessionObservationTransport {
  observe(request: unknown, traceId?: string | null): Promise<SessionObservationResponse>;
  release(request: unknown, traceId?: string | null): Promise<SessionObservationResponse>;
}

export function observationRequest(identity: SessionIdentity, leaseId: string, operationId: SessionObservationRequest['operationId'], limit?: number): SessionObservationRequest {
  return {
    id: 'session.management', operationId,
    scope: { kind: 'session', identity }, target: { kind: 'session', identity },
    input: { sessionIdentity: identity, sessionKey: identity.sessionKey, leaseId, ...(limit === undefined ? {} : { limit }) },
  };
}

export function isSessionObservationRequest(value: unknown, operation: SessionObservationRequest['operationId']): value is SessionObservationRequest {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'session.management' || value.operationId !== operation
    || !isRecord(value.scope) || !hasExactKeys(value.scope, ['kind', 'identity']) || value.scope.kind !== 'session' || !isSessionIdentity(value.scope.identity)
    || !isRecord(value.target) || !hasExactKeys(value.target, ['kind', 'identity']) || value.target.kind !== 'session' || !isSessionIdentity(value.target.identity)
    || !isRecord(value.input) || !isSessionIdentity(value.input.sessionIdentity)
    || !hasExactKeys(value.input, operation === 'sessions.observe' && Object.hasOwn(value.input, 'limit')
      ? ['sessionIdentity', 'sessionKey', 'leaseId', 'limit'] : ['sessionIdentity', 'sessionKey', 'leaseId'])
    || !isLeaseId(value.input.leaseId)
    || (value.input.limit !== undefined && (!Number.isSafeInteger(value.input.limit) || (value.input.limit as number) < 1 || (value.input.limit as number) > 200))) return false;
  return sameSessionIdentity(value.scope.identity, value.target.identity)
    && sameSessionIdentity(value.scope.identity, value.input.sessionIdentity)
    && value.input.sessionKey === value.scope.identity.sessionKey;
}

export function createSessionObservationTransport(issuer: RuntimeHostDeliveryIssuer, port: number, fetcher: typeof fetch = fetch): SessionObservationTransport {
  const execute = async (request: unknown, operation: SessionObservationRequest['operationId'], traceId?: string | null): Promise<SessionObservationResponse> => {
    if (!isSessionObservationRequest(request, operation)) return { status: 400, body: INVALID };
    const tracing = isSessionTraceEnabled();
    const correlation = tracing ? { identity: summarizeSessionIdentity(request.scope.identity), leaseHash: summarizeIdentifier(request.input.leaseId).hash, operation } : {};
    if (tracing) logSessionTrace('electron.session.observation.request', traceId ?? 'session-observation-boundary', { ...correlation, limit: request.input.limit ?? null });
    const endpoint = operation === 'sessions.observe' ? '/api/sessions/observe' : '/api/sessions/release';
    const response = await sendLoopbackJson({
      port, path: endpoint, issuer, fetcher, method: 'POST', body: request, headers: traceHeader(traceId), timeoutMs: 30_000,
      decision: { endpoint, scope: 'sessions:read', capability: 'session.management', subject: 'session-timeline' },
    });
    if (response?.status === 200 && isRecord(response.body)) {
      if (operation === 'sessions.release' && hasExactKeys(response.body, ['outcome'])
        && (response.body.outcome === 'released' || response.body.outcome === 'not-found')) {
        if (tracing) logSessionTrace('electron.session.observation.response', traceId ?? 'session-observation-boundary', { ...correlation, status: 200, decoded: true, outcome: response.body.outcome });
        return { status: 200, body: { outcome: response.body.outcome } };
      }
      if (operation === 'sessions.observe' && hasExactKeys(response.body, ['leaseId', 'outcome'])
        && response.body.leaseId === request.input.leaseId && response.body.outcome === 'released') {
        if (tracing) logSessionTrace('electron.session.observation.response', traceId ?? 'session-observation-boundary', { ...correlation, status: 200, decoded: true, outcome: response.body.outcome });
        return { status: 200, body: { leaseId: request.input.leaseId, outcome: 'released' } };
      }
      if (operation === 'sessions.observe' && hasExactKeys(response.body, ['leaseId', 'view']) && response.body.leaseId === request.input.leaseId) {
        const view = decodeSessionView(response.body.view);
        if (view && sameSessionIdentity(view.identity, request.scope.identity)) {
          if (tracing) logSessionTrace('electron.session.observation.response', traceId ?? 'session-observation-boundary', { ...correlation, status: 200, decoded: true, view: summarizeSessionView(view) });
          return { status: 200, body: { leaseId: request.input.leaseId, view } };
        }
      }
    }
    if (tracing) logSessionTrace('electron.session.observation.response', traceId ?? 'session-observation-boundary', { ...correlation, status: response?.status ?? null, decoded: false, reason: 'unavailable-or-strict-decode-rejected' });
    if (response?.status === 400 && isRecord(response.body) && hasExactKeys(response.body, ['success', 'error'])
      && response.body.success === false && response.body.error === INVALID.error) return { status: 400, body: INVALID };
    return { status: 503, body: UNAVAILABLE };
  };
  return {
    observe: (request, traceId) => execute(request, 'sessions.observe', traceId),
    release: (request, traceId) => execute(request, 'sessions.release', traceId),
  };
}

function isLeaseId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 4096
    && value.trim() === value && ![...value].some((char) => (char.codePointAt(0) ?? 0) < 32 || char.codePointAt(0) === 127);
}
