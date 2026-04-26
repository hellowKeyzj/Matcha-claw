import { TRANSPORT_VERSION } from '../common/constants';
import { normalizeRoutePath, sendJson } from '../common/http';
import { parseDispatchEnvelope } from './dispatch-envelope';
import type { LocalDispatchResponse } from './local-business-dispatch-types';

interface TransportStats {
  totalDispatchRequests: number;
  localBusinessHandled: number;
  unhandledRouteCount: number;
  badRequestRejected: number;
  dispatchInternalError: number;
}

interface DispatchRouteDeps {
  transportStats: TransportStats;
  tryHandleLocalBusinessDispatch: (
    method: string,
    route: string,
    payload: unknown,
  ) => Promise<LocalDispatchResponse | null>;
}

function readRequestBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
    req.on('error', reject);
  });
}

export function handleDispatchRoute(req: any, res: any, deps: DispatchRouteDeps): void {
  readRequestBody(req).then(async (rawBody) => {
    try {
      const envelope = parseDispatchEnvelope(rawBody);
      deps.transportStats.totalDispatchRequests += 1;
      if (!envelope.ok) {
        deps.transportStats.badRequestRejected += 1;
        sendJson(res, envelope.status, {
          version: TRANSPORT_VERSION,
          success: false,
          status: envelope.status,
          error: envelope.error,
        });
        return;
      }
      const parsed = envelope.value;

      const localResponse = await deps.tryHandleLocalBusinessDispatch(parsed.method, parsed.route, parsed.payload);
      if (localResponse) {
        deps.transportStats.localBusinessHandled += 1;
        sendJson(res, localResponse.status, {
          version: TRANSPORT_VERSION,
          success: true,
          status: localResponse.status,
          data: localResponse.data,
        });
        return;
      }

      deps.transportStats.unhandledRouteCount += 1;
      sendJson(res, 404, {
        version: TRANSPORT_VERSION,
        success: false,
        status: 404,
        error: {
          code: 'NOT_FOUND',
          message: `Runtime Host route not implemented: ${parsed.method} ${normalizeRoutePath(parsed.route)}`,
        },
      });
    } catch (error) {
      const isBadRequest = error instanceof SyntaxError;
      const statusCode = isBadRequest ? 400 : 500;
      if (isBadRequest) {
        deps.transportStats.badRequestRejected += 1;
      } else {
        deps.transportStats.dispatchInternalError += 1;
      }
      sendJson(res, statusCode, {
        version: TRANSPORT_VERSION,
        success: false,
        status: statusCode,
        error: {
          code: isBadRequest ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
          message: `Dispatch failure: ${String(error)}`,
        },
      });
    }
  }).catch((error) => {
    deps.transportStats.dispatchInternalError += 1;
    sendJson(res, 500, {
      version: TRANSPORT_VERSION,
      success: false,
      status: 500,
      error: {
        code: 'INTERNAL_ERROR',
        message: `Dispatch failure: ${String(error)}`,
      },
    });
  });
}
