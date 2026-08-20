import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TeamSkillTransport } from '../../main/runtime-host-delivery/transport/teams/skill';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'TeamSkill selection request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'TeamSkill selection is unavailable',
} as const;

type TeamSkillRequest =
  | Readonly<{ operation: 'team.skill.authorize'; packageRoot: string }>
  | Readonly<{ operation: 'team.skill.validate' | 'team.skill.dependency-plan'; selectionId: string }>
  | Readonly<{
      operation: 'team.skill.materialize';
      selectionId: string;
      teamId: string;
      idempotencyKey: string;
    }>;

export async function handleTeamSkillRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: TeamSkillTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/team/skill' || req.method !== 'POST') return false;

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
    const response = request.operation === 'team.skill.authorize'
      ? await transport.authorize(request.packageRoot)
      : request.operation === 'team.skill.validate'
        ? await transport.validate(request.selectionId)
        : request.operation === 'team.skill.dependency-plan'
          ? await transport.dependencyPlan(request.selectionId)
          : await transport.materialize(request.selectionId, request.teamId, request.idempotencyKey);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}

function isRequest(value: unknown): value is TeamSkillRequest {
  if (!isRecord(value) || typeof value.operation !== 'string') return false;
  if (value.operation === 'team.skill.authorize') {
    return hasExactKeys(value, ['operation', 'packageRoot']) && isLocalRoot(value.packageRoot);
  }
  if (value.operation === 'team.skill.materialize') {
    return hasExactKeys(value, ['operation', 'selectionId', 'teamId', 'idempotencyKey'])
      && isSelectionId(value.selectionId)
      && isOpaqueId(value.teamId)
      && isOpaqueId(value.idempotencyKey);
  }
  return hasExactKeys(value, ['operation', 'selectionId'])
    && (value.operation === 'team.skill.validate' || value.operation === 'team.skill.dependency-plan')
    && isSelectionId(value.selectionId);
}

function isSelectionId(value: unknown): value is string {
  return typeof value === 'string' && /^teamskill:v1:[a-f0-9]{64}$/.test(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isLocalRoot(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !value.includes('\0')
    && !value.includes('\n')
    && !value.includes('\r');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
