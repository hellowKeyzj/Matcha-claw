import type { ChannelConfigPort } from '../../application/channels/channel-runtime';
import type { ChannelActivationStrategyPort } from '../../application/channels/channel-activation-strategy';
import { ChannelLoginSessionService, type ChannelLoginRuntimePort } from '../../application/channels/channel-login-session-service';
import { OpenClawChannelLoginSessionService } from '../../application/adapters/openclaw/projections/openclaw-channel-login-session-service';
import { ChannelPairingService, type ChannelPairingRuntimeEnvironmentPort } from '../../application/channels/channel-pairing-service';
import {
  ACTIVATE_DIRECT_CHANNEL_JOB,
  DELETE_CHANNEL_CONFIG_JOB,
  PROBE_CHANNEL_SNAPSHOT_JOB,
  REFRESH_CHANNEL_SNAPSHOT_JOB,
  createChannelJobPort,
  type ChannelJobPort,
} from '../../application/channels/channel-jobs';
import { ChannelService } from '../../application/channels/service';
import { ChannelActivationWorkflow } from '../../application/workflows/channel-runtime/channel-activation-workflow';
import { ChannelConfigMutationWorkflow } from '../../application/workflows/channel-runtime/channel-config-mutation-workflow';
import { ChannelRuntimeWorkflow } from '../../application/workflows/channel-runtime/channel-runtime-workflow';
import { OpenClawWeixinAccountStoreWorkflow } from '../../application/adapters/openclaw/workflows/openclaw-channel/openclaw-weixin-account-store-workflow';
import { OpenClawCliCommandWorkflow } from '../../application/adapters/openclaw/workflows/openclaw-workspace/openclaw-cli-command-workflow';
import { OpenClawService } from '../../application/adapters/openclaw/openclaw-service';
import type { RuntimeHostRuntimeConfigPort, RuntimeHostWorkspaceBootstrapPort } from '../../application/runtime-host/bootstrap';
import {
  CAPABILITY_ROUTING_SERVICE_TOKEN,
  CHANNEL_SERVICE_TOKEN,
  CLAWHUB_SERVICE_TOKEN,
  OPENCLAW_SERVICE_TOKEN,
  PROVIDER_ACCOUNTS_SERVICE_TOKEN,
  PROVIDER_MODELS_SERVICE_TOKEN,
  SETTINGS_SERVICE_TOKEN,
  SKILLS_SERVICE_TOKEN,
  SUBAGENT_SERVICE_TOKEN,
} from '../runtime-host-tokens';
import type { GatewayPluginCapabilityPort } from '../../application/gateway/gateway-capability-service';
import type { GatewayChannelPort, GatewayChatPort, GatewayRuntimePort } from '../../application/gateway/gateway-runtime-port';
import { OpenClawRuntimeConfigService } from '../../application/adapters/openclaw/projections/openclaw-runtime-config-service';
import { SubagentTemplateService } from '../../application/adapters/openclaw/infrastructure/openclaw-subagent-template-service';
import { SubagentRuntimeService } from '../../application/subagents/service';
import { SubagentRuntimeWorkflow } from '../../application/workflows/subagent-runtime/subagent-runtime-workflow';
import {
  ClawHubService,
  type ClawHubRuntimePort,
  type ClawHubSkillInventory,
} from '../../application/skills/clawhub';
import {
  CLAWHUB_INSTALL_JOB,
  CLAWHUB_UNINSTALL_JOB,
  createClawHubJobPort,
  type ClawHubJobPort,
} from '../../application/skills/clawhub-jobs';
import type { ClawHubCliRunner } from '../../application/skills/clawhub-cli';
import type { ClawHubRegistryClient } from '../../application/skills/clawhub-registry-client';
import { SkillsService, type SkillsWorkspacePort } from '../../application/skills/service';
import { ClawHubSkillInstallWorkflow } from '../../application/workflows/skill-install/clawhub-skill-install-workflow';
import { LocalSkillImportWorkflow } from '../../application/workflows/skill-install/local-skill-import-workflow';
import { SkillBundleTransferWorkflow } from '../../application/workflows/skill-install/skill-bundle-transfer-workflow';
import { PreinstalledSkillsWorkflow } from '../../application/workflows/skill-install/preinstalled-skills-workflow';
import { SkillsOperationsWorkflow } from '../../application/workflows/skill-runtime/skills-operations-workflow';
import { SkillRuntimeWorkflow } from '../../application/workflows/skill-runtime/skill-runtime-workflow';
import {
  ENSURE_PREINSTALLED_SKILLS_JOB,
  IMPORT_LOCAL_SKILL_JOB,
  REFRESH_SKILL_STATUS_JOB,
  SYNC_SKILL_GATEWAY_UPDATE_JOB,
  createSkillsJobPort,
  type SkillsJobPort,
} from '../../application/skills/skills-jobs';
import { SettingsService } from '../../application/settings/service';
import { SettingsRuntimeConfigSyncWorkflow } from '../../application/workflows/settings-runtime-config/settings-runtime-config-sync-workflow';
import {
  SYNC_SETTINGS_RUNTIME_CONFIG_JOB,
  createSettingsJobPort,
  type SettingsJobPort,
} from '../../application/settings/settings-jobs';
import { ProviderAccountsService } from '../../application/providers/accounts';
import { ProviderAccountMutationWorkflow } from '../../application/workflows/provider-account/provider-account-mutation-workflow';
import { ProviderModelsOperationsWorkflow } from '../../application/workflows/provider-model/provider-models-operations-workflow';
import { ProviderModelsProjectionWorkflow } from '../../application/workflows/provider-model/provider-models-projection-workflow';
import { ProviderCapabilityRoutingWorkflow } from '../../application/workflows/provider-capability-routing/provider-capability-routing-workflow';
import { ProviderCapabilityRoutingStorePersistenceWorkflow } from '../../application/workflows/provider-capability-routing-store/provider-capability-routing-store-persistence-workflow';
import { ProviderModelsStorePersistenceWorkflow } from '../../application/workflows/provider-models-store/provider-models-store-persistence-workflow';
import { ProviderOAuthCompletionWorkflow } from '../../application/workflows/provider-oauth/provider-oauth-completion-workflow';
import { CapabilityRoutingApplicationService, type CapabilityRoutingProjectionPort } from '../../application/providers/capability-routing-service';
import { ProviderModelsApplicationService, type CustomMediaProviderProjectionPort, type ProviderModelsAgentIdentityPort, type ProviderModelsAgentProjectionPort, type ProviderModelsProjectionPort } from '../../application/providers/provider-models-service';
import {
  CREATE_PROVIDER_ACCOUNT_JOB,
  DELETE_PROVIDER_ACCOUNT_JOB,
  UPDATE_PROVIDER_ACCOUNT_JOB,
  createProviderAccountJobPort,
  type ProviderAccountJobPort,
} from '../../application/providers/provider-account-jobs';
import type { RuntimeClockPort, RuntimeHttpClientPort, RuntimeIdGeneratorPort } from '../../application/common/runtime-ports';
import type { RuntimeCommandExecutorPort } from '../../application/common/runtime-ports';
import type { OpenClawAuthProfileService } from '../../application/adapters/openclaw/infrastructure/openclaw-auth-profile-store';
import { ProviderOAuthCompletionService } from '../../application/providers/oauth-runtime';
import type { ProviderStoreRepository } from '../../application/providers/provider-store-repository';
import { ProviderModelsStoreRepository, type ProviderModelsStoragePort } from '../../application/providers/provider-models-store';
import { CapabilityRoutingStoreRepository, type CapabilityRoutingStoragePort } from '../../application/providers/capability-routing-store';
import type { RuntimeFileSystemPort } from '../../application/common/runtime-ports';
import type { ParentGatewayForwardEventName } from '../../shared/parent-transport-contracts';
import type { ApplicationServiceRegistry } from '../application-service-registry';
import type { RuntimeHostContainer } from '../container';
import {
  registerRuntimeJobDefinitions,
  type RuntimeJobDefinition,
  type RuntimeJobRegistry,
} from '../../core/jobs';
import {
  registerRuntimeLifecycleDefinitions,
  type RuntimeHostLifecycle,
} from '../../core/lifecycle';
import type { OpenClawConfigRepositoryPort } from '../../application/adapters/openclaw/infrastructure/openclaw-config-repository';
import type { OpenClawEnvironmentRepository } from '../../application/adapters/openclaw/infrastructure/openclaw-environment-repository';
import type { ProviderAccountsProjectionPort } from '../../application/providers/provider-accounts-projection-port';
import type { ProviderProjectionKeyResolverPort } from '../../application/providers/provider-store-model';
import type { ProviderProjectionPolicyPort } from '../../application/providers/provider-projection-sync-plan';
import type { RuntimePluginRepositoryPort } from '../../application/plugins/runtime-plugin-service';
import type { GatewayControlPort, ParentShellPort } from '../../application/runtime-host/parent-shell-port';
import type { RuntimeLongTaskSubmissionPort } from '../../application/runtime-host/runtime-task-ports';
import type { SettingsRepository } from '../../application/settings/store';
import type { SkillReadmePreviewRepository, SkillsConfigRepository } from '../../application/skills/store';
import { createSubagentManagementCapabilityOperationRoutes } from '../../application/capabilities/agent/subagent-management-capability';
import { createChannelIntegrationCapabilityOperationRoutes } from '../../application/capabilities/integration/channel-integration-capability';
import { createModelProviderCapabilityOperationRoutes } from '../../application/capabilities/model/model-provider-capability';
import { createSettingsRuntimeCapabilityOperationRoutes } from '../../application/capabilities/settings/settings-runtime-capability';
import { createSkillManagementCapabilityOperationRoutes } from '../../application/capabilities/skill/skill-management-capability';
import type { CapabilityOperationRoute } from '../../application/capabilities/contracts/capability-router';
import type { RuntimeHostLogger } from '../../shared/logger';

