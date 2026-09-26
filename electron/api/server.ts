import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { getPort } from '../utils/config';
import { logger } from '../utils/logger';
import type { HostApiContext } from './context';
import { handleAccountRoutes } from './routes/account';
import { handleBillingRoutes } from './routes/billing';
import { handleCapabilityRoutes } from './routes/capabilities';
import { handleAgentsRoutes } from './routes/agents';
import { handleAppRoutes } from './routes/app';
import { handleChannelAuthorizationRoutes } from './routes/channel-authorization';
import { handleChannelCatalogRoutes } from './routes/channel-catalog';
import { handleChannelConfigureRoutes } from './routes/channel-configure';
import { handleChannelCredentialsRoutes } from './routes/channel-credentials';
import { handleChannelControlRoutes } from './routes/channel-control';
import { handleChannelDeleteConfigRoutes } from './routes/channel-delete-config';
import { handleChannelLoginRoutes } from './routes/channel-login';
import { handleChannelConfigReadRoutes } from './routes/channel-config-read';
import { handleChannelPairingRoutes } from './routes/channel-pairing';
import { handleChannelStatusRoutes } from './routes/channel-status';
import { handleSessionHistoryRoutes } from './routes/session-history';
import { handleClawHubSkillRoutes } from './routes/clawhub-skill';
import { handleCronRoutes } from './routes/cron';
import { handleDiagnosticsRoutes } from './routes/diagnostics';
import { handleExternalConnectorsRoutes } from './routes/external-connectors';
import { handleFileRoutes } from './routes/files';
import { handleFleetRoutes } from './routes/fleet';
import { handleGatewayRoutes } from './routes/gateway';
import { handleLogRoutes } from './routes/logs';
import { handleManualTeamRoutes } from './routes/manual-team';
import { handleMatchaAgentAppServerRoutes } from './routes/matcha-agent-app-server';
import { handleOpenClawRoutes } from './routes/openclaw';
import { handleOpenClawMcpServersRoutes } from './routes/openclaw-mcp-servers';
import { handlePackageRoutes } from './routes/packages';
import { handlePluginsRoutes } from './routes/plugins';
import { handleProviderAccountsRoutes } from './routes/provider-accounts';
import { handleProviderModelsRoutes } from './routes/provider-models';
import { handleProviderRoutingRoutes } from './routes/provider-routing';
import { handleRuntimeHostProcessRoutes } from './routes/runtime-host-process';
import { handleRuntimeHostUsageRoutes } from './routes/runtime-host-usage';
import { handleRuntimeDirectoryRoutes } from './routes/runtime-directory';
import { handleSecurityEmergencyRoutes } from './routes/security-emergency';
import { handleSecurityPolicyRoutes } from './routes/security-policy';
import { handleSecurityRoutes } from './routes/security';
import { handleSealedSkillsRoutes } from './routes/sealed-skills';
import { handleSettingsDesiredRoutes } from './routes/settings-desired';
import { handleSettingsRoutes } from './routes/settings';
import { handleSkillBundleRoutes } from './routes/skill-bundle';
import { handleSkillsRoutes } from './routes/skills';
import { handleSubscriptionRoutes } from './routes/subscription';
import { handleTeamApprovalsRoutes } from './routes/team-approvals';
import { handleTeamDecisionRoutes } from './routes/team-decision';
import { handleTeamGraphRoutes } from './routes/team-graph';
import { handleTeamLifecycleRoutes } from './routes/team-lifecycle';
import { handleTeamPublicRoutes } from './routes/team-public';
import { handleTeamTaskBoardRoutes } from './routes/team-task-board';
import { handleTeamRoleSessionsRoutes } from './routes/team-role-sessions';
import { handleTeamSkillRoutes } from './routes/team-skill';
import { handleTeamTriggerRoutes } from './routes/team-trigger';
import { handleTeamWebhookAuthRoutes } from './routes/team-webhook-auth';
import { handleToolchainRoutes } from './routes/toolchain';
import { handleUsageRoutes } from './routes/usage';
import { handleWikiRoutes } from './routes/wiki';
import { proxyFleetRuntimeAgentIngress, proxyFleetTerminalStreamUpgrade } from '../main/runtime-host-delivery/transport/fleet';
import {
  isHostApiProxyWebSocketRoute,
  isHostApiQueryTokenAllowedRoute,
  isHostApiRequestAllowed,
  isMainOwnedRoute,
} from './route-boundary';
import { requireJsonContentType, sendJson, setCorsHeaders } from './route-utils';

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: HostApiContext,
) => Promise<boolean>;

