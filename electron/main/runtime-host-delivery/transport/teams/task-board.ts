import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = { success: false, error: 'Team task board is unavailable' } as const;
export type TeamTaskBoardTransportResponse = Readonly<{ status: 200 | 409 | 503; body: unknown }>;
export interface TeamTaskBoardTransport {
  read(request: Readonly<{ teamId: string; runId: string }>, signal?: AbortSignal): Promise<TeamTaskBoardTransportResponse>;
  mutate(request: Record<string, unknown>, signal?: AbortSignal): Promise<TeamTaskBoardTransportResponse>;
}
export function createTeamTaskBoardTransport(issuer: RuntimeHostDeliveryIssuer, port: number, fetcher: typeof fetch = fetch): TeamTaskBoardTransport {
  const url = `http://127.0.0.1:${port}/api/team/task-board`;
  async function call(body: Record<string, unknown>, signal?: AbortSignal): Promise<TeamTaskBoardTransportResponse> {
    try {
      const response = await fetcher(url, { method: 'POST', headers: {
        Authorization: `Bearer ${issuer.signDecision({ principal: 'electron-main-local', endpoint: '/api/team/task-board', scope: body.action === 'read' ? 'team:read' : 'team:write', capability: body.action === 'read' ? 'team.task-board.read' : String(body.operation), subject: 'team-task-board', expiresAt: Date.now() + DECISION_TTL_MS, revision: '1' })}`,
        'Content-Type': 'application/json',
      }, body: JSON.stringify(body), signal });
      const value: unknown = await response.json();
      if ((response.status === 200 || response.status === 409) && isRecord(value)) return { status: response.status, body: value };
    } catch { /* suppress native transport details */ }
    return { status: 503, body: UNAVAILABLE };
  }
  return {
    read: (request, signal) => call({ action: 'read', ...request }, signal),
    mutate: (request, signal) => call({ action: 'mutate', ...request }, signal),
  };
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
