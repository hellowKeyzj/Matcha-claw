import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import {
  hasExactKeys,
  isNonEmptyBoundedText,
  isRecord,
  isSafeNonNegativeInteger,
  sendLoopbackJson,
} from '../client';

const ENDPOINT = '/api/team/approvals';
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
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): TeamApprovalsTransport {
  return {
    async read(request): Promise<TeamApprovalsTransportResponse> {
      if (!isRequest(request)) return { status: 503, body: UNAVAILABLE };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ENDPOINT,
        issuer,
        decision: {
          endpoint: ENDPOINT,
          scope: 'team:read',
          capability: 'team.approvals.list',
          subject: 'team-pending-approvals',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response === null) return { status: 503, body: UNAVAILABLE };
      if (response.status === 200 && isProjection(response.body)) return { status: 200, body: response.body };
      if (response.status === 503 && isUnavailable(response.body)) return { status: 503, body: response.body };
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRequest(value: unknown): value is Readonly<{ teamId: string; runId: string }> {
  return isRecord(value)
    && hasExactKeys(value, ['teamId', 'runId'])
    && isNonEmptyBoundedText(value.teamId)
    && isNonEmptyBoundedText(value.runId);
}

function isProjection(value: unknown): value is TeamPendingApprovals {
  return isRecord(value)
    && hasExactKeys(value, ['teamId', 'runId', 'approvals'])
    && isNonEmptyBoundedText(value.teamId)
    && isNonEmptyBoundedText(value.runId)
    && Array.isArray(value.approvals)
    && value.approvals.every(isApproval);
}

function isApproval(value: unknown): value is TeamPendingApproval {
  return isRecord(value)
    && hasExactKeys(value, ['approvalId', 'stageId', 'roleId', 'reason', 'requestedAction', 'createdAt'])
    && isNonEmptyBoundedText(value.approvalId)
    && isNonEmptyBoundedText(value.stageId)
    && isNonEmptyBoundedText(value.roleId)
    && typeof value.reason === 'string'
    && typeof value.requestedAction === 'string'
    && isSafeNonNegativeInteger(value.createdAt);
}

function isUnavailable(value: unknown): value is typeof UNAVAILABLE {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && value.error === UNAVAILABLE.error;
}
