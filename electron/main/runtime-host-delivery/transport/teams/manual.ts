import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const ENDPOINT = '/api/team/manual-materialize-and-create';
const UNAVAILABLE = { success: false, error: 'Manual Team materialization is unavailable' } as const;

type ManualTeamRole = Readonly<{
  roleId: string;
  agentId: string;
  displayName: string;
  leader: boolean;
}>;

export type ManualTeamMaterializeAndCreateRequest = Readonly<{
  teamId: string;
  teamName: string;
  idempotencyKey: string;
  roles: readonly ManualTeamRole[];
}>;

export type ManualTeamTransportResponse = Readonly<{
  status: 200 | 503;
  body: Readonly<{ status: 'materialized' | 'rejected' | 'outcome_unknown' }> | typeof UNAVAILABLE;
}>;

export interface ManualTeamTransport {
  materializeAndCreate(request: ManualTeamMaterializeAndCreateRequest): Promise<ManualTeamTransportResponse>;
}

export function createManualTeamTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): ManualTeamTransport {
  return {
    async materializeAndCreate(request): Promise<ManualTeamTransportResponse> {
      if (!isRequest(request)) return { status: 503, body: UNAVAILABLE };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ENDPOINT,
        issuer,
        decision: {
          endpoint: ENDPOINT,
          scope: 'team:write',
          capability: 'team.manual.materialize-and-create',
          subject: 'team-manual-materialize-and-create',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 200 && isOutcome(response.body)) return { status: 200, body: response.body };
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRequest(value: unknown): value is ManualTeamMaterializeAndCreateRequest {
  return isRecord(value)
    && hasExactKeys(value, ['teamId', 'teamName', 'idempotencyKey', 'roles'])
    && isText(value.teamId)
    && isText(value.teamName)
    && isOpaque(value.idempotencyKey)
    && Array.isArray(value.roles)
    && value.roles.length > 0
    && value.roles.length <= 32
    && value.roles.every(isRole)
    && value.roles.filter((role) => role.leader).length === 1;
}

function isRole(value: unknown): value is ManualTeamRole {
  return isRecord(value)
    && hasExactKeys(value, ['roleId', 'agentId', 'displayName', 'leader'])
    && isText(value.roleId)
    && isText(value.agentId)
    && isText(value.displayName)
    && typeof value.leader === 'boolean';
}

function isOutcome(value: unknown): value is Readonly<{ status: 'materialized' | 'rejected' | 'outcome_unknown' }> {
  return isRecord(value)
    && hasExactKeys(value, ['status'])
    && (value.status === 'materialized' || value.status === 'rejected' || value.status === 'outcome_unknown');
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0\p{Cc}]/u.test(value);
}

function isOpaque(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
