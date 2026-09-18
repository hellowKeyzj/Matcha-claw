import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { isRecord, sendLoopbackJson } from '../client';

const UNAVAILABLE = { success: false, error: 'Team task board is unavailable' } as const;
export type TeamTaskBoardTransportResponse = Readonly<{ status: 200 | 409 | 503; body: unknown }>;
export interface TeamTaskBoardTransport {
  read(request: Readonly<{ teamId: string; runId: string }>, signal?: AbortSignal): Promise<TeamTaskBoardTransportResponse>;
  mutate(request: Record<string, unknown>, signal?: AbortSignal): Promise<TeamTaskBoardTransportResponse>;
}
export function createTeamTaskBoardTransport(issuer: RuntimeHostDeliveryIssuer, runtimeHostTransportPort: number, fetcher: typeof fetch = fetch): TeamTaskBoardTransport {
  async function call(body: Record<string, unknown>, signal?: AbortSignal): Promise<TeamTaskBoardTransportResponse> {
    const response = await sendLoopbackJson({
      port: runtimeHostTransportPort,
      path: '/api/team/task-board',
      issuer,
      decision: {
        endpoint: '/api/team/task-board',
        scope: body.action === 'read' ? 'team:read' : 'team:write',
        capability: body.action === 'read' ? 'team.task-board.read' : String(body.operation),
        subject: 'team-task-board',
      },
      method: 'POST',
      fetcher,
      body,
      signal,
    });
    if ((response?.status === 200 || response?.status === 409) && isRecord(response.body)) return { status: response.status, body: response.body };
    return { status: 503, body: UNAVAILABLE };
  }
  return {
    read: (request, signal) => call({ action: 'read', ...request }, signal),
    mutate: (request, signal) => call({ action: 'mutate', ...request }, signal),
  };
}
