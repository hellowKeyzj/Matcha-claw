import type {
  TeamHumanDecisionRequest,
  TeamHumanDecisionTransport,
} from '../../main/runtime-host-delivery/transport/teams/decision';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const INVALID = {
  success: false,
  error: 'Team human decision request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Team human decision is unavailable',
} as const;

export async function handleTeamDecisionRoutes(
  req: HostApiRequest,
  url: URL,
  transport: TeamHumanDecisionTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/team/decision' || req.method !== 'POST') return undefined;

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
    const response = await transport.resolve(request);
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
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
