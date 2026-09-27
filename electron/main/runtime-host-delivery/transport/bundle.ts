import type { RuntimeHostTransports } from './host-api-transports';
import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { createAgentsTransport } from '../products/agents';
import { createSettingsDesiredTransport } from '../products/settings/desired';
import { createCapabilityDirectoryTransport } from './capabilities';
import { createCronTransport } from './cron';
import { createDiagnosticsArchiveTransport } from './diagnostics';
import { createFleetCredentialsTransport } from './fleet-credentials';
import { createFleetTransport } from './fleet';
import { createOpenClawMcpServersTransport } from './connectors/openclaw-mcp-servers';
import { createExternalConnectorsTransport } from './connectors/external';
import { createOpenClawGatewayTransport } from './openclaw-gateway';
import { createOpenClawPlatformTransport } from './openclaw-platform';
import { createPluginsTransport } from './plugins';
import { createProviderAccountsTransport } from './providers/accounts';
import { createProviderModelsTransport } from './providers/models';
import { createProviderRoutingTransport } from './providers/routing';
import { createSecurityEmergencyTransport } from './security/emergency';
import { createSecurityPolicyTransport } from './security/policy';
import { createSecurityRuleCatalogTransport } from './security/rule-catalog';
import { createSessionAbortTransport } from './sessions/abort';
import { createSessionApprovalTransport } from './sessions/approvals';
import { createSessionContentTransport } from './sessions/content';
import { createSessionCreateTransport } from './sessions/create';
import { createSessionDeleteTransport } from './sessions/delete';
import { createSessionEventsTransport, type SessionEventsTransport } from './sessions/events';
import { createSessionHistoryTransport } from './sessions/history';
import { createSessionListTransport } from './sessions/list';
import { createSessionModelSelectionTransport } from './sessions/model-selection';
import { createSessionPermissionTransport } from './sessions/permission';
import { createSessionRenameTransport } from './sessions/rename';
import { createSessionSendTransport } from './sessions/send';
import { createSessionTimelineTransport } from './sessions/timeline';
import { createClawHubSkillInstallTransport } from './skills/clawhub-install';
import { createClawHubSkillSearchTransport } from './skills/clawhub-search';
import { createSkillBundleTransport } from './skills/bundle';
import { createSkillsManagementTransport } from './skills/management';
import { createSealedSkillsTransport } from './skills/sealed';
import { createTaskManagerTransport } from './task-manager';
import { createTeamApprovalsTransport } from './teams/approvals';
import { createTeamHumanDecisionTransport } from './teams/decision';
import { createTeamGraphTransport } from './teams/graph';
import { createTeamLifecycleTransport } from './teams/lifecycle';
import { createManualTeamTransport } from './teams/manual';
import { createTeamPublicTransport } from './teams/public';
import { createTeamRuntimeTransport } from './teams/runtime';
import { createTeamRoleSessionsTransport } from './teams/role-sessions';
import { createTeamSkillTransport } from './teams/skill';
import { createTeamTaskBoardTransport } from './teams/task-board';
import { createTeamTriggerTransport } from './teams/trigger';
import { createTeamWebhookAuthTransport } from './teams/webhook-auth';
import { createToolchainTransport } from './toolchain';
import { createChannelAuthorizationTransport } from './channels/authorization';
import { createChannelCatalogTransport } from './channels/catalog';
import { createChannelConfigReadTransport } from './channels/config-read';
import { createChannelControlTransport } from './channels/control';
import { createChannelCredentialsTransport } from './channels/credentials';
import { createChannelDeleteConfigTransport } from './channels/delete-config';
import { createChannelLoginTransport } from './channels/login';
import { createChannelPairingTransport } from './channels/pairing';
import { createChannelStatusTransport } from './channels/status';
import { createWorkspaceMediaTransport } from './workspace/media';
import { createWorkspaceBinaryTransport } from './workspace/read-binary';
import { createWorkspaceDirectoryTransport } from './workspace/read-directory';
import { createWorkspaceTextTransport } from './workspace/read-text';
import { createWorkspaceWriteTransport } from './workspace/write-text';
import { createRuntimeControlTransport } from './runtime-control';
import { createRuntimeEndpointDirectoryTransport } from './runtime-directory';
import { createSealedResourceAuthorizationTransport } from './sealed-resource';
import { createUsageTransport } from './usage';
import { createWikiTransport } from './wiki';

