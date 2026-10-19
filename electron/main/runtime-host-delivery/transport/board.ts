import {
  BOARD_EXECUTE_PATH, decodeBoardExecuteRequest, decodeBoardFailure, decodeBoardResult,
  type BoardErrorResponse, type BoardFailureCode,
} from '../../../../src/types/board';
import { buildSessionIdentityKey } from '../../../../src/types/desktop/runtime-address';
import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { hasExactKeys, isRecord, sendLoopbackJsonDelivery } from './client';

export type BoardResponse = Readonly<{ status: 200 | 400 | 401 | 404 | 409 | 500 | 503; body: unknown }>;
export interface BoardTransport {
  execute(request: unknown, signal?: AbortSignal): Promise<BoardResponse>;
}

const FAILURE_MESSAGES: Readonly<Record<BoardFailureCode, string>> = {
  unsupported: 'Board is not supported by this runtime',
  invalid: 'Board request is invalid',
  forbidden: 'Board operation is not authorized',
  stale: 'Board widget has changed; refresh and try again',
  expired: 'Board view has expired; refresh the board',
  'missing-source': 'Board widget source is no longer available',
  unavailable: 'Board runtime is unavailable',
  unknown: 'Board operation outcome is unknown',
};

export function boardFailureResponse(code: BoardFailureCode): BoardErrorResponse {
  return { error: { code, message: FAILURE_MESSAGES[code] } };
}

export function createBoardTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): BoardTransport {
  return {
    async execute(value, signal) {
      let request;
      try { request = decodeBoardExecuteRequest(value); }
      catch { return { status: 400, body: boardFailureResponse('invalid') }; }
      const mutating = request.operation.method !== 'board.get' && request.operation.method !== 'board.data.read';
      const delivery = await sendLoopbackJsonDelivery({
        port, path: BOARD_EXECUTE_PATH, method: 'POST', issuer, fetcher, signal, body: request, timeoutMs: 35_000,
        decision: { endpoint: BOARD_EXECUTE_PATH, scope: 'board.runtime', capability: request.operation.method,
          subject: buildSessionIdentityKey(request.identity) },
      });
      if (delivery.outcome !== 'response') return { status: 503,
        body: boardFailureResponse(delivery.outcome === 'unknown' && mutating ? 'unknown' : 'unavailable') };
      const { status, body } = delivery.response;
      if (status === 200) {
        try {
          const result = decodeBoardResult(request.operation.method, body);
          if (['board.get', 'board.update', 'board.widget.put', 'board.widget.grant'].includes(request.operation.method)
            && isRecord(result) && 'sessionKey' in result && result.sessionKey !== request.identity.sessionKey) throw new Error('Board identity mismatch');
          return { status: 200, body: result };
        } catch { return { status: 503, body: boardFailureResponse(mutating ? 'unknown' : 'unavailable') }; }
      }
      if ([400, 401, 404, 409, 500, 503].includes(status) && isRecord(body) && hasExactKeys(body, ['error'])) {
        try {
          const failure = decodeBoardFailure(body.error);
          return { status: status as Exclude<BoardResponse['status'], 200>, body: boardFailureResponse(failure.code) };
        } catch { /* An unsealed failure is never renderer-visible. */ }
      }
      return { status: 503, body: boardFailureResponse(mutating && status !== 401 && status !== 403 ? 'unknown' : 'unavailable') };
    },
  };
}