const routeHandlers: readonly RouteHandler[] = [
  handleAppRoutes,
  (req, res, url, deps) => handleAccountRoutes(req, res, url, deps),
  (req, res, url, deps) => handleAgentsRoutes(req, res, url, deps.runtimeHostTransports.agentsTransport),
  (req, res, url, deps) => handleBillingRoutes(req, res, url, deps),
  (req, res, url, deps) => handleCapabilityRoutes(req, res, url, deps),
  (req, res, url, deps) => handleChannelAuthorizationRoutes(req, res, url, deps.runtimeHostTransports.channelAuthorizationTransport),
  (req, res, url, deps) => handleChannelCatalogRoutes(req, res, url, deps.runtimeHostTransports.channelCatalogTransport),
  (req, res, url, deps) => handleChannelConfigureRoutes(req, res, url, deps.runtimeHostTransports.channelCatalogTransport),
  (req, res, url, deps) => handleChannelCredentialsRoutes(req, res, url, deps.runtimeHostTransports.channelCredentialsTransport),
  (req, res, url, deps) => handleChannelDeleteConfigRoutes(req, res, url, deps.runtimeHostTransports.channelDeleteConfigTransport),
  (req, res, url, deps) => handleChannelLoginRoutes(req, res, url, deps.runtimeHostTransports.channelLoginTransport),
  (req, res, url, deps) => handleChannelConfigReadRoutes(req, res, url, deps.runtimeHostTransports.channelConfigReadTransport),
  (req, res, url, deps) => handleChannelControlRoutes(req, res, url, deps.runtimeHostTransports.channelControlTransport),
  (req, res, url, deps) => handleChannelPairingRoutes(req, res, url, deps.runtimeHostTransports.channelPairingTransport),
  (req, res, url, deps) => handleChannelStatusRoutes(req, res, url, deps.runtimeHostTransports.channelStatusTransport),
  (req, res, url, deps) => handleSessionHistoryRoutes(req, res, url, deps),
  (req, res, url, deps) => handleClawHubSkillRoutes(
    req,
    res,
    url,
    deps.runtimeHostTransports.clawHubSkillInstallTransport,
    deps.runtimeHostTransports.clawHubSkillSearchTransport,
  ),
  (req, res, url, deps) => handleCronRoutes(req, res, url, deps.runtimeHostTransports.cronTransport),
  (req, res, url, deps) => handleFileRoutes(req, res, url, deps),
  (req, res, url, deps) => handleDiagnosticsRoutes(req, res, url, deps),
  (req, res, url, deps) => handleExternalConnectorsRoutes(req, res, url, deps.runtimeHostTransports.externalConnectorsTransport),
  (req, res, url, deps) => handleFleetRoutes(
    req,
    res,
    url,
    deps.runtimeHostTransports.fleetTransport,
    deps.credentialWriteAdapter,
  ),
  (req, res, url, deps) => handleGatewayRoutes(req, res, url, deps),
  (req, res, url, deps) => handleLogRoutes(req, res, url, deps),
  (req, res, url, deps) => handleManualTeamRoutes(req, res, url, deps.runtimeHostTransports.manualTeamTransport),
  (req, res, url, deps) => handleMatchaAgentAppServerRoutes(req, res, url, deps),
  (req, res, url, deps) => handleOpenClawRoutes(req, res, url, deps),
  (req, res, url, deps) => handleOpenClawMcpServersRoutes(req, res, url, deps.runtimeHostTransports.openClawMcpServersTransport),
  (req, res, url, deps) => handlePackageRoutes(req, res, url, deps),
  (req, res, url, deps) => handlePluginsRoutes(req, res, url, deps.runtimeHostTransports.pluginsTransport),
  (req, res, url, deps) => handleProviderAccountsRoutes(
    req,
    res,
    url,
    deps.runtimeHostTransports.providerAccountsTransport,
    deps.providerCredentialStatusTransport,
  ),
  (req, res, url, deps) => handleProviderModelsRoutes(req, res, url, deps.runtimeHostTransports.providerModelsTransport),
  (req, res, url, deps) => handleProviderRoutingRoutes(req, res, url, deps.runtimeHostTransports.providerRoutingTransport),
  (req, res, url, deps) => handleRuntimeHostProcessRoutes(req, res, url, deps),
  (req, res, url, deps) => handleRuntimeHostUsageRoutes(req, res, url, deps.runtimeHostTransports.usageTransport),
  (req, res, url, deps) => handleRuntimeDirectoryRoutes(req, res, url, deps.runtimeHostTransports.runtimeDirectoryTransport),
  (req, res, url, deps) => handleSecurityEmergencyRoutes(req, res, url, deps.runtimeHostTransports.securityEmergencyTransport),
  (req, res, url, deps) => handleSecurityPolicyRoutes(req, res, url, deps.runtimeHostTransports.securityPolicyTransport),
  (req, res, url, deps) => handleSecurityRoutes(
    req,
    res,
    url,
    deps.runtimeHostTransports.securityPolicyTransport,
    deps.runtimeHostTransports.securityRuleCatalogTransport,
  ),
  (req, res, url, deps) => handleSettingsDesiredRoutes(req, res, url, deps.runtimeHostTransports.settingsDesiredTransport),
  (req, res, url, deps) => handleSettingsRoutes(req, res, url, deps.runtimeHostTransports.settingsDesiredTransport),
  (req, res, url, deps) => handleSkillBundleRoutes(req, res, url, deps.runtimeHostTransports.skillBundleTransport),
  (req, res, url, deps) => handleSkillsRoutes(req, res, url, deps.runtimeHostTransports.skillsManagementTransport),
  (req, res, url, deps) => handleSealedSkillsRoutes(req, res, url, deps.runtimeHostTransports.sealedSkillsTransport),
  (req, res, url, deps) => handleSubscriptionRoutes(req, res, url, deps),
  (req, res, url, deps) => handleTeamApprovalsRoutes(req, res, url, deps.runtimeHostTransports.teamApprovalsTransport),
  (req, res, url, deps) => handleTeamDecisionRoutes(req, res, url, deps.runtimeHostTransports.teamHumanDecisionTransport),
  (req, res, url, deps) => handleTeamGraphRoutes(req, res, url, deps.runtimeHostTransports.teamGraphTransport),
  (req, res, url, deps) => handleTeamLifecycleRoutes(req, res, url, deps.runtimeHostTransports.teamLifecycleTransport),
  (req, res, url, deps) => handleTeamPublicRoutes(req, res, url, deps.runtimeHostTransports.teamPublicTransport),
  (req, res, url, deps) => handleTeamTaskBoardRoutes(req, res, url, deps.runtimeHostTransports.teamTaskBoardTransport),
  (req, res, url, deps) => handleTeamRoleSessionsRoutes(req, res, url, deps.runtimeHostTransports.teamRoleSessionsTransport),
  (req, res, url, deps) => handleTeamSkillRoutes(req, res, url, deps.runtimeHostTransports.teamSkillTransport),
  (req, res, url, deps) => handleTeamTriggerRoutes(req, res, url, deps.runtimeHostTransports.teamTriggerTransport),
  (req, res, url, deps) => handleTeamWebhookAuthRoutes(
    req,
    res,
    url,
    deps.runtimeHostTransports.teamWebhookAuthTransport,
  ),
  (req, res, url, deps) => handleToolchainRoutes(req, res, url, deps.runtimeHostTransports.toolchainTransport),
  (req, res, url, deps) => handleUsageRoutes(req, res, url, deps.runtimeHostTransports.usageTransport),
  (req, res, url, deps) => handleWikiRoutes(req, res, url, deps.runtimeHostTransports.wikiTransport),
];

