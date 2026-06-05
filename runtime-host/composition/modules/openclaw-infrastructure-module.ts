import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SubagentTemplateService } from '../../application/adapters/openclaw/infrastructure/openclaw-subagent-template-service';
import { OpenClawSubagentTemplateWorkflow } from '../../application/adapters/openclaw/workflows/openclaw-workspace/openclaw-subagent-template-workflow';
import { OpenClawEnvironmentRepository } from '../../application/adapters/openclaw/infrastructure/openclaw-environment-repository';
import { OpenClawAgentModelRepository } from '../../application/adapters/openclaw/infrastructure/openclaw-agent-model-repository';
import { OpenClawAgentModelStoreWorkflow } from '../../application/adapters/openclaw/workflows/openclaw-auth/openclaw-agent-model-store-workflow';
import { OpenClawAuthProfileWorkflow } from '../../application/adapters/openclaw/workflows/openclaw-auth/openclaw-auth-profile-workflow';
import { OpenClawConfigRepository, type OpenClawConfigRepositoryPort } from '../../application/adapters/openclaw/infrastructure/openclaw-config-repository';
import { OpenClawAuthProfileService } from '../../application/adapters/openclaw/infrastructure/openclaw-auth-profile-store';
import { OpenClawAuthRepository } from '../../application/adapters/openclaw/infrastructure/openclaw-auth-store';
import { OpenClawAuthStoreWorkflow } from '../../application/adapters/openclaw/workflows/openclaw-auth/openclaw-auth-store-workflow';
import { OpenClawOAuthPluginRegistrationService } from '../../application/adapters/openclaw/projections/openclaw-oauth-plugin-registration';
import { OpenClawProviderConfigService } from '../../application/adapters/openclaw/projections/openclaw-provider-config-service';
import { OpenClawProviderSnapshotService } from '../../application/adapters/openclaw/projections/openclaw-provider-snapshot';
import { OpenClawProviderConfigWorkflow } from '../../application/adapters/openclaw/workflows/openclaw-provider/openclaw-provider-config-workflow';
import { OpenClawCapabilityRoutingService } from '../../application/adapters/openclaw/projections/openclaw-capability-routing-service';
import { OpenClawCapabilityRoutingProjectionWorkflow } from '../../application/adapters/openclaw/workflows/openclaw-capability-routing-projection-workflow';
import { OpenClawProviderModelsService } from '../../application/adapters/openclaw/projections/openclaw-provider-models-service';
import { OpenClawProviderModelsProjectionWorkflow } from '../../application/adapters/openclaw/workflows/openclaw-provider/openclaw-provider-models-projection-workflow';
import { OpenClawCustomMediaPluginConfigService } from '../../application/adapters/openclaw/projections/openclaw-custom-media-plugin-config-service';
import { OpenClawCustomMediaPluginConfigWorkflow } from '../../application/adapters/openclaw/workflows/openclaw-provider/openclaw-custom-media-plugin-config-workflow';
import { OpenClawSecurityPluginConfigService } from '../../application/adapters/openclaw/projections/openclaw-security-plugin-config-service';
import { OpenClawSecurityPluginConfigWorkflow } from '../../application/adapters/openclaw/workflows/openclaw-security-plugin-config-workflow';
import { OpenClawWorkspaceService } from '../../application/adapters/openclaw/infrastructure/openclaw-workspace-service';
import { OpenClawWorkspaceMaintenanceWorkflow } from '../../application/adapters/openclaw/workflows/openclaw-workspace/openclaw-workspace-maintenance-workflow';
import { OpenClawWorkspaceQueryWorkflow } from '../../application/adapters/openclaw/workflows/openclaw-workspace/openclaw-workspace-query-workflow';
import { OpenClawEnvironmentConfigFileWorkflow } from '../../application/adapters/openclaw/workflows/openclaw-workspace/openclaw-environment-config-file-workflow';
import { OpenClawEnvironmentStatusWorkflow } from '../../application/adapters/openclaw/workflows/openclaw-workspace/openclaw-environment-status-workflow';
import { OpenClawRuntimeDataLayout } from '../../application/adapters/openclaw/infrastructure/openclaw-runtime-data-layout';
import { OpenClawRuntimeDriver, type OpenClawRuntimeBridge } from '../../application/adapters/openclaw/runtime/openclaw-runtime-driver';
import { OpenClawProviderAccountsProjectionPort } from '../../application/adapters/openclaw/projections/openclaw-provider-accounts-projection-port';
import type { ProviderProjectionKeyResolverPort } from '../../application/providers/provider-store-model';
import type { ProviderProjectionPolicyPort } from '../../application/providers/provider-projection-sync-plan';
import type { CapabilityRoutingProjectionPort } from '../../application/providers/capability-routing-service';
import type {
  CustomMediaProviderProjectionPort,
  ProviderModelsAgentIdentityPort,
  ProviderModelsAgentProjectionPort,
  ProviderModelsProjectionPort,
} from '../../application/providers/provider-models-service';
import type { RuntimeAdapterRegistrationFactory, RuntimeEndpointId } from '../../application/agent-runtime/contracts/runtime-endpoint-types';
import { OPENCLAW_RUNTIME_ENDPOINT_ID } from '../../application/adapters/openclaw/runtime/openclaw-runtime-identity';
import { OpenClawRuntimeAdapter } from '../../application/adapters/openclaw/runtime/openclaw-runtime-adapter';
import { ProviderProjectionSyncService } from '../../application/providers/store-sync';
import { ProviderProjectionSyncWorkflow } from '../../application/workflows/provider-projection-sync/provider-projection-sync-workflow';
import { ProviderStorePersistenceWorkflow } from '../../application/workflows/provider-store/provider-store-persistence-workflow';
import { ProviderStoreRepository, type ProviderStoreStoragePort } from '../../application/providers/provider-store-repository';
import type { ChannelActivationStrategyPort } from '../../application/channels/channel-activation-strategy';
import { ChannelConfigRepository, type ChannelConfigProjectionPort, type ChannelPluginConfigProjectionPort, type ChannelPluginProvisionerPort } from '../../application/channels/channel-runtime';
import { ChannelConfigWorkflow } from '../../application/workflows/channel-runtime/channel-config-workflow';
import { OpenClawChannelConfigProjection, OpenClawChannelPluginProjection } from '../../application/adapters/openclaw/projections/openclaw-channel-config-projection';
import type { PrelaunchChannelPluginProjectionPort } from '../../application/runtime-host/prelaunch-plugin-maintenance';
import type { ChannelLoginRuntimePort } from '../../application/channels/channel-login-session-service';
import type { ChannelPairingRuntimeEnvironmentPort } from '../../application/channels/channel-pairing-service';
import { SettingsRepository, type SettingsStoreEnvironmentPort } from '../../application/settings/store';
import { SettingsStoreWorkflow } from '../../application/workflows/settings-store/settings-store-workflow';
import type { CronDeliveryChannelProjectionPort } from '../../application/cron/cron-model';
import type { CronRuntimeDataPort } from '../../application/cron/cron-session-history';
import type { FileRuntimeDataStorePort } from '../../application/files/file-service';
import type { SecurityPluginConfigProjectionPort } from '../../application/security/security-plugin-config-applier';
import type { SecurityPolicyStoragePort } from '../../application/security/security-policy-store';
import type { SessionConfigDirectoryPort, SessionExternalArtefactResolverPort } from '../../application/sessions/session-storage-repository';
import type { SessionDefaultModelResolverPort } from '../../application/sessions/session-metadata-repository';
import { OpenClawSessionArtefactResolver } from '../../application/adapters/openclaw/runtime/openclaw-session-artefact-resolver';
import { OpenClawSessionMetadataResolver } from '../../application/adapters/openclaw/runtime/openclaw-session-metadata-resolver';
import type { TaskWorkspacePort } from '../../application/workflows/task-runtime/task-runtime-workflow';
import type { TeamRuntimeStorageRootPort } from '../../application/team-runtime/service';
import type { ToolchainUvRuntimePort } from '../../application/toolchain/uv-service';
import type { TokenUsageRuntimeDataPort, TokenUsageTranscriptLayoutPort } from '../../application/usage/token-usage-history';
import type { DiagnosticsRuntimeBundleLayoutPort } from '../../application/support/diagnostics-bundle';
import type { PrelaunchMaintenanceCacheStoragePort } from '../../application/runtime-host/prelaunch-maintenance-cache';
import type { PrelaunchPluginMaintenanceRuntimePort } from '../../application/runtime-host/prelaunch-plugin-maintenance';
import type { RuntimeHostEnvironmentPort } from '../../application/runtime-host/service';
import { SkillReadmePreviewRepository, SkillsConfigRepository } from '../../application/skills/store';
import { ClawHubSkillInventory, type ClawHubRuntimePort, type ClawHubSkillInventoryStoragePort } from '../../application/skills/clawhub';
import type { SkillsWorkspacePort } from '../../application/skills/service';
import { ClawHubCliRunner, type ClawHubCliRuntimePort } from '../../application/skills/clawhub-cli';
import { ClawHubRegistryClient, type ClawHubRegistryRuntimePort } from '../../application/skills/clawhub-registry-client';
import { OpenClawManagedPluginInstaller, type OpenClawManagedPluginInstallLocationPort } from '../../application/adapters/openclaw/projections/openclaw-managed-plugin-installer';
import { OpenClawInjectedPluginCatalogPlatformPolicy } from '../../application/adapters/openclaw/projections/openclaw-injected-plugin-catalog-platform-policy';
import { OpenClawManagedPluginCatalog } from '../../application/adapters/openclaw/projections/openclaw-managed-plugin-catalog';
import type { PluginCompanionSkillWorkspacePort } from '../../application/plugins/plugin-companion-skill-service';
import type { RuntimePluginCatalogProjectionPort, RuntimePluginConfigProjectionPort, RuntimePluginConfigStorePort } from '../../application/plugins/runtime-plugin-service';
import { NodePluginFileSystem } from '../plugin-file-system-adapter';
import {
  applyManuallyManagedPluginIdsToOpenClawConfig,
  readManuallyManagedPluginIdsFromConfig,
  resolveEffectivePluginIdsForConfig,
} from '../../application/adapters/openclaw/projections/openclaw-plugin-config-service';
import {
  getLegacyOpenClawProviderKeys,
  getOAuthApiKeyEnv,
  getOAuthProviderApi,
  getOAuthProviderDefaultBaseUrl,
  getOAuthProviderTokenKey,
  getOpenClawProviderKeyForType,
  normalizeOAuthBaseUrl,
  usesOAuthAuthHeader,
} from '../../application/adapters/openclaw/projections/openclaw-provider-projection-rules';
import type { RuntimeHostContainer } from '../container';
import { createOpenClawBridge, type OpenClawGatewayClient } from '../../openclaw-bridge';
import type { GatewayBridgeRuntimeDataPort, GatewayBridgeSettingsPort, GatewayRuntimeFactoryPort } from './gateway-bridge-module';
import type { AgentRuntimeDriverFactoryPort } from './platform-runtime-module';
import type {
  RuntimeCommandExecutorPort,
  RuntimeClockPort,
  RuntimeFileSystemPort,
  RuntimeHttpClientPort,
  RuntimeIdGeneratorPort,
  RuntimeProcessInfoPort,
  RuntimeSystemEnvironmentPort,
} from '../../application/common/runtime-ports';
import type { RuntimeHostLogger } from '../../shared/logger';

