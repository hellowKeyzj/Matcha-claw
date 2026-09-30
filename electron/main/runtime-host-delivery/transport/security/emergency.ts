import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import type { CallReceipt } from '../../../../../src/types/call-log';
import { sendLoopbackJson } from '../client';
import { isSecurityCallReceipt } from './policy';

const UNAVAILABLE = {
  success: false,
  error: 'Security emergency is unavailable',
} as const;

export type SecurityEmergencyTransportResponse = Readonly<{
  status: 202;
  body: CallReceipt;
}> | Readonly<{
  status: 503;
  body: typeof UNAVAILABLE;
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
      if (response?.status === 202 && isSecurityCallReceipt(response.body)) {
        return { status: 202, body: response.body };
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}
