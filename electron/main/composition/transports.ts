import type { RuntimeHostDeliveryIssuer } from '../runtime-host-delivery/issuer';
import type { RuntimeHostTransports } from '../runtime-host-delivery/transport/host-api-transports';
import { createAgentsTransport } from '../runtime-host-delivery/products/agents';
import { createSettingsDesiredTransport } from '../settings/desired';
import { createBoardTransport } from '../runtime-host-delivery/transport/board';
import { createCapabilityDirectoryTransport } from '../runtime-host-delivery/transport/capabilities';
import { createCronTransport } from '../runtime-host-delivery/transport/cron';
import { createCallLogTransport } from '../runtime-host-delivery/transport/call-log';
import { createDiagnosticsArchiveTransport } from '../runtime-host-delivery/transport/diagnostics';
import { createFleetCredentialsTransport } from '../runtime-host-delivery/transport/fleet-credentials';
import { createFleetTransport } from '../runtime-host-delivery/transport/fleet';
import { createOpenClawMcpServersTransport } from '../runtime-host-delivery/transport/connectors/openclaw-mcp-servers';
import { createExternalConnectorsTransport } from '../runtime-host-delivery/transport/connectors/external';
import { createOpenClawGatewayTransport } from '../runtime-host-delivery/transport/openclaw-gateway';
import { createOpenClawPlatformTransport } from '../runtime-host-delivery/transport/openclaw-platform';
import { createPluginsTransport } from '../runtime-host-delivery/transport/plugins';
import { createProviderAccountsTransport } from '../runtime-host-delivery/transport/providers/accounts';
import { createProviderModelsTransport } from '../runtime-host-delivery/transport/providers/models';
import { createProviderRoutingTransport } from '../runtime-host-delivery/transport/providers/routing';
import { createProviderRecoveryTransport } from '../runtime-host-delivery/transport/providers/recovery';
import { createSearchTransport } from '../runtime-host-delivery/transport/search';
import { fetchLoopbackHttp } from '../../utils/loopback-http';
import { createSecurityEmergencyTransport } from '../runtime-host-delivery/transport/security/emergency';
import { createSecurityPolicyTransport } from '../runtime-host-delivery/transport/security/policy';
import { createNativePolicyTransport } from '../runtime-host-delivery/transport/security/native-policy';
import { createSecurityRuleCatalogTransport } from '../runtime-host-delivery/transport/security/rule-catalog';
import { createSessionAbortTransport } from '../runtime-host-delivery/transport/sessions/abort';
import { createSessionApprovalTransport } from '../runtime-host-delivery/transport/sessions/approvals';
import { createSessionContentTransport } from '../runtime-host-delivery/transport/sessions/content';
import { createSessionCreateTransport } from '../runtime-host-delivery/transport/sessions/create';
import { createSessionDeleteTransport } from '../runtime-host-delivery/transport/sessions/delete';
import { createSessionEventsTransport } from '../runtime-host-delivery/transport/sessions/events';
import { createSessionHistoryTransport } from '../runtime-host-delivery/transport/sessions/history';
import { createSessionGoalTransport } from '../runtime-host-delivery/transport/sessions/goal';
import { createSessionQuestionTransport } from '../runtime-host-delivery/transport/sessions/questions';
import { createSessionListTransport } from '../runtime-host-delivery/transport/sessions/list';
import { createSessionModelSelectionTransport } from '../runtime-host-delivery/transport/sessions/model-selection';
import { createSessionPermissionTransport } from '../runtime-host-delivery/transport/sessions/permission';
import { createSessionThinkingTransport } from '../runtime-host-delivery/transport/sessions/thinking';
import { createSessionRenameTransport } from '../runtime-host-delivery/transport/sessions/rename';
import { createSessionSendTransport } from '../runtime-host-delivery/transport/sessions/send';
import { createSessionTimelineTransport } from '../runtime-host-delivery/transport/sessions/timeline';
import { createSessionObservationTransport } from '../runtime-host-delivery/transport/sessions/observation';
import { createClawHubSkillInstallTransport } from '../runtime-host-delivery/transport/skills/clawhub-install';
import { createClawHubSkillSearchTransport } from '../runtime-host-delivery/transport/skills/clawhub-search';
import { createSkillBundleTransport } from '../runtime-host-delivery/transport/skills/bundle';
import { createSkillsManagementTransport } from '../runtime-host-delivery/transport/skills/management';
import { createSealedSkillsTransport } from '../runtime-host-delivery/transport/skills/sealed';
import { createTaskManagerTransport } from '../runtime-host-delivery/transport/task-manager';
import { createTeamApprovalsTransport } from '../runtime-host-delivery/transport/teams/approvals';
import { createTeamHumanDecisionTransport } from '../runtime-host-delivery/transport/teams/decision';
import { createTeamGraphTransport } from '../runtime-host-delivery/transport/teams/graph';
import { createTeamLifecycleTransport } from '../runtime-host-delivery/transport/teams/lifecycle';
import { createManualTeamTransport } from '../runtime-host-delivery/transport/teams/manual';
import { createTeamPublicTransport } from '../runtime-host-delivery/transport/teams/public';
import { createTeamRuntimeTransport } from '../runtime-host-delivery/transport/teams/runtime';
import { createTeamRoleSessionsTransport } from '../runtime-host-delivery/transport/teams/role-sessions';
import { createTeamSkillTransport } from '../runtime-host-delivery/transport/teams/skill';
import { createTeamTaskBoardTransport } from '../runtime-host-delivery/transport/teams/task-board';
import { createTeamTriggerTransport } from '../runtime-host-delivery/transport/teams/trigger';
import { createTeamWebhookAuthTransport } from '../runtime-host-delivery/transport/teams/webhook-auth';
import { createToolchainTransport } from '../runtime-host-delivery/transport/toolchain';
import { createChannelCatalogTransport } from '../runtime-host-delivery/transport/channels/catalog';
import { createChannelConfigReadTransport } from '../runtime-host-delivery/transport/channels/config-read';
import { createChannelControlTransport } from '../runtime-host-delivery/transport/channels/control';
import { createChannelCredentialsTransport } from '../runtime-host-delivery/transport/channels/credentials';
import { createChannelDeleteConfigTransport } from '../runtime-host-delivery/transport/channels/delete-config';
import { createChannelLoginTransport } from '../runtime-host-delivery/transport/channels/login';
import { createChannelPairingTransport } from '../runtime-host-delivery/transport/channels/pairing';
import { createChannelStatusTransport } from '../runtime-host-delivery/transport/channels/status';
import { createWorkspaceMediaTransport } from '../runtime-host-delivery/transport/workspace/media';
import { createWorkspaceSessionImagesTransport } from '../runtime-host-delivery/transport/workspace/session-images';
import { createWorkspaceBinaryTransport } from '../runtime-host-delivery/transport/workspace/read-binary';
import { createWorkspaceDirectoryTransport } from '../runtime-host-delivery/transport/workspace/read-directory';
import { createWorkspaceTextTransport } from '../runtime-host-delivery/transport/workspace/read-text';
import { createWorkspaceWriteTransport } from '../runtime-host-delivery/transport/workspace/write-text';
import { createWorkspaceWriteBinaryTransport } from '../runtime-host-delivery/transport/workspace/write-binary';
import { createRuntimeControlTransport } from '../runtime-host-delivery/transport/runtime-control';
import { createRuntimeEndpointDirectoryTransport } from '../runtime-host-delivery/transport/runtime-directory';
import { createSealedResourceAuthorizationTransport } from '../runtime-host-delivery/transport/sealed-resource';
import { createUsageTransport } from '../runtime-host-delivery/transport/usage';
import { createWikiTransport } from '../runtime-host-delivery/transport/wiki';
import { createWorldTransport } from '../world/transport';