function createSettingsStoreEnvironmentPort(environment: OpenClawEnvironmentRepository): SettingsStoreEnvironmentPort {
  return {
    getRuntimeHostSettingsFilePath: () => environment.getRuntimeHostSettingsFilePath(),
    getSystemLocaleCandidates: () => environment.getSystemLocaleCandidates(),
    ensureParentDir: (filePath) => environment.ensureParentDir(filePath),
  };
}

function createProviderStoreStoragePort(environment: OpenClawEnvironmentRepository): ProviderStoreStoragePort {
  return {
    getProviderStoreFilePath: () => environment.getProviderStoreFilePath(),
    ensureParentDir: (filePath) => environment.ensureParentDir(filePath),
  };
}

function createGatewayBridgeSettingsPort(settingsRepository: SettingsRepository): GatewayBridgeSettingsPort {
  return {
    readGatewayToken: async () => {
      const settings = await settingsRepository.getAll();
      return typeof settings.gatewayToken === 'string' ? settings.gatewayToken : '';
    },
  };
}

function createCapabilityRoutingStoragePort(environment: OpenClawEnvironmentRepository) {
  return {
    getCapabilityRoutingStoreFilePath: () => environment.getCapabilityRoutingStoreFilePath(),
    ensureParentDir: (filePath: string) => environment.ensureParentDir(filePath),
  };
}

