import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TeamTriggerTransport } from '../../main/runtime-host-delivery/transport/teams/trigger';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Team trigger request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Team trigger is unavailable',
} as const;

type TeamTriggerRequest =
  | Readonly<{ action: 'list'; teamId: string }>
  | Readonly<{
      action: 'fire';
      runId: string;
      startNodeId: string;
      source: 'cron' | 'webhook';
      idempotencyKey: string;
    }>;

export async function handleTeamTriggerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: TeamTriggerTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/team/trigger' || req.method !== 'POST') return false;

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
    const response = request.action === 'list'
      ? await transport.list(request)
      : await transport.fire(request);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}

function isRequest(value: unknown): value is TeamTriggerRequest {
  if (!isRecord(value) || typeof value.action !== 'string') return false;
  if (value.action === 'list') {
    return hasExactKeys(value, ['action', 'teamId']) && isIdentifier(value.teamId);
  }
  if (value.action === 'fire') {
    return hasExactKeys(value, ['action', 'runId', 'startNodeId', 'source', 'idempotencyKey'])
      && isIdentifier(value.runId)
      && isIdentifier(value.startNodeId)
      && (value.source === 'cron' || value.source === 'webhook')
      && isOpaqueId(value.idempotencyKey);
  }
  return false;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\p{Cc}]/u.test(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
