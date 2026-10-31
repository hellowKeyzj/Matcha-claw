import {
  isGraphDefinition,
  type TeamGraphDefinition,
  type TeamGraphTransport,
} from '../../main/runtime-host-delivery/transport/teams/graph';
import { hasExactKeys, isRecord } from '../../main/runtime-host-delivery/transport/client';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const INVALID = {
  success: false,
  error: 'Team graph request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Team graph is unavailable',
} as const;

type TeamGraphRequest =
  | Readonly<{ action: 'export'; teamId: string; runId: string }>
  | Readonly<{
      action: 'replace';
      teamId: string;
      commandId?: string;
      idempotencyKey: string;
      graph: TeamGraphDefinition;
    }>
  | Readonly<{
      action: 'import';
      teamId: string;
      commandId?: string;
      idempotencyKey: string;
      yaml: string;
    }>;

export async function handleTeamGraphRoutes(
  req: HostApiRequest,
  url: URL,
  transport: TeamGraphTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/team/graph' || req.method !== 'POST') return undefined;

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
    const response = request.action === 'export'
      ? await transport.export({ teamId: request.teamId, runId: request.runId })
      : request.action === 'replace'
        ? await transport.replace({ teamId: request.teamId, ...(request.commandId ? { commandId: request.commandId } : {}), idempotencyKey: request.idempotencyKey, graph: request.graph })
        : await transport.import({ teamId: request.teamId, ...(request.commandId ? { commandId: request.commandId } : {}), idempotencyKey: request.idempotencyKey, yaml: request.yaml });
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}

function isRequest(value: unknown): value is TeamGraphRequest {
  if (!isRecord(value)) return false;
  if (value.action === 'export') {
    return hasExactKeys(value, ['action', 'teamId', 'runId'])
      && isIdentifier(value.teamId)
      && isIdentifier(value.runId);
  }
  if (value.action === 'replace') {
    return hasOnlyKeys(value, ['action', 'teamId', 'commandId', 'idempotencyKey', 'graph'])
      && hasRequiredKeys(value, ['action', 'teamId', 'idempotencyKey', 'graph'])
      && isIdentifier(value.teamId)
      && (value.commandId === undefined || isOpaqueId(value.commandId))
      && isOpaqueId(value.idempotencyKey)
      && isGraphDefinition(value.graph);
  }
  return value.action === 'import'
    && hasOnlyKeys(value, ['action', 'teamId', 'commandId', 'idempotencyKey', 'yaml'])
    && hasRequiredKeys(value, ['action', 'teamId', 'idempotencyKey', 'yaml'])
    && isIdentifier(value.teamId)
    && (value.commandId === undefined || isOpaqueId(value.commandId))
    && isOpaqueId(value.idempotencyKey)
    && isYaml(value.yaml);
}

function isYaml(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 * 1024 && !value.includes('\0');
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\p{Cc}]/u.test(value);
}

function hasRequiredKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
