import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = {
  success: false,
  error: 'Team pending approvals are unavailable',
} as const;

export type TeamPendingApproval = Readonly<{
  approvalId: string;
  stageId: string;
  roleId: string;
  reason: string;
  requestedAction: string;
  createdAt: number;
}>;

export type TeamPendingApprovals = Readonly<{
  teamId: string;
  runId: string;
  approvals: readonly TeamPendingApproval[];
}>;

export type TeamApprovalsTransportResponse = Readonly<{
  status: 200 | 503;
  body: TeamPendingApprovals | typeof UNAVAILABLE;
}>;

export interface TeamApprovalsTransport {
  read(request: Readonly<{ teamId: string; runId: string }>): Promise<TeamApprovalsTransportResponse>;
}

export function createTeamApprovalsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): TeamApprovalsTransport {
  const url = `http://127.0.0.1:${port}/api/team/approvals`;
  return {
    async read(request): Promise<TeamApprovalsTransportResponse> {
      if (!isRequest(request)) return { status: 503, body: UNAVAILABLE };
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/team/approvals',
              scope: 'team:read',
              capability: 'team.approvals.list',
              subject: 'team-pending-approvals',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isProjection(body)) return { status: 200, body };
        if (response.status === 503 && isUnavailable(body)) return { status: 503, body };
      } catch {
        // Native transport details do not cross the Electron delivery boundary.
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRequest(value: unknown): value is Readonly<{ teamId: string; runId: string }> {
  return isRecord(value)
    && hasExactKeys(value, ['teamId', 'runId'])
    && isIdentifier(value.teamId)
    && isIdentifier(value.runId);
}

function isProjection(value: unknown): value is TeamPendingApprovals {
  return isRecord(value)
    && hasExactKeys(value, ['teamId', 'runId', 'approvals'])
    && isIdentifier(value.teamId)
    && isIdentifier(value.runId)
    && Array.isArray(value.approvals)
    && value.approvals.every(isApproval);
}

function isApproval(value: unknown): value is TeamPendingApproval {
  return isRecord(value)
    && hasExactKeys(value, ['approvalId', 'stageId', 'roleId', 'reason', 'requestedAction', 'createdAt'])
    && isIdentifier(value.approvalId)
    && isIdentifier(value.stageId)
    && isIdentifier(value.roleId)
    && typeof value.reason === 'string'
    && typeof value.requestedAction === 'string'
    && isCounter(value.createdAt);
}

function isUnavailable(value: unknown): value is typeof UNAVAILABLE {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && value.error === UNAVAILABLE.error;
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
