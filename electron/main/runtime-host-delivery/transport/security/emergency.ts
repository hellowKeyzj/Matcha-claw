import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

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
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SecurityEmergencyTransport {
  return {
    async run(): Promise<SecurityEmergencyTransportResponse> {
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: '/api/security/emergency',
        issuer,
        decision: {
          endpoint: '/api/security/emergency',
          scope: 'security:write',
          capability: 'security.emergency',
          subject: 'security-emergency',
        },
        method: 'POST',
        fetcher,
        body: {},
      });
      if (response?.status === 200 && isOutcome(response.body)) {
        return { status: 200, body: response.body };
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isOutcome(value: unknown): value is Readonly<{ outcome: SecurityEmergencyOutcome }> {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'applied'
      || value.outcome === 'target_rejected'
      || value.outcome === 'outcome_unknown');
}
