import type { RendererEventRouteRegistry } from '../main/renderer-event-routes';
import type { HostEventBus } from './event-bus';
import type { DirectRuntimeHost } from '../main/runtime-host-delivery/direct-host';
import type { FleetTransport } from '../main/runtime-host-delivery/transport/fleet';
import type { DiagnosticsArchiveTransport } from '../main/runtime-host-delivery/transport/diagnostics';
import type { AgentsTransport } from '../main/runtime-host-delivery/products/agents';
import type { SettingsDesiredTransport } from '../main/runtime-host-delivery/products/settings/desired';
import type { SessionAbortTransport } from '../main/runtime-host-delivery/transport/sessions/abort';
import type { SessionApprovalTransport } from '../main/runtime-host-delivery/transport/sessions/approvals';
import type { SessionCreateTransport } from '../main/runtime-host-delivery/transport/sessions/create';
import type { SessionDeleteTransport } from '../main/runtime-host-delivery/transport/sessions/delete';
import type { MatchaAgentHistoryTransport } from '../main/runtime-host-delivery/transport/sessions/matcha-history';
import type { MatchaSessionListTransport } from '../main/runtime-host-delivery/transport/sessions/matcha-list';
import type { SessionModelSelectionTransport } from '../main/runtime-host-delivery/transport/sessions/model-selection';
import type { SessionPermissionTransport } from '../main/runtime-host-delivery/transport/sessions/permission';
import type { SessionRenameTransport } from '../main/runtime-host-delivery/transport/sessions/rename';
import type { SessionSendTransport } from '../main/runtime-host-delivery/transport/sessions/send';
import type { SessionListTransport } from '../main/runtime-host-delivery/transport/sessions/list';
import type { SessionContentTransport } from '../main/runtime-host-delivery/transport/sessions/content';
import type { SessionTimelineTransport } from '../main/runtime-host-delivery/transport/sessions/timeline';
import type { ChannelAuthorizationTransport } from '../main/runtime-host-delivery/transport/channels/authorization';
import type { ChannelCatalogTransport } from '../main/runtime-host-delivery/transport/channels/catalog';
import type { ChannelConfigReadTransport } from '../main/runtime-host-delivery/transport/channels/config-read';
import type { ChannelCredentialsTransport } from '../main/runtime-host-delivery/transport/channels/credentials';
import type { ChannelControlTransport } from '../main/runtime-host-delivery/transport/channels/control';
import type { ChannelDeleteConfigTransport } from '../main/runtime-host-delivery/transport/channels/delete-config';
import type { ChannelLoginTransport } from '../main/runtime-host-delivery/transport/channels/login';
import type { ChannelPairingTransport } from '../main/runtime-host-delivery/transport/channels/pairing';
import type { ChannelStatusTransport } from '../main/runtime-host-delivery/transport/channels/status';
import type { ExternalConnectorsTransport } from '../main/runtime-host-delivery/transport/connectors/external';
import type { OpenClawMcpServersTransport } from '../main/runtime-host-delivery/transport/connectors/openclaw-mcp-servers';
import type { CronTransport } from '../main/runtime-host-delivery/transport/cron';
import type { SecurityEmergencyTransport } from '../main/runtime-host-delivery/transport/security/emergency';
import type { SecurityPolicyTransport } from '../main/runtime-host-delivery/transport/security/policy';
import type { SecurityRuleCatalogTransport } from '../main/runtime-host-delivery/transport/security/rule-catalog';
import type { WorkspaceBinaryTransport } from '../main/runtime-host-delivery/transport/workspace/read-binary';
import type { WorkspaceDirectoryTransport } from '../main/runtime-host-delivery/transport/workspace/read-directory';
import type { WorkspaceTextTransport } from '../main/runtime-host-delivery/transport/workspace/read-text';
import type { WorkspaceWriteTransport } from '../main/runtime-host-delivery/transport/workspace/write-text';
import type { WorkspaceMediaTransport } from '../main/runtime-host-delivery/transport/workspace/media';
import type { ProviderAccountsTransport } from '../main/runtime-host-delivery/transport/providers/accounts';
import type { ProviderCredentialStatusTransport } from '../main/ipc/provider-private-auth';
import type { RemoteFleetCredentialWriteAdapter } from '../main/ipc/fleet-private';
import type { ProviderModelsTransport } from '../main/runtime-host-delivery/transport/providers/models';
import type { ProviderRoutingTransport } from '../main/runtime-host-delivery/transport/providers/routing';
import type { ClawHubSkillInstallTransport } from '../main/runtime-host-delivery/transport/skills/clawhub-install';
import type { ClawHubSkillSearchTransport } from '../main/runtime-host-delivery/transport/skills/clawhub-search';
import type { SkillBundleTransport } from '../main/runtime-host-delivery/transport/skills/bundle';
import type { SkillsManagementTransport } from '../main/runtime-host-delivery/transport/skills/management';
import type { SealedSkillsTransport } from '../main/runtime-host-delivery/transport/skills/sealed';
import type { TeamApprovalsTransport } from '../main/runtime-host-delivery/transport/teams/approvals';
import type { TeamGraphTransport } from '../main/runtime-host-delivery/transport/teams/graph';
import type { TeamLifecycleTransport } from '../main/runtime-host-delivery/transport/teams/lifecycle';
import type { ManualTeamTransport } from '../main/runtime-host-delivery/transport/teams/manual';
import type { TeamHumanDecisionTransport } from '../main/runtime-host-delivery/transport/teams/decision';
import type { TeamPublicTransport } from '../main/runtime-host-delivery/transport/teams/public';
import type { TeamRoleChatTransport } from '../main/runtime-host-delivery/transport/teams/role-chat';
import type { TeamRoleSessionsTransport } from '../main/runtime-host-delivery/transport/teams/role-sessions';
import type { TeamSkillTransport } from '../main/runtime-host-delivery/transport/teams/skill';
import type { TeamTaskBoardTransport } from '../main/runtime-host-delivery/transport/teams/task-board';
import type { TeamTriggerTransport } from '../main/runtime-host-delivery/transport/teams/trigger';
import type { TeamWebhookAuthTransport } from '../main/runtime-host-delivery/transport/teams/webhook-auth';
import type { TaskManagerTransport } from '../main/runtime-host-delivery/transport/task-manager';
import type { PluginsTransport } from '../main/runtime-host-delivery/transport/plugins';
import type { UsageTransport } from '../main/runtime-host-delivery/transport/usage';
import type { RuntimeEndpointDirectoryTransport } from '../main/runtime-host-delivery/transport/runtime-directory';
import type { CloudAccountService } from '../main/cloud-account/service';

