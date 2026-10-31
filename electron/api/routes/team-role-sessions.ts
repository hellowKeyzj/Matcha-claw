import type { TeamRoleSessionsTransport } from '../../main/runtime-host-delivery/transport/teams/role-sessions';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const INVALID = {
  success: false,
  error: 'Team role sessions request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Team role sessions are unavailable',
} as const;

type TeamRoleSessionsRequest = Readonly<{
  teamId: string;
}>;

export async function handleTeamRoleSessionsRoutes(
  req: HostApiRequest,
  url: URL,
  transport: TeamRoleSessionsTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/team/role-sessions' || req.method !== 'POST') return undefined;

  let request: unknown;
  try {
    request = await req.readJson<unknown>();
  } catch {
    return jsonResult(400, INVALID);
  }
  if (!isRequest(request)) {
    return jsonResult(400, INVALID);
  }

  try {
    const response = await transport.list(request);
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}

function isRequest(value: unknown): value is TeamRoleSessionsRequest {
  return isRecord(value)
    && hasExactKeys(value, ['teamId'])
    && isIdentifier(value.teamId);
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
