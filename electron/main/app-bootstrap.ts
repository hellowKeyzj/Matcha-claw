import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, session, type BrowserWindow } from 'electron';
import {
  registerRuntimeIpcHandlers,
  registerStaticIpcHandlers,
} from './ipc-handlers';
import { createTray } from './tray';
import { createMenu } from './menu';
import { appUpdater, registerE2EUpdateHandlers, registerUpdateHandlers } from './updater';
import { logger } from '../utils/logger';
import { getPort } from '../utils/config';
import { warmupNetworkOptimization } from '../utils/uv-env';
import type { HostEventBus } from '../api/event-bus';
import { startHostApiServer, waitForHostApiServerListening } from '../api/server';
import { registerHostEventBridge } from './host-event-bridge';
import { RendererEventRouteRegistry } from './renderer-event-routes';
import { createMainWindow, loadMainWindowContent } from './main-window';
import { isQuitting } from './app-state';
import { applyLaunchAtStartupSetting } from './launch-at-startup';
import {
  buildRuntimeHostBootstrap,
  createRuntimeHostDeliveryIssuer,
} from './runtime-host-delivery/bootstrap';
import { resolveRuntimeHostBootstrap } from './runtime-host-delivery/bootstrap-resources';
import { resolveRuntimeHostBinary } from './runtime-host-delivery/binary';
import { createRuntimeHostCronBrokerProvisioning } from './runtime-host-delivery/cron-broker-provisioning';
import {
  launchDirectRuntimeHost,
  type DirectRuntimeHost,
  type DirectRuntimeHostDeliveryError,
  type DirectRuntimeHostDeliveryErrorCode,
} from './runtime-host-delivery/direct-host';
import { createParentCallbackReceiver, type ParentCallbackReceiver } from './runtime-host-delivery/parent-callback';
import { RuntimeHostLifecycleOwner } from './runtime-host-delivery/lifecycle-owner';
import { composeLicenseService } from './license/composition';
import { createSessionListTransport } from './runtime-host-delivery/transport/sessions/list';
import { createRuntimeEndpointDirectoryTransport } from './runtime-host-delivery/transport/runtime-directory';
import { createFleetTransport } from './runtime-host-delivery/transport/fleet';
import { createSessionTimelineTransport } from './runtime-host-delivery/transport/sessions/timeline';
import { createMatchaSessionListTransport } from './runtime-host-delivery/transport/sessions/matcha-list';
import { createDiagnosticsArchiveTransport } from './runtime-host-delivery/transport/diagnostics';
import { createDiagnosticsExportDependencies } from './ipc/diagnostics-export-ipc';
import { createWorkspaceBinaryTransport } from './runtime-host-delivery/transport/workspace/read-binary';
import { createWorkspaceDirectoryTransport } from './runtime-host-delivery/transport/workspace/read-directory';
import { createWorkspaceTextTransport } from './runtime-host-delivery/transport/workspace/read-text';
import { createWorkspaceWriteTransport } from './runtime-host-delivery/transport/workspace/write-text';
import { createWorkspaceMediaTransport } from './runtime-host-delivery/transport/workspace/media';
import { createSessionAbortTransport } from './runtime-host-delivery/transport/sessions/abort';
import { createSessionCreateTransport } from './runtime-host-delivery/transport/sessions/create';
import { createSessionDeleteTransport } from './runtime-host-delivery/transport/sessions/delete';
import { createSessionRenameTransport } from './runtime-host-delivery/transport/sessions/rename';
import { createSessionApprovalTransport } from './runtime-host-delivery/transport/sessions/approvals';
import { createSessionSendTransport } from './runtime-host-delivery/transport/sessions/send';
import { createSessionModelSelectionTransport } from './runtime-host-delivery/transport/sessions/model-selection';
import { createSecurityEmergencyTransport } from './runtime-host-delivery/transport/security/emergency';
import { createChannelCatalogTransport } from './runtime-host-delivery/transport/channels/catalog';
import { createChannelConfigReadTransport } from './runtime-host-delivery/transport/channels/config-read';
import { createChannelCredentialsTransport } from './runtime-host-delivery/transport/channels/credentials';
import { createChannelDeleteConfigTransport } from './runtime-host-delivery/transport/channels/delete-config';
import { createChannelLoginTransport } from './runtime-host-delivery/transport/channels/login';
import { createChannelControlTransport } from './runtime-host-delivery/transport/channels/control';
import { createChannelStatusTransport } from './runtime-host-delivery/transport/channels/status';
import { createChannelPairingTransport } from './runtime-host-delivery/transport/channels/pairing';
import { createSettingsDesiredTransport } from './runtime-host-delivery/products/settings/desired';
import {
  createProviderCredentialStatusTransport,
  migrateLegacyProviderPrivateAuth,
  startProviderPrivateCredentialResolver,
  type ProviderCredentialStatusTransport,
  type ProviderPrivateCredentialResolver,
} from './ipc/provider-private-auth';
import { createSecurityPolicyTransport } from './runtime-host-delivery/transport/security/policy';
import { createSecurityRuleCatalogTransport } from './runtime-host-delivery/transport/security/rule-catalog';
import { createCronTransport } from './runtime-host-delivery/transport/cron';
import { createTaskManagerTransport } from './runtime-host-delivery/transport/task-manager';
import { createAgentsTransport } from './runtime-host-delivery/products/agents';
import { createTeamGraphTransport } from './runtime-host-delivery/transport/teams/graph';
import { createTeamSkillTransport } from './runtime-host-delivery/transport/teams/skill';
import { createTeamTriggerTransport } from './runtime-host-delivery/transport/teams/trigger';
import { createTeamWebhookAuthTransport } from './runtime-host-delivery/transport/teams/webhook-auth';
import { createTeamLifecycleTransport } from './runtime-host-delivery/transport/teams/lifecycle';
import { createTeamRoleSessionsTransport } from './runtime-host-delivery/transport/teams/role-sessions';
import { createManualTeamTransport } from './runtime-host-delivery/transport/teams/manual';
import { createTeamPublicTransport } from './runtime-host-delivery/transport/teams/public';
import { createTeamTaskBoardTransport } from './runtime-host-delivery/transport/teams/task-board';
import { createTeamApprovalsTransport } from './runtime-host-delivery/transport/teams/approvals';
import { createTeamHumanDecisionTransport } from './runtime-host-delivery/transport/teams/decision';
import { createTeamRoleChatTransport } from './runtime-host-delivery/transport/teams/role-chat';
import { createProviderAccountsTransport } from './runtime-host-delivery/transport/providers/accounts';
import { createProviderModelsTransport } from './runtime-host-delivery/transport/providers/models';
import { createExternalConnectorsTransport } from './runtime-host-delivery/transport/connectors/external';
import { createProviderRoutingTransport } from './runtime-host-delivery/transport/providers/routing';
import { createClawHubSkillInstallTransport } from './runtime-host-delivery/transport/skills/clawhub-install';
import { createClawHubSkillSearchTransport } from './runtime-host-delivery/transport/skills/clawhub-search';
import { createSkillBundleTransport } from './runtime-host-delivery/transport/skills/bundle';
import { createSkillsManagementTransport } from './runtime-host-delivery/transport/skills/management';
import { createPluginsTransport } from './runtime-host-delivery/transport/plugins';
import { createOpenClawHistoryTransport } from './runtime-host-delivery/transport/sessions/openclaw-history';
import { createUsageTransport } from './runtime-host-delivery/transport/usage';
import { createMatchaAgentHistoryTransport } from './runtime-host-delivery/transport/sessions/matcha-history';

