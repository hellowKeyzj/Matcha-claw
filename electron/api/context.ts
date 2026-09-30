import type { RendererEventRouteRegistry } from '../main/renderer-event-routes';
import type { HostEventBus } from './event-bus';
import type { RuntimeHostTransports } from '../main/runtime-host-delivery/transport/host-api-transports';
import type { ProviderCredentialStatusTransport } from '../main/ipc/provider-private-auth';
import type { RemoteFleetCredentialWriteAdapter } from '../main/ipc/fleet-private';
import type { CloudAccountService } from '../main/cloud-account/service';

export type { RuntimeHostLifecycle } from '../main/runtime-host-delivery/lifecycle-owner';
import type { RuntimeHostLifecycle } from '../main/runtime-host-delivery/lifecycle-owner';

export type RuntimeHostTransportContext<K extends keyof RuntimeHostTransports> = Readonly<{
  runtimeHostTransports: Pick<RuntimeHostTransports, K>;
}>;

export interface HostApiContext {
  cloudAccountService?: CloudAccountService;
  eventBus: HostEventBus;
  runtimeHost: RuntimeHostLifecycle;
  rendererEventRoutes: RendererEventRouteRegistry;
  runtimeHostTransports: RuntimeHostTransports;
  providerCredentialStatusTransport: ProviderCredentialStatusTransport;
  credentialWriteAdapter?: RemoteFleetCredentialWriteAdapter;
}

export type RuntimeHostApiContext = Pick<HostApiContext, 'runtimeHost'>;

export type AppApiContext = Pick<HostApiContext, 'eventBus' | 'runtimeHost'>;

export type DiagnosticsApiContext = Pick<HostApiContext, 'runtimeHost'> & RuntimeHostTransportContext<'diagnosticsArchiveTransport'>;

export type FileApiContext = RuntimeHostTransportContext<
  'workspaceTextTransport' | 'workspaceBinaryTransport' | 'workspaceDirectoryTransport' | 'workspaceWriteTransport'
>;

export type SessionApiContext = Pick<HostApiContext, 'runtimeHost' | 'rendererEventRoutes'> & RuntimeHostTransportContext<
  | 'sessionListTransport'
  | 'sessionTimelineTransport'
  | 'sessionContentTransport'
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

export type ProductApiContext = Pick<HostApiContext, 'cloudAccountService'> & RuntimeHostTransportContext<
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
  | 'sealedResourceAuthorizationTransport'
  | 'pluginsTransport'
  | 'usageTransport'
  | 'runtimeDirectoryTransport'
>;

export type CloudAccountApiContext = Pick<HostApiContext, 'cloudAccountService'>;

export type TeamApiContext = RuntimeHostTransportContext<
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
>;

export type SessionHistoryApiContext = RuntimeHostTransportContext<'sessionHistoryTransport'>;

export type LogApiContext = Record<never, never>;
