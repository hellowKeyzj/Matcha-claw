import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
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
  port: number,
  fetcher: typeof fetch = fetch,
): ManualTeamTransport {
  const url = `http://127.0.0.1:${port}/api/team/manual-materialize-and-create`;
  return {
    async materializeAndCreate(request): Promise<ManualTeamTransportResponse> {
      if (!isRequest(request)) return { status: 503, body: UNAVAILABLE };
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/team/manual-materialize-and-create',
              scope: 'team:write',
              capability: 'team.manual.materialize-and-create',
              subject: 'team-manual-materialize-and-create',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const result: unknown = await response.json();
        if (response.status === 200 && isOutcome(result)) return { status: 200, body: result };
      } catch {
        // Native transport details do not cross the Electron delivery boundary.
      }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
