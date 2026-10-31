import type { TeamApprovalsTransport } from '../../main/runtime-host-delivery/transport/teams/approvals';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const INVALID = {
  success: false,
  error: 'Team pending approvals request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Team pending approvals are unavailable',
} as const;

type TeamApprovalsRequest = Readonly<{
  teamId: string;
  runId: string;
}>;

export async function handleTeamApprovalsRoutes(
  req: HostApiRequest,
  url: URL,
  transport: TeamApprovalsTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/team/approvals' || req.method !== 'POST') return undefined;

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
    const response = await transport.read(request);
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}

function isRequest(value: unknown): value is TeamApprovalsRequest {
  return isRecord(value)
    && hasExactKeys(value, ['teamId', 'runId'])
    && isIdentifier(value.teamId)
    && isIdentifier(value.runId);
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
