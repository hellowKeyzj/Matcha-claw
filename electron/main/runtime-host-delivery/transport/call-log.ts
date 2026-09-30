import type { CallHistory, CallPage, CallRecord } from '../../../../src/types/call-log';
import { decodeCallHistory, decodeCallPage, decodeCallRecord, isCallId, isCallStatus } from '../../../../src/types/call-log/decode';
import { isCallModule } from '../../../../src/types/call-log/modules';
import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { hasExactKeys, isRecord, isSafeNonNegativeInteger, sendLoopbackJson } from './client';

const INVALID = { success: false, error: 'Call log input is invalid' } as const;
const UNAVAILABLE = { success: false, error: 'Call log is unavailable' } as const;
const NOT_FOUND = { success: false, error: 'Call record was not found' } as const;
type Failure = typeof INVALID | typeof UNAVAILABLE | typeof NOT_FOUND;
type Response<T> = Readonly<{ status: number; body: T | Failure }>;

export interface CallLogTransport {
  list(input: unknown): Promise<Response<CallPage>>;
  get(input: unknown): Promise<Response<CallRecord>>;
  history(input: unknown): Promise<Response<CallHistory>>;
}

export function createCallLogTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): CallLogTransport {
  async function read<T>(path: string, body: unknown, decode: (value: unknown) => T): Promise<Response<T>> {
    const response = await sendLoopbackJson({
      port: runtimeHostTransportPort, path, issuer, method: 'POST', fetcher, body, timeoutMs: 30_000,
      decision: { endpoint: path, scope: 'call-log:read', capability: 'call-log.read', subject: 'host-call-log' },
    });
    if (response?.status === 200) {
      try { return { status: 200, body: decode(response.body) }; } catch { /* closed public boundary */ }
    }
    if (response?.status === 400) return { status: 400, body: INVALID };
    if (response?.status === 404) return { status: 404, body: NOT_FOUND };
    return { status: 503, body: UNAVAILABLE };
  }

  async function get(input: unknown): Promise<Response<CallRecord>> {
    if (!isRecord(input) || !hasExactKeys(input, ['callId']) || !isCallId(input.callId)) {
      return { status: 400, body: INVALID };
    }
    return read('/api/calls/get', input, (value) => {
      const call = decodeCallRecord(value);
      if (call.callId !== input.callId) throw new Error('Invalid call identity');
      return call;
    });
  }

  return {
    async list(input) {
      if (!isRecord(input) || !Object.keys(input).every((key) => ['module', 'status', 'before', 'limit'].includes(key))
        || !isLimit(input.limit)
        || (input.module !== undefined && input.module !== null && (typeof input.module !== 'string' || !isCallModule(input.module)))
        || (input.status !== undefined && input.status !== null && !isCallStatus(input.status))
        || (input.before !== undefined && input.before !== null && !isCallId(input.before))) {
        return { status: 400, body: INVALID };
      }
      return read('/api/calls/list', input, decodeCallPage);
    },
    get,
    async history(input) {
      if (!isRecord(input) || !Object.keys(input).every((key) => ['callId', 'afterRevision', 'limit'].includes(key))
        || !isCallId(input.callId) || !isLimit(input.limit)
        || (input.afterRevision !== undefined && input.afterRevision !== null && !isSafeNonNegativeInteger(input.afterRevision))) {
        return { status: 400, body: INVALID };
      }
      const response = await get({ callId: input.callId });
      if (!('module' in response.body)) return { status: response.status, body: response.body };
      const module = response.body.module;
      return read('/api/calls/history', input, (value) => decodeCallHistory(value, module));
    },
  };
}

function isLimit(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0 && value <= 200;
}
