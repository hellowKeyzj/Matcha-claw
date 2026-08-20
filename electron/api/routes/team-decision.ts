import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  TeamHumanDecisionRequest,
  TeamHumanDecisionTransport,
} from '../../main/runtime-host-delivery/transport/teams/decision';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Team human decision request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Team human decision is unavailable',
} as const;

export async function handleTeamDecisionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: TeamHumanDecisionTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/team/decision' || req.method !== 'POST') return false;

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
    const response = await transport.resolve(request);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}

function isRequest(value: unknown): value is TeamHumanDecisionRequest {
  if (!isRecord(value)) return false;
  const keys = value.note === undefined
    ? ['runId', 'approvalId', 'decision', 'idempotencyKey']
    : ['runId', 'approvalId', 'decision', 'note', 'idempotencyKey'];
  return hasExactKeys(value, keys)
    && isOpaqueId(value.runId)
    && isOpaqueId(value.approvalId)
    && (value.decision === 'approve' || value.decision === 'deny' || value.decision === 'abort')
    && (value.note === undefined || isNote(value.note))
    && isOpaqueId(value.idempotencyKey);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isNote(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
