import type { CallReceipt } from '../../../../../src/types/call-log';
import { decodeCallReceipt } from '../../../../../src/types/call-log/receipt';
import {
  decodeNativePolicyResult,
  isNativePolicyRequest,
  type NativePolicyResult,
} from '../../../../../src/types/native-policy';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJsonDelivery } from '../client';

const ENDPOINT = '/api/security/native-policy';
export const NATIVE_POLICY_INVALID = { success: false, error: 'Native policy request is invalid' } as const;
const UNAUTHORIZED = { success: false, error: 'Native policy authorization is invalid' } as const;
const NOT_FOUND = { success: false, error: 'Native policy result is not available' } as const;
export const NATIVE_POLICY_UNAVAILABLE = { success: false, error: 'Native policy is unavailable' } as const;
export const NATIVE_POLICY_OUTCOME_UNKNOWN: NativePolicyResult = {
  outcome: 'unknown',
  code: null,
  kind: 'native_policy_unknown',
  persisted: null,
  projection: null,
  acknowledgedSteps: [],
  restartRequired: null,
  restartFields: [],
  otherSessions: null,
};

export type NativePolicyTransportResponse = Readonly<{
  status: 200 | 202 | 400 | 401 | 404 | 422 | 501 | 503;
  body: NativePolicyResult | CallReceipt | typeof NATIVE_POLICY_INVALID | typeof UNAUTHORIZED
    | typeof NOT_FOUND | typeof NATIVE_POLICY_UNAVAILABLE;
}>;

export interface NativePolicyTransport {
  execute(request: unknown): Promise<NativePolicyTransportResponse>;
}

export function createNativePolicyTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): NativePolicyTransport {
  return {
    async execute(value) {
      if (!isNativePolicyRequest(value)) return { status: 400, body: NATIVE_POLICY_INVALID };
      const mutation = value.operationId.endsWith('.set');
      const result = value.operationId === 'nativePolicy.result';
      const endpoint = result ? `${ENDPOINT}/result` : ENDPOINT;
      const delivery = await sendLoopbackJsonDelivery({
        port: runtimeHostTransportPort,
        path: endpoint,
        issuer,
        decision: {
          endpoint,
          scope: 'security:native-policy',
          capability: value.operationId,
          subject: 'native-policy',
        },
        method: 'POST',
        fetcher,
        body: value,
      });
      if (delivery.outcome !== 'response') {
        return { status: 503, body: delivery.outcome === 'unknown' && (mutation || result)
          ? NATIVE_POLICY_OUTCOME_UNKNOWN : NATIVE_POLICY_UNAVAILABLE };
      }
      const response = delivery.response;
      if (mutation && response.status === 202) {
        try { return { status: 202, body: decodeCallReceipt(response.body) }; }
        catch { return { status: 503, body: NATIVE_POLICY_OUTCOME_UNKNOWN }; }
      }
      const errors = {
        400: NATIVE_POLICY_INVALID,
        401: UNAUTHORIZED,
        404: NOT_FOUND,
        503: NATIVE_POLICY_UNAVAILABLE,
      } as const;
      for (const status of [400, 401, 404, 503] as const) {
        if (response.status === status && (status !== 404 || result) && isExactError(response.body, errors[status])) {
          return { status, body: errors[status] };
        }
      }
      const body = decodeNativePolicyResult(response.body, value);
      if (body) {
        if (!mutation && response.status === 200 && (body.outcome === 'available' || body.outcome === 'confirmed')) {
          return { status: 200, body };
        }
        if (response.status === 422 && body.outcome === 'rejected') return { status: 422, body };
        if (response.status === 501 && body.outcome === 'unsupported') return { status: 501, body };
        if (response.status === 503 && (body.outcome === 'unavailable' || body.outcome === 'unknown')) return { status: 503, body };
      }
      return { status: 503, body: mutation || result ? NATIVE_POLICY_OUTCOME_UNKNOWN : NATIVE_POLICY_UNAVAILABLE };
    },
  };
}

function isExactError(value: unknown, expected: Readonly<{ success: false; error: string }>): boolean {
  return isRecord(value) && hasExactKeys(value, ['success', 'error'])
    && value.success === false && value.error === expected.error;
}