function createProviderModelsStoragePort(environment: OpenClawEnvironmentRepository) {
  return {
    getProviderModelsStoreFilePath: () => environment.getProviderModelsStoreFilePath(),
    ensureParentDir: (filePath: string) => environment.ensureParentDir(filePath),
  };
}

function createRuntimeHostEnvironmentPort(environment: OpenClawEnvironmentRepository): RuntimeHostEnvironmentPort {
  return {
    getRuntimeDataRootDir: () => environment.getOpenClawConfigDir(),
  };
}

function createGatewayBridgeRuntimeDataPort(environment: OpenClawEnvironmentRepository): GatewayBridgeRuntimeDataPort {
  return {
    getRuntimeHostDataDir: () => environment.getRuntimeHostDataDir(),
  };
}

function createPrelaunchMaintenanceCacheStoragePort(
  environment: OpenClawEnvironmentRepository,
): PrelaunchMaintenanceCacheStoragePort {
  return {
    getRuntimeHostDataDir: () => environment.getRuntimeHostDataDir(),
  };
}

function createPrelaunchPluginMaintenanceRuntimePort(
  environment: OpenClawEnvironmentRepository,
): PrelaunchPluginMaintenanceRuntimePort {
  return {
    getRuntimeDataRootDir: () => environment.getOpenClawConfigDir(),
    getRuntimeDistributionDir: () => environment.getOpenClawDirPath(),
    getWorkingDir: () => environment.getWorkingDir(),
  };
}

function createSessionConfigDirectoryPort(workspace: OpenClawWorkspaceService): SessionConfigDirectoryPort {
  return {
    getConfigDir: () => workspace.getConfigDir(),
  };
}

function createOperationsRuntimeDataRootPort(workspace: OpenClawWorkspaceService): CronRuntimeDataPort {
  return {
    getRuntimeDataRootDir: () => workspace.getConfigDir(),
  };
}

function createOperationsTaskWorkspacePort(workspace: OpenClawWorkspaceService): TaskWorkspacePort {
  return {
    getWorkspaceDirForSession: (sessionKey) => workspace.getWorkspaceDirForSession(sessionKey),
  };
}

function createOpenClawConfigRuntimeDataPort(configRepository: OpenClawConfigRepositoryPort): CronRuntimeDataPort {
  return {
    getRuntimeDataRootDir: () => configRepository.getConfigDir(),
  };
}

function createFileRuntimeDataStorePort(environment: OpenClawEnvironmentRepository): FileRuntimeDataStorePort {
  return {
    getRuntimeDataRootDir: () => environment.getOpenClawConfigDir(),
  };
}

function createToolchainUvRuntimePort(environment: OpenClawEnvironmentRepository): ToolchainUvRuntimePort {
  return {
    getPlatform: () => environment.getPlatform(),
    getBundledUvPathCandidates: () => environment.getBundledUvPathCandidates(),
  };
}

function createChannelPairingRuntimeEnvironmentPort(
  environment: OpenClawEnvironmentRepository,
): ChannelPairingRuntimeEnvironmentPort {
  const runtimeRequire = createRequire(join(environment.getOpenClawDirPath(), 'package.json'));
  return {
    getConversationRuntimeEnv: () => ({
      ...environment.getProcessEnv(),
      OPENCLAW_CONFIG_DIR: environment.getOpenClawConfigDir(),
    }),
    getConversationRuntimeModuleUrl: () => pathToFileURL(
      runtimeRequire.resolve('openclaw/plugin-sdk/conversation-runtime'),
    ).href,
  };
}

