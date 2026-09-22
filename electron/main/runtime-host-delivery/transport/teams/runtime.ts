import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { isRecord, sendLoopbackJson } from '../client';

const ENDPOINT = '/api/team/runtime/execute';
const INVALID = { success: false, error: 'Team runtime request is invalid' } as const;
const UNAVAILABLE = { success: false, error: 'Team runtime operation is unavailable' } as const;

export type TeamRuntimeTransportResponse = Readonly<{
  status: 200 | 400 | 500 | 503;
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
      if (response?.status === 200) return { status: 200, body: response.body };
      if (response?.status === 400) return { status: 400, body: INVALID };
      if (response?.status === 500) return { status: 500, body: UNAVAILABLE };
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function withTrace(request: unknown, traceId: string | undefined): unknown {
  if (!traceId || !isRecord(request)) return request;
  return { ...request, traceId };
}