type CronE2ETraceReporter = NonNullable<
  NonNullable<Parameters<typeof createCronTransport>[3]>['reportE2ETrace']
>;

export type RuntimeHostTransportBundleInput = Readonly<{
  issuer: RuntimeHostDeliveryIssuer;
  runtimeHostTransportPort: number;
  reportE2ECronTrace?: CronE2ETraceReporter;
}>;

export type RuntimeHostTransportBundle = ReturnType<typeof createRuntimeHostTransportBundle>;

export function createRuntimeHostTransportBundle(
  input: RuntimeHostTransportBundleInput,
) {
  const { issuer, runtimeHostTransportPort } = input;
  const sessionEventsTransport = createSessionEventsTransport(issuer, runtimeHostTransportPort);
  const channelCatalogTransport = createChannelCatalogTransport(issuer, runtimeHostTransportPort);
  const cronTransport = input.reportE2ECronTrace === undefined
    ? createCronTransport(issuer, runtimeHostTransportPort)
    : createCronTransport(issuer, runtimeHostTransportPort, undefined, {
        reportE2ETrace: input.reportE2ECronTrace,
      });

  const hostApiTransports: RuntimeHostTransports = {
    boardTransport: createBoardTransport(issuer, runtimeHostTransportPort),
    sessionListTransport: createSessionListTransport(issuer, runtimeHostTransportPort),
    capabilityDirectoryTransport: createCapabilityDirectoryTransport(issuer, runtimeHostTransportPort),
    runtimeDirectoryTransport: createRuntimeEndpointDirectoryTransport(issuer, runtimeHostTransportPort),
    runtimeControlTransport: createRuntimeControlTransport(issuer, runtimeHostTransportPort),
    fleetTransport: createFleetTransport(issuer, runtimeHostTransportPort),
    fleetCredentialsTransport: createFleetCredentialsTransport(issuer, runtimeHostTransportPort),
    sessionContentTransport: createSessionContentTransport(issuer, runtimeHostTransportPort),
    sessionTimelineTransport: createSessionTimelineTransport(issuer, runtimeHostTransportPort),
    sessionObservationTransport: createSessionObservationTransport(issuer, runtimeHostTransportPort),
    diagnosticsArchiveTransport: createDiagnosticsArchiveTransport(issuer, runtimeHostTransportPort),
    workspaceTextTransport: createWorkspaceTextTransport(issuer, runtimeHostTransportPort),
    workspaceBinaryTransport: createWorkspaceBinaryTransport(issuer, runtimeHostTransportPort),
    workspaceDirectoryTransport: createWorkspaceDirectoryTransport(issuer, runtimeHostTransportPort),
    workspaceWriteTransport: createWorkspaceWriteTransport(issuer, runtimeHostTransportPort),
    workspaceWriteBinaryTransport: createWorkspaceWriteBinaryTransport(issuer, runtimeHostTransportPort),
    workspaceMediaTransport: createWorkspaceMediaTransport(issuer, runtimeHostTransportPort),
    workspaceSessionImagesTransport: createWorkspaceSessionImagesTransport(issuer, runtimeHostTransportPort),
    sessionAbortTransport: createSessionAbortTransport(issuer, runtimeHostTransportPort),
    sessionCreateTransport: createSessionCreateTransport(issuer, runtimeHostTransportPort),
    sessionDeleteTransport: createSessionDeleteTransport(issuer, runtimeHostTransportPort),
    sessionRenameTransport: createSessionRenameTransport(issuer, runtimeHostTransportPort),
    sessionApprovalTransport: createSessionApprovalTransport(issuer, runtimeHostTransportPort),
    sessionSendTransport: createSessionSendTransport(issuer, runtimeHostTransportPort),
    sessionGoalTransport: createSessionGoalTransport(issuer, runtimeHostTransportPort),
    sessionQuestionTransport: createSessionQuestionTransport(issuer, runtimeHostTransportPort),
    sessionModelSelectionTransport: createSessionModelSelectionTransport(issuer, runtimeHostTransportPort),
    sessionPermissionTransport: createSessionPermissionTransport(issuer, runtimeHostTransportPort),
    sessionThinkingTransport: createSessionThinkingTransport(issuer, runtimeHostTransportPort),
    securityEmergencyTransport: createSecurityEmergencyTransport(issuer, runtimeHostTransportPort),
    channelStatusTransport: createChannelStatusTransport(issuer, runtimeHostTransportPort),
    channelCatalogTransport,
    channelConfigReadTransport: createChannelConfigReadTransport(issuer, runtimeHostTransportPort),
    channelCredentialsTransport: createChannelCredentialsTransport(issuer, runtimeHostTransportPort),
    channelDeleteConfigTransport: createChannelDeleteConfigTransport(issuer, runtimeHostTransportPort),
    channelLoginTransport: createChannelLoginTransport(issuer, runtimeHostTransportPort),
    channelControlTransport: createChannelControlTransport(issuer, runtimeHostTransportPort),
    channelPairingTransport: createChannelPairingTransport(issuer, runtimeHostTransportPort),
    settingsDesiredTransport: createSettingsDesiredTransport(issuer, runtimeHostTransportPort),
    securityPolicyTransport: createSecurityPolicyTransport(issuer, runtimeHostTransportPort),
    nativePolicyTransport: createNativePolicyTransport(issuer, runtimeHostTransportPort),
    securityRuleCatalogTransport: createSecurityRuleCatalogTransport(issuer, runtimeHostTransportPort),
    cronTransport,
    callLogTransport: createCallLogTransport(issuer, runtimeHostTransportPort),
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
    providerRecoveryTransport: createProviderRecoveryTransport(issuer, runtimeHostTransportPort),
    search: createSearchTransport(issuer, runtimeHostTransportPort, fetchLoopbackHttp),
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
    worldTransport: createWorldTransport(issuer, runtimeHostTransportPort),
    sessionHistoryTransport: createSessionHistoryTransport(issuer, runtimeHostTransportPort),
  };

  return {
    hostApiTransports,
    sessionEventsTransport,
    close: () => sessionEventsTransport.close(),
  } as const;
}
