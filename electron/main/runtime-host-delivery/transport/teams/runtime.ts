import { decodeCallReceipt } from '../../../../../src/types/call-log/receipt';
import { decodeTeamDesignMutation, decodeTeamDesignSnapshot } from '../../../../../src/types/team-design';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { isRecord, sendLoopbackJson } from '../client';

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
      const response = await sendLoopbackJson({
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
      if (isRecord(request) && (request.operationId === 'team.provisionAgents' || request.operationId === 'team.delete' || request.operationId === 'team.runDelete')) {
        if (response?.status === 202) {
          try {
            return { status: 202, body: decodeCallReceipt(response.body) };
          } catch {
            return { status: 503, body: UNAVAILABLE };
          }
        }
        if (response?.status === 200) return { status: 503, body: UNAVAILABLE };
      } else if (response?.status === 200) {
        if (isRecord(request) && (request.operationId === 'team.designStart' || request.operationId === 'team.designContinue' || request.operationId === 'team.designExit' || request.operationId === 'team.designSnapshot' || request.operationId === 'team.designGraphPatch')) {
          try {
            const body = (request.operationId === 'team.designSnapshot' || request.operationId === 'team.designGraphPatch')
              && isRecord(request.target) && typeof request.target.teamId === 'string'
              && isRecord(request.input) && typeof request.input.runId === 'string'
              ? decodeTeamDesignSnapshot(response.body, { teamId: request.target.teamId, runId: request.input.runId })
              : decodeTeamDesignMutation(response.body, request.operationId === 'team.designExit' ? 'intake' : 'designing');
            return { status: 200, body };
          } catch {
            return { status: 503, body: UNAVAILABLE };
          }
        }
        return { status: 200, body: response.body };
      }
      if (response?.status === 400) return { status: 400, body: response.body ?? INVALID };
      if (response?.status === 500) return { status: 500, body: response.body ?? UNAVAILABLE };
      return { status: 503, body: response?.body ?? UNAVAILABLE };
    },
  };
}

function withTrace(request: unknown, traceId: string | undefined): unknown {
  if (!traceId || !isRecord(request)) return request;
  return { ...request, traceId };
}