type CronE2ETraceReporter = NonNullable<
  NonNullable<Parameters<typeof createCronTransport>[3]>['reportE2ETrace']
>;

export type RuntimeHostTransportBundleInput = Readonly<{
  issuer: RuntimeHostDeliveryIssuer;
  runtimeHostTransportPort: number;
  reportE2ECronTrace?: CronE2ETraceReporter;
}>;

export type RuntimeHostTransportBundle = Readonly<{
  hostApiTransports: RuntimeHostTransports;
  sessionEventsTransport: SessionEventsTransport;
  close: () => void;
}>;

export function createRuntimeHostTransportBundle(
  input: RuntimeHostTransportBundleInput,
): RuntimeHostTransportBundle {
  const { issuer, runtimeHostTransportPort } = input;
  const sessionEventsTransport = createSessionEventsTransport(issuer, runtimeHostTransportPort);
  const channelCatalogTransport = createChannelCatalogTransport(issuer, runtimeHostTransportPort);
  const cronTransport = input.reportE2ECronTrace === undefined
    ? createCronTransport(issuer, runtimeHostTransportPort)
    : createCronTransport(issuer, runtimeHostTransportPort, undefined, {
        reportE2ETrace: input.reportE2ECronTrace,
      });

  const hostApiTransports: RuntimeHostTransports = {
    sessionListTransport: createSessionListTransport(issuer, runtimeHostTransportPort),
    capabilityDirectoryTransport: createCapabilityDirectoryTransport(issuer, runtimeHostTransportPort),
    runtimeDirectoryTransport: createRuntimeEndpointDirectoryTransport(issuer, runtimeHostTransportPort),
    runtimeControlTransport: createRuntimeControlTransport(issuer, runtimeHostTransportPort),
    fleetTransport: createFleetTransport(issuer, runtimeHostTransportPort),
    fleetCredentialsTransport: createFleetCredentialsTransport(issuer, runtimeHostTransportPort),
    sessionContentTransport: createSessionContentTransport(issuer, runtimeHostTransportPort),
    sessionTimelineTransport: createSessionTimelineTransport(issuer, runtimeHostTransportPort),
    diagnosticsArchiveTransport: createDiagnosticsArchiveTransport(issuer, runtimeHostTransportPort),
    workspaceTextTransport: createWorkspaceTextTransport(issuer, runtimeHostTransportPort),
    workspaceBinaryTransport: createWorkspaceBinaryTransport(issuer, runtimeHostTransportPort),
    workspaceDirectoryTransport: createWorkspaceDirectoryTransport(issuer, runtimeHostTransportPort),
    workspaceWriteTransport: createWorkspaceWriteTransport(issuer, runtimeHostTransportPort),
    workspaceMediaTransport: createWorkspaceMediaTransport(issuer, runtimeHostTransportPort),
    sessionAbortTransport: createSessionAbortTransport(issuer, runtimeHostTransportPort),
    sessionCreateTransport: createSessionCreateTransport(issuer, runtimeHostTransportPort),
    sessionDeleteTransport: createSessionDeleteTransport(issuer, runtimeHostTransportPort),
    sessionRenameTransport: createSessionRenameTransport(issuer, runtimeHostTransportPort),
    sessionApprovalTransport: createSessionApprovalTransport(issuer, runtimeHostTransportPort),
    sessionSendTransport: createSessionSendTransport(issuer, runtimeHostTransportPort),
    sessionModelSelectionTransport: createSessionModelSelectionTransport(issuer, runtimeHostTransportPort),
    sessionPermissionTransport: createSessionPermissionTransport(issuer, runtimeHostTransportPort),
    securityEmergencyTransport: createSecurityEmergencyTransport(issuer, runtimeHostTransportPort),
    channelStatusTransport: createChannelStatusTransport(issuer, runtimeHostTransportPort),
    channelCatalogTransport,
    channelAuthorizationTransport: createChannelAuthorizationTransport(channelCatalogTransport),
    channelConfigReadTransport: createChannelConfigReadTransport(issuer, runtimeHostTransportPort),
    channelCredentialsTransport: createChannelCredentialsTransport(issuer, runtimeHostTransportPort),
    channelDeleteConfigTransport: createChannelDeleteConfigTransport(issuer, runtimeHostTransportPort),
    channelLoginTransport: createChannelLoginTransport(issuer, runtimeHostTransportPort),
    channelControlTransport: createChannelControlTransport(issuer, runtimeHostTransportPort),
    channelPairingTransport: createChannelPairingTransport(issuer, runtimeHostTransportPort),
    settingsDesiredTransport: createSettingsDesiredTransport(issuer, runtimeHostTransportPort),
    securityPolicyTransport: createSecurityPolicyTransport(issuer, runtimeHostTransportPort),
    securityRuleCatalogTransport: createSecurityRuleCatalogTransport(issuer, runtimeHostTransportPort),
    cronTransport,
    taskManagerTransport: createTaskManagerTransport(issuer, runtimeHostTransportPort),
    agentsTransport: createAgentsTransport(issuer, runtimeHostTransportPort),
    teamPublicTransport: createTeamPublicTransport(issuer, runtimeHostTransportPort),
    teamTaskBoardTransport: createTeamTaskBoardTransport(issuer, runtimeHostTransportPort),
    teamRoleSessionsTransport: createTeamRoleSessionsTransport(issuer, runtimeHostTransportPort),
    teamApprovalsTransport: createTeamApprovalsTransport(issuer, runtimeHostTransportPort),
    teamGraphTransport: createTeamGraphTransport(issuer, runtimeHostTransportPort),
    teamSkillTransport: createTeamSkillTransport(issuer, runtimeHostTransportPort),
    teamTriggerTransport: createTeamTriggerTransport(issuer, runtimeHostTransportPort),
    teamWebhookAuthTransport: createTeamWebhookAuthTransport(issuer, runtimeHostTransportPort),
    teamLifecycleTransport: createTeamLifecycleTransport(issuer, runtimeHostTransportPort),
    teamRuntimeTransport: createTeamRuntimeTransport(issuer, runtimeHostTransportPort),
    manualTeamTransport: createManualTeamTransport(issuer, runtimeHostTransportPort),
    teamHumanDecisionTransport: createTeamHumanDecisionTransport(issuer, runtimeHostTransportPort),
    providerAccountsTransport: createProviderAccountsTransport(issuer, runtimeHostTransportPort),
    providerModelsTransport: createProviderModelsTransport(issuer, runtimeHostTransportPort),
    externalConnectorsTransport: createExternalConnectorsTransport(issuer, runtimeHostTransportPort),
    openClawMcpServersTransport: createOpenClawMcpServersTransport(issuer, runtimeHostTransportPort),
    openClawGatewayTransport: createOpenClawGatewayTransport(issuer, runtimeHostTransportPort),
    openClawPlatformTransport: createOpenClawPlatformTransport(issuer, runtimeHostTransportPort),
    providerRoutingTransport: createProviderRoutingTransport(issuer, runtimeHostTransportPort),
    clawHubSkillInstallTransport: createClawHubSkillInstallTransport(issuer, runtimeHostTransportPort),
    clawHubSkillSearchTransport: createClawHubSkillSearchTransport(issuer, runtimeHostTransportPort),
    skillBundleTransport: createSkillBundleTransport(issuer, runtimeHostTransportPort),
    skillsManagementTransport: createSkillsManagementTransport(issuer, runtimeHostTransportPort),
    sealedSkillsTransport: createSealedSkillsTransport(issuer, runtimeHostTransportPort),
    sealedResourceAuthorizationTransport: createSealedResourceAuthorizationTransport(issuer, runtimeHostTransportPort),
    pluginsTransport: createPluginsTransport(issuer, runtimeHostTransportPort),
    toolchainTransport: createToolchainTransport(issuer, runtimeHostTransportPort),
    usageTransport: createUsageTransport(issuer, runtimeHostTransportPort),
    wikiTransport: createWikiTransport(issuer, runtimeHostTransportPort),
    sessionHistoryTransport: createSessionHistoryTransport(issuer, runtimeHostTransportPort),
  };

  return {
    hostApiTransports,
    sessionEventsTransport,
    close: () => sessionEventsTransport.close(),
  };
}
