import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PORTS, getPort } from '../utils/config';
import { logger } from '../utils/logger';
import type { HostApiContext } from './context';
import { handleAppRoutes } from './routes/app';
import { handleGatewayRoutes } from './routes/gateway';
import { handleSettingsRoutes } from './routes/settings';
import { handleSecurityRoutes } from './routes/security';
import { handleProviderRoutes } from './routes/providers';
import { handleChannelRoutes } from './routes/channels';
import { handleLogRoutes } from './routes/logs';
import { handleUsageRoutes } from './routes/usage';
import { handleSkillRoutes } from './routes/skills';
import { handleFileRoutes } from './routes/files';
import { handleSessionRoutes } from './routes/sessions';
import { handleCronRoutes } from './routes/cron';
import { handleLicenseRoutes } from './routes/license';
import { handleDiagnosticsRoutes } from './routes/diagnostics';
import { sendJson } from './route-utils';

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
) => Promise<boolean>;

const routeHandlers: RouteHandler[] = [
  handleAppRoutes,
  handleGatewayRoutes,
  handleSettingsRoutes,
  handleSecurityRoutes,
  handleProviderRoutes,
  handleChannelRoutes,
  handleSkillRoutes,
  handleFileRoutes,
  handleSessionRoutes,
  handleCronRoutes,
  handleLicenseRoutes,
  handleDiagnosticsRoutes,
  handleLogRoutes,
  handleUsageRoutes,
];

export function startHostApiServer(ctx: HostApiContext, port = PORTS.MATCHACLAW_HOST_API): Server {
  const resolvedPort = Number.isFinite(port) && port > 0
    ? port
    : getPort('MATCHACLAW_HOST_API');

  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${resolvedPort}`);
      for (const handler of routeHandlers) {
        if (await handler(req, res, requestUrl, ctx)) {
          return;
        }
      }
      sendJson(res, 404, { success: false, error: `No route for ${req.method} ${requestUrl.pathname}` });
    } catch (error) {
      logger.error('Host API request failed:', error);
      sendJson(res, 500, { success: false, error: String(error) });
    }
  });

  server.listen(resolvedPort, '127.0.0.1', () => {
    logger.info(`Host API server listening on http://127.0.0.1:${resolvedPort}`);
  });

  return server;
}
