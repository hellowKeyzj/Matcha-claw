import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalE2EMode = process.env.MATCHACLAW_E2E;
const e2eStartupOutcomeKey = '__matchaclawE2EStartupOutcome';

type E2EProcess = typeof process & {
  [e2eStartupOutcomeKey]?: unknown;
};

function readE2EStartupOutcome(): unknown {
  return (process as E2EProcess)[e2eStartupOutcomeKey];
}

function clearE2EStartupOutcome(): void {
  delete (process as E2EProcess)[e2eStartupOutcomeKey];
}

const hoisted = vi.hoisted(() => ({
  onHeadersReceivedMock: vi.fn(),
  registerStaticIpcHandlersMock: vi.fn(),
  registerRuntimeIpcHandlersMock: vi.fn(),
  createTrayMock: vi.fn(),
  createMenuMock: vi.fn(),
  checkForUpdatesMock: vi.fn(),
  registerUpdateHandlersMock: vi.fn(),
  registerE2EUpdateHandlersMock: vi.fn(),
  loggerInitMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  applyLaunchAtStartupSettingMock: vi.fn(),
  warmupNetworkOptimizationMock: vi.fn(),
  registerHostEventBridgeMock: vi.fn(),
  createMainWindowMock: vi.fn(),
  loadMainWindowContentMock: vi.fn(),
  isQuittingMock: vi.fn(),
  resolveRuntimeHostBootstrapMock: vi.fn(),
  buildRuntimeHostBootstrapMock: vi.fn(),
  createRuntimeHostDeliveryIssuerMock: vi.fn(),
  createRuntimeHostCronBrokerProvisioningMock: vi.fn(),
  createParentCallbackReceiverMock: vi.fn(),
  createSessionListTransportMock: vi.fn(),
  createRuntimeEndpointDirectoryTransportMock: vi.fn(),
  createFleetTransportMock: vi.fn(),
  createSessionContentTransportMock: vi.fn(),
  createSessionTimelineTransportMock: vi.fn(),
  createMatchaSessionListTransportMock: vi.fn(),
  createDiagnosticsArchiveTransportMock: vi.fn(),
  createDiagnosticsExportDependenciesMock: vi.fn(),
  createWorkspaceDirectoryTransportMock: vi.fn(),
  createWorkspaceTextTransportMock: vi.fn(),
  createWorkspaceBinaryTransportMock: vi.fn(),
  createWorkspaceWriteTransportMock: vi.fn(),
  createWorkspaceMediaTransportMock: vi.fn(),
  createSessionAbortTransportMock: vi.fn(),
  createSessionCreateTransportMock: vi.fn(),
  createSessionDeleteTransportMock: vi.fn(),
  createSessionRenameTransportMock: vi.fn(),
  createSessionApprovalTransportMock: vi.fn(),
  createSessionSendTransportMock: vi.fn(),
  createSessionModelSelectionTransportMock: vi.fn(),
  createSessionPermissionTransportMock: vi.fn(),
  createSecurityEmergencyTransportMock: vi.fn(),
  createChannelStatusTransportMock: vi.fn(),
  createChannelCatalogTransportMock: vi.fn(),
  createChannelConfigReadTransportMock: vi.fn(),
  createChannelCredentialsTransportMock: vi.fn(),
  createChannelDeleteConfigTransportMock: vi.fn(),
  createChannelLoginTransportMock: vi.fn(),
  createChannelControlTransportMock: vi.fn(),
  createChannelPairingTransportMock: vi.fn(),
  createSettingsDesiredTransportMock: vi.fn(),
  createSecurityPolicyTransportMock: vi.fn(),
  createSecurityRuleCatalogTransportMock: vi.fn(),
  createCronTransportMock: vi.fn(),
  createTaskManagerTransportMock: vi.fn(),
  createAgentsTransportMock: vi.fn(),
  createTeamPublicTransportMock: vi.fn(),
  createTeamTaskBoardTransportMock: vi.fn(),
  createTeamRoleSessionsTransportMock: vi.fn(),
  createTeamApprovalsTransportMock: vi.fn(),
  createTeamGraphTransportMock: vi.fn(),
  createTeamSkillTransportMock: vi.fn(),
  createTeamTriggerTransportMock: vi.fn(),
  createTeamWebhookAuthTransportMock: vi.fn(),
  createTeamLifecycleTransportMock: vi.fn(),
  createManualTeamTransportMock: vi.fn(),
  createTeamHumanDecisionTransportMock: vi.fn(),
  createTeamRoleChatTransportMock: vi.fn(),
  createProviderAccountsTransportMock: vi.fn(),
  createProviderModelsTransportMock: vi.fn(),
  createExternalConnectorsTransportMock: vi.fn(),
  createOpenClawMcpServersTransportMock: vi.fn(),
  createProviderRoutingTransportMock: vi.fn(),
  createClawHubSkillInstallTransportMock: vi.fn(),
  createClawHubSkillSearchTransportMock: vi.fn(),
  createSkillBundleTransportMock: vi.fn(),
  createSkillsManagementTransportMock: vi.fn(),
  createPluginsTransportMock: vi.fn(),
  createUsageTransportMock: vi.fn(),
  createMatchaAgentHistoryTransportMock: vi.fn(),
  resolveRuntimeHostBinaryMock: vi.fn(),
  launchDirectRuntimeHostMock: vi.fn(),
  createCloudAccountClientMock: vi.fn(),
  createCloudAccountServiceMock: vi.fn(),
  createCloudProviderSyncMock: vi.fn(),
  cloudAccountServicePrewarmMock: vi.fn(),
  startHostApiServerMock: vi.fn(),
  waitForHostApiServerListeningMock: vi.fn(),
  createProviderCredentialStatusTransportMock: vi.fn(),
  startProviderPrivateCredentialResolverMock: vi.fn(),
  waitForGatewayControlReadyMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: (...args: unknown[]) => hoisted.onHeadersReceivedMock(...args),
      },
    },
  },
}));

