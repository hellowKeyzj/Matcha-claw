import type { HostApiContext, HostApiServerContext, MainHostApiContext } from './context';
import { type HostApiDispatcher, type HostApiRequest, type HostApiRouteResult, jsonResult } from './execution';
import { getHostApiRequestDependency, isMainOwnedRoute } from './route-boundary';
import { logger } from '../utils/logger';
import { handleAccountRoutes } from './routes/account';
import { handleBillingRoutes } from './routes/billing';
import { handleBoardRoutes } from './routes/board';
import { handleCapabilityRoutes } from './routes/capabilities';
import { handleCallRoutes } from './routes/calls';
import { handleAgentsRoutes } from './routes/agents';
import { handleMainAppRoutes } from './routes/app';
import { handleAppPluginRoutes } from './routes/app-plugins';
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
import { handleLicenseRoutes } from './routes/license';
import { handleLogRoutes, handleMainLogRoutes } from './routes/logs';
import { handleManualTeamRoutes } from './routes/manual-team';
import { handleMatchaAgentAppServerRoutes } from './routes/matcha-agent-app-server';
import { handleOpenClawRoutes } from './routes/openclaw';
import { handleOpenClawMcpServersRoutes } from './routes/openclaw-mcp-servers';
import { handlePackageRoutes } from './routes/packages';
import { handlePluginsRoutes } from './routes/plugins';
import { handleProviderAccountsRoutes } from './routes/provider-accounts';
import { handleProviderModelsRoutes } from './routes/provider-models';
import { handleProviderRoutingRoutes } from './routes/provider-routing';
import { handleProviderRecoveryRoutes } from './routes/provider-recovery';
import { handleProviderTextRoutes } from './routes/provider-text';
import { handleRuntimeHostProcessRoutes } from './routes/runtime-host-process';
import { handleRuntimeHostUsageRoutes } from './routes/runtime-host-usage';
import { handleRuntimeDirectoryRoutes } from './routes/runtime-directory';
import { handleSearchRoutes } from './routes/search';
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
import { handleWorldRoutes } from './routes/world';

type RouteHandler<Context> = (
  req: HostApiRequest,
  url: URL,
  deps: Context,
) => Promise<HostApiRouteResult>;

const runtimeDirectoryRouteHandlers: readonly RouteHandler<HostApiContext>[] = [
  (req, url, deps) => handleRuntimeDirectoryRoutes(req, url, deps.runtimeHostTransports.runtimeDirectoryTransport),
];

// Families only locate handlers; route-boundary remains the method/path authority.
const mainRouteFamilies: Readonly<Record<string, readonly RouteHandler<MainHostApiContext>[]>> = {
  app: [handleMainAppRoutes],
  'app-plugins': [handleAppPluginRoutes],
  account: [handleAccountRoutes],
  billing: [handleBillingRoutes],
  license: [handleLicenseRoutes],
  logs: [handleMainLogRoutes],
  subscription: [handleSubscriptionRoutes],
};

