import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
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
  port: number,
  fetcher: typeof fetch = fetch,
): TeamWebhookAuthTransport {
  const url = `http://127.0.0.1:${port}/api/team/webhook-auth`;
  return {
    read: async () => {
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/team/webhook-auth',
              scope: 'team:read',
              capability: 'team.webhook-auth',
              subject: 'team-webhook-auth',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        const result: unknown = await response.json();
        if (response.status === 200 && isProjection(result)) {
          return { status: 200, body: result };
        }
      } catch {
        // Native transport details do not cross the Electron delivery boundary.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