export function registerOpenClawApplicationServices(
  container: RuntimeHostContainer,
  facades: ApplicationServiceRegistry,
): void {
  container.register('openclaw.cliCommandWorkflow', (scope) => new OpenClawCliCommandWorkflow({
    environment: scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
  }));
  container.register('openclaw.service', (scope) => {
    const configRepository = scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository');
    const environmentRepository = scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository');
    const subagentTemplates = scope.resolve<SubagentTemplateService>('openclaw.subagentTemplateService');
    return new OpenClawService({
      config: configRepository,
      environment: environmentRepository,
      cliCommandWorkflow: scope.resolve<OpenClawCliCommandWorkflow>('openclaw.cliCommandWorkflow'),
      workspace: scope.resolve('openclaw.workspaceService'),
      subagentTemplates,
      providerSnapshot: scope.resolve('openclaw.providerSnapshotService'),
    });
  });
  container.register('channels.configMutationWorkflow', (scope) => new ChannelConfigMutationWorkflow({
    channelConfig: scope.resolve<ChannelConfigPort>('channels.configRepository'),
    parentShell: scope.resolve<ParentShellPort>('runtimeHost.parentShell'),
  }));
  container.register('channels.runtimeWorkflow', (scope) => new ChannelRuntimeWorkflow({
    gateway: scope.resolve<GatewayChannelPort>('gateway.runtime'),
    channelConfig: scope.resolve<ChannelConfigPort>('channels.configRepository'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('channels.activationWorkflow', (scope) => new ChannelActivationWorkflow({
    channelConfig: scope.resolve<ChannelConfigPort>('channels.configRepository'),
    loginSessions: scope.resolve('channels.loginSessionService'),
    jobs: scope.resolve<ChannelJobPort>('channels.jobs'),
    activationStrategy: scope.resolve<ChannelActivationStrategyPort>('channels.activationStrategy'),
  }));
  container.register('channels.service', (scope) => new ChannelService({
    channelConfig: scope.resolve<ChannelConfigPort>('channels.configRepository'),
    activationWorkflow: scope.resolve<ChannelActivationWorkflow>('channels.activationWorkflow'),
    configMutationWorkflow: scope.resolve<ChannelConfigMutationWorkflow>('channels.configMutationWorkflow'),
    runtimeWorkflow: scope.resolve<ChannelRuntimeWorkflow>('channels.runtimeWorkflow'),
    pairing: scope.resolve('channels.pairingService'),
    jobs: scope.resolve<ChannelJobPort>('channels.jobs'),
  }));
  container.register('channels.pairingService', (scope) => new ChannelPairingService(
    scope.resolve<ChannelPairingRuntimeEnvironmentPort>('channels.pairingRuntime'),
  ));
  container.register('channels.openclawWeixinAccountStoreWorkflow', (scope) => new OpenClawWeixinAccountStoreWorkflow({
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    runtime: scope.resolve<ChannelLoginRuntimePort>('channels.loginRuntime'),
  }));
  container.register('channels.openclawLoginSessionHandler', (scope) => new OpenClawChannelLoginSessionService({
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    runtime: scope.resolve<ChannelLoginRuntimePort>('channels.loginRuntime'),
    weixinAccounts: scope.resolve<OpenClawWeixinAccountStoreWorkflow>('channels.openclawWeixinAccountStoreWorkflow'),
    idGenerator: scope.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
    timer: scope.resolve('runtime.timer'),
    logger: scope.resolve<RuntimeHostLogger>('logger'),
    emitGatewayEvent: (eventName, payload) => {
      void scope.resolve<{ emit: (eventName: ParentGatewayForwardEventName, payload: unknown) => Promise<void> }>('runtimeHost.parentGatewayEvents').emit(eventName, payload).catch(() => undefined);
    },
    saveChannelConfig: async (payload) => {
      await scope.resolve<ChannelConfigPort>('channels.configRepository').saveChannelConfig(payload);
    },
    restartGateway: async () => {
      await scope.resolve<ParentShellPort>('runtimeHost.parentShell').request('gateway_restart');
    },
  }));
  container.register('channels.loginSessionService', (scope) => new ChannelLoginSessionService([
    scope.resolve('channels.openclawLoginSessionHandler'),
  ]));
  container.register('channels.jobs', (scope): ChannelJobPort => createChannelJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('providers.accountMutationWorkflow', (scope) => new ProviderAccountMutationWorkflow({
    store: scope.resolve<ProviderStoreRepository>('providers.storeRepository'),
    projection: scope.resolve<ProviderAccountsProjectionPort>('providers.accountsProjectionPort'),
    providerModels: scope.resolve<ProviderModelsApplicationService>('providers.modelsService'),
    capabilityRouting: scope.resolve<CapabilityRoutingApplicationService>('providers.capabilityRoutingService'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('providers.accountsService', (scope) => new ProviderAccountsService({
    store: scope.resolve<ProviderStoreRepository>('providers.storeRepository'),
    parentShell: scope.resolve<ParentShellPort>('runtimeHost.parentShell'),
    oauthCompletion: scope.resolve<ProviderOAuthCompletionService>('providers.oauthCompletionService'),
    projection: scope.resolve<ProviderAccountsProjectionPort>('providers.accountsProjectionPort'),
    mutations: scope.resolve<ProviderAccountMutationWorkflow>('providers.accountMutationWorkflow'),
    httpClient: scope.resolve<RuntimeHttpClientPort>('runtime.httpClient'),
    jobs: scope.resolve<ProviderAccountJobPort>('providers.jobs'),
    projectionKeys: scope.resolve<ProviderProjectionKeyResolverPort>('providers.projectionKeyResolver'),
  }));
  container.register('providers.capabilityRoutingStorePersistenceWorkflow', (scope) => new ProviderCapabilityRoutingStorePersistenceWorkflow({
    storage: scope.resolve<CapabilityRoutingStoragePort>('providers.capabilityRoutingStorage'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('providers.capabilityRoutingStore', (scope) => new CapabilityRoutingStoreRepository({
    persistenceWorkflow: scope.resolve<ProviderCapabilityRoutingStorePersistenceWorkflow>('providers.capabilityRoutingStorePersistenceWorkflow'),
  }));
  container.register('providers.capabilityRoutingWorkflow', (scope) => new ProviderCapabilityRoutingWorkflow({
    store: scope.resolve<CapabilityRoutingStoreRepository>('providers.capabilityRoutingStore'),
    credentials: scope.resolve<ProviderStoreRepository>('providers.storeRepository'),
    models: scope.resolve<ProviderModelsStoreRepository>('providers.modelsStore'),
    writer: scope.resolve<CapabilityRoutingProjectionPort>('providers.capabilityRoutingProjection'),
    projectionKeys: scope.resolve<ProviderProjectionKeyResolverPort>('providers.projectionKeyResolver'),
  }));
  container.register('providers.capabilityRoutingService', (scope) => new CapabilityRoutingApplicationService({
    routingWorkflow: scope.resolve<ProviderCapabilityRoutingWorkflow>('providers.capabilityRoutingWorkflow'),
  }));
  container.register('providers.modelsStorePersistenceWorkflow', (scope) => new ProviderModelsStorePersistenceWorkflow({
    storage: scope.resolve<ProviderModelsStoragePort>('providers.modelsStorage'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('providers.modelsStore', (scope) => new ProviderModelsStoreRepository({
    persistenceWorkflow: scope.resolve<ProviderModelsStorePersistenceWorkflow>('providers.modelsStorePersistenceWorkflow'),
  }));
  container.register('providers.modelsProjectionWorkflow', (scope) => new ProviderModelsProjectionWorkflow({
    store: scope.resolve<ProviderModelsStoreRepository>('providers.modelsStore'),
    credentials: scope.resolve<ProviderStoreRepository>('providers.storeRepository'),
    writer: scope.resolve<ProviderModelsProjectionPort>('providers.modelsProjection'),
    customMediaWriter: scope.resolve<CustomMediaProviderProjectionPort>('providers.customMediaProjection'),
    capabilityRouting: scope.resolve<CapabilityRoutingApplicationService>('providers.capabilityRoutingService'),
    authRepository: scope.resolve<ProviderModelsAgentIdentityPort>('providers.agentIdentityProjection'),
    agentModels: scope.resolve<ProviderModelsAgentProjectionPort>('providers.agentModelsProjection'),
    projectionKeys: scope.resolve<ProviderProjectionKeyResolverPort>('providers.projectionKeyResolver'),
    projectionPolicy: scope.resolve<ProviderProjectionPolicyPort>('providers.projectionPolicy'),
  }));
  container.register('providers.modelsOperationsWorkflow', (scope) => new ProviderModelsOperationsWorkflow({
    credentials: scope.resolve<ProviderStoreRepository>('providers.storeRepository'),
    projectionKeys: scope.resolve<ProviderProjectionKeyResolverPort>('providers.projectionKeyResolver'),
    projectionWorkflow: scope.resolve<ProviderModelsProjectionWorkflow>('providers.modelsProjectionWorkflow'),
  }));
  container.register('providers.modelsService', (scope) => new ProviderModelsApplicationService({
    operationsWorkflow: scope.resolve<ProviderModelsOperationsWorkflow>('providers.modelsOperationsWorkflow'),
  }));
  container.register('providers.jobs', (scope): ProviderAccountJobPort => createProviderAccountJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('providers.oauthCompletionWorkflow', (scope) => new ProviderOAuthCompletionWorkflow({
    storeRepository: scope.resolve<ProviderStoreRepository>('providers.storeRepository'),
    projection: scope.resolve<ProviderAccountsProjectionPort>('providers.accountsProjectionPort'),
    authProfiles: scope.resolve<OpenClawAuthProfileService>('openclaw.authProfileService'),
    projectionPolicy: scope.resolve<ProviderProjectionPolicyPort>('providers.projectionPolicy'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('providers.oauthCompletionService', (scope) => new ProviderOAuthCompletionService(
    scope.resolve<ProviderOAuthCompletionWorkflow>('providers.oauthCompletionWorkflow'),
  ));
  container.register('openclaw.runtimeConfigService', (scope) => new OpenClawRuntimeConfigService(
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
    scope.resolve('openclaw.oauthPluginRegistrationService'),
    scope.resolve('openclaw.environmentRepository'),
    scope.resolve('plugins.fileSystem'),
    scope.resolve<RuntimeHostLogger>('logger'),
  ));
  container.register('runtimeHost.runtimeConfig', (scope): RuntimeHostRuntimeConfigPort => scope.resolve<OpenClawRuntimeConfigService>('openclaw.runtimeConfigService'));
  container.register('runtimeHost.workspaceBootstrap', (scope): RuntimeHostWorkspaceBootstrapPort => scope.resolve('openclaw.workspaceService'));
  container.register('settings.runtimeConfigSyncWorkflow', (scope) => new SettingsRuntimeConfigSyncWorkflow({
    repository: scope.resolve<SettingsRepository>('settings.repository'),
    jobs: scope.resolve<SettingsJobPort>('settings.jobs'),
    runtimeConfig: scope.resolve<RuntimeHostRuntimeConfigPort>('runtimeHost.runtimeConfig'),
    runtimePlugins: scope.resolve<RuntimePluginRepositoryPort>('plugins.repository'),
    gatewayControl: scope.resolve<GatewayControlPort>('gateway.control'),
  }));
  container.register('settings.service', (scope) => new SettingsService({
    repository: scope.resolve<SettingsRepository>('settings.repository'),
    runtimeConfigSyncWorkflow: scope.resolve<SettingsRuntimeConfigSyncWorkflow>('settings.runtimeConfigSyncWorkflow'),
  }));
  container.register('settings.jobs', (scope): SettingsJobPort => createSettingsJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('skills.localImportWorkflow', (scope) => new LocalSkillImportWorkflow({
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    commandExecutor: scope.resolve<RuntimeCommandExecutorPort>('runtime.commandExecutor'),
    systemEnvironment: scope.resolve('runtime.systemEnvironment'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
    skillsRoot: () => scope.resolve<SkillsWorkspacePort>('skills.workspace').getSkillsDir(),
    logger: scope.resolve<RuntimeHostLogger>('logger'),
  }));
  container.register('skills.runtimeWorkflow', (scope) => new SkillRuntimeWorkflow({
    gateway: scope.resolve<GatewayRuntimePort>('gateway.runtime'),
    jobs: scope.resolve<SkillsJobPort>('skills.jobs'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
    repository: scope.resolve<SkillsConfigRepository>('skills.configRepository'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    workspace: scope.resolve<SkillsWorkspacePort>('skills.workspace'),
    logger: scope.resolve<RuntimeHostLogger>('logger'),
  }));
  container.register('skills.bundleTransferWorkflow', (scope) => new SkillBundleTransferWorkflow({
    repository: scope.resolve<SkillsConfigRepository>('skills.configRepository'),
    jobs: scope.resolve<SkillsJobPort>('skills.jobs'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    skillsRoot: () => scope.resolve<SkillsWorkspacePort>('skills.workspace').getSkillsDir(),
  }));
  container.register('skills.preinstalledWorkflow', (scope) => new PreinstalledSkillsWorkflow({
    repository: scope.resolve<SkillsConfigRepository>('skills.configRepository'),
    jobs: scope.resolve<SkillsJobPort>('skills.jobs'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    workspace: scope.resolve<SkillsWorkspacePort>('skills.workspace'),
    logger: scope.resolve<RuntimeHostLogger>('logger'),
  }));
  container.register('skills.operationsWorkflow', (scope) => new SkillsOperationsWorkflow({
    repository: scope.resolve<SkillsConfigRepository>('skills.configRepository'),
    readmePreviews: scope.resolve<SkillReadmePreviewRepository>('skills.readmePreviewRepository'),
    jobs: scope.resolve<SkillsJobPort>('skills.jobs'),
    skillRuntimeWorkflow: scope.resolve<SkillRuntimeWorkflow>('skills.runtimeWorkflow'),
    skillBundleTransferWorkflow: scope.resolve<SkillBundleTransferWorkflow>('skills.bundleTransferWorkflow'),
    localSkillImportWorkflow: scope.resolve<LocalSkillImportWorkflow>('skills.localImportWorkflow'),
    logger: scope.resolve<RuntimeHostLogger>('logger'),
  }));
  container.register('skills.service', (scope) => new SkillsService({
    operationsWorkflow: scope.resolve<SkillsOperationsWorkflow>('skills.operationsWorkflow'),
    skillRuntimeWorkflow: scope.resolve<SkillRuntimeWorkflow>('skills.runtimeWorkflow'),
    skillBundleTransferWorkflow: scope.resolve<SkillBundleTransferWorkflow>('skills.bundleTransferWorkflow'),
    preinstalledSkillsWorkflow: scope.resolve<PreinstalledSkillsWorkflow>('skills.preinstalledWorkflow'),
  }));
  container.register('skills.jobs', (scope): SkillsJobPort => createSkillsJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('subagents.runtimeWorkflow', (scope) => new SubagentRuntimeWorkflow({
    gateway: scope.resolve<GatewayChatPort>('gateway.runtime'),
    capabilities: scope.resolve<GatewayPluginCapabilityPort>('gateway.capabilities'),
    workspace: scope.resolve('openclaw.workspaceService'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('subagents.service', (scope) => new SubagentRuntimeService({
    runtimeWorkflow: scope.resolve<SubagentRuntimeWorkflow>('subagents.runtimeWorkflow'),
  }));
  container.register('clawhub.skillInstallWorkflow', (scope) => new ClawHubSkillInstallWorkflow({
    cliRunner: scope.resolve<ClawHubCliRunner>('clawhub.cliRunner'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    skillsRoot: () => scope.resolve<ClawHubSkillInventory>('clawhub.skillInventory').skillsRoot,
    lockFilePath: () => scope.resolve<ClawHubSkillInventory>('clawhub.skillInventory').lockFilePath,
  }));
  container.register('clawhub.service', (scope) => new ClawHubService({
    parentShell: scope.resolve<ParentShellPort>('runtimeHost.parentShell'),
    registryClient: scope.resolve<ClawHubRegistryClient>('clawhub.registryClient'),
    skillInstallWorkflow: scope.resolve<ClawHubSkillInstallWorkflow>('clawhub.skillInstallWorkflow'),
    skillInventory: scope.resolve<ClawHubSkillInventory>('clawhub.skillInventory'),
    runtime: scope.resolve<ClawHubRuntimePort>('clawhub.runtime'),
    commandExecutor: scope.resolve<RuntimeCommandExecutorPort>('runtime.commandExecutor'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    jobs: scope.resolve<ClawHubJobPort>('clawhub.jobs'),
  }));
  container.register('clawhub.jobs', (scope): ClawHubJobPort => createClawHubJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  registerOpenClawCapabilityOperationRoutes(container);
  facades.registerContainerFacade('openclaw', SETTINGS_SERVICE_TOKEN, container);
  facades.registerContainerFacade('openclaw', PROVIDER_ACCOUNTS_SERVICE_TOKEN, container);
  facades.registerContainerFacade('openclaw', CAPABILITY_ROUTING_SERVICE_TOKEN, container);
  facades.registerContainerFacade('openclaw', PROVIDER_MODELS_SERVICE_TOKEN, container);
  facades.registerContainerFacade('openclaw', CHANNEL_SERVICE_TOKEN, container);
  facades.registerContainerFacade('openclaw', OPENCLAW_SERVICE_TOKEN, container);
  facades.registerContainerFacade('openclaw', SKILLS_SERVICE_TOKEN, container);
  facades.registerContainerFacade('openclaw', SUBAGENT_SERVICE_TOKEN, container);
  facades.registerContainerFacade('openclaw', CLAWHUB_SERVICE_TOKEN, container);
}

function registerOpenClawCapabilityOperationRoutes(container: RuntimeHostContainer): void {
  container.contribute('agentRuntime.capabilityOperationRoutes', (scope): readonly CapabilityOperationRoute[] => [
    ...createSkillManagementCapabilityOperationRoutes({
      skillsService: scope.resolve<SkillsService>('skills.service'),
      clawHubService: scope.resolve<ClawHubService>('clawhub.service'),
    }),
    ...createChannelIntegrationCapabilityOperationRoutes({
      channelService: scope.resolve<ChannelService>('channels.service'),
    }),
    ...createSettingsRuntimeCapabilityOperationRoutes({
      settingsService: scope.resolve<SettingsService>('settings.service'),
    }),
    ...createModelProviderCapabilityOperationRoutes({
      providerAccountsService: scope.resolve<ProviderAccountsService>('providers.accountsService'),
      providerModelsService: scope.resolve<ProviderModelsApplicationService>('providers.modelsService'),
      capabilityRoutingService: scope.resolve<CapabilityRoutingApplicationService>('providers.capabilityRoutingService'),
    }),
    ...createSubagentManagementCapabilityOperationRoutes({
      subagentService: scope.resolve<SubagentRuntimeService>('subagents.service'),
    }),
  ]);
}

export function registerOpenClawApplicationJobs(
  container: RuntimeHostContainer,
  deps: {
    readonly jobRegistry: RuntimeJobRegistry;
  },
): void {
  registerRuntimeJobDefinitions(deps.jobRegistry, createOpenClawApplicationJobDefinitions(container));
}

function createOpenClawApplicationJobDefinitions(
  container: RuntimeHostContainer,
): readonly RuntimeJobDefinition[] {
  return [
    {
      type: ACTIVATE_DIRECT_CHANNEL_JOB,
      handler: async (payload) => {
        return await container.resolve<ChannelService>('channels.service').activateDirect(payload);
      },
    },
    {
      type: REFRESH_CHANNEL_SNAPSHOT_JOB,
      handler: async () => {
        return await container.resolve<ChannelService>('channels.service').refreshSnapshot();
      },
    },
    {
      type: PROBE_CHANNEL_SNAPSHOT_JOB,
      handler: async () => {
        return await container.resolve<ChannelService>('channels.service').probeSnapshot();
      },
    },
    {
      type: DELETE_CHANNEL_CONFIG_JOB,
      handler: async (payload) => {
        const body = readJobPayloadRecord(payload);
        const channelType = typeof body.channelType === 'string' ? body.channelType : '';
        if (!channelType) {
          throw new Error('channelType is required');
        }
        return await container.resolve<ChannelService>('channels.service').deleteConfigDirect(channelType);
      },
    },
    {
      type: SYNC_SETTINGS_RUNTIME_CONFIG_JOB,
      handler: async (payload) => {
        const body = readJobPayloadRecord(payload);
        const settings = body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)
          ? body.settings as Record<string, unknown>
          : {};
        return await container.resolve<SettingsService>('settings.service').executeRuntimeConfigSync({
          settings,
          syncProxy: body.syncProxy === true,
          syncBrowserMode: body.syncBrowserMode === true,
        });
      },
    },
    {
      type: SYNC_SKILL_GATEWAY_UPDATE_JOB,
      handler: async (payload) => {
        const body = readJobPayloadRecord(payload);
        const skillKey = typeof body.skillKey === 'string' ? body.skillKey : '';
        const updates = body.updates && typeof body.updates === 'object' && !Array.isArray(body.updates)
          ? body.updates as Record<string, unknown>
          : {};
        if (!skillKey) {
          throw new Error('skillKey is required');
        }
        return await container.resolve<SkillsService>('skills.service').executeGatewayUpdate(skillKey, updates);
      },
    },
    {
      type: REFRESH_SKILL_STATUS_JOB,
      handler: async () => {
        return await container.resolve<SkillsService>('skills.service').refreshStatus();
      },
    },
    {
      type: IMPORT_LOCAL_SKILL_JOB,
      handler: async (payload) => {
        return await container.resolve<SkillsService>('skills.service').executeImportLocal(payload);
      },
    },
    {
      type: ENSURE_PREINSTALLED_SKILLS_JOB,
      handler: async () => {
        return await container.resolve<SkillsService>('skills.service').executeEnsurePreinstalled();
      },
    },
    {
      type: CREATE_PROVIDER_ACCOUNT_JOB,
      handler: async (payload) => {
        return await container.resolve<ProviderAccountsService>('providers.accountsService').executeCreate(payload);
      },
    },
    {
      type: UPDATE_PROVIDER_ACCOUNT_JOB,
      handler: async (payload) => {
        const body = readJobPayloadRecord(payload);
        const accountId = typeof body.accountId === 'string' ? body.accountId : '';
        if (!accountId) {
          throw new Error('accountId is required');
        }
        return await container.resolve<ProviderAccountsService>('providers.accountsService').executeUpdate(
          accountId,
          body.payload,
        );
      },
    },
    {
      type: DELETE_PROVIDER_ACCOUNT_JOB,
      handler: async (payload) => {
        const body = readJobPayloadRecord(payload);
        const accountId = typeof body.accountId === 'string' ? body.accountId : '';
        if (!accountId) {
          throw new Error('accountId is required');
        }
        return await container.resolve<ProviderAccountsService>('providers.accountsService').executeDelete(
          accountId,
          body.apiKeyOnly === true,
        );
      },
    },
    {
      type: CLAWHUB_INSTALL_JOB,
      handler: async (payload) => {
        return await container.resolve<ClawHubService>('clawhub.service').executeInstall(readJobPayloadRecord(payload));
      },
    },
    {
      type: CLAWHUB_UNINSTALL_JOB,
      handler: async (payload) => {
        return await container.resolve<ClawHubService>('clawhub.service').executeUninstall(readJobPayloadRecord(payload));
      },
    },
  ];
}

function readJobPayloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

export function registerOpenClawApplicationLifecycle(
  container: RuntimeHostContainer,
  deps: {
    readonly lifecycle: RuntimeHostLifecycle;
  },
): void {
  registerRuntimeLifecycleDefinitions(deps.lifecycle, {
    backgroundServices: [
      {
        name: 'channels.snapshot-refresh',
        start: () => {
          container.resolve<ChannelJobPort>('channels.jobs').submitRefreshSnapshot();
        },
      },
      {
        name: 'skills.status-refresh',
        start: () => {
          void container.resolve<SkillsService>('skills.service').status();
        },
      },
      {
        name: 'skills.preinstalled-ensure',
        start: () => {
          container.resolve<SkillsJobPort>('skills.jobs').submitEnsurePreinstalled();
        },
      },
    ],
  });
}
