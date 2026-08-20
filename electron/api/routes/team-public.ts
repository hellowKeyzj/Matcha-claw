import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TeamPublicTransport } from '../../main/runtime-host-delivery/transport/teams/public';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Team public projection request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Team public projection is unavailable',
} as const;

type TeamPublicRequest = Readonly<{
  teamId: string;
  runId: string;
}>;

export async function handleTeamPublicRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: TeamPublicTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/team/public' || req.method !== 'POST') return false;

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

function isRequest(value: unknown): value is TeamPublicRequest {
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