vi.mock('../../electron/main/ipc-handlers', () => ({
  registerRuntimeIpcHandlers: (...args: unknown[]) => hoisted.registerRuntimeIpcHandlersMock(...args),
  registerStaticIpcHandlers: (...args: unknown[]) => hoisted.registerStaticIpcHandlersMock(...args),
}));
vi.mock('../../electron/main/tray', () => ({
  createTray: (...args: unknown[]) => hoisted.createTrayMock(...args),
}));
vi.mock('../../electron/main/menu', () => ({
  createMenu: (...args: unknown[]) => hoisted.createMenuMock(...args),
}));
vi.mock('../../electron/main/updater', () => ({
  appUpdater: {
    checkForUpdates: (...args: unknown[]) => hoisted.checkForUpdatesMock(...args),
  },
  registerE2EUpdateHandlers: (...args: unknown[]) => hoisted.registerE2EUpdateHandlersMock(...args),
  registerUpdateHandlers: (...args: unknown[]) => hoisted.registerUpdateHandlersMock(...args),
}));
vi.mock('../../electron/utils/logger', () => ({
  logger: {
    init: (...args: unknown[]) => hoisted.loggerInitMock(...args),
    info: (...args: unknown[]) => hoisted.loggerInfoMock(...args),
    debug: (...args: unknown[]) => hoisted.loggerDebugMock(...args),
    warn: (...args: unknown[]) => hoisted.loggerInfoMock(...args),
  },
}));
vi.mock('../../electron/utils/uv-env', () => ({
  warmupNetworkOptimization: (...args: unknown[]) => hoisted.warmupNetworkOptimizationMock(...args),
}));
vi.mock('../../electron/main/host-event-bridge', () => ({
  registerHostEventBridge: (...args: unknown[]) => hoisted.registerHostEventBridgeMock(...args),
}));
vi.mock('../../electron/api/server', () => ({
  startHostApiServer: (...args: unknown[]) => hoisted.startHostApiServerMock(...args),
  waitForHostApiServerListening: (...args: unknown[]) =>
    hoisted.waitForHostApiServerListeningMock(...args),
}));
vi.mock('../../electron/main/main-window', () => ({
  createMainWindow: (...args: unknown[]) => hoisted.createMainWindowMock(...args),
  loadMainWindowContent: (...args: unknown[]) => hoisted.loadMainWindowContentMock(...args),
}));
vi.mock('../../electron/main/app-state', () => ({
  isQuitting: (...args: unknown[]) => hoisted.isQuittingMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/bootstrap-resources', () => ({
  resolveRuntimeHostBootstrap: (...args: unknown[]) =>
    hoisted.resolveRuntimeHostBootstrapMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/bootstrap', () => ({
  buildRuntimeHostBootstrap: (...args: unknown[]) => hoisted.buildRuntimeHostBootstrapMock(...args),
  createRuntimeHostDeliveryIssuer: (...args: unknown[]) =>
    hoisted.createRuntimeHostDeliveryIssuerMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/cron-broker-provisioning', () => ({
  createRuntimeHostCronBrokerProvisioning: (...args: unknown[]) =>
    hoisted.createRuntimeHostCronBrokerProvisioningMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/parent-callback', () => ({
  createParentCallbackReceiver: (...args: unknown[]) =>
    hoisted.createParentCallbackReceiverMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/sessions/list', () => ({
  createSessionListTransport: (...args: unknown[]) =>
    hoisted.createSessionListTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/runtime-directory', () => ({
  createRuntimeEndpointDirectoryTransport: (...args: unknown[]) =>
    hoisted.createRuntimeEndpointDirectoryTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/fleet', () => ({
  createFleetTransport: (...args: unknown[]) => hoisted.createFleetTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/sessions/content', () => ({
  createSessionContentTransport: (...args: unknown[]) =>
    hoisted.createSessionContentTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/sessions/timeline', () => ({
  createSessionTimelineTransport: (...args: unknown[]) =>
    hoisted.createSessionTimelineTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/sessions/matcha-list', () => ({
  createMatchaSessionListTransport: (...args: unknown[]) =>
    hoisted.createMatchaSessionListTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/diagnostics', () => ({
  createDiagnosticsArchiveTransport: (...args: unknown[]) =>
    hoisted.createDiagnosticsArchiveTransportMock(...args),
}));
vi.mock('../../electron/main/ipc/diagnostics-export-ipc', () => ({
  createDiagnosticsExportDependencies: (...args: unknown[]) =>
    hoisted.createDiagnosticsExportDependenciesMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/workspace/read-directory', () => ({
  createWorkspaceDirectoryTransport: (...args: unknown[]) =>
    hoisted.createWorkspaceDirectoryTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/workspace/read-text', () => ({
  createWorkspaceTextTransport: (...args: unknown[]) =>
    hoisted.createWorkspaceTextTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/workspace/read-binary', () => ({
  createWorkspaceBinaryTransport: (...args: unknown[]) =>
    hoisted.createWorkspaceBinaryTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/workspace/write-text', () => ({
  createWorkspaceWriteTransport: (...args: unknown[]) =>
    hoisted.createWorkspaceWriteTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/workspace/media', () => ({
  createWorkspaceMediaTransport: (...args: unknown[]) =>
    hoisted.createWorkspaceMediaTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/sessions/abort', () => ({
  createSessionAbortTransport: (...args: unknown[]) =>
    hoisted.createSessionAbortTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/sessions/create', () => ({
  createSessionCreateTransport: (...args: unknown[]) =>
    hoisted.createSessionCreateTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/sessions/delete', () => ({
  createSessionDeleteTransport: (...args: unknown[]) =>
    hoisted.createSessionDeleteTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/sessions/rename', () => ({
  createSessionRenameTransport: (...args: unknown[]) =>
    hoisted.createSessionRenameTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/sessions/approvals', () => ({
  createSessionApprovalTransport: (...args: unknown[]) =>
    hoisted.createSessionApprovalTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/sessions/send', () => ({
  createSessionSendTransport: (...args: unknown[]) =>
    hoisted.createSessionSendTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/sessions/model-selection', () => ({
  createSessionModelSelectionTransport: (...args: unknown[]) =>
    hoisted.createSessionModelSelectionTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/sessions/permission', () => ({
  createSessionPermissionTransport: (...args: unknown[]) =>
    hoisted.createSessionPermissionTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/security/emergency', () => ({
  createSecurityEmergencyTransport: (...args: unknown[]) =>
    hoisted.createSecurityEmergencyTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/channels/status', () => ({
  createChannelStatusTransport: (...args: unknown[]) =>
    hoisted.createChannelStatusTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/channels/catalog', () => ({
  createChannelCatalogTransport: (...args: unknown[]) =>
    hoisted.createChannelCatalogTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/channels/config-read', () => ({
  createChannelConfigReadTransport: (...args: unknown[]) =>
    hoisted.createChannelConfigReadTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/channels/credentials', () => ({
  createChannelCredentialsTransport: (...args: unknown[]) =>
    hoisted.createChannelCredentialsTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/channels/delete-config', () => ({
  createChannelDeleteConfigTransport: (...args: unknown[]) =>
    hoisted.createChannelDeleteConfigTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/channels/login', () => ({
  createChannelLoginTransport: (...args: unknown[]) =>
    hoisted.createChannelLoginTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/channels/control', () => ({
  createChannelControlTransport: (...args: unknown[]) =>
    hoisted.createChannelControlTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/channels/pairing', () => ({
  createChannelPairingTransport: (...args: unknown[]) =>
    hoisted.createChannelPairingTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/products/settings/desired', () => ({
  createSettingsDesiredTransport: (...args: unknown[]) =>
    hoisted.createSettingsDesiredTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/security/policy', () => ({
  createSecurityPolicyTransport: (...args: unknown[]) =>
    hoisted.createSecurityPolicyTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/security/rule-catalog', () => ({
  createSecurityRuleCatalogTransport: (...args: unknown[]) =>
    hoisted.createSecurityRuleCatalogTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/cron', () => ({
  createCronTransport: (...args: unknown[]) => hoisted.createCronTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/task-manager', () => ({
  createTaskManagerTransport: (...args: unknown[]) => hoisted.createTaskManagerTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/products/agents', () => ({
  createAgentsTransport: (...args: unknown[]) => hoisted.createAgentsTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/teams/public', () => ({
  createTeamPublicTransport: (...args: unknown[]) => hoisted.createTeamPublicTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/teams/task-board', () => ({
  createTeamTaskBoardTransport: (...args: unknown[]) =>
    hoisted.createTeamTaskBoardTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/teams/role-sessions', () => ({
  createTeamRoleSessionsTransport: (...args: unknown[]) =>
    hoisted.createTeamRoleSessionsTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/teams/approvals', () => ({
  createTeamApprovalsTransport: (...args: unknown[]) =>
    hoisted.createTeamApprovalsTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/teams/graph', () => ({
  createTeamGraphTransport: (...args: unknown[]) => hoisted.createTeamGraphTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/teams/skill', () => ({
  createTeamSkillTransport: (...args: unknown[]) => hoisted.createTeamSkillTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/teams/trigger', () => ({
  createTeamTriggerTransport: (...args: unknown[]) => hoisted.createTeamTriggerTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/teams/webhook-auth', () => ({
  createTeamWebhookAuthTransport: (...args: unknown[]) =>
    hoisted.createTeamWebhookAuthTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/teams/lifecycle', () => ({
  createTeamLifecycleTransport: (...args: unknown[]) =>
    hoisted.createTeamLifecycleTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/teams/manual', () => ({
  createManualTeamTransport: (...args: unknown[]) => hoisted.createManualTeamTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/teams/decision', () => ({
  createTeamHumanDecisionTransport: (...args: unknown[]) =>
    hoisted.createTeamHumanDecisionTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/teams/role-chat', () => ({
  createTeamRoleChatTransport: (...args: unknown[]) =>
    hoisted.createTeamRoleChatTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/providers/accounts', () => ({
  createProviderAccountsTransport: (...args: unknown[]) =>
    hoisted.createProviderAccountsTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/providers/models', () => ({
  createProviderModelsTransport: (...args: unknown[]) =>
    hoisted.createProviderModelsTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/connectors/external', () => ({
  createExternalConnectorsTransport: (...args: unknown[]) =>
    hoisted.createExternalConnectorsTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/connectors/openclaw-mcp-servers', () => ({
  createOpenClawMcpServersTransport: (...args: unknown[]) =>
    hoisted.createOpenClawMcpServersTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/providers/routing', () => ({
  createProviderRoutingTransport: (...args: unknown[]) =>
    hoisted.createProviderRoutingTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/skills/clawhub-install', () => ({
  createClawHubSkillInstallTransport: (...args: unknown[]) =>
    hoisted.createClawHubSkillInstallTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/skills/clawhub-search', () => ({
  createClawHubSkillSearchTransport: (...args: unknown[]) =>
    hoisted.createClawHubSkillSearchTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/skills/bundle', () => ({
  createSkillBundleTransport: (...args: unknown[]) =>
    hoisted.createSkillBundleTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/skills/management', () => ({
  createSkillsManagementTransport: (...args: unknown[]) =>
    hoisted.createSkillsManagementTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/plugins', () => ({
  createPluginsTransport: (...args: unknown[]) => hoisted.createPluginsTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/usage', () => ({
  createUsageTransport: (...args: unknown[]) => hoisted.createUsageTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/sessions/matcha-history', () => ({
  createMatchaAgentHistoryTransport: (...args: unknown[]) =>
    hoisted.createMatchaAgentHistoryTransportMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/binary', () => ({
  resolveRuntimeHostBinary: (...args: unknown[]) => hoisted.resolveRuntimeHostBinaryMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/direct-host', () => ({
  launchDirectRuntimeHost: (...args: unknown[]) => hoisted.launchDirectRuntimeHostMock(...args),
}));
vi.mock('../../electron/main/cloud-account/client', () => ({
  createCloudAccountClient: (...args: unknown[]) => hoisted.createCloudAccountClientMock(...args),
}));
vi.mock('../../electron/main/cloud-account/service', () => ({
  createCloudAccountService: (...args: unknown[]) => hoisted.createCloudAccountServiceMock(...args),
}));
vi.mock('../../electron/main/cloud-account/provider-sync', () => ({
  createCloudProviderSync: (...args: unknown[]) => hoisted.createCloudProviderSyncMock(...args),
}));
vi.mock('../../electron/main/launch-at-startup', () => ({
  applyLaunchAtStartupSetting: (...args: unknown[]) =>
    hoisted.applyLaunchAtStartupSettingMock(...args),
}));
vi.mock('../../electron/main/ipc/provider-private-auth', () => ({
  createProviderCredentialStatusTransport: (...args: unknown[]) =>
    hoisted.createProviderCredentialStatusTransportMock(...args),
  migrateLegacyProviderPrivateAuth: vi.fn().mockResolvedValue(undefined),
  startProviderPrivateCredentialResolver: (...args: unknown[]) =>
    hoisted.startProviderPrivateCredentialResolverMock(...args),
}));
vi.mock('../../electron/main/gateway-control-ready-probe', () => ({
  GatewayControlReadinessBudgetError: class GatewayControlReadinessBudgetError extends Error {},
  waitForGatewayControlReady: (...args: unknown[]) =>
    hoisted.waitForGatewayControlReadyMock(...args),
}));