export type RuntimeHostLifecycle = DirectRuntimeHost & Readonly<{
  restart: () => Promise<void>;
}>;

export interface HostApiContext {
  cloudAccountService?: CloudAccountService;
  eventBus: HostEventBus;
  runtimeHost: RuntimeHostLifecycle;
  rendererEventRoutes: RendererEventRouteRegistry;
  sessionListTransport: SessionListTransport;
  fleetTransport: FleetTransport;
  credentialWriteAdapter?: RemoteFleetCredentialWriteAdapter;
  sessionTimelineTransport: SessionTimelineTransport;
  sessionContentTransport: SessionContentTransport;
  matchaSessionListTransport: MatchaSessionListTransport;
  sessionAbortTransport: SessionAbortTransport;
  sessionCreateTransport: SessionCreateTransport;
  sessionDeleteTransport: SessionDeleteTransport;
  sessionRenameTransport: SessionRenameTransport;
  sessionApprovalTransport: SessionApprovalTransport;
  diagnosticsArchiveTransport: DiagnosticsArchiveTransport;
  workspaceTextTransport: WorkspaceTextTransport;
  workspaceBinaryTransport: WorkspaceBinaryTransport;
  workspaceDirectoryTransport: WorkspaceDirectoryTransport;
  workspaceWriteTransport: WorkspaceWriteTransport;
  workspaceMediaTransport: WorkspaceMediaTransport;
  sessionSendTransport: SessionSendTransport;
  sessionModelSelectionTransport: SessionModelSelectionTransport;
  sessionPermissionTransport: SessionPermissionTransport;
  securityEmergencyTransport: SecurityEmergencyTransport;
  channelStatusTransport: ChannelStatusTransport;
  channelAuthorizationTransport: ChannelAuthorizationTransport;
  channelCatalogTransport: ChannelCatalogTransport;
  channelConfigReadTransport: ChannelConfigReadTransport;
  channelCredentialsTransport: ChannelCredentialsTransport;
  channelDeleteConfigTransport: ChannelDeleteConfigTransport;
  channelLoginTransport: ChannelLoginTransport;
  channelControlTransport: ChannelControlTransport;
  channelPairingTransport: ChannelPairingTransport;
  settingsDesiredTransport: SettingsDesiredTransport;
  securityPolicyTransport: SecurityPolicyTransport;
  securityRuleCatalogTransport: SecurityRuleCatalogTransport;
  cronTransport: CronTransport;
  taskManagerTransport: TaskManagerTransport;
  agentsTransport: AgentsTransport;
  teamPublicTransport: TeamPublicTransport;
  teamTaskBoardTransport: TeamTaskBoardTransport;
  teamRoleSessionsTransport: TeamRoleSessionsTransport;
  teamApprovalsTransport: TeamApprovalsTransport;
  teamGraphTransport: TeamGraphTransport;
  teamSkillTransport: TeamSkillTransport;
  teamTriggerTransport: TeamTriggerTransport;
  teamWebhookAuthTransport: TeamWebhookAuthTransport;
  teamLifecycleTransport: TeamLifecycleTransport;
  manualTeamTransport: ManualTeamTransport;
  teamHumanDecisionTransport: TeamHumanDecisionTransport;
  teamRoleChatTransport: TeamRoleChatTransport;
  providerAccountsTransport: ProviderAccountsTransport;
  providerCredentialStatusTransport: ProviderCredentialStatusTransport;
  providerModelsTransport: ProviderModelsTransport;
  externalConnectorsTransport: ExternalConnectorsTransport;
  openClawMcpServersTransport: OpenClawMcpServersTransport;
  providerRoutingTransport: ProviderRoutingTransport;
  clawHubSkillInstallTransport: ClawHubSkillInstallTransport;
  clawHubSkillSearchTransport: ClawHubSkillSearchTransport;
  skillBundleTransport: SkillBundleTransport;
  skillsManagementTransport: SkillsManagementTransport;
  sealedSkillsTransport: SealedSkillsTransport;
  pluginsTransport: PluginsTransport;
  matchaAgentHistoryTransport: MatchaAgentHistoryTransport;
  usageTransport: UsageTransport;
  runtimeDirectoryTransport: RuntimeEndpointDirectoryTransport;
}

