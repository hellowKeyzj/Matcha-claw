import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = { success: false, error: 'Team trigger is unavailable' } as const;
const REJECTED = { success: false, error: 'Team trigger was rejected' } as const;

export type TeamTrigger = Readonly<{
  teamId: string;
  runId: string;
  startNodeId: string;
  trigger: Readonly<{ kind: 'webhook'; path: string }> | Readonly<{ kind: 'cron'; expression: string }>;
}>;

export type TeamTriggerTransportResponse = Readonly<{
  status: 200 | 404 | 409 | 503;
  body: Readonly<{ success: true; triggers: readonly TeamTrigger[] }>
    | Readonly<{ success: true; runId: string }>
    | typeof UNAVAILABLE
    | typeof REJECTED;
}>;

export interface TeamTriggerTransport {
  list(request: Readonly<{ teamId: string }>): Promise<TeamTriggerTransportResponse>;
  fire(request: Readonly<{ runId: string; startNodeId: string; source: 'cron' | 'webhook'; idempotencyKey: string }>): Promise<TeamTriggerTransportResponse>;
}

export function createTeamTriggerTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): TeamTriggerTransport {
  const url = `http://127.0.0.1:${port}/api/team/trigger`;
  return {
    list: (request) => send(url, issuer, fetcher, { action: 'list', ...request }),
    fire: (request) => send(url, issuer, fetcher, { action: 'fire', ...request }),
  };
}

async function send(
  url: string,
  issuer: RuntimeHostDeliveryIssuer,
  fetcher: typeof fetch,
  body: Record<string, unknown>,
): Promise<TeamTriggerTransportResponse> {
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${issuer.signDecision({
          principal: 'electron-main-local',
          endpoint: '/api/team/trigger',
          scope: 'team:write',
          capability: 'team.trigger',
          subject: 'team-trigger',
          expiresAt: Date.now() + DECISION_TTL_MS,
          revision: '1',
        })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const result: unknown = await response.json();
    if (response.status === 200 && isSuccess(result)) return { status: 200, body: result };
    if (response.status === 404 && isUnavailable(result)) return { status: 404, body: result };
    if (response.status === 409 && isRejected(result)) return { status: 409, body: result };
  } catch {
    // Native transport details do not cross the Electron delivery boundary.
  }
  return { status: 503, body: UNAVAILABLE };
}

function isSuccess(value: unknown): value is TeamTriggerTransportResponse['body'] {
  return isRecord(value) && value.success === true && (
    (hasExactKeys(value, ['success', 'runId']) && isIdentifier(value.runId))
    || (hasExactKeys(value, ['success', 'triggers']) && Array.isArray(value.triggers) && value.triggers.every(isTrigger))
  );
}

function isTrigger(value: unknown): value is TeamTrigger {
  return isRecord(value)
    && hasExactKeys(value, ['teamId', 'runId', 'startNodeId', 'trigger'])
    && isIdentifier(value.teamId)
    && isIdentifier(value.runId)
    && isIdentifier(value.startNodeId)
    && isRecord(value.trigger)
    && ((hasExactKeys(value.trigger, ['kind', 'path']) && value.trigger.kind === 'webhook' && typeof value.trigger.path === 'string')
      || (hasExactKeys(value.trigger, ['kind', 'expression']) && value.trigger.kind === 'cron' && typeof value.trigger.expression === 'string'));
}

function isUnavailable(value: unknown): value is typeof UNAVAILABLE {
  return isRecord(value) && hasExactKeys(value, ['success', 'error']) && value.success === false && value.error === UNAVAILABLE.error;
}

function isRejected(value: unknown): value is typeof REJECTED {
  return isRecord(value) && hasExactKeys(value, ['success', 'error']) && value.success === false && value.error === REJECTED.error;
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
