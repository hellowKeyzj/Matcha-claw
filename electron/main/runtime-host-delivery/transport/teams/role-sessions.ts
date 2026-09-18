import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const ROUTE_PATH = '/api/team/role-sessions';
const UNAVAILABLE = { success: false, error: 'Team role sessions are unavailable' } as const;

type TeamRoleSession = Readonly<{
  teamId: string;
  runId: string;
  roleId: string;
  sessionRef: string;
  status: 'available';
}>;

type Response = Readonly<{
  status: 200 | 503;
  body: Readonly<{ success: true; sessions: readonly TeamRoleSession[] }> | typeof UNAVAILABLE;
}>;

export interface TeamRoleSessionsTransport {
  list(request: Readonly<{ teamId: string }>): Promise<Response>;
}

export function createTeamRoleSessionsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): TeamRoleSessionsTransport {
  return {
    list: async (request) => {
      if (!isTeamRequest(request)) return { status: 503, body: UNAVAILABLE };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE_PATH,
        issuer,
        decision: {
          endpoint: ROUTE_PATH,
          scope: 'team:read',
          capability: 'team.role-sessions.list',
          subject: 'team-role-session-projection',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 200 && isSuccess(response.body)) return { status: 200, body: response.body };
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isTeamRequest(value: Readonly<{ teamId: string }>): boolean {
  return isIdentifier(value.teamId);
}

function isSuccess(value: unknown): value is Extract<Response['body'], { success: true }> {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'sessions'])
    && value.success === true
    && Array.isArray(value.sessions)
    && value.sessions.every(isTeamRoleSession);
}

function isTeamRoleSession(value: unknown): value is TeamRoleSession {
  return isRecord(value)
    && hasExactKeys(value, ['teamId', 'runId', 'roleId', 'sessionRef', 'status'])
    && isIdentifier(value.teamId)
    && isIdentifier(value.runId)
    && isIdentifier(value.roleId)
    && isIdentifier(value.sessionRef)
    && value.status === 'available';
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\p{Cc}]/u.test(value);
}