export type RuntimeHostApiContext = Pick<HostApiContext, 'runtimeHost'>;

export type AppApiContext = Pick<HostApiContext, 'eventBus' | 'runtimeHost'>;

export type DiagnosticsApiContext = Pick<HostApiContext, 'runtimeHost' | 'diagnosticsArchiveTransport'>;

export type FileApiContext = Pick<
  HostApiContext,
  'workspaceTextTransport' | 'workspaceBinaryTransport' | 'workspaceDirectoryTransport' | 'workspaceWriteTransport'
>;

export type SessionApiContext = Pick<
  HostApiContext,
  | 'runtimeHost'
  | 'rendererEventRoutes'
  | 'sessionListTransport'
  | 'sessionTimelineTransport'
  | 'sessionContentTransport'
  | 'matchaSessionListTransport'
  | 'sessionAbortTransport'
  | 'sessionCreateTransport'
  | 'sessionDeleteTransport'
  | 'sessionRenameTransport'
  | 'sessionApprovalTransport'
  | 'sessionSendTransport'
  | 'sessionModelSelectionTransport'
  | 'sessionPermissionTransport'
  | 'workspaceMediaTransport'
  | 'providerRoutingTransport'
  | 'taskManagerTransport'
>;

export type ProductApiContext = Pick<
  HostApiContext,
  | 'cloudAccountService'
  | 'securityEmergencyTransport'
  | 'channelStatusTransport'
  | 'channelCatalogTransport'
  | 'channelConfigReadTransport'
  | 'channelCredentialsTransport'
  | 'channelDeleteConfigTransport'
  | 'channelLoginTransport'
  | 'channelControlTransport'
  | 'channelPairingTransport'
  | 'settingsDesiredTransport'
  | 'securityPolicyTransport'
  | 'securityRuleCatalogTransport'
  | 'cronTransport'
  | 'taskManagerTransport'
  | 'agentsTransport'
  | 'providerAccountsTransport'
  | 'providerModelsTransport'
  | 'providerRoutingTransport'
  | 'externalConnectorsTransport'
  | 'openClawMcpServersTransport'
  | 'clawHubSkillInstallTransport'
  | 'clawHubSkillSearchTransport'
  | 'skillBundleTransport'
  | 'skillsManagementTransport'
  | 'sealedSkillsTransport'
  | 'pluginsTransport'
  | 'usageTransport'
  | 'runtimeDirectoryTransport'
>;

export type CloudAccountApiContext = Pick<HostApiContext, 'cloudAccountService'>;

export type TeamApiContext = Pick<
  HostApiContext,
  | 'teamPublicTransport'
  | 'teamTaskBoardTransport'
  | 'teamRoleSessionsTransport'
  | 'teamApprovalsTransport'
  | 'teamGraphTransport'
  | 'teamSkillTransport'
  | 'teamTriggerTransport'
  | 'teamLifecycleTransport'
  | 'manualTeamTransport'
  | 'teamHumanDecisionTransport'
  | 'teamRoleChatTransport'
>;

export type ChatHistoryApiContext = Pick<HostApiContext, 'matchaAgentHistoryTransport'>;

export type LogApiContext = Record<never, never>;
