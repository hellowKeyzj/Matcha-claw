import type { SessionGoalClearInput, SessionGoalOutcome, SessionGoalReceipt, SessionGoalUpdateInput, SessionSendIntent } from '../../../../../src/types/session-goal';
import { tryDecodeSessionGoal } from '../../../../../src/types/session/snapshot';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, isSafeNonNegativeInteger, sendLoopbackJson } from '../client';
import { isSessionIdentity, sameSessionIdentity, type SessionIdentity } from './session-contract';
import { traceHeader } from './trace';

const ENDPOINT = '/api/sessions/goal';
const INVALID = { success: false, error: 'Session Goal request is invalid' } as const;
const UNKNOWN = { outcome: 'unknown' } as const;

export type SessionGoalRequest = Readonly<{
  id: 'session.goal';
  scope: Readonly<{ kind: 'session'; identity: SessionIdentity }>;
  target: Readonly<{ kind: 'session'; identity: SessionIdentity }>;
}> & (
  | Readonly<{ operationId: 'sessions.goal.update'; input: SessionGoalUpdateInput }>
  | Readonly<{ operationId: 'sessions.goal.clear'; input: SessionGoalClearInput }>
);

export type SessionGoalTransportResponse = Readonly<{
  status: 200 | 400 | 503;
  body: SessionGoalOutcome | typeof INVALID;
}>;

export interface SessionGoalTransport {
  execute(request: unknown, traceId?: string | null): Promise<SessionGoalTransportResponse>;
}

export function createSessionGoalTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionGoalTransport {
  return {
    async execute(value, traceId) {
      const request = decodeSessionGoalRequest(value);
      if (!request) return { status: 400, body: INVALID };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ENDPOINT,
        issuer,
        decision: { endpoint: ENDPOINT, scope: 'sessions:write', capability: 'session.goal', subject: 'session-goal' },
        method: 'POST',
        fetcher,
        body: request,
        headers: traceHeader(traceId),
      });
      if (response === null) return { status: 503, body: { outcome: 'unknown' } };
      if (response.status === 400 && isRecord(response.body)
        && hasExactKeys(response.body, ['success', 'error']) && response.body.success === false
        && response.body.error === INVALID.error) return { status: 400, body: INVALID };
      if (response.status === 200) {
        const outcome = decodeSessionGoalOutcome(response.body, request);
        if (outcome) return { status: 200, body: outcome };
      }
      return { status: 503, body: UNKNOWN };
    },
  };
}

export function decodeSessionGoalRequest(value: unknown): SessionGoalRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'session.goal'
    || (value.operationId !== 'sessions.goal.update' && value.operationId !== 'sessions.goal.clear')
    || !isRecord(value.scope) || !hasExactKeys(value.scope, ['kind', 'identity']) || value.scope.kind !== 'session'
    || !isSessionIdentity(value.scope.identity)
    || !isRecord(value.target) || !hasExactKeys(value.target, ['kind', 'identity']) || value.target.kind !== 'session'
    || !isSessionIdentity(value.target.identity) || !sameSessionIdentity(value.scope.identity, value.target.identity)
    || !isRecord(value.input) || !isSessionIdentity(value.input.sessionIdentity)
    || !sameSessionIdentity(value.scope.identity, value.input.sessionIdentity)
    || !isGoalIdentifier(value.input.endpointSessionId, 4096)
    || !isGoalIdentifier(value.input.goalId, 256) || !isGoalIdentifier(value.input.operationId, 128)
    || !isSafeNonNegativeInteger(value.input.issuedAtMs)) return null;
  const required = ['sessionIdentity', 'endpointSessionId', 'goalId', 'operationId', 'issuedAtMs'];
  if (value.operationId === 'sessions.goal.clear') {
    return hasExactKeys(value.input, required) ? value as SessionGoalRequest : null;
  }
  if (value.input.action === 'edit') {
    return hasExactKeys(value.input, [...required, 'action', 'objective'])
      && isGoalObjective(value.input.objective)
      ? value as SessionGoalRequest : null;
  }
  return ['pause', 'resume', 'complete', 'block'].includes(value.input.action as string)
    && hasAllowedKeys(value.input, [...required, 'action'], ['note'])
    && (value.input.note === undefined || isGoalText(value.input.note, 2_000))
    ? value as SessionGoalRequest : null;
}

export function decodeSessionGoalOutcome(value: unknown, request: SessionGoalRequest): SessionGoalOutcome | null {
  if (!isRecord(value)) return null;
  if (value.outcome === 'succeeded') {
    const receipt = decodeSessionGoalReceipt(value.receipt);
    const action = request.operationId === 'sessions.goal.clear' ? 'clear' : request.input.action;
    return hasExactKeys(value, ['outcome', 'receipt']) && receipt
      && receipt.operationId === request.input.operationId && receipt.action === action
      && receipt.sessionId === request.input.endpointSessionId && receipt.goalId === request.input.goalId
      ? { outcome: 'succeeded', receipt } : null;
  }
  return hasExactKeys(value, ['outcome'])
    && (value.outcome === 'target_rejected' || value.outcome === 'unknown'
      || value.outcome === 'unsupported' || value.outcome === 'unavailable')
    ? value as SessionGoalOutcome : null;
}

export function decodeSessionGoalReceipt(value: unknown): SessionGoalReceipt | null {
  if (!isRecord(value)
    || !hasAllowedKeys(value, ['operationId', 'action', 'sessionId', 'goalId', 'status'], ['goal', 'runId', 'replayed'])
    || !isGoalIdentifier(value.operationId, 128) || !isGoalIdentifier(value.sessionId, 4096)
    || !isGoalIdentifier(value.goalId, 256)
    || (value.runId !== undefined && !isGoalIdentifier(value.runId, 256))
    || (value.replayed !== undefined && value.replayed !== true)) return null;
  const goal = value.goal === undefined ? undefined : tryDecodeSessionGoal(value.goal);
  if (value.goal !== undefined && (!goal || goal.id !== value.goalId)) return null;
  if (value.status === 'started') {
    if ((value.action !== 'start' && value.action !== 'resume') || !goal || value.runId === undefined) return null;
  } else if (value.status === 'updated') {
    if (!['edit', 'pause', 'complete', 'block'].includes(value.action as string) || !goal || value.runId !== undefined) return null;
  } else if (value.status !== 'cleared' || value.action !== 'clear' || value.runId !== undefined || value.goal !== undefined) return null;
  return value as SessionGoalReceipt;
}

export function isSessionSendIntent(value: unknown): value is SessionSendIntent {
  return isRecord(value) && hasExactKeys(value, ['kind', 'issuedAtMs'])
    && value.kind === 'goalStart' && isSafeNonNegativeInteger(value.issuedAtMs);
}

export function isGoalIdentifier(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    && Buffer.byteLength(value, 'utf8') <= maxBytes && !/\p{Cc}/u.test(value);
}

export function isGoalObjective(value: unknown): value is string {
  return isGoalText(value, 16_000) && value.trim().length > 0;
}

function isGoalText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength
    && Buffer.byteLength(value, 'utf8') <= 128 * 1024 && !value.includes('\0');
}

function hasAllowedKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
