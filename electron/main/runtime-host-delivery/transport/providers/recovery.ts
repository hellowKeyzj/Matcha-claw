import { isAbsolute } from 'node:path';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const RECOVERY_PATH = '/api/providers/recovery';
const ACKNOWLEDGE_PATH = `${RECOVERY_PATH}/acknowledge`;
const UNAVAILABLE = { success: false, error: 'Provider configuration recovery is unavailable' } as const;

export type ProviderRecoveryResponse = Readonly<{
  recovery: Readonly<{ backupDirectory: string }> | null;
}>;

type RecoveryReadResponse =
  | Readonly<{ status: 200; body: ProviderRecoveryResponse }>
  | Readonly<{ status: 503; body: typeof UNAVAILABLE }>;
type RecoveryAcknowledgeResponse =
  | Readonly<{ status: 200; body: Readonly<{ success: true }> }>
  | Readonly<{ status: 503; body: typeof UNAVAILABLE }>;

export interface ProviderRecoveryTransport {
  read(): Promise<RecoveryReadResponse>;
  acknowledge(): Promise<RecoveryAcknowledgeResponse>;
}

export function createProviderRecoveryTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): ProviderRecoveryTransport {
  const request = (path: string, method: 'GET' | 'POST', operationId: string) => sendLoopbackJson({
    port: runtimeHostTransportPort,
    path,
    issuer,
    decision: { endpoint: path, scope: 'providers:accounts', capability: operationId, subject: 'provider-recovery' },
    method,
    fetcher,
    timeoutMs: 5_000,
    ...(method === 'POST' ? { emptyContentLength: true } : {}),
  });
  return {
    async read() {
      const response = await request(RECOVERY_PATH, 'GET', 'providerRecovery.get');
      if (response?.status === 200 && isRecoveryResponse(response.body)) {
        return { status: 200, body: response.body };
      }
      return { status: 503, body: UNAVAILABLE };
    },
    async acknowledge() {
      const response = await request(ACKNOWLEDGE_PATH, 'POST', 'providerRecovery.acknowledge');
      if (response?.status === 200 && isRecord(response.body)
        && hasExactKeys(response.body, ['success']) && response.body.success === true) {
        return { status: 200, body: { success: true } };
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRecoveryResponse(value: unknown): value is ProviderRecoveryResponse {
  if (!isRecord(value) || !hasExactKeys(value, ['recovery'])) return false;
  if (value.recovery === null) return true;
  return isRecord(value.recovery)
    && hasExactKeys(value.recovery, ['backupDirectory'])
    && typeof value.recovery.backupDirectory === 'string'
    && value.recovery.backupDirectory.trim().length > 0
    && Buffer.byteLength(value.recovery.backupDirectory, 'utf8') <= 16 * 1024
    && !/[\p{Cc}]/u.test(value.recovery.backupDirectory)
    && isAbsolute(value.recovery.backupDirectory);
}