const isE2EMode = process.env.MATCHACLAW_E2E === '1';
const legacyRuntimeHostDataDir = process.env.MATCHACLAW_RUNTIME_HOST_DATA_DIR?.trim()
  || process.env.OPENCLAW_CONFIG_DIR?.trim()
  || join(homedir(), '.openclaw');
const e2eStartupOutcomeKey = '__matchaclawE2EStartupOutcome';
const directRuntimeHostDeliveryErrorCodes = new Set<DirectRuntimeHostDeliveryErrorCode>([
  'SPAWN_FAILED',
  'READY_TIMEOUT',
  'CHILD_EXITED',
  'CHILD_FAILED',
  'STOP_FAILED',
  'FORCE_TERMINATION_FAILED',
]);
type E2EStartupOutcome =
  | Readonly<{ stage: 'bootstrap-resolve'; outcome: 'BOOTSTRAP_RESOLVE_FAILED' }>
  | Readonly<{
      stage: 'runtime-host-launch';
      outcome: DirectRuntimeHostDeliveryErrorCode | 'RUNTIME_HOST_LAUNCH_FAILED';
    }>
  | Readonly<{ stage: 'host-api'; outcome: 'HOST_API_FAILED' }>
  | Readonly<{ stage: 'ready'; outcome: 'started' }>;

const e2eLaunchDiagnosticKey = '__matchaclawE2ELaunchDiagnostic';

type E2EProcess = typeof process & {
  [e2eStartupOutcomeKey]?: E2EStartupOutcome;
  [e2eLaunchDiagnosticKey]?: Readonly<{
    code: DirectRuntimeHostDeliveryErrorCode;
    stderr: string;
  }>;
  __matchaclawE2ECronProviderTrace?: readonly string[];
};

function runtimeHostLaunchEnvironment(): Readonly<Record<string, string>> {
  return {
    MATCHACLAW_RUNTIME_HOST_PORT: String(getPort('MATCHACLAW_RUNTIME_HOST')),
    ...(process.env.MATCHACLAW_SESSION_TRACE === '1' ? { MATCHACLAW_SESSION_TRACE: '1' } : {}),
    ...(isE2EMode ? { MATCHACLAW_DEBUG_CRON_PROVIDER: '1' } : {}),
    ...providerStoreMigrationEnvironment(),
  };
}

function providerStoreMigrationEnvironment(): Readonly<Record<string, string>> {
  return {
    MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE: process.env.MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE
      || join(legacyRuntimeHostDataDir, 'matchaclaw-provider-accounts.json'),
    MATCHACLAW_RUNTIME_HOST_PROVIDER_MODELS_STORE_FILE: process.env.MATCHACLAW_RUNTIME_HOST_PROVIDER_MODELS_STORE_FILE
      || join(legacyRuntimeHostDataDir, 'matchaclaw-provider-models.json'),
    MATCHACLAW_RUNTIME_HOST_CAPABILITY_ROUTING_STORE_FILE: process.env.MATCHACLAW_RUNTIME_HOST_CAPABILITY_ROUTING_STORE_FILE
      || join(legacyRuntimeHostDataDir, 'matchaclaw-capability-routing.json'),
  };
}

function publishE2EStartupOutcome(outcome: E2EStartupOutcome): void {
  if (!isE2EMode || (process as E2EProcess)[e2eStartupOutcomeKey] !== undefined) return;

  Object.defineProperty(process as E2EProcess, e2eStartupOutcomeKey, {
    configurable: true,
    enumerable: false,
    value: Object.freeze(outcome),
    writable: false,
  });
}

function publishE2ECronProviderTrace(trace: readonly string[]): void {
  if (!isE2EMode || trace.length === 0) return;
  Object.defineProperty(process as E2EProcess, '__matchaclawE2ECronProviderTrace', {
    configurable: true,
    enumerable: false,
    value: Object.freeze([...trace]),
    writable: false,
  });
}