function createMainWindowFixture() {
  return {
    on: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
}

function createDirectRuntimeHostFixture() {
  return {
    command: vi.fn(),
    onSafeEvent: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    stop: vi.fn().mockResolvedValue(undefined),
    forceKill: vi.fn().mockResolvedValue(undefined),
  };
}

function createBootstrapContext() {
  const mainWindow = createMainWindowFixture();
  const directRuntimeHost = createDirectRuntimeHostFixture();
  let currentMainWindow: unknown = null;
  const setMainWindow = vi.fn((window: unknown) => {
    currentMainWindow = window;
  });
  const getMainWindow = vi.fn(() => currentMainWindow);
  return {
    deps: {
      hostEventBus: { emit: vi.fn(), on: vi.fn(() => () => undefined) },
      setMainWindow,
      getMainWindow,
    },
    directRuntimeHost,
    mainWindow,
  };
}

async function importBootstrapMainApplication() {
  const module = await import('../../electron/main/app-bootstrap');
  return module.bootstrapMainApplication;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  clearE2EStartupOutcome();
  delete process.env.MATCHACLAW_E2E;
  hoisted.createMainWindowMock.mockReturnValue(createMainWindowFixture());
  hoisted.warmupNetworkOptimizationMock.mockResolvedValue(undefined);
  hoisted.applyLaunchAtStartupSettingMock.mockResolvedValue(true);
  hoisted.isQuittingMock.mockReturnValue(false);
  hoisted.resolveRuntimeHostBootstrapMock.mockReturnValue({
    bootstrap: 'input',
    sessionTransportPort: 34_101,
    fleetTransportPort: 34_102,
    diagnosticsTransportPort: 34_104,
    workspaceTextTransportPort: 34_105,
    workspaceBinaryTransportPort: 34_106,
    workspaceDirectoryTransportPort: 34_110,
    workspaceWriteTransportPort: 34_111,
    workspaceMediaTransportPort: 34_112,
    sessionSendTransportPort: 34_117,
    sessionAbortTransportPort: 34_118,
    sessionApprovalTransportPort: 34_122,
    sessionModelSelectionTransportPort: 34_120,
    matchaHistoryTransportPort: 34_146,
    usageTransportPort: 34_236,
    securityEmergencyTransportPort: 34_121,
    channelStatusTransportPort: 34_124,
    channelCatalogTransportPort: 34_139,
    channelControlTransportPort: 34_140,
    channelPairingTransportPort: 34_237,
    settingsDesiredTransportPort: 34_136,
    securityPolicyTransportPort: 34_137,
    cronTransportPort: 34_125,
    cronBrokerTransportPort: 34_150,
    taskManagerTransportPort: 34_147,
    agentsTransportPort: 34_126,
    teamPublicTransportPort: 34_127,
    teamTaskBoardTransportPort: 34_143,
    teamRoleSessionsTransportPort: 34_144,
    teamApprovalsTransportPort: 34_141,
    teamDecisionTransportPort: 34_134,
    teamRoleChatTransportPort: 34_138,
    teamGraphTransportPort: 34_129,
    teamSkillTransportPort: 34_130,
    teamTriggerTransportPort: 34_131,
    providerModelsTransportPort: 34_128,
    providerAccountsTransportPort: 34_145,
    teamLifecycleTransportPort: 34_133,
    manualTeamTransportPort: 34_135,
    matcha: { privateSecretRoot: 'C:\\ProgramData\\Matcha\\private' },
    openClaw: { stateDir: 'C:\\ProgramData\\Matcha\\openclaw' },
  });
  hoisted.buildRuntimeHostBootstrapMock.mockReturnValue(new Uint8Array([1, 2, 3]));
  hoisted.createRuntimeHostDeliveryIssuerMock.mockReturnValue({ verificationKey: 'public-key' });
  hoisted.createRuntimeHostCronBrokerProvisioningMock.mockReturnValue({
    verificationKey: 'cron-public-key',
    endpoint: 'http://127.0.0.1:34150/api/cron/broker',
    privateKeyPath: 'C:\\ProgramData\\Matcha\\private\\cron-broker-private-key.pem',
    close: vi.fn(),
  });
  hoisted.createParentCallbackReceiverMock.mockResolvedValue({
    baseUrl: 'http://127.0.0.1:34160',
    dispatchToken: 'parent-dispatch-token',
    close: vi.fn().mockResolvedValue(undefined),
  });
  hoisted.startProviderPrivateCredentialResolverMock.mockResolvedValue({
    endpoint: 'http://127.0.0.1:34135/resolve',
    authorization: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
    close: vi.fn().mockResolvedValue(undefined),
  });
  hoisted.createCloudProviderSyncMock.mockReturnValue({ reconcile: vi.fn() });
  hoisted.createCloudAccountServiceMock.mockReturnValue({
    prewarm: hoisted.cloudAccountServicePrewarmMock,
  });
  hoisted.createSessionListTransportMock.mockReturnValue({ list: vi.fn() });
  hoisted.createRuntimeEndpointDirectoryTransportMock.mockReturnValue({ list: vi.fn() });
  hoisted.createFleetTransportMock.mockReturnValue({ execute: vi.fn() });
  hoisted.createSessionContentTransportMock.mockReturnValue({ load: vi.fn() });
  hoisted.createSessionTimelineTransportMock.mockReturnValue({ list: vi.fn() });
  hoisted.createMatchaSessionListTransportMock.mockReturnValue({ list: vi.fn() });
  hoisted.createDiagnosticsArchiveTransportMock.mockReturnValue({ archive: vi.fn(), download: vi.fn() });
  hoisted.createDiagnosticsExportDependenciesMock.mockReturnValue({
    transport: { download: vi.fn() },
    showSaveDialog: vi.fn(),
    writeFile: vi.fn(),
    getE2ESavePath: vi.fn(),
  });
  hoisted.createWorkspaceTextTransportMock.mockReturnValue({ read: vi.fn() });
  hoisted.createWorkspaceBinaryTransportMock.mockReturnValue({ read: vi.fn() });
  hoisted.createWorkspaceDirectoryTransportMock.mockReturnValue({ list: vi.fn() });
  hoisted.createWorkspaceWriteTransportMock.mockReturnValue({ write: vi.fn() });
  hoisted.createWorkspaceMediaTransportMock.mockReturnValue({ thumbnail: vi.fn() });
  hoisted.createSessionAbortTransportMock.mockReturnValue({ abort: vi.fn() });
  hoisted.createSessionCreateTransportMock.mockReturnValue({ create: vi.fn() });
  hoisted.createSessionDeleteTransportMock.mockReturnValue({ delete: vi.fn() });
  hoisted.createSessionRenameTransportMock.mockReturnValue({ rename: vi.fn() });
  hoisted.createSessionApprovalTransportMock.mockReturnValue({ list: vi.fn(), respond: vi.fn() });
  hoisted.createSessionSendTransportMock.mockReturnValue({ send: vi.fn() });
  hoisted.createSessionModelSelectionTransportMock.mockReturnValue({ patch: vi.fn() });
  hoisted.createSessionPermissionTransportMock.mockReturnValue({ get: vi.fn(), set: vi.fn() });
  hoisted.createSecurityEmergencyTransportMock.mockReturnValue({ run: vi.fn() });
  hoisted.createChannelStatusTransportMock.mockReturnValue({ read: vi.fn() });
  hoisted.createChannelCatalogTransportMock.mockReturnValue({ read: vi.fn() });
  hoisted.createChannelConfigReadTransportMock.mockReturnValue({ read: vi.fn() });
  hoisted.createChannelCredentialsTransportMock.mockReturnValue({ validate: vi.fn() });
  hoisted.createChannelDeleteConfigTransportMock.mockReturnValue({ deleteConfig: vi.fn() });
  hoisted.createChannelLoginTransportMock.mockReturnValue({ login: vi.fn() });
  hoisted.createChannelControlTransportMock.mockReturnValue({ operate: vi.fn() });
  hoisted.createChannelPairingTransportMock.mockReturnValue({
    list: vi.fn(),
    approve: vi.fn(),
  });
  hoisted.createSettingsDesiredTransportMock.mockReturnValue({
    read: vi.fn().mockResolvedValue({
      browserMode: 'relay',
      launchAtStartup: false,
      gatewayAutoStart: true,
      proxyEnabled: false,
      proxyServer: '',
      proxyBypassRules: '',
    }),
    submit: vi.fn(),
  });
  hoisted.createSecurityPolicyTransportMock.mockReturnValue({
    operate: vi.fn(),
    read: vi.fn(),
    readAudit: vi.fn(),
    submit: vi.fn(),
  });
  hoisted.createSecurityRuleCatalogTransportMock.mockReturnValue({ read: vi.fn() });
  hoisted.createCronTransportMock.mockReturnValue({ execute: vi.fn() });
  hoisted.createTaskManagerTransportMock.mockReturnValue({ list: vi.fn() });
  hoisted.createAgentsTransportMock.mockReturnValue({ execute: vi.fn() });
  hoisted.createTeamPublicTransportMock.mockReturnValue({ read: vi.fn() });
  hoisted.createTeamTaskBoardTransportMock.mockReturnValue({ read: vi.fn() });
  hoisted.createTeamRoleSessionsTransportMock.mockReturnValue({ read: vi.fn() });
  hoisted.createTeamApprovalsTransportMock.mockReturnValue({ read: vi.fn() });
  hoisted.createTeamGraphTransportMock.mockReturnValue({ read: vi.fn() });
  hoisted.createTeamSkillTransportMock.mockReturnValue({ execute: vi.fn() });
  hoisted.createTeamTriggerTransportMock.mockReturnValue({ execute: vi.fn() });
  hoisted.createTeamWebhookAuthTransportMock.mockReturnValue({ read: vi.fn() });
  hoisted.createTeamLifecycleTransportMock.mockReturnValue({
    list: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
  });
  hoisted.createManualTeamTransportMock.mockReturnValue({ materializeAndCreate: vi.fn() });
  hoisted.createTeamHumanDecisionTransportMock.mockReturnValue({ resolve: vi.fn() });
  hoisted.createTeamRoleChatTransportMock.mockReturnValue({ submit: vi.fn() });
  hoisted.createProviderCredentialStatusTransportMock.mockReturnValue({ hasApiKey: vi.fn() });
  hoisted.createProviderAccountsTransportMock.mockReturnValue({ execute: vi.fn() });
  hoisted.createProviderModelsTransportMock.mockReturnValue({ execute: vi.fn() });
  hoisted.createCloudAccountClientMock.mockReturnValue({ fetchClientBootstrap: vi.fn() });
  hoisted.createExternalConnectorsTransportMock.mockReturnValue({ execute: vi.fn() });
  hoisted.createOpenClawMcpServersTransportMock.mockReturnValue({ execute: vi.fn() });
  hoisted.createProviderRoutingTransportMock.mockReturnValue({ execute: vi.fn() });
  hoisted.createClawHubSkillInstallTransportMock.mockReturnValue({ install: vi.fn() });
  hoisted.createClawHubSkillSearchTransportMock.mockReturnValue({ search: vi.fn() });
  hoisted.createSkillBundleTransportMock.mockReturnValue({
    exportBundles: vi.fn(),
    importBundles: vi.fn(),
  });
  hoisted.createSkillsManagementTransportMock.mockReturnValue({ execute: vi.fn() });
  hoisted.createPluginsTransportMock.mockReturnValue({ execute: vi.fn() });
  hoisted.createUsageTransportMock.mockReturnValue({ read: vi.fn() });
  hoisted.createMatchaAgentHistoryTransportMock.mockReturnValue({ history: vi.fn() });
  hoisted.resolveRuntimeHostBinaryMock.mockReturnValue('/workspace/runtime-host');
  hoisted.launchDirectRuntimeHostMock.mockResolvedValue(createDirectRuntimeHostFixture());
  hoisted.waitForGatewayControlReadyMock.mockResolvedValue(undefined);
  hoisted.startHostApiServerMock.mockReturnValue({});
  hoisted.waitForHostApiServerListeningMock.mockResolvedValue({});
});

