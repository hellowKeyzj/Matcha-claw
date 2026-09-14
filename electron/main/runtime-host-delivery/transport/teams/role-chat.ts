import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const ENDPOINT = '/api/team/role-chat';
const SCOPE = 'team:write';
const CAPABILITY = 'team.role-chat.submit';
const SUBJECT = 'team-role-chat';

const INVALID = {
  success: false,
  error: 'Team role chat request is invalid',
} as const;

const UNAVAILABLE = {
  success: false,
  error: 'Team role chat is unavailable',
} as const;

const UNKNOWN = {
  success: false,
  outcome: 'outcome-unknown',
  error: 'Team role chat outcome is unknown',
} as const;

export type TeamRoleChatRequest = Readonly<{
  teamId: string;
  runId: string;
  roleId: string;
  message: string;
  idempotencyKey: string;
}>;

export type TeamRoleChatTransportResponse = Readonly<{
  status: 200 | 400 | 409 | 503;
  body:
    | Readonly<{ success: true; outcome: 'accepted' | 'rejected' }>
    | typeof INVALID
    | typeof UNKNOWN
    | typeof UNAVAILABLE;
}>;

export interface TeamRoleChatTransport {
  submit(request: TeamRoleChatRequest): Promise<TeamRoleChatTransportResponse>;
}

export function createTeamRoleChatTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): TeamRoleChatTransport {
  const url = `http://127.0.0.1:${port}${ENDPOINT}`;
  return {
    async submit(request): Promise<TeamRoleChatTransportResponse> {
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
        if (response.status === 409 && isUnknown(body)) return { status: 409, body };
      } catch {
        // Native transport details do not cross the Electron delivery boundary.
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRequest(value: unknown): value is TeamRoleChatRequest {
  return isRecord(value)
    && hasExactKeys(value, ['teamId', 'runId', 'roleId', 'message', 'idempotencyKey'])
    && isOpaqueId(value.teamId)
    && isOpaqueId(value.runId)
    && isOpaqueId(value.roleId)
    && isMessage(value.message)
    && isOpaqueId(value.idempotencyKey);
}

function isSuccess(value: unknown): value is Readonly<{
  success: true;
  outcome: 'accepted' | 'rejected';
}> {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'outcome'])
    && value.success === true
    && (value.outcome === 'accepted' || value.outcome === 'rejected');
}

function isUnknown(value: unknown): value is typeof UNKNOWN {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'outcome', 'error'])
    && value.success === false
    && value.outcome === UNKNOWN.outcome
    && value.error === UNKNOWN.error;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isMessage(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= 16 * 1024;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