function registerGatewayControlUiSecurityHeaders(): void {
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['http://127.0.0.1:18789/*', 'http://localhost:18789/*'] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      delete headers['X-Frame-Options'];
      delete headers['x-frame-options'];
      if (headers['Content-Security-Policy']) {
        headers['Content-Security-Policy'] = headers['Content-Security-Policy'].map((csp) =>
          csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      if (headers['content-security-policy']) {
        headers['content-security-policy'] = headers['content-security-policy'].map((csp) =>
          csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      callback({ responseHeaders: headers });
    }
  );
}

function revealMainWindowAfterGatewayLeavesStopped(deps: {
  hostEventBus: HostEventBus;
  mainWindow: BrowserWindow;
}): void {
  const unsubscribe = deps.hostEventBus.on('gateway:status', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const processState = (payload as { processState?: unknown }).processState;
    if (processState === 'stopped') return;
    unsubscribe();
    if (!deps.mainWindow.isDestroyed()) {
      deps.mainWindow.show();
    }
  });
}

function registerMainWindowLifecycle(deps: {
  mainWindow: BrowserWindow;
  clearMainWindowRef: () => void;
}): void {
  deps.mainWindow.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault();
      deps.mainWindow.hide();
    }
  });

  deps.mainWindow.on('closed', () => {
    deps.clearMainWindowRef();
  });
}

