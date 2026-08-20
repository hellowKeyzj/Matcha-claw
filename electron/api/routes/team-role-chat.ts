import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  TeamRoleChatRequest,
  TeamRoleChatTransport,
} from '../../main/runtime-host-delivery/transport/teams/role-chat';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Team role chat request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Team role chat is unavailable',
} as const;

export async function handleTeamRoleChatRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: TeamRoleChatTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/team/role-chat' || req.method !== 'POST') return false;

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
    const response = await transport.submit(request);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
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
