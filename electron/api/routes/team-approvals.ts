import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TeamApprovalsTransport } from '../../main/runtime-host-delivery/transport/teams/approvals';
import { parseJsonBody, sendJson } from '../route-utils';

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
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: TeamApprovalsTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/team/approvals' || req.method !== 'POST') return false;

  let request: unknown;
  try {
    request = await parseJsonBody<unknown>(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }
  if (!isRequest(request)) {
    sendJson(res, 400, INVALID);
    return true;
  }

  try {
    const response = await transport.read(request);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
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