function createChannelLoginRuntimePort(environment: OpenClawEnvironmentRepository): ChannelLoginRuntimePort {
  return {
    getEnv: (name) => environment.getEnv(name),
    getRuntimeDataRootDir: () => environment.getOpenClawConfigDir(),
    resolveRuntimeModulePath: (specifier) => {
      const runtimeRequire = createRequire(join(environment.getOpenClawDirPath(), 'package.json'));
      return runtimeRequire.resolve(specifier);
    },
  };
}

function createClawHubRuntimePort(environment: OpenClawEnvironmentRepository): ClawHubRuntimePort {
  return {
    getPlatform: () => environment.getPlatform(),
  };
}

function createOpenClawSkillsWorkspacePort(deps: {
  readonly workspace: OpenClawWorkspaceService;
  readonly environment: OpenClawEnvironmentRepository;
}): SkillsWorkspacePort {
  const { workspace, environment } = deps;
  const resourcesPath = environment.getResourcesPath();
  return {
    getSkillsDir: () => workspace.getSkillsDir(),
    getBuiltinVisibleSkillsManifestCandidates: () => [
      resourcesPath ? join(resourcesPath, 'resources', 'skills', 'builtin-visible-skills.json') : '',
      resourcesPath ? join(resourcesPath, 'skills', 'builtin-visible-skills.json') : '',
      join(environment.getWorkingDir(), 'resources', 'skills', 'builtin-visible-skills.json'),
    ].filter((item) => item.trim().length > 0),
    getBuiltinSkillRootCandidates: () => [...new Set([
      join(environment.getOpenClawDirPath(), 'skills'),
      join(environment.getWorkingDir(), 'build', 'openclaw', 'skills'),
      resourcesPath ? join(resourcesPath, 'openclaw', 'skills') : '',
      resourcesPath ? join(resourcesPath, 'app.asar.unpacked', 'openclaw', 'skills') : '',
      resourcesPath ? join(resourcesPath, 'app.asar.unpacked', 'build', 'openclaw', 'skills') : '',
    ].filter((item) => item.trim().length > 0))],
    getPreinstalledManifestCandidates: () => [
      resourcesPath ? join(resourcesPath, 'resources', 'skills', 'preinstalled-manifest.json') : '',
      resourcesPath ? join(resourcesPath, 'skills', 'preinstalled-manifest.json') : '',
      join(environment.getWorkingDir(), 'resources', 'skills', 'preinstalled-manifest.json'),
    ].filter((item) => item.trim().length > 0),
    getPreinstalledSourceRootCandidates: () => [
      resourcesPath ? join(resourcesPath, 'preinstalled-skills') : '',
      resourcesPath ? join(resourcesPath, 'resources', 'preinstalled-skills') : '',
      join(environment.getWorkingDir(), 'build', 'preinstalled-skills'),
    ].filter((item) => item.trim().length > 0),
  };
}

function createClawHubSkillInventoryStoragePort(configRepository: OpenClawConfigRepositoryPort): ClawHubSkillInventoryStoragePort {
  return {
    getSkillsRootDir: () => join(configRepository.getConfigDir(), 'skills'),
    getLockFilePath: () => join(configRepository.getConfigDir(), '.clawhub', 'lock.json'),
  };
}

function createPluginCompanionSkillWorkspacePort(deps: {
  readonly environment: OpenClawEnvironmentRepository;
  readonly configRepository: OpenClawConfigRepositoryPort;
}): PluginCompanionSkillWorkspacePort {
  return {
    getCompanionSkillRootCandidates: () => deps.environment.getCompanionSkillRootCandidates(),
    getSkillsRootDir: () => join(deps.configRepository.getConfigDir(), 'skills'),
  };
}

function createOpenClawManagedPluginInstallLocationPort(deps: {
  readonly environment: OpenClawEnvironmentRepository;
  readonly configRepository: OpenClawConfigRepositoryPort;
}): OpenClawManagedPluginInstallLocationPort {
  return {
    getManagedPluginRegistryRootCandidates: () => deps.environment.getManagedPluginRegistryRootCandidates(),
    getExtensionsRootDir: () => join(deps.configRepository.getConfigDir(), 'extensions'),
  };
}

function createClawHubRegistryRuntimePort(environment: OpenClawEnvironmentRepository): ClawHubRegistryRuntimePort {
  return {
    getClawHubRegistryBases: () => environment.getClawHubRegistryBases(),
    getRuntimeHostSettingsFilePath: () => environment.getRuntimeHostSettingsFilePath(),
  };
}

function createClawHubCliRuntimePort(deps: {
  readonly configRepository: OpenClawConfigRepositoryPort;
  readonly environment: OpenClawEnvironmentRepository;
}): ClawHubCliRuntimePort {
  return {
    getCliEntryCandidates: () => deps.environment.getClawHubCliEntryCandidates(),
    getProcessEnv: () => deps.environment.getProcessEnv(),
    getWorkDir: () => deps.configRepository.getConfigDir(),
  };
}

function createRuntimePluginConfigProjectionPort(deps: {
  readonly configRepository: OpenClawConfigRepositoryPort;
  readonly pluginFileSystem: NodePluginFileSystem;
}): RuntimePluginConfigProjectionPort {
  return {
    readManuallyManagedPluginIds: async (config) => await readManuallyManagedPluginIdsFromConfig(
      deps.configRepository,
      deps.pluginFileSystem,
      config,
    ),
    applyManuallyManagedPluginIds: async (config, manualPluginIds) => await applyManuallyManagedPluginIdsToOpenClawConfig(
      deps.configRepository,
      deps.pluginFileSystem,
      config,
      manualPluginIds,
    ),
    resolveEffectivePluginIds: (config, manualPluginIds) => resolveEffectivePluginIdsForConfig(config, manualPluginIds),
  };
}

