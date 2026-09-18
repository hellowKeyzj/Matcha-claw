import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const ENDPOINT = '/api/team/decision';
const SCOPE = 'team:write';
const CAPABILITY = 'team.decision.resolve';
const SUBJECT = 'team-decision';

const INVALID = {
  success: false,
  error: 'Team human decision request is invalid',
} as const;

const UNAVAILABLE = {
  success: false,
  error: 'Team human decision is unavailable',
} as const;

const REJECTED = {
  success: false,
  error: 'Team human decision was rejected',
} as const;

const UNKNOWN = {
  success: false,
  outcome: 'outcome-unknown',
  error: 'Team human decision outcome is unknown',
} as const;

export type TeamHumanDecision = 'approve' | 'deny' | 'abort';

export type TeamHumanDecisionRequest = Readonly<{
  runId: string;
  approvalId: string;
  decision: TeamHumanDecision;
  note?: string;
  idempotencyKey: string;
}>;

export type TeamHumanDecisionTransportResponse = Readonly<{
  status: 200 | 400 | 409 | 503;
  body:
    | Readonly<{ success: true; outcome: 'recorded' | 'replayed' }>
    | typeof INVALID
    | typeof UNKNOWN
    | typeof REJECTED
    | typeof UNAVAILABLE;
}>;

export interface TeamHumanDecisionTransport {
  resolve(request: TeamHumanDecisionRequest): Promise<TeamHumanDecisionTransportResponse>;
}

export function createTeamHumanDecisionTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): TeamHumanDecisionTransport {
  return {
    async resolve(request): Promise<TeamHumanDecisionTransportResponse> {
      if (!isRequest(request)) return { status: 400, body: INVALID };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ENDPOINT,
        issuer,
        decision: {
          endpoint: ENDPOINT,
          scope: SCOPE,
          capability: CAPABILITY,
          subject: SUBJECT,
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response === null) return { status: 503, body: UNAVAILABLE };
      if (response.status === 200 && isSuccess(response.body)) return { status: 200, body: response.body };
      if (response.status === 409 && (isUnknown(response.body) || isRejected(response.body))) return { status: 409, body: response.body };
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRequest(value: unknown): value is TeamHumanDecisionRequest {
  if (!isRecord(value)) return false;
  const expectedKeys = value.note === undefined
    ? ['runId', 'approvalId', 'decision', 'idempotencyKey']
    : ['runId', 'approvalId', 'decision', 'note', 'idempotencyKey'];
  return hasExactKeys(value, expectedKeys)
    && isOpaqueId(value.runId)
    && isOpaqueId(value.approvalId)
    && (value.decision === 'approve' || value.decision === 'deny' || value.decision === 'abort')
    && (value.note === undefined || isNote(value.note))
    && isOpaqueId(value.idempotencyKey);
}

function isSuccess(value: unknown): value is Readonly<{
  success: true;
  outcome: 'recorded' | 'replayed';
}> {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'outcome'])
    && value.success === true
    && (value.outcome === 'recorded' || value.outcome === 'replayed');
}

function isUnknown(value: unknown): value is typeof UNKNOWN {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'outcome', 'error'])
    && value.success === false
    && value.outcome === UNKNOWN.outcome
    && value.error === UNKNOWN.error;
}

function isRejected(value: unknown): value is typeof REJECTED {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && value.error === REJECTED.error;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isNote(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 256;
}