const runtimeRouteFamilies: Readonly<Record<string, readonly RouteHandler<HostApiContext>[]>> = {
  subagents: [
    (req, url, deps) => handleAgentsRoutes(req, url, deps.runtimeHostTransports.agentsTransport),
    (req, url, deps) => handleSkillBundleRoutes(req, url, deps.runtimeHostTransports.skillBundleTransport),
  ],
  board: [(req, url, deps) => handleBoardRoutes(req, url, deps.runtimeHostTransports.boardTransport)],
  capabilities: [(req, url, deps) => handleCapabilityRoutes(req, url, deps)],
  calls: [(req, url, deps) => handleCallRoutes(req, url, deps.runtimeHostTransports.callLogTransport)],
  channels: [
    (req, url, deps) => handleChannelAuthorizationRoutes(req, url, deps.channelAuthorization),
    (req, url, deps) => handleChannelCatalogRoutes(req, url, deps.runtimeHostTransports.channelCatalogTransport),
    (req, url, deps) => handleChannelConfigureRoutes(req, url, deps.runtimeHostTransports.channelCatalogTransport),
    (req, url, deps) => handleChannelCredentialsRoutes(req, url, deps.runtimeHostTransports.channelCredentialsTransport),
    (req, url, deps) => handleChannelDeleteConfigRoutes(req, url, deps.runtimeHostTransports.channelDeleteConfigTransport),
    (req, url, deps) => handleChannelLoginRoutes(req, url, deps.runtimeHostTransports.channelLoginTransport),
    (req, url, deps) => handleChannelConfigReadRoutes(req, url, deps.runtimeHostTransports.channelConfigReadTransport),
    (req, url, deps) => handleChannelControlRoutes(req, url, deps.runtimeHostTransports.channelControlTransport),
    (req, url, deps) => handleChannelPairingRoutes(req, url, deps.runtimeHostTransports.channelPairingTransport),
    (req, url, deps) => handleChannelStatusRoutes(req, url, deps.runtimeHostTransports.channelStatusTransport),
  ],
  sessions: [(req, url, deps) => handleSessionHistoryRoutes(req, url, deps)],
  clawhub: [
    (req, url, deps) => handleClawHubSkillRoutes(
      req,
      url,
      deps.runtimeHostTransports.clawHubSkillInstallTransport,
      deps.runtimeHostTransports.clawHubSkillSearchTransport,
    ),
  ],
  cron: [(req, url, deps) => handleCronRoutes(req, url, deps.runtimeHostTransports.cronTransport)],
  files: [(req, url, deps) => handleFileRoutes(req, url, deps)],
  diagnostics: [(req, url, deps) => handleDiagnosticsRoutes(req, url, deps)],
  'external-connectors': [(req, url, deps) => handleExternalConnectorsRoutes(req, url, deps.runtimeHostTransports.externalConnectorsTransport)],
  'remote-fleet': [
    (req, url, deps) => handleFleetRoutes(
      req,
      url,
      deps.runtimeHostTransports.fleetTransport,
      deps.credentialWriteAdapter,
    ),
  ],
  gateway: [(req, url, deps) => handleGatewayRoutes(req, url, deps)],
  openclaw: [
    (req, url, deps) => handleLogRoutes(req, url, deps),
    (req, url, deps) => handleOpenClawRoutes(req, url, deps),
    (req, url, deps) => handleOpenClawMcpServersRoutes(req, url, deps.runtimeHostTransports.openClawMcpServersTransport),
  ],
  team: [
    (req, url, deps) => handleManualTeamRoutes(req, url, deps.runtimeHostTransports.manualTeamTransport),
    (req, url, deps) => handleTeamApprovalsRoutes(req, url, deps.runtimeHostTransports.teamApprovalsTransport),
    (req, url, deps) => handleTeamDecisionRoutes(req, url, deps.runtimeHostTransports.teamHumanDecisionTransport),
    (req, url, deps) => handleTeamGraphRoutes(req, url, deps.runtimeHostTransports.teamGraphTransport),
    (req, url, deps) => handleTeamLifecycleRoutes(req, url, deps.runtimeHostTransports.teamLifecycleTransport),
    (req, url, deps) => handleTeamPublicRoutes(req, url, deps.runtimeHostTransports.teamPublicTransport),
    (req, url, deps) => handleTeamTaskBoardRoutes(req, url, deps.runtimeHostTransports.teamTaskBoardTransport),
    (req, url, deps) => handleTeamRoleSessionsRoutes(req, url, deps.runtimeHostTransports.teamRoleSessionsTransport),
    (req, url, deps) => handleTeamSkillRoutes(req, url, deps.runtimeHostTransports.teamSkillTransport),
    (req, url, deps) => handleTeamTriggerRoutes(req, url, deps.runtimeHostTransports.teamTriggerTransport),
  ],
  'matcha-agent': [(req, url, deps) => handleMatchaAgentAppServerRoutes(req, url, deps)],
  packages: [(req, url, deps) => handlePackageRoutes(req, url, deps)],
  plugins: [(req, url, deps) => handlePluginsRoutes(req, url, deps.runtimeHostTransports.pluginsTransport)],
  'provider-accounts': [
    (req, url, deps) => handleProviderAccountsRoutes(
      req,
      url,
      deps.runtimeHostTransports.providerAccountsTransport,
      deps.providerCredentialStatusTransport,
    ),
  ],
  'provider-models': [(req, url, deps) => handleProviderModelsRoutes(req, url, deps.runtimeHostTransports.providerModelsTransport)],
  'provider-routing': [(req, url, deps) => handleProviderRoutingRoutes(req, url, deps.runtimeHostTransports.providerRoutingTransport)],
  providers: [
    (req, url, deps) => handleProviderRecoveryRoutes(req, url, deps.runtimeHostTransports.providerRecoveryTransport),
    handleProviderTextRoutes,
  ],
  'runtime-host': [
    (req, url, deps) => handleRuntimeHostProcessRoutes(req, url, deps),
    (req, url, deps) => handleRuntimeHostUsageRoutes(req, url, deps.runtimeHostTransports.usageTransport),
    (req, url, deps) => handleTeamWebhookAuthRoutes(
      req,
      url,
      deps.runtimeHostTransports.teamWebhookAuthTransport,
    ),
  ],
  search: [(req, url, deps) => handleSearchRoutes(req, url, deps.runtimeHostTransports.search)],
  security: [
    (req, url, deps) => handleSecurityEmergencyRoutes(req, url, deps.runtimeHostTransports.securityEmergencyTransport),
    (req, url, deps) => handleSecurityPolicyRoutes(req, url, deps.runtimeHostTransports.securityPolicyTransport),
    (req, url, deps) => handleSecurityRoutes(
      req,
      url,
      deps.runtimeHostTransports.securityPolicyTransport,
      deps.runtimeHostTransports.securityRuleCatalogTransport,
    ),
  ],
  settings: [
    (req, url, deps) => handleSettingsDesiredRoutes(req, url, deps.runtimeHostTransports.settingsDesiredTransport),
    (req, url, deps) => handleSettingsRoutes(req, url, deps.runtimeHostTransports.settingsDesiredTransport),
  ],
  skills: [(req, url, deps) => handleSkillsRoutes(req, url, deps.runtimeHostTransports.skillsManagementTransport)],
  'sealed-skills': [(req, url, deps) => handleSealedSkillsRoutes(req, url, deps.runtimeHostTransports.sealedSkillsTransport, deps.runtimeHostTransports.skillsManagementTransport)],
  toolchain: [(req, url, deps) => handleToolchainRoutes(req, url, deps.runtimeHostTransports.toolchainTransport)],
  usage: [(req, url, deps) => handleUsageRoutes(req, url, deps.runtimeHostTransports.usageTransport)],
  wiki: [(req, url, deps) => handleWikiRoutes(req, url, deps.runtimeHostTransports.wikiTransport)],
  world: [(req, url, deps) => handleWorldRoutes(req, url, deps.runtimeHostTransports.worldTransport)],
  'runtime-adapters': runtimeDirectoryRouteHandlers,
  'runtime-connectors': runtimeDirectoryRouteHandlers,
  'platform': runtimeDirectoryRouteHandlers,
  'runtime-endpoints': runtimeDirectoryRouteHandlers,
};