function createChannelPluginConfigProjectionPort(deps: {
  readonly configRepository: OpenClawConfigRepositoryPort;
  readonly pluginFileSystem: NodePluginFileSystem;
}): ChannelPluginConfigProjectionPort {
  return {
    reconcileChannelDerivedPluginState: async (config) => await applyManuallyManagedPluginIdsToOpenClawConfig(
      deps.configRepository,
      deps.pluginFileSystem,
      config,
      await readManuallyManagedPluginIdsFromConfig(deps.configRepository, deps.pluginFileSystem, config),
    ),
  };
}

function createChannelPluginProvisionerPort(installer: OpenClawManagedPluginInstaller): ChannelPluginProvisionerPort {
  const catalog = new OpenClawManagedPluginCatalog();
  return {
    ensureChannelPluginInstalled: async (pluginId, options) => {
      const definition = catalog.findChannelDefinition(pluginId);
      if (!definition) {
        return;
      }
      await installer.ensureDefinitionInstalled(definition, options);
    },
  };
}

function createRuntimeAdapterRegistrationFactory(): RuntimeAdapterRegistrationFactory {
  return {
    create: () => [new OpenClawRuntimeAdapter()],
  };
}

function createOpenClawProviderProjectionKeyResolver(): ProviderProjectionKeyResolverPort {
  return {
    resolveProviderKey: ({ vendorId, accountId }) => getOpenClawProviderKeyForType(vendorId, accountId),
  };
}

function createOpenClawProviderProjectionPolicy(): ProviderProjectionPolicyPort {
  return {
    getReplaceProviderKeys: ({ vendorId, accountId }) => getLegacyOpenClawProviderKeys(vendorId, accountId),
    getOAuthProviderApi,
    getOAuthProviderTokenKey,
    getOAuthProviderDefaultBaseUrl,
    normalizeOAuthBaseUrl,
    getOAuthApiKeyEnv,
    usesOAuthAuthHeader,
  };
}

function createOpenClawEnvironmentLayout(system: RuntimeSystemEnvironmentPort): { getOpenClawDirPath(): string; getOpenClawConfigDir(): string; getOpenClawConfigFilePath(): string } {
  return {
    getOpenClawDirPath: () => {
      const explicitDir = system.getEnv('MATCHACLAW_OPENCLAW_DIR');
      if (explicitDir) {
        return resolve(expandHomePath(explicitDir, system.homeDir));
      }
      if (system.resourcesPath) {
        return resolve(join(system.resourcesPath, 'openclaw'));
      }
      return resolve(join(system.workingDir, 'node_modules/openclaw'));
    },
    getOpenClawConfigDir: () => {
      const explicitConfigDir = system.getEnv('OPENCLAW_CONFIG_DIR');
      if (explicitConfigDir) {
        return resolve(expandHomePath(explicitConfigDir, system.homeDir));
      }
      return resolve(join(system.homeDir, '.openclaw'));
    },
    getOpenClawConfigFilePath() {
      return join(this.getOpenClawConfigDir(), 'openclaw.json');
    },
  };
}

function expandHomePath(value: string, homeDir: string): string {
  return value.startsWith('~') ? value.replace('~', homeDir) : value;
}

