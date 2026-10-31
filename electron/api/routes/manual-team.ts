import type {
  ManualTeamMaterializeAndCreateRequest,
  ManualTeamTransport,
} from '../../main/runtime-host-delivery/transport/teams/manual';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const INVALID = {
  success: false,
  error: 'Manual Team materialization request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Manual Team materialization is unavailable',
} as const;

export async function handleManualTeamRoutes(
  req: HostApiRequest,
  url: URL,
  transport: ManualTeamTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/team/manual-materialize-and-create' || req.method !== 'POST') return undefined;

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
    const response = await transport.materializeAndCreate(request);
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}

function isRequest(value: unknown): value is ManualTeamMaterializeAndCreateRequest {
  return isRecord(value)
    && hasExactKeys(value, ['teamId', 'teamName', 'idempotencyKey', 'roles'])
    && isText(value.teamId)
    && isText(value.teamName)
    && isOpaqueId(value.idempotencyKey)
    && Array.isArray(value.roles)
    && value.roles.length > 0
    && value.roles.length <= 32
    && value.roles.every(isRole)
    && value.roles.filter((role) => role.leader).length === 1;
}

function isRole(value: unknown): value is Readonly<{
  roleId: string;
  agentId: string;
  displayName: string;
  leader: boolean;
}> {
  return isRecord(value)
    && hasExactKeys(value, ['roleId', 'agentId', 'displayName', 'leader'])
    && isText(value.roleId)
    && isText(value.agentId)
    && isText(value.displayName)
    && typeof value.leader === 'boolean';
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0\p{Cc}]/u.test(value);
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
