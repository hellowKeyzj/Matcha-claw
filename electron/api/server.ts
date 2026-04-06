import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PORTS, getPort } from '../utils/config';
import { logger } from '../utils/logger';
import type { HostApiContext } from './context';
import { handleAppRoutes } from './routes/app';
import { handleGatewayRoutes } from './routes/gateway';
import { handleRuntimeHostInternalRoutes } from './routes/runtime-host-internal';
import { handleLogRoutes } from './routes/logs';
import { handleFileRoutes } from './routes/files';
import { handleDiagnosticsRoutes } from './routes/diagnostics';
import { handleRuntimeHostProxyRoutes } from './routes/runtime-host-proxy';
import { isMainOwnedRoute } from './route-boundary';
import { sendJson } from './route-utils';

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
) => Promise<boolean>;

const mainOwnedHandlers: RouteHandler[] = [
  handleRuntimeHostInternalRoutes,
  handleAppRoutes,
  handleGatewayRoutes,
  handleFileRoutes,
  handleDiagnosticsRoutes,
  handleLogRoutes,
];

const routeHandlers: RouteHandler[] = [
  ...mainOwnedHandlers,
  handleRuntimeHostProxyRoutes,
];

if (routeHandlers[routeHandlers.length - 1] !== handleRuntimeHostProxyRoutes) {
  throw new Error('Host API route handler chain invalid: runtime-host proxy must be the final fallback handler.');
}

export function createHostApiRequestHandler(ctx: HostApiContext, port: number) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      for (const handler of routeHandlers) {
        if (await handler(req, res, requestUrl, ctx)) {
          return;
        }
      }
      if (isMainOwnedRoute(requestUrl.pathname)) {
        sendJson(res, 500, {
          success: false,
          error: `Main-owned route is not registered: ${req.method} ${requestUrl.pathname}`,
        });
        return;
      }
      sendJson(res, 404, { success: false, error: `No route for ${req.method} ${requestUrl.pathname}` });
    } catch (error) {
      logger.error('Host API request failed:', error);
      sendJson(res, 500, { success: false, error: String(error) });
    }
  };
}

export function startHostApiServer(ctx: HostApiContext, port = PORTS.MATCHACLAW_HOST_API): Server {
  const resolvedPort = Number.isFinite(port) && port > 0
    ? port
    : getPort('MATCHACLAW_HOST_API');

  const server = createServer(createHostApiRequestHandler(ctx, resolvedPort));

  server.listen(resolvedPort, '127.0.0.1', () => {
    logger.info(`Host API server listening on http://127.0.0.1:${resolvedPort}`);
  });

  return server;
}