export async function bootstrapMainApplication(deps: {
  hostEventBus: HostEventBus;
  setMainWindow: (window: BrowserWindow | null) => void;
  getMainWindow: () => BrowserWindow | null;
}): Promise<{
  mainWindow: BrowserWindow;
  directRuntimeHost: RuntimeHostLifecycleOwner;
  closeRuntimeHostDelivery: () => Promise<void>;
}> {
  logger.init();
  logger.info('=== MatchaClaw Application Starting ===');
  logger.debug(
    `Runtime: platform=${process.platform}/${process.arch}, electron=${process.versions.electron}, node=${process.versions.node}, packaged=${app.isPackaged}`
  );

  if (!isE2EMode) {
    void warmupNetworkOptimization();
  } else {
    logger.info('E2E mode enabled: startup side effects are minimized');
  }

  createMenu();

  const mainWindow = createMainWindow({ showOnReady: false });
  deps.setMainWindow(mainWindow);
  if (!isE2EMode) {
    createTray(mainWindow, {
      checkForUpdates: () => appUpdater.checkForUpdates(),
    });
  }

  registerGatewayControlUiSecurityHeaders();
  registerStaticIpcHandlers(deps.getMainWindow);
  if (isE2EMode) {
    registerE2EUpdateHandlers();
  } else {
    registerUpdateHandlers(appUpdater, mainWindow);
  }
  loadMainWindowContent(mainWindow);
  let licenseService: ReturnType<typeof composeLicenseService>;
  const rendererEventRoutes = new RendererEventRouteRegistry();
  let directRuntimeHost: RuntimeHostLifecycleOwner;
  let startedRuntimeHost: DirectRuntimeHost | undefined;
  let closeRuntimeHostDelivery: (() => Promise<void>) | undefined;
  let sessionListTransport: ReturnType<typeof createSessionListTransport>;
  let runtimeDirectoryTransport: ReturnType<typeof createRuntimeEndpointDirectoryTransport>;
  let fleetTransport: ReturnType<typeof createFleetTransport>;
  let sessionTimelineTransport: ReturnType<typeof createSessionTimelineTransport>;
  let matchaSessionListTransport: ReturnType<typeof createMatchaSessionListTransport>;
  let diagnosticsArchiveTransport: ReturnType<typeof createDiagnosticsArchiveTransport>;
  let workspaceTextTransport: ReturnType<typeof createWorkspaceTextTransport>;
  let workspaceBinaryTransport: ReturnType<typeof createWorkspaceBinaryTransport>;
  let workspaceDirectoryTransport: ReturnType<typeof createWorkspaceDirectoryTransport>;
  let workspaceWriteTransport: ReturnType<typeof createWorkspaceWriteTransport>;
  let workspaceMediaTransport: ReturnType<typeof createWorkspaceMediaTransport>;
  let sessionAbortTransport: ReturnType<typeof createSessionAbortTransport>;
  let sessionCreateTransport: ReturnType<typeof createSessionCreateTransport>;
  let sessionDeleteTransport: ReturnType<typeof createSessionDeleteTransport>;
  let sessionRenameTransport: ReturnType<typeof createSessionRenameTransport>;
  let sessionApprovalTransport: ReturnType<typeof createSessionApprovalTransport>;
  let sessionSendTransport: ReturnType<typeof createSessionSendTransport>;
  let sessionModelSelectionTransport: ReturnType<typeof createSessionModelSelectionTransport>;
  let securityEmergencyTransport: ReturnType<typeof createSecurityEmergencyTransport>;
  let channelStatusTransport: ReturnType<typeof createChannelStatusTransport>;
  let channelCatalogTransport: ReturnType<typeof createChannelCatalogTransport>;
  let channelConfigReadTransport: ReturnType<typeof createChannelConfigReadTransport>;
  let channelCredentialsTransport: ReturnType<typeof createChannelCredentialsTransport>;
  let channelDeleteConfigTransport: ReturnType<typeof createChannelDeleteConfigTransport>;
  let channelLoginTransport: ReturnType<typeof createChannelLoginTransport>;
  let channelControlTransport: ReturnType<typeof createChannelControlTransport>;
  let channelPairingTransport: ReturnType<typeof createChannelPairingTransport>;
  let settingsDesiredTransport: ReturnType<typeof createSettingsDesiredTransport>;
  let securityPolicyTransport: ReturnType<typeof createSecurityPolicyTransport>;
  let securityRuleCatalogTransport: ReturnType<typeof createSecurityRuleCatalogTransport>;
  let cronTransport: ReturnType<typeof createCronTransport>;
  let taskManagerTransport: ReturnType<typeof createTaskManagerTransport>;
  let agentsTransport: ReturnType<typeof createAgentsTransport>;
  let teamPublicTransport: ReturnType<typeof createTeamPublicTransport>;
  let teamTaskBoardTransport: ReturnType<typeof createTeamTaskBoardTransport>;
  let teamRoleSessionsTransport: ReturnType<typeof createTeamRoleSessionsTransport>;
  let teamApprovalsTransport: ReturnType<typeof createTeamApprovalsTransport>;
  let teamGraphTransport: ReturnType<typeof createTeamGraphTransport>;
  let teamSkillTransport: ReturnType<typeof createTeamSkillTransport>;
  let teamTriggerTransport: ReturnType<typeof createTeamTriggerTransport>;
  let teamWebhookAuthTransport: ReturnType<typeof createTeamWebhookAuthTransport>;
  let teamLifecycleTransport: ReturnType<typeof createTeamLifecycleTransport>;
  let manualTeamTransport: ReturnType<typeof createManualTeamTransport>;
  let teamHumanDecisionTransport: ReturnType<typeof createTeamHumanDecisionTransport>;
  let teamRoleChatTransport: ReturnType<typeof createTeamRoleChatTransport>;
  let providerAccountsTransport: ReturnType<typeof createProviderAccountsTransport>;
  let providerCredentialStatusTransport: ProviderCredentialStatusTransport;
  let providerModelsTransport: ReturnType<typeof createProviderModelsTransport>;
  let externalConnectorsTransport: ReturnType<typeof createExternalConnectorsTransport>;
  let providerRoutingTransport: ReturnType<typeof createProviderRoutingTransport>;
  let clawHubSkillInstallTransport: ReturnType<typeof createClawHubSkillInstallTransport>;
  let clawHubSkillSearchTransport: ReturnType<typeof createClawHubSkillSearchTransport>;
  let skillBundleTransport: ReturnType<typeof createSkillBundleTransport>;
  let skillsManagementTransport: ReturnType<typeof createSkillsManagementTransport>;
  let pluginsTransport: ReturnType<typeof createPluginsTransport>;
  let openClawHistoryTransport: ReturnType<typeof createOpenClawHistoryTransport>;
  let usageTransport: ReturnType<typeof createUsageTransport>;
  let matchaAgentHistoryTransport: ReturnType<typeof createMatchaAgentHistoryTransport>;
  let delivery: RuntimeHostDelivery;
  try {
    licenseService = composeLicenseService({
      onGateChanged: (snapshot) => {
        const payload = snapshot;
        deps.hostEventBus.emit('license:gate-changed', payload);
        deps.getMainWindow()?.webContents.send('host:event', {
          eventName: 'license:gate-changed',
          payload,
        });
      },
    });
    delivery = await createRuntimeHostDelivery(deps.hostEventBus, deps.getMainWindow);
    closeRuntimeHostDelivery = delivery.close;
    const initialRuntimeHost = await delivery.launchRuntimeHost();
    startedRuntimeHost = initialRuntimeHost;
    directRuntimeHost = new RuntimeHostLifecycleOwner(
      initialRuntimeHost,
      delivery.launchRuntimeHost,
    );
    sessionListTransport = createSessionListTransport(delivery.issuer, delivery.sessionTransportPort);
    runtimeDirectoryTransport = createRuntimeEndpointDirectoryTransport(
      delivery.issuer,
      delivery.sessionTransportPort,
    );
    fleetTransport = createFleetTransport(delivery.issuer, delivery.fleetTransportPort);
    sessionTimelineTransport = createSessionTimelineTransport(delivery.issuer, delivery.sessionTransportPort);
    matchaSessionListTransport = createMatchaSessionListTransport(
      delivery.issuer,
      delivery.sessionTransportPort
    );
    diagnosticsArchiveTransport = createDiagnosticsArchiveTransport(
      delivery.issuer,
      delivery.diagnosticsTransportPort
    );
    workspaceTextTransport = createWorkspaceTextTransport(
      delivery.issuer,
      delivery.workspaceTextTransportPort
    );
    workspaceBinaryTransport = createWorkspaceBinaryTransport(
      delivery.issuer,
      delivery.workspaceBinaryTransportPort
    );
    workspaceDirectoryTransport = createWorkspaceDirectoryTransport(
      delivery.issuer,
      delivery.workspaceDirectoryTransportPort
    );
    workspaceWriteTransport = createWorkspaceWriteTransport(
      delivery.issuer,
      delivery.workspaceWriteTransportPort
    );
    workspaceMediaTransport = createWorkspaceMediaTransport(
      delivery.issuer,
      delivery.workspaceMediaTransportPort
    );
    sessionAbortTransport = createSessionAbortTransport(
      delivery.issuer,
      delivery.sessionAbortTransportPort
    );
    sessionCreateTransport = createSessionCreateTransport(
      delivery.issuer,
      delivery.sessionTransportPort
    );
    sessionDeleteTransport = createSessionDeleteTransport(
      delivery.issuer,
      delivery.sessionTransportPort
    );
    sessionRenameTransport = createSessionRenameTransport(
      delivery.issuer,
      delivery.sessionTransportPort
    );
    sessionApprovalTransport = createSessionApprovalTransport(
      delivery.issuer,
      delivery.sessionApprovalTransportPort
    );
    sessionSendTransport = createSessionSendTransport(
      delivery.issuer,
      delivery.sessionSendTransportPort
    );
    sessionModelSelectionTransport = createSessionModelSelectionTransport(
      delivery.issuer,
      delivery.sessionModelSelectionTransportPort
    );
    securityEmergencyTransport = createSecurityEmergencyTransport(
      delivery.issuer,
      delivery.securityEmergencyTransportPort
    );
    channelStatusTransport = createChannelStatusTransport(
      delivery.issuer,
      delivery.channelStatusTransportPort
    );
    channelCatalogTransport = createChannelCatalogTransport(
      delivery.issuer,
      delivery.channelCatalogTransportPort
    );
    channelConfigReadTransport = createChannelConfigReadTransport(
      delivery.issuer,
      delivery.channelCatalogTransportPort
    );
    channelCredentialsTransport = createChannelCredentialsTransport(
      delivery.issuer,
      delivery.channelCatalogTransportPort
    );
    channelDeleteConfigTransport = createChannelDeleteConfigTransport(
      delivery.issuer,
      delivery.channelControlTransportPort
    );
    channelLoginTransport = createChannelLoginTransport(
      delivery.issuer,
      delivery.channelControlTransportPort
    );
    channelControlTransport = createChannelControlTransport(
      delivery.issuer,
      delivery.channelControlTransportPort
    );
    channelPairingTransport = createChannelPairingTransport(
      delivery.issuer,
      delivery.channelPairingTransportPort
    );
    settingsDesiredTransport = createSettingsDesiredTransport(
      delivery.issuer,
      delivery.settingsDesiredTransportPort
    );
    securityPolicyTransport = createSecurityPolicyTransport(
      delivery.issuer,
      delivery.securityPolicyTransportPort
    );
    securityRuleCatalogTransport = createSecurityRuleCatalogTransport(
      delivery.securityPolicyTransportPort
    );
    cronTransport = isE2EMode
      ? createCronTransport(delivery.issuer, delivery.cronTransportPort, undefined, {
          reportE2ETrace: async (stage) => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            publishE2ECronProviderTrace([...directRuntimeHost.readE2ECronProviderTrace(), stage]);
          },
        })
      : createCronTransport(delivery.issuer, delivery.cronTransportPort);
    taskManagerTransport = createTaskManagerTransport(delivery.issuer, delivery.taskManagerTransportPort);
    agentsTransport = createAgentsTransport(delivery.issuer, delivery.agentsTransportPort);
    teamPublicTransport = createTeamPublicTransport(delivery.issuer, delivery.teamPublicTransportPort);
    teamTaskBoardTransport = createTeamTaskBoardTransport(delivery.issuer, delivery.teamTaskBoardTransportPort);
    teamRoleSessionsTransport = createTeamRoleSessionsTransport(
      delivery.issuer,
      delivery.teamRoleSessionsTransportPort
    );
    teamApprovalsTransport = createTeamApprovalsTransport(
      delivery.issuer,
      delivery.teamApprovalsTransportPort
    );
    teamGraphTransport = createTeamGraphTransport(delivery.issuer, delivery.teamGraphTransportPort);
    teamSkillTransport = createTeamSkillTransport(delivery.issuer, delivery.teamSkillTransportPort);
    teamTriggerTransport = createTeamTriggerTransport(
      delivery.issuer,
      delivery.teamTriggerTransportPort
    );
    teamWebhookAuthTransport = createTeamWebhookAuthTransport(
      delivery.issuer,
      delivery.teamTriggerTransportPort
    );
    teamLifecycleTransport = createTeamLifecycleTransport(
      delivery.issuer,
      delivery.teamLifecycleTransportPort
    );
    manualTeamTransport = createManualTeamTransport(delivery.issuer, delivery.manualTeamTransportPort);
    teamHumanDecisionTransport = createTeamHumanDecisionTransport(
      delivery.issuer,
      delivery.teamDecisionTransportPort
    );
    teamRoleChatTransport = createTeamRoleChatTransport(
      delivery.issuer,
      delivery.teamRoleChatTransportPort
    );
    providerAccountsTransport = createProviderAccountsTransport(
      delivery.issuer,
      delivery.providerAccountsTransportPort
    );
    providerCredentialStatusTransport = createProviderCredentialStatusTransport();
    providerModelsTransport = createProviderModelsTransport(
      delivery.issuer,
      delivery.providerModelsTransportPort
    );
    externalConnectorsTransport = createExternalConnectorsTransport(
      delivery.issuer,
      delivery.providerModelsTransportPort
    );
    providerRoutingTransport = createProviderRoutingTransport(
      delivery.issuer,
      delivery.providerModelsTransportPort
    );
    clawHubSkillInstallTransport = createClawHubSkillInstallTransport(
      delivery.issuer,
      delivery.providerModelsTransportPort
    );
    clawHubSkillSearchTransport = createClawHubSkillSearchTransport(
      delivery.issuer,
      delivery.providerModelsTransportPort
    );
    skillBundleTransport = createSkillBundleTransport(
      delivery.issuer,
      delivery.providerModelsTransportPort
    );
    skillsManagementTransport = createSkillsManagementTransport(
      delivery.issuer,
      delivery.providerModelsTransportPort
    );
    pluginsTransport = createPluginsTransport(delivery.issuer, delivery.providerModelsTransportPort);
    openClawHistoryTransport = createOpenClawHistoryTransport(
      delivery.issuer,
      delivery.openclawHistoryTransportPort
    );
    usageTransport = createUsageTransport(delivery.issuer, delivery.usageTransportPort);
    matchaAgentHistoryTransport = createMatchaAgentHistoryTransport(
      delivery.issuer,
      delivery.matchaHistoryTransportPort
    );
  } catch (error) {
    if (startedRuntimeHost) {
      await reclaimFailedBootstrapRuntimeHost(startedRuntimeHost);
    }
    await closeRuntimeHostDelivery?.().catch(() => undefined);
    publishE2ELaunchDiagnostic(error);
    if (isDirectRuntimeHostDeliveryError(error) && error.diagnostic?.stderr) {
      logger.error(`[RuntimeHost] launch diagnostic: ${error.diagnostic.stderr}`);
    }
    publishE2EStartupOutcome(classifyBootstrapStartupFailure(error));
    throw error;
  }

  try {
    await waitForHostApiServerListening(
      startHostApiServer({
        licenseService,
        eventBus: deps.hostEventBus,
        runtimeHost: directRuntimeHost,
        sessionListTransport,
        runtimeDirectoryTransport,
        fleetTransport,
        sessionTimelineTransport,
        matchaSessionListTransport,
        sessionAbortTransport,
        sessionCreateTransport,
        sessionDeleteTransport,
        sessionRenameTransport,
        sessionApprovalTransport,
        diagnosticsArchiveTransport,
        workspaceTextTransport,
        workspaceBinaryTransport,
        workspaceDirectoryTransport,
        workspaceWriteTransport,
        workspaceMediaTransport,
        sessionSendTransport,
        sessionModelSelectionTransport,
        rendererEventRoutes,
        securityEmergencyTransport,
        channelStatusTransport,
        channelCatalogTransport,
        channelConfigReadTransport,
        channelCredentialsTransport,
        channelDeleteConfigTransport,
        channelLoginTransport,
        channelControlTransport,
        channelPairingTransport,
        settingsDesiredTransport,
        securityPolicyTransport,
        securityRuleCatalogTransport,
        cronTransport,
        taskManagerTransport,
        agentsTransport,
        teamPublicTransport,
        teamTaskBoardTransport,
        teamRoleSessionsTransport,
        teamApprovalsTransport,
        teamGraphTransport,
        teamSkillTransport,
        teamTriggerTransport,
        teamWebhookAuthTransport,
        teamLifecycleTransport,
        manualTeamTransport,
        teamHumanDecisionTransport,
        teamRoleChatTransport,
        providerAccountsTransport,
        providerCredentialStatusTransport,
        providerModelsTransport,
        externalConnectorsTransport,
        providerRoutingTransport,
        clawHubSkillInstallTransport,
        clawHubSkillSearchTransport,
        skillBundleTransport,
        skillsManagementTransport,
        pluginsTransport,
        openClawHistoryTransport,
        matchaAgentHistoryTransport,
        usageTransport,
      }, undefined, delivery.fleetTransportPort)
    );

    registerRuntimeIpcHandlers(
      directRuntimeHost,
      deps.getMainWindow,
      providerAccountsTransport,
      createDiagnosticsExportDependencies(diagnosticsArchiveTransport),
    );
    registerHostEventBridge({
      runtimeHost: directRuntimeHost,
      hostEventBus: deps.hostEventBus,
      getMainWindow: deps.getMainWindow,
      rendererEventRoutes,
    });

    if (!isE2EMode) {
      const settings = await settingsDesiredTransport.read().catch(() => null);
      if (!settings || !(await applyLaunchAtStartupSetting(settings.launchAtStartup))) {
        logger.warn('Launch-at-startup setting could not be applied during startup');
      }
    }

    registerMainWindowLifecycle({
      mainWindow,
      clearMainWindowRef: () => deps.setMainWindow(null),
    });
    revealMainWindowAfterGatewayLeavesStopped({
      hostEventBus: deps.hostEventBus,
      mainWindow,
    });

    publishE2EStartupOutcome({ stage: 'ready', outcome: 'started' });
    return {
      mainWindow,
      directRuntimeHost,
      closeRuntimeHostDelivery: closeRuntimeHostDelivery ?? (async () => undefined),
    };
  } catch (error) {
    publishE2EStartupOutcome({ stage: 'host-api', outcome: 'HOST_API_FAILED' });
    await reclaimFailedBootstrapRuntimeHost(directRuntimeHost);
    await closeRuntimeHostDelivery?.().catch(() => undefined);
    throw error;
  }
}