export type HostApiConnection = Readonly<{
  baseUrl: string;
  token: string;
}>;

let hostApiToken = '';
let hostApiBaseUrl = '';
let resolveHostApiReady: (() => void) | null = null;
let rejectHostApiReady: ((error: Error) => void) | null = null;
let hostApiReadyPromise: Promise<void>;
let isHostApiReadySettled = false;
let hostApiServerGeneration = 0;

function createHostApiReadyBarrier(): void {
  isHostApiReadySettled = false;
  hostApiReadyPromise = new Promise((resolve, reject) => {
    resolveHostApiReady = () => {
      isHostApiReadySettled = true;
      resolve();
    };
    rejectHostApiReady = (error) => {
      isHostApiReadySettled = true;
      reject(error);
    };
  });
  void hostApiReadyPromise.catch(() => undefined);
}

function prepareHostApiReadyBarrier(): number {
  hostApiServerGeneration += 1;
  if (isHostApiReadySettled) {
    createHostApiReadyBarrier();
  }
  return hostApiServerGeneration;
}

createHostApiReadyBarrier();

export function getHostApiToken(): string {
  return hostApiToken;
}

export function getHostApiBaseUrl(): string {
  return hostApiBaseUrl;
}

export async function waitForHostApiReady(): Promise<void> {
  await hostApiReadyPromise;
}

