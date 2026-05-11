import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { handleDispatchRoute } from '../api/dispatch/dispatch-route-handler';
import type { RuntimeRouteResponse } from '../api/dispatch/runtime-route-dispatcher-types';
import { sendJson } from '../api/common/http';
import {
  TRANSPORT_VERSION,
} from '../shared/runtime-host-constants';
import type { RuntimeLifecycleState } from '../application/common/runtime-contracts';
import type { RuntimeHostLogger } from '../shared/logger';

export interface RuntimeHostTransportStats {
  totalDispatchRequests: number;
  runtimeRouteHandled: number;
  unhandledRouteCount: number;
  badRequestRejected: number;
  dispatchInternalError: number;
}

export interface RuntimeHostHttpServerDeps {
  readonly port: number;
  readonly startedAtMs: number;
  readonly getLifecycleState: () => RuntimeLifecycleState;
  readonly restartLifecycle: () => void;
  readonly createHealthPayload: (lifecycle: RuntimeLifecycleState, startedAtMs: number) => unknown;
  readonly transportStats: RuntimeHostTransportStats;
  readonly logger?: RuntimeHostLogger;
  readonly dispatchRuntimeRoute: (
    method: string,
    route: string,
    payload: unknown,
  ) => Promise<RuntimeRouteResponse | null>;
  readonly shutdown: (exitCode?: number) => Promise<void>;
}

export function createTransportStats(): RuntimeHostTransportStats {
  return {
    totalDispatchRequests: 0,
    runtimeRouteHandled: 0,
    unhandledRouteCount: 0,
    badRequestRejected: 0,
    dispatchInternalError: 0,
  };
}

export function createRuntimeHostHttpServer(deps: RuntimeHostHttpServerDeps): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', `http://127.0.0.1:${deps.port}`);

    if (method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, deps.createHealthPayload(deps.getLifecycleState(), deps.startedAtMs));
      return;
    }

    if (method === 'POST' && url.pathname === '/lifecycle/restart') {
      deps.restartLifecycle();
      sendJson(res, 200, { version: TRANSPORT_VERSION, success: true, lifecycle: deps.getLifecycleState() });
      return;
    }

    if (method === 'POST' && url.pathname === '/lifecycle/stop') {
      sendJson(res, 200, { version: TRANSPORT_VERSION, success: true, lifecycle: 'stopped' });
      void deps.shutdown(0);
      return;
    }

    if (method === 'POST' && url.pathname === '/dispatch') {
      handleDispatchRoute(req, res, {
        transportStats: deps.transportStats,
        logger: deps.logger,
        dispatchRuntimeRoute: deps.dispatchRuntimeRoute,
      });
      return;
    }

    sendJson(res, 404, {
      version: TRANSPORT_VERSION,
      success: false,
      status: 404,
      error: {
        code: 'NOT_FOUND',
        message: `No route for ${method} ${url.pathname}`,
      },
    });
  });
}

export function closeRuntimeHostHttpServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
