import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

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
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): TeamRoleChatTransport {
  return {
    async submit(request): Promise<TeamRoleChatTransportResponse> {
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
      if (response?.status === 200 && isSuccess(response.body)) return { status: 200, body: response.body };
      if (response?.status === 409 && isUnknown(response.body)) return { status: 409, body: response.body };
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
