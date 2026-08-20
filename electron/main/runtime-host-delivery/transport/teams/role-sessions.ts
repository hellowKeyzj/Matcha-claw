import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
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
  port: number,
  fetcher: typeof fetch = fetch,
): TeamRoleSessionsTransport {
  const url = `http://127.0.0.1:${port}/api/team/role-sessions`;
  return {
    list: async (request) => {
      if (!isTeamRequest(request)) return { status: 503, body: UNAVAILABLE };
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/team/role-sessions',
              scope: 'team:read',
              capability: 'team.role-sessions.list',
              subject: 'team-role-session-projection',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const result: unknown = await response.json();
        if (response.status === 200 && isSuccess(result)) return { status: 200, body: result };
      } catch {
        // Native transport details do not cross the Electron delivery boundary.
      }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