export function registerOpenClawInfrastructure(container: RuntimeHostContainer): void {
  container.register('openclaw.environmentRepository', (scope) => {
    const systemEnvironment = scope.resolve<RuntimeSystemEnvironmentPort>('runtime.systemEnvironment');
    const fileSystem = scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem');
    const layout = createOpenClawEnvironmentLayout(systemEnvironment);
    return new OpenClawEnvironmentRepository(
      systemEnvironment,
      fileSystem,
      new OpenClawEnvironmentConfigFileWorkflow({ fileSystem, layout }),
      new OpenClawEnvironmentStatusWorkflow({ fileSystem, layout }),
    );
  });
  container.register('openclaw.configRepository', (scope) => new OpenClawConfigRepository(
    scope.resolve('openclaw.environmentRepository'),
  ));
  container.register('openclaw.authStoreWorkflow', (scope) => new OpenClawAuthStoreWorkflow({
    configRepository: scope.resolve('openclaw.configRepository'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    logger: scope.resolve<RuntimeHostLogger>('logger'),
  }));
  container.register('openclaw.authRepository', (scope) => new OpenClawAuthRepository(
    scope.resolve<OpenClawAuthStoreWorkflow>('openclaw.authStoreWorkflow'),
  ));
  container.register('openclaw.agentModelStoreWorkflow', (scope) => new OpenClawAgentModelStoreWorkflow({
    configRepository: scope.resolve('openclaw.configRepository'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('openclaw.agentModelRepository', (scope) => new OpenClawAgentModelRepository(
    scope.resolve<OpenClawAgentModelStoreWorkflow>('openclaw.agentModelStoreWorkflow'),
  ));
  container.register('openclaw.oauthPluginRegistrationService', (scope) => new OpenClawOAuthPluginRegistrationService(
    scope.resolve('openclaw.configRepository'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    scope.resolve<RuntimeHostLogger>('logger'),
  ));
  container.register('openclaw.authProfileWorkflow', (scope) => new OpenClawAuthProfileWorkflow({
    repository: scope.resolve('openclaw.authRepository'),
    logger: scope.resolve<RuntimeHostLogger>('logger'),
  }));
  container.register('openclaw.authProfileService', (scope) => new OpenClawAuthProfileService(
    scope.resolve<OpenClawAuthProfileWorkflow>('openclaw.authProfileWorkflow'),
  ));
  container.register('openclaw.workspaceQueryWorkflow', (scope) => new OpenClawWorkspaceQueryWorkflow({
    config: scope.resolve('openclaw.configRepository'),
  }));
  container.register('openclaw.workspaceMaintenanceWorkflow', (scope) => new OpenClawWorkspaceMaintenanceWorkflow({
    workspaceQuery: scope.resolve<OpenClawWorkspaceQueryWorkflow>('openclaw.workspaceQueryWorkflow'),
    environment: scope.resolve('openclaw.environmentRepository'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    logger: scope.resolve<RuntimeHostLogger>('logger'),
  }));
  container.register('openclaw.workspaceService', (scope) => new OpenClawWorkspaceService(
    scope.resolve<OpenClawWorkspaceQueryWorkflow>('openclaw.workspaceQueryWorkflow'),
    scope.resolve<OpenClawWorkspaceMaintenanceWorkflow>('openclaw.workspaceMaintenanceWorkflow'),
  ));
  container.register('openclaw.runtimeDataLayout', () => new OpenClawRuntimeDataLayout());
  container.register('openclaw.providerConfigWorkflow', (scope) => new OpenClawProviderConfigWorkflow({
    configRepository: scope.resolve('openclaw.configRepository'),
    authRepository: scope.resolve('openclaw.authRepository'),
    oauthPlugins: scope.resolve('openclaw.oauthPluginRegistrationService'),
    agentModels: scope.resolve('openclaw.agentModelRepository'),
    logger: scope.resolve<RuntimeHostLogger>('logger'),
  }));
  container.register('openclaw.providerConfigService', (scope) => new OpenClawProviderConfigService(
    scope.resolve<OpenClawProviderConfigWorkflow>('openclaw.providerConfigWorkflow'),
  ));
  container.register('openclaw.providerSnapshotService', (scope) => new OpenClawProviderSnapshotService(
    scope.resolve('openclaw.configRepository'),
    scope.resolve('openclaw.authRepository'),
    scope.resolve<RuntimeHostLogger>('logger'),
  ));
  container.register('platform.runtimeDriverFactory', (scope): AgentRuntimeDriverFactoryPort => ({
    createRuntimeDriver: (gateway) => new OpenClawRuntimeDriver(
      gateway as OpenClawRuntimeBridge,
      scope.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
    ),
  }));
  container.register('providers.projectionKeyResolver', (): ProviderProjectionKeyResolverPort => createOpenClawProviderProjectionKeyResolver());
  container.register('providers.projectionPolicy', (): ProviderProjectionPolicyPort => createOpenClawProviderProjectionPolicy());
  container.register('providers.projectionSyncWorkflow', (scope) => new ProviderProjectionSyncWorkflow({
    authProfiles: scope.resolve('openclaw.authProfileService'),
    providerConfig: scope.resolve('openclaw.providerConfigService'),
    projectionState: scope.resolve('openclaw.providerSnapshotService'),
    authRepository: scope.resolve('openclaw.authRepository'),
    agentModels: scope.resolve('openclaw.agentModelRepository'),
    projectionKeys: scope.resolve<ProviderProjectionKeyResolverPort>('providers.projectionKeyResolver'),
    projectionPolicy: scope.resolve<ProviderProjectionPolicyPort>('providers.projectionPolicy'),
  }));
  container.register('providers.projectionSyncService', (scope) => new ProviderProjectionSyncService(
    scope.resolve<ProviderProjectionSyncWorkflow>('providers.projectionSyncWorkflow'),
  ));
  container.register('openclaw.subagentTemplateWorkflow', (scope) => new OpenClawSubagentTemplateWorkflow({
    sources: scope.resolve('openclaw.environmentRepository'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('openclaw.subagentTemplateService', (scope) => new SubagentTemplateService(
    scope.resolve<OpenClawSubagentTemplateWorkflow>('openclaw.subagentTemplateWorkflow'),
  ));
  container.register('providers.accountsProjectionPort', (scope) => new OpenClawProviderAccountsProjectionPort(
    scope.resolve('openclaw.authProfileService'),
    scope.resolve('providers.projectionSyncService'),
    scope.resolve('openclaw.providerConfigService'),
    scope.resolve<ProviderProjectionKeyResolverPort>('providers.projectionKeyResolver'),
  ));
  container.register('openclaw.capabilityRoutingProjectionWorkflow', (scope) => new OpenClawCapabilityRoutingProjectionWorkflow(
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
  ));
  container.register('providers.capabilityRoutingProjection', (scope): CapabilityRoutingProjectionPort => new OpenClawCapabilityRoutingService(
    scope.resolve<OpenClawCapabilityRoutingProjectionWorkflow>('openclaw.capabilityRoutingProjectionWorkflow'),
  ));
  container.register('openclaw.providerModelsProjectionWorkflow', (scope) => new OpenClawProviderModelsProjectionWorkflow(
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
  ));
  container.register('providers.modelsProjection', (scope): ProviderModelsProjectionPort => new OpenClawProviderModelsService(
    scope.resolve<OpenClawProviderModelsProjectionWorkflow>('openclaw.providerModelsProjectionWorkflow'),
  ));
  container.register('openclaw.customMediaPluginConfigWorkflow', (scope) => new OpenClawCustomMediaPluginConfigWorkflow(
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
  ));
  container.register('providers.customMediaProjection', (scope): CustomMediaProviderProjectionPort => new OpenClawCustomMediaPluginConfigService(
    scope.resolve<OpenClawCustomMediaPluginConfigWorkflow>('openclaw.customMediaPluginConfigWorkflow'),
  ));
  container.register('providers.agentIdentityProjection', (scope): ProviderModelsAgentIdentityPort => scope.resolve<ProviderModelsAgentIdentityPort>('openclaw.authRepository'));
  container.register('providers.agentModelsProjection', (scope): ProviderModelsAgentProjectionPort => scope.resolve<ProviderModelsAgentProjectionPort>('openclaw.agentModelRepository'));
  container.register('runtimeHost.environment', (scope): RuntimeHostEnvironmentPort => createRuntimeHostEnvironmentPort(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
  ));
  container.register('gateway.runtimeData', (scope): GatewayBridgeRuntimeDataPort => createGatewayBridgeRuntimeDataPort(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
  ));
  container.register('gateway.runtimeFactory', (): GatewayRuntimeFactoryPort => ({
    createGatewayRuntime: (client: OpenClawGatewayClient) => createOpenClawBridge(client),
  }));
  container.register('runtimeHost.prelaunchMaintenanceCacheStorage', (scope): PrelaunchMaintenanceCacheStoragePort => createPrelaunchMaintenanceCacheStoragePort(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
  ));
  container.register('runtimeHost.prelaunchPluginMaintenanceRuntime', (scope): PrelaunchPluginMaintenanceRuntimePort => createPrelaunchPluginMaintenanceRuntimePort(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
  ));
  container.register('operations.runtimeDataRoot', (scope): CronRuntimeDataPort => createOperationsRuntimeDataRootPort(
    scope.resolve<OpenClawWorkspaceService>('openclaw.workspaceService'),
  ));
  container.register('operations.taskWorkspace', (scope): TaskWorkspacePort => createOperationsTaskWorkspacePort(
    scope.resolve<OpenClawWorkspaceService>('openclaw.workspaceService'),
  ));
  container.register('file.runtimeDataStore', (scope): FileRuntimeDataStorePort => createFileRuntimeDataStorePort(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
  ));
  container.register('security.policyStorage', (scope): SecurityPolicyStoragePort => createOpenClawConfigRuntimeDataPort(
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
  ));
  container.register('security.openclawPluginConfigWorkflow', (scope) => new OpenClawSecurityPluginConfigWorkflow(
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
  ));
  container.register('security.pluginConfigProjection', (scope): SecurityPluginConfigProjectionPort => new OpenClawSecurityPluginConfigService(
    scope.resolve<OpenClawSecurityPluginConfigWorkflow>('security.openclawPluginConfigWorkflow'),
  ));
  container.register('usage.runtimeData', (scope): TokenUsageRuntimeDataPort => createOpenClawConfigRuntimeDataPort(
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
  ));
  container.register('usage.transcriptLayout', (scope): TokenUsageTranscriptLayoutPort => scope.resolve<OpenClawRuntimeDataLayout>('openclaw.runtimeDataLayout'));
  container.register('diagnostics.runtimeLayout', (scope): DiagnosticsRuntimeBundleLayoutPort => scope.resolve<OpenClawRuntimeDataLayout>('openclaw.runtimeDataLayout'));
  container.register('teamRuntime.storageRoot', (scope): TeamRuntimeStorageRootPort => scope.resolve<TeamRuntimeStorageRootPort>('operations.runtimeDataRoot'));
  container.register('toolchainUv.runtime', (scope): ToolchainUvRuntimePort => createToolchainUvRuntimePort(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
  ));
  container.register('sessionConfigDirectory', (scope): SessionConfigDirectoryPort => createSessionConfigDirectoryPort(
    scope.resolve<OpenClawWorkspaceService>('openclaw.workspaceService'),
  ));
  container.register('sessionExternalArtefactResolver', (): SessionExternalArtefactResolverPort => new OpenClawSessionArtefactResolver());
  container.register('sessionDefaultModelResolver', (scope): SessionDefaultModelResolverPort => new OpenClawSessionMetadataResolver(
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
  ));
  container.contribute('runtime.adapterRegistrationFactories', (): RuntimeAdapterRegistrationFactory => createRuntimeAdapterRegistrationFactory());
  container.register('gateway.runtimeEndpointId', (): RuntimeEndpointId => OPENCLAW_RUNTIME_ENDPOINT_ID);
  container.register('providers.storeStorage', (scope): ProviderStoreStoragePort => createProviderStoreStoragePort(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
  ));
  container.register('providers.capabilityRoutingStorage', (scope) => createCapabilityRoutingStoragePort(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
  ));
  container.register('providers.modelsStorage', (scope) => createProviderModelsStoragePort(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
  ));
  container.register('channels.pairingRuntime', (scope): ChannelPairingRuntimeEnvironmentPort => createChannelPairingRuntimeEnvironmentPort(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
  ));
  container.register('channels.loginRuntime', (scope): ChannelLoginRuntimePort => createChannelLoginRuntimePort(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
  ));
  container.register('skills.workspace', (scope): SkillsWorkspacePort => createOpenClawSkillsWorkspacePort({
    workspace: scope.resolve<OpenClawWorkspaceService>('openclaw.workspaceService'),
    environment: scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
  }));
  container.register('clawhub.runtime', (scope): ClawHubRuntimePort => createClawHubRuntimePort(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
  ));
  container.register('providers.storePersistenceWorkflow', (scope) => new ProviderStorePersistenceWorkflow({
    storage: scope.resolve<ProviderStoreStoragePort>('providers.storeStorage'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('providers.storeRepository', (scope) => new ProviderStoreRepository({
    persistenceWorkflow: scope.resolve<ProviderStorePersistenceWorkflow>('providers.storePersistenceWorkflow'),
  }));
  container.register('plugins.fileSystem', () => new NodePluginFileSystem());
  container.register('plugins.configStore', (scope): RuntimePluginConfigStorePort => scope.resolve<RuntimePluginConfigStorePort>('openclaw.configRepository'));
  container.register('plugins.managedCatalog', () => new OpenClawManagedPluginCatalog());
  container.register('plugins.companionSkillWorkspace', (scope): PluginCompanionSkillWorkspacePort => createPluginCompanionSkillWorkspacePort({
    environment: scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
    configRepository: scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
  }));
  container.register('plugins.installLocation', (scope): OpenClawManagedPluginInstallLocationPort => createOpenClawManagedPluginInstallLocationPort({
    environment: scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
    configRepository: scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
  }));
  container.register('plugins.managedInstaller', (scope) => new OpenClawManagedPluginInstaller(
    scope.resolve<OpenClawManagedPluginInstallLocationPort>('plugins.installLocation'),
    scope.resolve('plugins.fileSystem'),
    scope.resolve('plugins.managedCatalog'),
  ));
  container.register('plugins.configProjection', (scope): RuntimePluginConfigProjectionPort => createRuntimePluginConfigProjectionPort({
    configRepository: scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
    pluginFileSystem: scope.resolve<NodePluginFileSystem>('plugins.fileSystem'),
  }));
  container.register('channels.pluginConfigProjection', (scope): ChannelPluginConfigProjectionPort => createChannelPluginConfigProjectionPort({
    configRepository: scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
    pluginFileSystem: scope.resolve<NodePluginFileSystem>('plugins.fileSystem'),
  }));
  container.register('channels.pluginProvisioner', (scope): ChannelPluginProvisionerPort => createChannelPluginProvisionerPort(
    scope.resolve<OpenClawManagedPluginInstaller>('plugins.managedInstaller'),
  ));
  container.register('channels.configProjection', (): ChannelConfigProjectionPort => new OpenClawChannelConfigProjection());
  container.register('plugins.injectedCatalogPlatformPolicy', () => new OpenClawInjectedPluginCatalogPlatformPolicy());
  container.register('plugins.catalogProjection', (): RuntimePluginCatalogProjectionPort => new OpenClawChannelPluginProjection());
  container.register('channels.prelaunchPluginProjection', (scope): PrelaunchChannelPluginProjectionPort => scope.resolve('plugins.catalogProjection'));
  container.register('channels.deliveryProjection', (scope): CronDeliveryChannelProjectionPort => scope.resolve('plugins.catalogProjection'));
  container.register('channels.activationStrategy', (scope): ChannelActivationStrategyPort => scope.resolve('plugins.catalogProjection'));
  container.register('channels.configWorkflow', (scope) => new ChannelConfigWorkflow({
    configRepository: scope.resolve('openclaw.configRepository'),
    configProjection: scope.resolve<ChannelConfigProjectionPort>('channels.configProjection'),
    pluginProjection: scope.resolve<ChannelPluginConfigProjectionPort>('channels.pluginConfigProjection'),
    pluginProvisioner: scope.resolve<ChannelPluginProvisionerPort>('channels.pluginProvisioner'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('channels.configRepository', (scope) => new ChannelConfigRepository(
    scope.resolve<ChannelConfigWorkflow>('channels.configWorkflow'),
  ));
  container.register('settings.storeWorkflow', (scope) => new SettingsStoreWorkflow({
    environment: createSettingsStoreEnvironmentPort(scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository')),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('settings.repository', (scope) => new SettingsRepository(
    scope.resolve<SettingsStoreWorkflow>('settings.storeWorkflow'),
  ));
  container.register('gateway.settings', (scope): GatewayBridgeSettingsPort => createGatewayBridgeSettingsPort(
    scope.resolve<SettingsRepository>('settings.repository'),
  ));
  container.register('clawhub.skillInventory', (scope) => new ClawHubSkillInventory(
    createClawHubSkillInventoryStoragePort(scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository')),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  ));
  container.register('clawhub.registryClient', (scope) => new ClawHubRegistryClient(
    createClawHubRegistryRuntimePort(scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository')),
    scope.resolve<RuntimeHttpClientPort>('runtime.httpClient'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  ));
  container.register('clawhub.cliRunner', (scope) => new ClawHubCliRunner(
    createClawHubCliRuntimePort({
      configRepository: scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
      environment: scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
    }),
    scope.resolve('clawhub.registryClient'),
    scope.resolve<RuntimeCommandExecutorPort>('runtime.commandExecutor'),
    scope.resolve<RuntimeProcessInfoPort>('runtime.processInfo'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  ));
  container.register('skills.configRepository', (scope) => new SkillsConfigRepository(
    scope.resolve('openclaw.configRepository'),
    scope.resolve<ClawHubSkillInventory>('clawhub.skillInventory'),
  ));
  container.register('skills.readmePreviewRepository', (scope) => new SkillReadmePreviewRepository(
    scope.resolve('openclaw.workspaceService'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  ));
}