async function reclaimFailedBootstrapRuntimeHost(runtimeHost: DirectRuntimeHost): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    runtimeHost.stop().then(
      () => true,
      () => false
    ),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), 5000);
      timeout.unref?.();
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (!stopped) {
    await runtimeHost.forceKill().catch(() => undefined);
  }
}

type RuntimeHostDelivery = Readonly<{
  readonly issuer: ReturnType<typeof createRuntimeHostDeliveryIssuer>;
  readonly parentCallback: ParentCallbackReceiver;
  readonly launchRuntimeHost: () => Promise<DirectRuntimeHost>;
  readonly close: () => Promise<void>;
  readonly sessionTransportPort: number;
  readonly fleetTransportPort: number;
  readonly diagnosticsTransportPort: number;
  readonly workspaceTextTransportPort: number;
  readonly workspaceBinaryTransportPort: number;
  readonly workspaceDirectoryTransportPort: number;
  readonly workspaceWriteTransportPort: number;
  readonly workspaceMediaTransportPort: number;
  readonly sessionSendTransportPort: number;
  readonly sessionAbortTransportPort: number;
  readonly sessionApprovalTransportPort: number;
  readonly sessionModelSelectionTransportPort: number;
  readonly openclawHistoryTransportPort: number;
  readonly matchaHistoryTransportPort: number;
  readonly usageTransportPort: number;
  readonly securityEmergencyTransportPort: number;
  readonly channelStatusTransportPort: number;
  readonly channelCatalogTransportPort: number;
  readonly channelControlTransportPort: number;
  readonly channelPairingTransportPort: number;
  readonly settingsDesiredTransportPort: number;
  readonly securityPolicyTransportPort: number;
  readonly cronTransportPort: number;
  readonly cronBrokerTransportPort: number;
  readonly taskManagerTransportPort: number;
  readonly agentsTransportPort: number;
  readonly teamPublicTransportPort: number;
  readonly teamTaskBoardTransportPort: number;
  readonly teamRoleSessionsTransportPort: number;
  readonly teamApprovalsTransportPort: number;
  readonly teamDecisionTransportPort: number;
  readonly teamRoleChatTransportPort: number;
  readonly teamGraphTransportPort: number;
  readonly providerModelsTransportPort: number;
  readonly providerAccountsTransportPort: number;
  readonly teamSkillTransportPort: number;
  readonly teamTriggerTransportPort: number;
  readonly teamLifecycleTransportPort: number;
  readonly manualTeamTransportPort: number;
}>;