afterEach(() => {
  clearE2EStartupOutcome();
  if (originalE2EMode === undefined) {
    delete process.env.MATCHACLAW_E2E;
  } else {
    process.env.MATCHACLAW_E2E = originalE2EMode;
  }
});

describe('bootstrapMainApplication', () => {
  it('直接启动 Rust Host，并将同一实例交给 IPC 与安全事件桥', async () => {
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
    hoisted.launchDirectRuntimeHostMock.mockResolvedValue(context.directRuntimeHost);

    const result = await bootstrapMainApplication(context.deps as never);

    expect(hoisted.resolveRuntimeHostBootstrapMock).toHaveBeenCalledTimes(1);
    expect(hoisted.createRuntimeHostDeliveryIssuerMock).toHaveBeenCalledTimes(1);
    expect(hoisted.createRuntimeHostCronBrokerProvisioningMock).toHaveBeenCalledWith({
      storageRoot: 'C:\\ProgramData\\Matcha\\private',
      cronBrokerTransportPort: 34_150,
    });
    expect(hoisted.startProviderPrivateCredentialResolverMock).toHaveBeenCalledWith('C:\\ProgramData\\Matcha\\openclaw');
    expect(hoisted.buildRuntimeHostBootstrapMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bootstrap: 'input',
        sessionTransportPort: 34_101,
        fleetTransportPort: 34_102,
        diagnosticsTransportPort: 34_104,
        workspaceTextTransportPort: 34_105,
        workspaceBinaryTransportPort: 34_106,
        workspaceDirectoryTransportPort: 34_110,
        workspaceWriteTransportPort: 34_111,
        workspaceMediaTransportPort: 34_112,
        sessionSendTransportPort: 34_117,
        sessionAbortTransportPort: 34_118,
        sessionApprovalTransportPort: 34_122,
        sessionModelSelectionTransportPort: 34_120,
        matchaHistoryTransportPort: 34_146,
        usageTransportPort: 34_236,
        securityEmergencyTransportPort: 34_121,
        channelStatusTransportPort: 34_124,
        channelCatalogTransportPort: 34_139,
        channelControlTransportPort: 34_140,
        channelPairingTransportPort: 34_237,
        settingsDesiredTransportPort: 34_136,
        securityPolicyTransportPort: 34_137,
        cronTransportPort: 34_125,
        cronBrokerTransportPort: 34_150,
        taskManagerTransportPort: 34_147,
        agentsTransportPort: 34_126,
        teamPublicTransportPort: 34_127,
        teamTaskBoardTransportPort: 34_143,
        teamRoleSessionsTransportPort: 34_144,
        teamApprovalsTransportPort: 34_141,
        teamDecisionTransportPort: 34_134,
        teamRoleChatTransportPort: 34_138,
        teamGraphTransportPort: 34_129,
        teamSkillTransportPort: 34_130,
        teamTriggerTransportPort: 34_131,
        providerModelsTransportPort: 34_128,
        providerAccountsTransportPort: 34_145,
        teamLifecycleTransportPort: 34_133,
        manualTeamTransportPort: 34_135,
        deliveryVerificationKey: 'public-key',
        cronBrokerVerificationKey: 'cron-public-key',
        parentCallbackBaseUrl: 'http://127.0.0.1:34160',
        parentCallbackDispatchToken: 'parent-dispatch-token',
        providerCredentialResolver: {
          endpoint: 'http://127.0.0.1:34135/resolve',
          authorization: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
        },
      })
    );
    expect(hoisted.resolveRuntimeHostBinaryMock).toHaveBeenCalledWith({
      isPackaged: false,
      projectRoot: process.cwd(),
    });
    expect(hoisted.launchDirectRuntimeHostMock).toHaveBeenCalledWith(expect.objectContaining({
      executablePath: '/workspace/runtime-host',
      workingDirectory: process.cwd(),
      bootstrapBytes: new Uint8Array([1, 2, 3]),
    }));
    expect(hoisted.waitForGatewayControlReadyMock).not.toHaveBeenCalled();
    expect(hoisted.createCloudAccountClientMock).toHaveBeenCalledOnce();
    expect(hoisted.createCloudProviderSyncMock).toHaveBeenCalledWith({
      fetchClientBootstrap: expect.any(Function),
      providerAccountsTransport: hoisted.createProviderAccountsTransportMock.mock.results[0]?.value,
      providerModelsTransport: hoisted.createProviderModelsTransportMock.mock.results[0]?.value,
    });
    expect(hoisted.createCloudAccountServiceMock).toHaveBeenCalledWith(
      hoisted.createCloudAccountClientMock.mock.results[0]?.value,
      hoisted.createCloudProviderSyncMock.mock.results[0]?.value,
    );
    expect(hoisted.cloudAccountServicePrewarmMock).toHaveBeenCalledOnce();
    expect(hoisted.createSessionListTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_101
    );
    expect(hoisted.createRuntimeEndpointDirectoryTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_101
    );
    expect(hoisted.createFleetTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_102
    );
    expect(hoisted.createSessionContentTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_101
    );
    expect(hoisted.createSessionTimelineTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_101
    );
    expect(hoisted.createMatchaSessionListTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_101
    );
    expect(hoisted.createDiagnosticsArchiveTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_104
    );
    expect(hoisted.createWorkspaceTextTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_105
    );
    expect(hoisted.createWorkspaceBinaryTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_106
    );
    expect(hoisted.createWorkspaceDirectoryTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_110
    );
    expect(hoisted.createWorkspaceWriteTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_111
    );
    expect(hoisted.createWorkspaceMediaTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_112
    );
    expect(hoisted.createSessionSendTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_117
    );
    expect(hoisted.createSessionAbortTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_118
    );
    expect(hoisted.createSessionCreateTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_101
    );
    expect(hoisted.createSessionDeleteTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_101
    );
    expect(hoisted.createSessionRenameTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_101
    );
    expect(hoisted.createUsageTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_236
    );
    expect(hoisted.createSessionModelSelectionTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_120
    );
    expect(hoisted.createSessionPermissionTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_101
    );
    expect(hoisted.createSecurityEmergencyTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_121
    );
    expect(hoisted.createSessionApprovalTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_122
    );
    expect(hoisted.createChannelStatusTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_124
    );
    expect(hoisted.createChannelCatalogTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_139
    );
    expect(hoisted.createChannelConfigReadTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_139
    );
    expect(hoisted.createChannelCredentialsTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_139
    );
    expect(hoisted.createChannelDeleteConfigTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_140
    );
    expect(hoisted.createChannelLoginTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_140
    );
    expect(hoisted.createChannelControlTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_140
    );
    expect(hoisted.createChannelPairingTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_237
    );
    expect(hoisted.createSettingsDesiredTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_136
    );
    expect(hoisted.createSecurityPolicyTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_137
    );
    expect(hoisted.createSecurityRuleCatalogTransportMock).toHaveBeenCalledWith(34_137);
    expect(hoisted.createCronTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_125
    );
    expect(hoisted.createTaskManagerTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_147
    );
    expect(hoisted.createAgentsTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_126
    );
    expect(hoisted.createTeamPublicTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_127
    );
    expect(hoisted.createTeamTaskBoardTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_143
    );
    expect(hoisted.createTeamRoleSessionsTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_144
    );
    expect(hoisted.createTeamApprovalsTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_141
    );
    expect(hoisted.createTeamGraphTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_129
    );
    expect(hoisted.createTeamSkillTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_130
    );
    expect(hoisted.createTeamTriggerTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_131
    );
    expect(hoisted.createTeamWebhookAuthTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_131
    );
    expect(hoisted.createTeamLifecycleTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_133
    );
    expect(hoisted.createManualTeamTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_135
    );
    expect(hoisted.createTeamHumanDecisionTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_134
    );
    expect(hoisted.createTeamRoleChatTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_138
    );
    expect(hoisted.createProviderAccountsTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_145
    );
    expect(hoisted.createProviderModelsTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_128
    );
    expect(hoisted.createExternalConnectorsTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_128
    );
    expect(hoisted.createOpenClawMcpServersTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_128
    );
    expect(hoisted.createProviderRoutingTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_128
    );
    expect(hoisted.createClawHubSkillInstallTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_128
    );
    expect(hoisted.createClawHubSkillSearchTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_128
    );
    expect(hoisted.createSkillBundleTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_128
    );
    expect(hoisted.createSkillsManagementTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_128
    );
    expect(hoisted.createPluginsTransportMock).toHaveBeenCalledWith(
      { verificationKey: 'public-key' },
      34_128
    );
    expect(hoisted.startHostApiServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudAccountService: expect.objectContaining({ prewarm: expect.any(Function) }),
        runtimeHost: expect.objectContaining({
          command: expect.any(Function),
          restart: expect.any(Function),
        }),
        sessionListTransport: { list: expect.any(Function) },
        runtimeDirectoryTransport: { list: expect.any(Function) },
        fleetTransport: { execute: expect.any(Function) },
        sessionContentTransport: { load: expect.any(Function) },
        sessionTimelineTransport: { list: expect.any(Function) },
        matchaSessionListTransport: { list: expect.any(Function) },
        sessionAbortTransport: { abort: expect.any(Function) },
        sessionCreateTransport: { create: expect.any(Function) },
        sessionDeleteTransport: { delete: expect.any(Function) },
        sessionRenameTransport: { rename: expect.any(Function) },
        sessionApprovalTransport: expect.objectContaining({ list: expect.any(Function), respond: expect.any(Function) }),
        diagnosticsArchiveTransport: expect.objectContaining({ archive: expect.any(Function) }),
        workspaceTextTransport: { read: expect.any(Function) },
        workspaceBinaryTransport: { read: expect.any(Function) },
        workspaceDirectoryTransport: { list: expect.any(Function) },
        workspaceWriteTransport: { write: expect.any(Function) },
        workspaceMediaTransport: { thumbnail: expect.any(Function) },
        sessionSendTransport: { send: expect.any(Function) },
        sessionModelSelectionTransport: { patch: expect.any(Function) },
        sessionPermissionTransport: { get: expect.any(Function), set: expect.any(Function) },
        securityEmergencyTransport: { run: expect.any(Function) },
        skillBundleTransport: expect.objectContaining({
          exportBundles: expect.any(Function),
          importBundles: expect.any(Function),
        }),
        channelStatusTransport: { read: expect.any(Function) },
        channelCatalogTransport: { read: expect.any(Function) },
        channelConfigReadTransport: { read: expect.any(Function) },
        channelCredentialsTransport: { validate: expect.any(Function) },
        channelDeleteConfigTransport: { deleteConfig: expect.any(Function) },
        channelLoginTransport: { login: expect.any(Function) },
        channelControlTransport: { operate: expect.any(Function) },
        channelPairingTransport: expect.objectContaining({
          list: expect.any(Function),
          approve: expect.any(Function),
        }),
        settingsDesiredTransport: { read: expect.any(Function), submit: expect.any(Function) },
        securityPolicyTransport: {
          operate: expect.any(Function),
          read: expect.any(Function),
          readAudit: expect.any(Function),
          submit: expect.any(Function),
        },
        securityRuleCatalogTransport: { read: expect.any(Function) },
        cronTransport: { execute: expect.any(Function) },
        taskManagerTransport: { list: expect.any(Function) },
        agentsTransport: { execute: expect.any(Function) },
        teamPublicTransport: { read: expect.any(Function) },
        teamTaskBoardTransport: { read: expect.any(Function) },
        teamRoleSessionsTransport: { read: expect.any(Function) },
        teamApprovalsTransport: { read: expect.any(Function) },
        teamGraphTransport: { read: expect.any(Function) },
        teamSkillTransport: { execute: expect.any(Function) },
        teamTriggerTransport: { execute: expect.any(Function) },
        teamWebhookAuthTransport: { read: expect.any(Function) },
        teamLifecycleTransport: expect.objectContaining({
          list: expect.any(Function),
          create: expect.any(Function),
          delete: expect.any(Function),
          resume: expect.any(Function),
          cancel: expect.any(Function),
        }),
        manualTeamTransport: { materializeAndCreate: expect.any(Function) },
        teamHumanDecisionTransport: { resolve: expect.any(Function) },
        teamRoleChatTransport: { submit: expect.any(Function) },
        providerAccountsTransport: { execute: expect.any(Function) },
        providerModelsTransport: { execute: expect.any(Function) },
        externalConnectorsTransport: { execute: expect.any(Function) },
        openClawMcpServersTransport: { execute: expect.any(Function) },
        providerRoutingTransport: { execute: expect.any(Function) },
        clawHubSkillInstallTransport: { install: expect.any(Function) },
        clawHubSkillSearchTransport: { search: expect.any(Function) },
        skillsManagementTransport: { execute: expect.any(Function) },
        pluginsTransport: { execute: expect.any(Function) },
        usageTransport: { read: expect.any(Function) },
        matchaAgentHistoryTransport: { history: expect.any(Function) },
      }),
      undefined,
      34_102,
    );
    expect(hoisted.startHostApiServerMock.mock.calls[0]?.[0]).not.toHaveProperty('licenseService');
    expect(hoisted.waitForHostApiServerListeningMock).toHaveBeenCalledWith({});
    expect(hoisted.registerRuntimeIpcHandlersMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.any(Function) }),
      context.deps.getMainWindow,
      expect.objectContaining({ execute: expect.any(Function) }),
      expect.objectContaining({ transport: expect.objectContaining({ download: expect.any(Function) }) })
    );
    expect(hoisted.registerHostEventBridgeMock).toHaveBeenCalledWith({
      runtimeHost: expect.objectContaining({
        command: expect.any(Function),
        onRestart: expect.any(Function),
      }),
      hostEventBus: context.deps.hostEventBus,
      getMainWindow: context.deps.getMainWindow,
      rendererEventRoutes: expect.anything(),
    });
    expect(result).toEqual(
      expect.objectContaining({
        mainWindow: context.mainWindow,
        directRuntimeHost: expect.objectContaining({
        command: expect.any(Function),
        restart: expect.any(Function),
      }),
      })
    );
    expect(hoisted.loadMainWindowContentMock).toHaveBeenCalledWith(context.mainWindow);
    expect(readE2EStartupOutcome()).toBeUndefined();
  });

  it('loads renderer after static IPC registration and before Runtime Host readiness', async () => {
    process.env.MATCHACLAW_E2E = '1';
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    let resolveRuntimeHost!: (runtimeHost: ReturnType<typeof createDirectRuntimeHostFixture>) => void;
    hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
    hoisted.launchDirectRuntimeHostMock.mockReturnValue(new Promise((resolve) => {
      resolveRuntimeHost = resolve;
    }));

    const bootstrapping = bootstrapMainApplication(context.deps as never);
    await Promise.resolve();

    expect(hoisted.registerStaticIpcHandlersMock).toHaveBeenCalledWith(context.deps.getMainWindow);
    expect(hoisted.registerE2EUpdateHandlersMock).toHaveBeenCalledOnce();
    expect(hoisted.loadMainWindowContentMock).toHaveBeenCalledWith(context.mainWindow);
    expect(hoisted.startHostApiServerMock).not.toHaveBeenCalled();
    expect(hoisted.registerRuntimeIpcHandlersMock).not.toHaveBeenCalled();
    expect(context.mainWindow.show).not.toHaveBeenCalled();

    resolveRuntimeHost(context.directRuntimeHost);
    await expect(bootstrapping).resolves.toMatchObject({
      directRuntimeHost: expect.objectContaining({
        command: expect.any(Function),
        restart: expect.any(Function),
      }),
    });
    expect(context.deps.hostEventBus.on).toHaveBeenCalledWith('gateway:status', expect.any(Function));
    const reveal = (context.deps.hostEventBus.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (payload: unknown) => void;
    reveal({ processState: 'stopped' });
    expect(context.mainWindow.show).not.toHaveBeenCalled();
    reveal({ processState: 'starting' });
    expect(context.mainWindow.show).toHaveBeenCalledOnce();
  });

  it('does not block Host admission on OpenClaw peer readiness', async () => {
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
    hoisted.launchDirectRuntimeHostMock.mockResolvedValue(context.directRuntimeHost);

    await expect(bootstrapMainApplication(context.deps as never)).resolves.toMatchObject({
      directRuntimeHost: expect.objectContaining({
        command: expect.any(Function),
        restart: expect.any(Function),
      }),
    });

    expect(hoisted.waitForGatewayControlReadyMock).not.toHaveBeenCalled();
    expect(context.directRuntimeHost.stop).not.toHaveBeenCalled();
    expect(hoisted.createSessionListTransportMock).toHaveBeenCalledOnce();
  });

  it('后续 bootstrap 失败时停止已启动的 Rust Host', async () => {
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    const failure = new Error('Host API listen failed');
    hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
    hoisted.launchDirectRuntimeHostMock.mockResolvedValue(context.directRuntimeHost);
    hoisted.waitForHostApiServerListeningMock.mockRejectedValue(failure);

    await expect(bootstrapMainApplication(context.deps as never)).rejects.toBe(failure);

    expect(context.directRuntimeHost.stop).toHaveBeenCalledOnce();
    expect(context.directRuntimeHost.forceKill).not.toHaveBeenCalled();
  });

  it('停止失败时强制终止已启动的 Rust Host', async () => {
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
    hoisted.launchDirectRuntimeHostMock.mockResolvedValue(context.directRuntimeHost);
    hoisted.waitForHostApiServerListeningMock.mockRejectedValue(
      new Error('Host API listen failed')
    );
    context.directRuntimeHost.stop.mockRejectedValue(new Error('graceful stop failed'));

    await expect(bootstrapMainApplication(context.deps as never)).rejects.toThrow(
      'Host API listen failed'
    );

    expect(context.directRuntimeHost.stop).toHaveBeenCalledOnce();
    expect(context.directRuntimeHost.forceKill).toHaveBeenCalledOnce();
  });

  it('停止超时后强制终止已启动的 Rust Host', async () => {
    vi.useFakeTimers();
    try {
      const bootstrapMainApplication = await importBootstrapMainApplication();
      const context = createBootstrapContext();
      hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
      hoisted.launchDirectRuntimeHostMock.mockResolvedValue(context.directRuntimeHost);
      hoisted.waitForHostApiServerListeningMock.mockRejectedValue(
        new Error('Host API listen failed')
      );
      context.directRuntimeHost.stop.mockReturnValue(new Promise(() => undefined));

      const outcome = bootstrapMainApplication(context.deps as never).then(
        () => undefined,
        (error) => error
      );
      await vi.advanceTimersByTimeAsync(5000);

      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Host API listen failed');
      expect(context.directRuntimeHost.forceKill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('不启动旧 peer runtime 或旧 Node Host API server', async () => {
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
    hoisted.launchDirectRuntimeHostMock.mockResolvedValue(context.directRuntimeHost);

    await bootstrapMainApplication(context.deps as never);

    expect(hoisted.launchDirectRuntimeHostMock).toHaveBeenCalledTimes(1);
    expect(hoisted.registerRuntimeIpcHandlersMock.mock.calls[0]).toHaveLength(4);
  });

  it('E2E 模式仍通过同一 Rust Host 路径启动', async () => {
    process.env.MATCHACLAW_E2E = '1';
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
    hoisted.launchDirectRuntimeHostMock.mockResolvedValue(context.directRuntimeHost);

    await bootstrapMainApplication(context.deps as never);

    expect(hoisted.launchDirectRuntimeHostMock).toHaveBeenCalledTimes(1);
    expect(hoisted.createTrayMock).not.toHaveBeenCalled();
    expect(hoisted.registerUpdateHandlersMock).not.toHaveBeenCalled();
    expect(hoisted.registerE2EUpdateHandlersMock).toHaveBeenCalledOnce();
    expect(readE2EStartupOutcome()).toEqual({ stage: 'ready', outcome: 'started' });
  });

  it('E2E 仅公布 bootstrap resolver 的安全失败分类', async () => {
    process.env.MATCHACLAW_E2E = '1';
    const failure = new Error('E:\\private\\runtime-host.json contains token');
    hoisted.resolveRuntimeHostBootstrapMock.mockImplementation(() => {
      throw failure;
    });
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();

    await expect(bootstrapMainApplication(context.deps as never)).rejects.toBe(failure);

    expect(readE2EStartupOutcome()).toEqual({
      stage: 'bootstrap-resolve',
      outcome: 'BOOTSTRAP_RESOLVE_FAILED',
    });
    expect(JSON.stringify(readE2EStartupOutcome())).not.toContain('private');
    expect(JSON.stringify(readE2EStartupOutcome())).not.toContain('token');
  });

  it('E2E 保留 DirectRuntimeHost delivery 的安全失败分类', async () => {
    process.env.MATCHACLAW_E2E = '1';
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    const failure = Object.assign(new Error('C:\\private\\runtime-host.exe'), {
      code: 'SPAWN_FAILED',
      name: 'DirectRuntimeHostDeliveryError',
    });
    hoisted.launchDirectRuntimeHostMock.mockRejectedValue(failure);

    await expect(bootstrapMainApplication(context.deps as never)).rejects.toBe(failure);

    expect(readE2EStartupOutcome()).toEqual({
      stage: 'runtime-host-launch',
      outcome: 'SPAWN_FAILED',
    });
    expect(JSON.stringify(readE2EStartupOutcome())).not.toContain('private');
  });
});
