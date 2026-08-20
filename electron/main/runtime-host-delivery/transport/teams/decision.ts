import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
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
    | Readonly<{ success: true; outcome: 'recorded' | 'replayed' | 'outcome-unknown' }>
    | typeof INVALID
    | typeof REJECTED
    | typeof UNAVAILABLE;
}>;

export interface TeamHumanDecisionTransport {
  resolve(request: TeamHumanDecisionRequest): Promise<TeamHumanDecisionTransportResponse>;
}

export function createTeamHumanDecisionTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): TeamHumanDecisionTransport {
  const url = `http://127.0.0.1:${port}${ENDPOINT}`;
  return {
    async resolve(request): Promise<TeamHumanDecisionTransportResponse> {
      if (!isRequest(request)) return { status: 400, body: INVALID };
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: ENDPOINT,
              scope: SCOPE,
              capability: CAPABILITY,
              subject: SUBJECT,
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isSuccess(body)) return { status: 200, body };
        if (response.status === 409 && isRejected(body)) return { status: 409, body };
      } catch {
        // Native transport details do not cross the Electron delivery boundary.
      }
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
  outcome: 'recorded' | 'replayed' | 'outcome-unknown';
}> {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'outcome'])
    && value.success === true
    && (value.outcome === 'recorded'
      || value.outcome === 'replayed'
      || value.outcome === 'outcome-unknown');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