async function createRuntimeHostDelivery(
  hostEventBus: HostEventBus,
  _getMainWindow: () => BrowserWindow | null,
): Promise<RuntimeHostDelivery> {
  const workingDirectory = app.isPackaged ? process.resourcesPath : process.cwd();
  let launch: Parameters<typeof launchDirectRuntimeHost>[0];
  let providerCredentialResolver: ProviderPrivateCredentialResolver | undefined;
  let parentCallback: ParentCallbackReceiver | undefined;
  let cronBrokerProvisioning: ReturnType<typeof createRuntimeHostCronBrokerProvisioning> | undefined;
  const issuer = createRuntimeHostDeliveryIssuer();
  let sessionTransportPort: number;
  let fleetTransportPort: number;
  let diagnosticsTransportPort: number;
  let workspaceTextTransportPort: number;
  let workspaceBinaryTransportPort: number;
  let workspaceDirectoryTransportPort: number;
  let workspaceWriteTransportPort: number;
  let workspaceMediaTransportPort: number;
  let sessionSendTransportPort: number;
  let sessionAbortTransportPort: number;
  let sessionApprovalTransportPort: number;
  let sessionModelSelectionTransportPort: number;
  let openclawHistoryTransportPort: number;
  let matchaHistoryTransportPort: number;
  let usageTransportPort: number;
  let securityEmergencyTransportPort: number;
  let channelStatusTransportPort: number;
  let channelCatalogTransportPort: number;
  let channelControlTransportPort: number;
  let channelPairingTransportPort: number;
  let settingsDesiredTransportPort: number;
  let securityPolicyTransportPort: number;
  let cronTransportPort: number;
  let cronBrokerTransportPort: number;
  let taskManagerTransportPort: number;
  let agentsTransportPort: number;
  let teamPublicTransportPort: number;
  let teamTaskBoardTransportPort: number;
  let teamRoleSessionsTransportPort: number;
  let teamApprovalsTransportPort: number;
  let teamDecisionTransportPort: number;
  let teamRoleChatTransportPort: number;
  let teamGraphTransportPort: number;
  let providerModelsTransportPort: number;
  let providerAccountsTransportPort: number;
  let teamSkillTransportPort: number;
  let teamTriggerTransportPort: number;
  let teamLifecycleTransportPort: number;
  let manualTeamTransportPort: number;
  try {
    const bootstrap = resolveRuntimeHostBootstrap();
    parentCallback = await createParentCallbackReceiver(hostEventBus);
    await migrateLegacyProviderPrivateAuth(
      providerStoreMigrationEnvironment().MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE,
      bootstrap.openClaw.stateDir
    );
    providerCredentialResolver = await startProviderPrivateCredentialResolver(bootstrap.openClaw.stateDir);
    cronBrokerProvisioning = createRuntimeHostCronBrokerProvisioning({
      storageRoot: bootstrap.matcha.privateSecretRoot,
      cronBrokerTransportPort: bootstrap.cronBrokerTransportPort,
    });
    sessionTransportPort = bootstrap.sessionTransportPort;
    fleetTransportPort = bootstrap.fleetTransportPort;
    diagnosticsTransportPort = bootstrap.diagnosticsTransportPort;
    workspaceTextTransportPort = bootstrap.workspaceTextTransportPort;
    workspaceBinaryTransportPort = bootstrap.workspaceBinaryTransportPort;
    workspaceDirectoryTransportPort = bootstrap.workspaceDirectoryTransportPort;
    workspaceWriteTransportPort = bootstrap.workspaceWriteTransportPort;
    workspaceMediaTransportPort = bootstrap.workspaceMediaTransportPort;
    sessionSendTransportPort = bootstrap.sessionSendTransportPort;
    sessionAbortTransportPort = bootstrap.sessionAbortTransportPort;
    sessionApprovalTransportPort = bootstrap.sessionApprovalTransportPort;
    sessionModelSelectionTransportPort = bootstrap.sessionModelSelectionTransportPort;
    openclawHistoryTransportPort = bootstrap.openclawHistoryTransportPort;
    matchaHistoryTransportPort = bootstrap.matchaHistoryTransportPort;
    usageTransportPort = bootstrap.usageTransportPort;
    securityEmergencyTransportPort = bootstrap.securityEmergencyTransportPort;
    channelStatusTransportPort = bootstrap.channelStatusTransportPort;
    channelCatalogTransportPort = bootstrap.channelCatalogTransportPort;
    channelControlTransportPort = bootstrap.channelControlTransportPort;
    channelPairingTransportPort = bootstrap.channelPairingTransportPort;
    settingsDesiredTransportPort = bootstrap.settingsDesiredTransportPort;
    securityPolicyTransportPort = bootstrap.securityPolicyTransportPort;
    cronTransportPort = bootstrap.cronTransportPort;
    cronBrokerTransportPort = bootstrap.cronBrokerTransportPort;
    taskManagerTransportPort = bootstrap.taskManagerTransportPort;
    agentsTransportPort = bootstrap.agentsTransportPort;
    teamPublicTransportPort = bootstrap.teamPublicTransportPort;
    teamTaskBoardTransportPort = bootstrap.teamTaskBoardTransportPort;
    teamRoleSessionsTransportPort = bootstrap.teamRoleSessionsTransportPort;
    teamApprovalsTransportPort = bootstrap.teamApprovalsTransportPort;
    teamDecisionTransportPort = bootstrap.teamDecisionTransportPort;
    teamRoleChatTransportPort = bootstrap.teamRoleChatTransportPort;
    teamGraphTransportPort = bootstrap.teamGraphTransportPort;
    providerModelsTransportPort = bootstrap.providerModelsTransportPort;
    providerAccountsTransportPort = bootstrap.providerAccountsTransportPort;
    teamSkillTransportPort = bootstrap.teamSkillTransportPort;
    teamTriggerTransportPort = bootstrap.teamTriggerTransportPort;
    teamLifecycleTransportPort = bootstrap.teamLifecycleTransportPort;
    manualTeamTransportPort = bootstrap.manualTeamTransportPort;
    launch = {
      executablePath: resolveRuntimeHostBinary({
        isPackaged: app.isPackaged,
        ...(app.isPackaged
          ? { resourcesPath: workingDirectory }
          : { projectRoot: workingDirectory }),
      }),
      workingDirectory,
      bootstrapBytes: buildRuntimeHostBootstrap({
        ...bootstrap,
        deliveryVerificationKey: issuer.verificationKey,
        cronBrokerVerificationKey: cronBrokerProvisioning.verificationKey,
        parentCallbackBaseUrl: parentCallback.baseUrl,
        parentCallbackDispatchToken: parentCallback.dispatchToken,
        providerCredentialResolver: providerCredentialResolver && {
          endpoint: providerCredentialResolver.endpoint,
          authorization: providerCredentialResolver.authorization,
        },
      }),
      environment: runtimeHostLaunchEnvironment(),
    };
  } catch (error) {
    await providerCredentialResolver?.close().catch(() => undefined);
    await parentCallback?.close().catch(() => undefined);
    cronBrokerProvisioning?.close();
    publishE2EStartupOutcome({
      stage: 'bootstrap-resolve',
      outcome: 'BOOTSTRAP_RESOLVE_FAILED',
    });
    throw error;
  }
  const launchRuntimeHost = async (): Promise<DirectRuntimeHost> =>
    launchDirectRuntimeHost(launch);
  return {
    launchRuntimeHost,
    close: async () => {
      await providerCredentialResolver?.close();
      await parentCallback?.close();
      cronBrokerProvisioning?.close();
    },
    issuer,
    parentCallback: parentCallback as ParentCallbackReceiver,
    sessionTransportPort,
    fleetTransportPort,
    diagnosticsTransportPort,
    workspaceTextTransportPort,
    workspaceBinaryTransportPort,
    workspaceDirectoryTransportPort,
    workspaceWriteTransportPort,
    workspaceMediaTransportPort,
    sessionSendTransportPort,
    sessionAbortTransportPort,
    sessionApprovalTransportPort,
    sessionModelSelectionTransportPort,
    openclawHistoryTransportPort,
      matchaHistoryTransportPort,
      usageTransportPort,
      securityEmergencyTransportPort,
      channelStatusTransportPort,
      channelCatalogTransportPort,
      channelControlTransportPort,
      channelPairingTransportPort,
      settingsDesiredTransportPort,
      securityPolicyTransportPort,
      cronTransportPort,
      cronBrokerTransportPort,
      taskManagerTransportPort,
      agentsTransportPort,
      teamPublicTransportPort,
      teamTaskBoardTransportPort,
      teamRoleSessionsTransportPort,
      teamApprovalsTransportPort,
      teamDecisionTransportPort,
      teamRoleChatTransportPort,
      teamGraphTransportPort,
      providerModelsTransportPort,
      providerAccountsTransportPort,
      teamSkillTransportPort,
      teamTriggerTransportPort,
      teamLifecycleTransportPort,
      manualTeamTransportPort,
  };
}

