import { TRANSPORT_VERSION } from '../../shared/runtime-host-constants';
import { normalizeRoutePath, sendJson, type RuntimeHttpResponsePort } from '../common/http';
import { parseDispatchEnvelope } from './dispatch-envelope';
import type { RuntimeRouteResponse } from './runtime-route-dispatcher-types';
import type { RuntimeHostLogger } from '../../shared/logger';

interface TransportStats {
  totalDispatchRequests: number;
  runtimeRouteHandled: number;
  unhandledRouteCount: number;
  badRequestRejected: number;
  dispatchInternalError: number;
}

interface DispatchRouteDeps {
  transportStats: TransportStats;
  logger?: RuntimeHostLogger;
  dispatchRuntimeRoute: (
    method: string,
    route: string,
    payload: unknown,
  ) => Promise<RuntimeRouteResponse | null>;
}

interface RuntimeHttpRequestPort {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

function readRequestBody(req: RuntimeHttpRequestPort): Promise<string> {
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

function createDispatchTraceId(totalDispatchRequests: number): string {
  return `dispatch-${String(totalDispatchRequests + 1)}-${Date.now().toString(36)}`;
}

function schedulePendingDispatchLog(
  deps: DispatchRouteDeps,
  traceId: string,
  method: string,
  route: string,
  startedAt: number,
  delayMs: number,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    deps.logger?.warn('[dispatch] pending', {
      traceId,
      method,
      route: normalizeRoutePath(route),
      elapsedMs: Date.now() - startedAt,
      pendingMs: delayMs,
    });
  }, delayMs);
  timer.unref?.();
  return timer;
}

export function handleDispatchRoute(
  req: RuntimeHttpRequestPort,
  res: RuntimeHttpResponsePort,
  deps: DispatchRouteDeps,
): void {
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
      const traceId = createDispatchTraceId(deps.transportStats.totalDispatchRequests);
      const startedAt = Date.now();
      deps.logger?.traceDebug?.(2, '[dispatch] start', {
        traceId,
        method: parsed.method,
        route: normalizeRoutePath(parsed.route),
      });
      const pendingTimers = [
        schedulePendingDispatchLog(deps, traceId, parsed.method, parsed.route, startedAt, 5_000),
        schedulePendingDispatchLog(deps, traceId, parsed.method, parsed.route, startedAt, 10_000),
      ];

      let routeResponse: RuntimeRouteResponse | null;
      try {
        routeResponse = await deps.dispatchRuntimeRoute(parsed.method, parsed.route, parsed.payload);
      } finally {
        for (const timer of pendingTimers) {
          clearTimeout(timer);
        }
      }
      if (routeResponse) {
        deps.transportStats.runtimeRouteHandled += 1;
        deps.logger?.traceDebug?.(2, '[dispatch] finish', {
          traceId,
          method: parsed.method,
          route: normalizeRoutePath(parsed.route),
          status: routeResponse.status,
          elapsedMs: Date.now() - startedAt,
        });
        sendJson(res, routeResponse.status, {
          version: TRANSPORT_VERSION,
          success: true,
          status: routeResponse.status,
          data: routeResponse.data,
        });
        return;
      }

      deps.transportStats.unhandledRouteCount += 1;
      deps.logger?.warn('[dispatch] unhandled', {
        traceId,
        method: parsed.method,
        route: normalizeRoutePath(parsed.route),
        elapsedMs: Date.now() - startedAt,
      });
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
