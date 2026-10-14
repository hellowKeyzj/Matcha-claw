import type { TeamCreationFailure } from '../../../../../src/types/call-log/organization';
import { decodeCallReceipt } from '../../../../../src/types/call-log/receipt';
import { decodeTeamDesignMutation, decodeTeamDesignSnapshot, isTeamDesignFailure } from '../../../../../src/types/team-design';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { isRecord, sendLoopbackJsonDelivery } from '../client';

const ENDPOINT = '/api/team/runtime/execute';
const INVALID = { success: false, error: 'Team runtime request is invalid' } as const;
const UNAVAILABLE = { success: false, error: 'Team runtime operation is unavailable' } as const;

export type TeamRuntimeTransportResponse = Readonly<{
  status: 200 | 202 | 400 | 500 | 503;
  body: unknown;
}>;

export interface TeamRuntimeTransport {
  execute(request: unknown, traceId?: string): Promise<TeamRuntimeTransportResponse>;
}

export function createTeamRuntimeTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): TeamRuntimeTransport {
  return {
    async execute(request, traceId): Promise<TeamRuntimeTransportResponse> {
      const delivery = await sendLoopbackJsonDelivery({
        port: runtimeHostTransportPort,
        path: ENDPOINT,
        issuer,
        decision: {
          endpoint: ENDPOINT,
          scope: 'team.runtime',
          capability: 'team.runtime',
          subject: 'team-runtime-execute',
        },
        method: 'POST',
        fetcher,
        body: withTrace(request, traceId),
      });
      if (delivery.outcome !== 'response') {
        return { status: 503, body: withCreationFailure(UNAVAILABLE, request, delivery.reason) };
      }
      const response = delivery.response;
      if (isRecord(request) && (request.operationId === 'team.provisionAgents' || request.operationId === 'team.delete' || request.operationId === 'team.runDelete')) {
        if (response?.status === 202) {
          try {
            return { status: 202, body: decodeCallReceipt(response.body) };
          } catch {
            return { status: 503, body: withCreationFailure(UNAVAILABLE, request, 'invalid_response') };
          }
        }
        if (response?.status === 200) return { status: 503, body: withCreationFailure(UNAVAILABLE, request, 'invalid_response') };
      } else if (response?.status === 200) {
        if (isRecord(request) && (request.operationId === 'team.designStart' || request.operationId === 'team.runStart' || request.operationId === 'team.designExit' || request.operationId === 'team.designSnapshot' || request.operationId === 'team.designGraphPatch')) {
          if (isTeamDesignFailure(response.body)) return { status: 200, body: response.body };
          try {
            const body = (request.operationId === 'team.designSnapshot' || request.operationId === 'team.designGraphPatch')
              && isRecord(request.target) && typeof request.target.teamId === 'string'
              && isRecord(request.input) && typeof request.input.runId === 'string'
              ? decodeTeamDesignSnapshot(response.body, { teamId: request.target.teamId, runId: request.input.runId })
              : decodeTeamDesignMutation(response.body, request.operationId === 'team.designExit' ? 'intake' : request.operationId === 'team.runStart' ? 'started' : 'designing');
            return { status: 200, body };
          } catch {
            return { status: 503, body: UNAVAILABLE };
          }
        }
        return { status: 200, body: response.body };
      }
      if (response?.status === 400) return { status: 400, body: response.body ?? INVALID };
      if (response?.status === 500) return { status: 500, body: response.body ?? UNAVAILABLE };
      const reason = response.status === 401 ? 'authorization_invalid'
        : response.status === 503 && isRecord(response.body) && response.body.code === 'TIMEOUT' ? 'observation_interrupted' : undefined;
      return { status: 503, body: withCreationFailure(response.body ?? UNAVAILABLE, request, reason) };
    },
  };
}

function withCreationFailure(body: unknown, request: unknown, reason: TeamCreationFailure['reason'] | undefined): unknown {
  if (!reason || !isRecord(request) || !isRecord(body) || Object.hasOwn(body, 'creationFailure')) return body;
  const stage: TeamCreationFailure['stage'] | undefined = request.operationId === 'team.provisionAgents' ? 'submitting'
    : request.operationId === 'team.runCreate' ? 'initializing_sessions'
      : request.operationId === 'team.runList' || request.operationId === 'team.runSnapshot' ? 'loading_team' : undefined;
  return stage ? { ...body, creationFailure: { stage, reason } satisfies TeamCreationFailure } : body;
}

function withTrace(request: unknown, traceId: string | undefined): unknown {
  if (!traceId || !isRecord(request)) return request;
  return { ...request, traceId };
}