function publishE2ELaunchDiagnostic(error: unknown): void {
  if (!isE2EMode || !isDirectRuntimeHostDeliveryError(error)) return;

  const diagnostic = (error as DirectRuntimeHostDeliveryError).diagnostic;
  if (!diagnostic || (process as E2EProcess)[e2eLaunchDiagnosticKey] !== undefined) return;

  Object.defineProperty(process as E2EProcess, e2eLaunchDiagnosticKey, {
    configurable: true,
    enumerable: false,
    value: Object.freeze({
      code: error.code,
      stderr: diagnostic.stderr,
    }),
    writable: false,
  });
}

function classifyBootstrapStartupFailure(error: unknown): E2EStartupOutcome {
  return {
    stage: 'runtime-host-launch',
    outcome: classifyRuntimeHostLaunchFailure(error),
  };
}

function classifyRuntimeHostLaunchFailure(error: unknown): Extract<E2EStartupOutcome, { stage: 'runtime-host-launch' }>['outcome'] {
  if (isDirectRuntimeHostDeliveryError(error)) return error.code;
  return 'RUNTIME_HOST_LAUNCH_FAILED';
}

function isDirectRuntimeHostDeliveryError(
  error: unknown
): error is Readonly<{ code: DirectRuntimeHostDeliveryErrorCode }> {
  return (
    error instanceof Error &&
    error.name === 'DirectRuntimeHostDeliveryError' &&
    directRuntimeHostDeliveryErrorCodes.has(
      (error as { code?: unknown }).code as DirectRuntimeHostDeliveryErrorCode
    )
  );
}
