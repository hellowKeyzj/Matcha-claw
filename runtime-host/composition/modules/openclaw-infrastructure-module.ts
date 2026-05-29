import { SubagentTemplateService } from '../../application/openclaw/templates';
import { OpenClawEnvironmentRepository } from '../../application/openclaw/openclaw-environment-repository';
import { OpenClawAgentModelRepository } from '../../application/openclaw/openclaw-agent-model-repository';
import { OpenClawConfigRepository } from '../../application/openclaw/openclaw-config-repository';
import { OpenClawAuthProfileService } from '../../application/openclaw/openclaw-auth-profile-store';
import { OpenClawAuthRepository } from '../../application/openclaw/openclaw-auth-store';
import { OpenClawOAuthPluginRegistrationService } from '../../application/openclaw/openclaw-oauth-plugin-registration';
import { OpenClawProviderConfigService } from '../../application/openclaw/openclaw-provider-config-service';
import { OpenClawWorkspaceService } from '../../application/openclaw/openclaw-workspace-service';
import { OpenClawProviderAccountsRuntimePort } from '../../application/providers/provider-accounts-runtime-port';
import { ProviderRuntimeSyncService } from '../../application/providers/store-sync';
import { ProviderStoreRepository } from '../../application/providers/provider-store-repository';
import { ChannelConfigRepository } from '../../application/channels/channel-runtime';
import { SettingsRepository } from '../../application/settings/store';
import { SkillReadmePreviewRepository, SkillsConfigRepository } from '../../application/skills/store';
import { ClawHubSkillInventory } from '../../application/skills/clawhub';
import { ClawHubCliRunner } from '../../application/skills/clawhub-cli';
import { ClawHubRegistryClient } from '../../application/skills/clawhub-registry-client';
import type { ManagedPluginInstaller } from '../../application/plugins/managed-plugin-installer';
import type { RuntimeHostContainer } from '../container';
import type {
  RuntimeCommandExecutorPort,
  RuntimeClockPort,
  RuntimeFileSystemPort,
  RuntimeHttpClientPort,
  RuntimeProcessInfoPort,
  RuntimeSystemEnvironmentPort,
} from '../../application/common/runtime-ports';
import type { RuntimeHostLogger } from '../../shared/logger';

export function registerOpenClawInfrastructure(container: RuntimeHostContainer): void {
  container.register('openclaw.environmentRepository', (scope) => new OpenClawEnvironmentRepository(
    scope.resolve<RuntimeSystemEnvironmentPort>('runtime.systemEnvironment'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  ));
  container.register('openclaw.configRepository', (scope) => new OpenClawConfigRepository(
    scope.resolve('openclaw.environmentRepository'),
  ));
  container.register('openclaw.authRepository', (scope) => new OpenClawAuthRepository(
    scope.resolve('openclaw.configRepository'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    scope.resolve<RuntimeHostLogger>('logger'),
  ));
  container.register('openclaw.agentModelRepository', (scope) => new OpenClawAgentModelRepository(
    scope.resolve('openclaw.configRepository'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  ));
  container.register('openclaw.oauthPluginRegistrationService', (scope) => new OpenClawOAuthPluginRegistrationService(
    scope.resolve('openclaw.configRepository'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    scope.resolve<RuntimeHostLogger>('logger'),
  ));
  container.register('openclaw.authProfileService', (scope) => new OpenClawAuthProfileService(
    scope.resolve('openclaw.authRepository'),
    scope.resolve<RuntimeHostLogger>('logger'),
  ));
  container.register('openclaw.workspaceService', (scope) => new OpenClawWorkspaceService(
    scope.resolve('openclaw.configRepository'),
    scope.resolve('openclaw.environmentRepository'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    scope.resolve<RuntimeHostLogger>('logger'),
  ));
  container.register('openclaw.providerConfigService', (scope) => new OpenClawProviderConfigService(
    scope.resolve('openclaw.configRepository'),
    scope.resolve('openclaw.authRepository'),
    scope.resolve('openclaw.oauthPluginRegistrationService'),
    scope.resolve('openclaw.agentModelRepository'),
    scope.resolve<RuntimeHostLogger>('logger'),
  ));
  container.register('providers.runtimeSyncService', (scope) => new ProviderRuntimeSyncService(
    scope.resolve('openclaw.authProfileService'),
    scope.resolve('openclaw.providerConfigService'),
    scope.resolve('openclaw.authRepository'),
    scope.resolve('openclaw.agentModelRepository'),
  ));
  container.register('openclaw.subagentTemplateService', (scope) => new SubagentTemplateService(
    scope.resolve('openclaw.environmentRepository'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  ));
  container.register('providers.runtimePort', (scope) => new OpenClawProviderAccountsRuntimePort(
    scope.resolve('openclaw.authProfileService'),
    scope.resolve('providers.runtimeSyncService'),
    scope.resolve('openclaw.providerConfigService'),
  ));
  container.register('providers.storeRepository', (scope) => new ProviderStoreRepository(
    scope.resolve('openclaw.environmentRepository'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  ));
  container.register('channels.configRepository', (scope) => new ChannelConfigRepository(
    scope.resolve('openclaw.configRepository'),
    scope.resolve<ManagedPluginInstaller>('plugins.managedInstaller'),
    scope.resolve('plugins.fileSystem'),
    scope.resolve<RuntimeClockPort>('runtime.clock'),
  ));
  container.register('settings.repository', (scope) => new SettingsRepository(
    scope.resolve('openclaw.environmentRepository'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  ));
  container.register('clawhub.skillInventory', (scope) => new ClawHubSkillInventory(
    scope.resolve('openclaw.configRepository'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  ));
  container.register('clawhub.registryClient', (scope) => new ClawHubRegistryClient(
    scope.resolve('openclaw.environmentRepository'),
    scope.resolve<RuntimeHttpClientPort>('runtime.httpClient'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  ));
  container.register('clawhub.cliRunner', (scope) => new ClawHubCliRunner(
    scope.resolve('openclaw.configRepository'),
    scope.resolve('openclaw.environmentRepository'),
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
