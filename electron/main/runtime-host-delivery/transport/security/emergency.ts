import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = {
  success: false,
  error: 'Security emergency is unavailable',
} as const;

type SecurityEmergencyOutcome = 'applied' | 'target_rejected' | 'outcome_unknown';

export type SecurityEmergencyTransportResponse = Readonly<{
  status: 200 | 503;
  body: Readonly<{ outcome: SecurityEmergencyOutcome }> | typeof UNAVAILABLE;
}>;

export interface SecurityEmergencyTransport {
  run(): Promise<SecurityEmergencyTransportResponse>;
}

export function createSecurityEmergencyTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): SecurityEmergencyTransport {
  const url = `http://127.0.0.1:${port}/api/security/emergency`;
  return {
    async run(): Promise<SecurityEmergencyTransportResponse> {
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/security/emergency',
              scope: 'security:write',
              capability: 'security.emergency',
              subject: 'security-emergency',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isOutcome(body)) {
          return { status: 200, body };
        }
      } catch {
        // The public contract deliberately suppresses native transport details.
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isOutcome(value: unknown): value is Readonly<{ outcome: SecurityEmergencyOutcome }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1
    && Object.hasOwn(body, 'outcome')
    && (body.outcome === 'applied'
      || body.outcome === 'target_rejected'
      || body.outcome === 'outcome_unknown');
}
