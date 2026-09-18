import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const ROUTE_PATH = '/api/team/webhook-auth';
const UNAVAILABLE = { success: false, error: 'Team webhook auth is unavailable' } as const;

export type TeamWebhookAuthProjection = Readonly<{
  success: true;
  enabled: true;
  source: 'environment' | 'settings';
  headerName: 'x-matchaclaw-webhook-token';
  authorizationScheme: 'Bearer';
  maskedToken: string;
  copySupported: false;
}>;

export type TeamWebhookAuthTransportResponse = Readonly<{
  status: 200 | 503;
  body: TeamWebhookAuthProjection | typeof UNAVAILABLE;
}>;

export interface TeamWebhookAuthTransport {
  read(): Promise<TeamWebhookAuthTransportResponse>;
}

export function createTeamWebhookAuthTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): TeamWebhookAuthTransport {
  return {
    read: async () => {
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE_PATH,
        issuer,
        decision: {
          endpoint: ROUTE_PATH,
          scope: 'team:read',
          capability: 'team.webhook-auth',
          subject: 'team-webhook-auth',
        },
        method: 'POST',
        fetcher,
        body: {},
      });
      if (response?.status === 200 && isProjection(response.body)) {
        return { status: 200, body: response.body };
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isProjection(value: unknown): value is TeamWebhookAuthProjection {
  return isRecord(value)
    && hasExactKeys(value, [
      'success', 'enabled', 'source', 'headerName', 'authorizationScheme', 'maskedToken', 'copySupported',
    ])
    && value.success === true
    && value.enabled === true
    && (value.source === 'environment' || value.source === 'settings')
    && value.headerName === 'x-matchaclaw-webhook-token'
    && value.authorizationScheme === 'Bearer'
    && isMaskedToken(value.maskedToken)
    && value.copySupported === false;
}

function isMaskedToken(value: unknown): value is string {
  return typeof value === 'string'
    && /^mctwh_…[0-9a-f]{4}$/.test(value);
}