export async function readHostApiConnection(): Promise<HostApiConnection> {
  await waitForHostApiReady();
  return { baseUrl: hostApiBaseUrl, token: hostApiToken };
}

export function createHostApiRequestHandler(deps: HostApiContext, port: number, runtimeHostTransportPort?: number) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : undefined;
      setCorsHeaders(res, origin);

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (requestUrl.pathname === '/api/remote-fleet/runtime-agent/ingress') {
        if (Number.isFinite(runtimeHostTransportPort)) {
          proxyFleetRuntimeAgentIngress(Number(runtimeHostTransportPort), req, res);
        } else {
          sendJson(res, 503, { success: false, error: 'Fleet data is unavailable' });
        }
        return;
      }

      if (hostApiToken) {
        const authHeader = typeof req.headers?.authorization === 'string'
          ? req.headers.authorization
          : '';
        const bearerToken = authHeader.startsWith('Bearer ')
          ? authHeader.slice(7)
          : '';
        const queryToken = isHostApiQueryTokenAllowedRoute(req.method, requestUrl.pathname)
          ? requestUrl.searchParams.get('token') || ''
          : '';
        const presentedToken = bearerToken || queryToken;
        if (!presentedToken || presentedToken !== hostApiToken) {
          sendJson(res, 401, { success: false, error: 'Unauthorized' });
          return;
        }
      }

      if (!requireJsonContentType(req)) {
        sendJson(res, 415, { success: false, error: 'Content-Type must be application/json' });
        return;
      }

      if (!isHostApiRequestAllowed(req.method ?? '', requestUrl.pathname)) {
        if (isMainOwnedRoute(requestUrl.pathname)) {
          sendJson(res, 500, {
            success: false,
            error: `Main-owned route is not registered: ${req.method} ${requestUrl.pathname}`,
          });
          return;
        }
        sendJson(res, 404, { success: false, error: `No route for ${req.method} ${requestUrl.pathname}` });
        return;
      }

      for (const handler of routeHandlers) {
        if (await handler(req, res, requestUrl, deps)) {
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
    } catch {
      logger.error('Host API request failed.');
      sendJson(res, 500, { success: false, error: 'Host API request failed.' });
    }
  };
}

export function startHostApiServer(
  ctx: HostApiContext,
  port?: number,
  runtimeHostTransportPort?: number,
): Server {
  const resolvedPort = Number.isFinite(port) && (port ?? 0) > 0
    ? Number(port)
    : getPort('MATCHACLAW_HOST_API');
  const readyGeneration = prepareHostApiReadyBarrier();
  hostApiToken = randomBytes(32).toString('hex');
  hostApiBaseUrl = '';

  const server = createServer(createHostApiRequestHandler(ctx, resolvedPort, runtimeHostTransportPort));

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${resolvedPort}`);
    if (!isHostApiProxyWebSocketRoute(requestUrl.pathname) || !Number.isFinite(runtimeHostTransportPort)) {
      socket.destroy();
      return;
    }
    proxyFleetTerminalStreamUpgrade(Number(runtimeHostTransportPort), req, socket, head);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (!server.listening && readyGeneration === hostApiServerGeneration) {
      rejectHostApiReady?.(error);
    }
    if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
      logger.error(
        `Host API server failed to bind port ${resolvedPort}: ${error.message}. ` +
        'You can override it with MATCHACLAW_PORT_MATCHACLAW_HOST_API.',
      );
      return;
    }
    logger.error('Host API server error:', error);
  });

  server.listen(resolvedPort, '127.0.0.1', () => {
    const address = server.address() as AddressInfo | null;
    const listeningPort = address?.port ?? resolvedPort;
    const listeningBaseUrl = `http://127.0.0.1:${listeningPort}`;
    if (readyGeneration === hostApiServerGeneration) {
      hostApiBaseUrl = listeningBaseUrl;
      resolveHostApiReady?.();
    }
    logger.info(`Host API server listening on ${listeningBaseUrl}`);
  });

  return server;
}

export async function waitForHostApiServerListening(server: Server): Promise<Server> {
  if (server.listening) {
    return server;
  }

  await new Promise<void>((resolve, reject) => {
    const handleListening = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      server.off('listening', handleListening);
      server.off('error', handleError);
    };

    server.once('listening', handleListening);
    server.once('error', handleError);
  });

  return server;
}
