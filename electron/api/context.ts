import type { RendererSessionObservationRegistry } from '../main/sessions/observations';
import type { RuntimeStatusProjection } from '../main/runtime-host-delivery/status';
import type { HostEventBus } from './event-bus';
import type { RuntimeHostTransports } from '../main/runtime-host-delivery/transport/host-api-transports';
import type { ProviderCredentialStatusTransport } from '../main/providers/private-auth';
import type { RemoteFleetCredentialWriteAdapter } from '../main/runtime-host-delivery/transport/fleet-credentials';
import type { CloudAccountService } from '../main/cloud-account/service';
import type { LicenseService } from '../main/license/service';
import type { ApplicationPluginOwner } from '../main/app-plugins/owner';
import type { AppPluginAgentGateway } from '../main/app-plugins/agent-gateway';
import type { AppPluginHost } from '../main/app-plugins/host';
import type { ChannelAuthorizationActions } from '../main/channels/authorization';
import type { AppTextModelRequest, AppTextModelResult } from '../../src/types/desktop/app-plugin-sdk';

export type { RuntimeHostLifecycle } from '../main/runtime-host-delivery/lifecycle-owner';
import type { RuntimeHostLifecycle } from '../main/runtime-host-delivery/lifecycle-owner';

export type RuntimeHostTransportContext<K extends keyof RuntimeHostTransports> = Readonly<{
  runtimeHostTransports: Pick<RuntimeHostTransports, K>;
}>;

export interface HostApiContext {
  licenseService: LicenseService;
  cloudAccountService?: CloudAccountService;
  appPlugins: ApplicationPluginOwner;
  appPluginHost: AppPluginHost;
  appPluginAgentGateway: Promise<AppPluginAgentGateway>;
  eventBus: HostEventBus;
  runtimeHost: RuntimeHostLifecycle;
  runtimeStatus: RuntimeStatusProjection;
  channelAuthorization: ChannelAuthorizationActions;
  generatePluginText(request: AppTextModelRequest, signal: AbortSignal): Promise<AppTextModelResult>;
  sessionObservers: RendererSessionObservationRegistry;
  runtimeHostTransports: RuntimeHostTransports;
  providerCredentialStatusTransport: ProviderCredentialStatusTransport;
  credentialWriteAdapter?: RemoteFleetCredentialWriteAdapter;
}

export type MainHostApiContext = Pick<HostApiContext,
  'licenseService' | 'cloudAccountService' | 'appPlugins' | 'appPluginHost' | 'appPluginAgentGateway' | 'eventBus' | 'sessionObservers'
>;

export type RuntimeHostApiDependencies = Omit<HostApiContext, keyof MainHostApiContext> & Readonly<{
  runtimeHostTransportPort: number;
}>;

export type HostApiServerContext = MainHostApiContext & Readonly<{
  runtime: Promise<RuntimeHostApiDependencies>;
  signal: AbortSignal;
}>;

export type RuntimeHostApiContext = Pick<HostApiContext, 'runtimeHost' | 'runtimeStatus'>;

export type AppApiContext = Pick<HostApiContext, 'eventBus' | 'runtimeStatus' | 'generatePluginText'>;

export type DiagnosticsApiContext = Pick<HostApiContext, 'runtimeHost' | 'runtimeStatus'> & RuntimeHostTransportContext<'diagnosticsArchiveTransport'>;

export type FileApiContext = RuntimeHostTransportContext<
  'workspaceTextTransport' | 'workspaceBinaryTransport' | 'workspaceDirectoryTransport' | 'workspaceWriteTransport' | 'workspaceWriteBinaryTransport'
>;

export type SessionApiContext = Pick<HostApiContext, 'runtimeHost' | 'sessionObservers'> & RuntimeHostTransportContext<
  | 'sessionListTransport'
  | 'sessionTimelineTransport'
  | 'sessionObservationTransport'
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
  | 'workspaceSessionImagesTransport'
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
