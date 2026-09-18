import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isNonEmptyBoundedText, isRecord, sendLoopbackJson } from '../client';

const ROUTE_PATH = '/api/team/trigger';
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
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): TeamTriggerTransport {
  return {
    list: (request) => send(issuer, runtimeHostTransportPort, fetcher, { action: 'list', ...request }),
    fire: (request) => send(issuer, runtimeHostTransportPort, fetcher, { action: 'fire', ...request }),
  };
}

async function send(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch,
  body: Record<string, unknown>,
): Promise<TeamTriggerTransportResponse> {
  const response = await sendLoopbackJson({
    port: runtimeHostTransportPort,
    path: ROUTE_PATH,
    issuer,
    decision: {
      endpoint: ROUTE_PATH,
      scope: 'team:write',
      capability: 'team.trigger',
      subject: 'team-trigger',
    },
    method: 'POST',
    fetcher,
    body,
  });
  if (response?.status === 200 && isSuccess(response.body)) return { status: 200, body: response.body };
  if (response?.status === 404 && isUnavailable(response.body)) return { status: 404, body: response.body };
  if (response?.status === 409 && isRejected(response.body)) return { status: 409, body: response.body };
  return { status: 503, body: UNAVAILABLE };
}

function isSuccess(value: unknown): value is TeamTriggerTransportResponse['body'] {
  return isRecord(value) && value.success === true && (
    (hasExactKeys(value, ['success', 'runId']) && isNonEmptyBoundedText(value.runId))
    || (hasExactKeys(value, ['success', 'triggers']) && Array.isArray(value.triggers) && value.triggers.every(isTrigger))
  );
}

function isTrigger(value: unknown): value is TeamTrigger {
  return isRecord(value)
    && hasExactKeys(value, ['teamId', 'runId', 'startNodeId', 'trigger'])
    && isNonEmptyBoundedText(value.teamId)
    && isNonEmptyBoundedText(value.runId)
    && isNonEmptyBoundedText(value.startNodeId)
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