export function createHostApiDispatcher(ctx: HostApiServerContext): HostApiDispatcher {
  const { runtime, signal, ...main } = ctx;
  const runtimeContext = runtime.then((deps): HostApiContext => ({ ...main, ...deps }));
  void runtimeContext.catch(() => undefined);

  return async (request, requestUrl) => {
    const closed = () => signal.aborted || request.signal.aborted;
    try {
      const dependency = getHostApiRequestDependency(request.method, requestUrl.pathname, 'ipc');
      if (dependency !== null) {
        if (closed()) return null;
        const family = requestUrl.pathname.split('/', 3)[2];
        if (dependency === 'main') {
          for (const handler of mainRouteFamilies[family] ?? []) {
            if (closed()) return null;
            const result = await handler(request, requestUrl, main);
            if (result !== undefined) return result;
          }
        } else {
          const deps = await runtimeContext;
          for (const handler of runtimeRouteFamilies[family] ?? []) {
            if (closed()) return null;
            const result = await handler(request, requestUrl, deps);
            if (result !== undefined) return result;
          }
        }
      }
      if (isMainOwnedRoute(requestUrl.pathname)) {
        return jsonResult(500, {
          success: false,
          error: `Main-owned route is not registered: ${request.method} ${requestUrl.pathname}`,
        });
      }
      return jsonResult(404, { success: false, error: `No route for ${request.method} ${requestUrl.pathname}` });
    } catch {
      if (closed()) return null;
      logger.error('Host API request failed.');
      return jsonResult(500, { success: false, error: 'Host API request failed.' });
    }
  };
}
