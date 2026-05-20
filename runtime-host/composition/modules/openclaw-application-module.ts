import { isChannelDerivedPluginId } from '../../application/channels/channel-plugin-bindings';
import type { ChannelConfigPort } from '../../application/channels/channel-runtime';
import { ChannelLoginSessionService } from '../../application/channels/channel-login-session-service';
import { ChannelPairingService } from '../../application/channels/channel-pairing-service';
import {
  ACTIVATE_DIRECT_CHANNEL_JOB,
  DELETE_CHANNEL_CONFIG_JOB,
  PROBE_CHANNEL_SNAPSHOT_JOB,
  REFRESH_CHANNEL_SNAPSHOT_JOB,
  createChannelJobPort,
  type ChannelJobPort,
} from '../../application/channels/channel-jobs';
import { ChannelService } from '../../application/channels/service';
import { OpenClawService } from '../../application/openclaw/service';
import type { GatewayPluginCapabilityPort } from '../../application/gateway/gateway-capability-service';
import { OpenClawProviderSnapshotService } from '../../application/openclaw/openclaw-provider-snapshot';
import { OpenClawRuntimeConfigService } from '../../application/openclaw/openclaw-runtime-config-service';
import { SubagentTemplateService } from '../../application/openclaw/templates';
import { SubagentRuntimeService } from '../../application/subagents/service';
import {
  ClawHubService,
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
import { SkillsService } from '../../application/skills/service';
import {
  ENSURE_PREINSTALLED_SKILLS_JOB,
  IMPORT_LOCAL_SKILL_JOB,
  REFRESH_SKILL_STATUS_JOB,
  SYNC_SKILL_GATEWAY_UPDATE_JOB,
  createSkillsJobPort,
  type SkillsJobPort,
} from '../../application/skills/skills-jobs';
import { SettingsService } from '../../application/settings/service';
import {
  SYNC_SETTINGS_RUNTIME_CONFIG_JOB,
  createSettingsJobPort,
  type SettingsJobPort,
} from '../../application/settings/settings-jobs';
import { ProviderAccountsService } from '../../application/providers/accounts';
import { CapabilityRoutingApplicationService } from '../../application/providers/capability-routing-service';
import { OpenClawCapabilityRoutingService } from '../../application/openclaw/openclaw-capability-routing-service';
import { ProviderModelsApplicationService } from '../../application/providers/provider-models-service';
import { OpenClawProviderModelsService } from '../../application/openclaw/openclaw-provider-models-service';
import { OpenClawCustomMediaPluginConfigService } from '../../application/openclaw/openclaw-custom-media-plugin-config-service';
import {
  CREATE_PROVIDER_ACCOUNT_JOB,
  DELETE_PROVIDER_ACCOUNT_JOB,
  UPDATE_PROVIDER_ACCOUNT_JOB,
  createProviderAccountJobPort,
  type ProviderAccountJobPort,
} from '../../application/providers/provider-account-jobs';
import type { RuntimeClockPort, RuntimeHttpClientPort, RuntimeIdGeneratorPort } from '../../application/common/runtime-ports';
import type { RuntimeCommandExecutorPort } from '../../application/common/runtime-ports';
import type { OpenClawAuthProfileService } from '../../application/openclaw/openclaw-auth-profile-store';
import { ProviderOAuthCompletionService } from '../../application/providers/oauth-runtime';
import type { ProviderStoreRepository } from '../../application/providers/provider-store-repository';
import { ProviderModelsStoreRepository } from '../../application/providers/provider-models-store';
import { CapabilityRoutingStoreRepository } from '../../application/providers/capability-routing-store';
import type { RuntimeFileSystemPort } from '../../application/common/runtime-ports';
import type { RuntimeHostApplicationServicesContext } from '../application-services';
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
import type { OpenClawConfigRepositoryPort } from '../../application/openclaw/openclaw-config-repository';
import type { OpenClawEnvironmentRepository } from '../../application/openclaw/openclaw-environment-repository';
import type { ProviderAccountsRuntimePort } from '../../application/providers/provider-accounts-runtime-port';
import type { RuntimePluginRepositoryPort } from '../../application/plugins/runtime-plugin-service';
import type { GatewayControlPort } from '../../application/runtime-host/parent-shell-port';
import type { RuntimeLongTaskSubmissionPort } from '../../application/runtime-host/runtime-task-ports';
import type { SettingsRepository } from '../../application/settings/store';
import type { SkillReadmePreviewRepository, SkillsConfigRepository } from '../../application/skills/store';
import type { RuntimeHostLogger } from '../../shared/logger';

export interface OpenClawApplicationServices {
  readonly channelService: ChannelService;
  readonly clawHubService: ClawHubService;
  readonly isChannelDerivedPluginId: typeof isChannelDerivedPluginId;
  readonly capabilityRoutingService: CapabilityRoutingApplicationService;
  readonly providerModelsService: ProviderModelsApplicationService;
  readonly openClawService: OpenClawService;
  readonly providerAccountsService: ProviderAccountsService;
  readonly settingsService: SettingsService;
  readonly skillsService: SkillsService;
  readonly subagentService: SubagentRuntimeService;
}

export function registerOpenClawApplicationServices(
  container: RuntimeHostContainer,
  context: RuntimeHostApplicationServicesContext,
): void {
  container.register('openclaw.service', (scope) => {
    const configRepository = scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository');
    const environmentRepository = scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository');
    const subagentTemplates = scope.resolve<SubagentTemplateService>('openclaw.subagentTemplateService');
    return new OpenClawService({
      config: configRepository,
      environment: environmentRepository,
      workspace: scope.resolve('openclaw.workspaceService'),
      subagentTemplates,
      providerSnapshot: scope.resolve('openclaw.providerSnapshotService'),
    });
  });
  container.register('openclaw.providerSnapshotService', (scope) => new OpenClawProviderSnapshotService(
    scope.resolve('openclaw.configRepository'),
    scope.resolve('openclaw.authRepository'),
    scope.resolve<RuntimeHostLogger>('logger'),
  ));
  container.register('channels.service', (scope) => new ChannelService({
    gateway: context.openclawBridge,
    channelConfig: scope.resolve<ChannelConfigPort>('channels.configRepository'),
    parentShell: context.parentShell,
    loginSessions: scope.resolve('channels.loginSessionService'),
    pairing: scope.resolve('channels.pairingService'),
    jobs: scope.resolve<ChannelJobPort>('channels.jobs'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('channels.pairingService', (scope) => new ChannelPairingService(
    scope.resolve('openclaw.environmentRepository'),
  ));
  container.register('channels.loginSessionService', (scope) => new ChannelLoginSessionService({
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    environment: scope.resolve('openclaw.environmentRepository'),
    idGenerator: scope.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
    timer: scope.resolve('runtime.timer'),
    logger: scope.resolve<RuntimeHostLogger>('logger'),
    emitGatewayEvent: (eventName, payload) => {
      void context.parentGatewayEvents.emit(eventName, payload).catch(() => undefined);
    },
    saveChannelConfig: async (payload) => {
      await scope.resolve<ChannelConfigPort>('channels.configRepository').saveChannelConfig(payload);
    },
    restartGateway: async () => {
      await context.parentShell.request('gateway_restart');
    },
  }));
  container.register('channels.jobs', (scope): ChannelJobPort => createChannelJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('providers.accountsService', (scope) => new ProviderAccountsService({
    store: scope.resolve<ProviderStoreRepository>('providers.storeRepository'),
    parentShell: context.parentShell,
    oauthCompletion: scope.resolve<ProviderOAuthCompletionService>('providers.oauthCompletionService'),
    runtime: scope.resolve<ProviderAccountsRuntimePort>('providers.runtimePort'),
    providerModels: scope.resolve<ProviderModelsApplicationService>('providers.modelsService'),
    capabilityRouting: scope.resolve<CapabilityRoutingApplicationService>('providers.capabilityRoutingService'),
    httpClient: scope.resolve<RuntimeHttpClientPort>('runtime.httpClient'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
    jobs: scope.resolve<ProviderAccountJobPort>('providers.jobs'),
  }));
  container.register('openclaw.capabilityRoutingWriter', (scope) => new OpenClawCapabilityRoutingService(
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
  ));
  container.register('providers.capabilityRoutingStore', (scope) => new CapabilityRoutingStoreRepository(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  ));
  container.register('providers.capabilityRoutingService', (scope) => new CapabilityRoutingApplicationService(
    scope.resolve<CapabilityRoutingStoreRepository>('providers.capabilityRoutingStore'),
    scope.resolve<ProviderStoreRepository>('providers.storeRepository'),
    scope.resolve<OpenClawCapabilityRoutingService>('openclaw.capabilityRoutingWriter'),
  ));
  container.register('openclaw.providerModelsWriter', (scope) => new OpenClawProviderModelsService(
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
  ));
  container.register('openclaw.customMediaPluginConfigWriter', (scope) => new OpenClawCustomMediaPluginConfigService(
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
  ));
  container.register('providers.modelsStore', (scope) => new ProviderModelsStoreRepository(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  ));
  container.register('providers.modelsService', (scope) => new ProviderModelsApplicationService(
    scope.resolve<ProviderModelsStoreRepository>('providers.modelsStore'),
    scope.resolve<ProviderStoreRepository>('providers.storeRepository'),
    scope.resolve<OpenClawProviderModelsService>('openclaw.providerModelsWriter'),
    scope.resolve<OpenClawCustomMediaPluginConfigService>('openclaw.customMediaPluginConfigWriter'),
  ));
  container.register('providers.jobs', (scope): ProviderAccountJobPort => createProviderAccountJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('providers.oauthCompletionService', (scope) => new ProviderOAuthCompletionService({
    storeRepository: scope.resolve<ProviderStoreRepository>('providers.storeRepository'),
    runtime: scope.resolve<ProviderAccountsRuntimePort>('providers.runtimePort'),
    authProfiles: scope.resolve<OpenClawAuthProfileService>('openclaw.authProfileService'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('openclaw.runtimeConfigService', (scope) => new OpenClawRuntimeConfigService(
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
    scope.resolve('openclaw.oauthPluginRegistrationService'),
    scope.resolve('openclaw.environmentRepository'),
    scope.resolve('plugins.fileSystem'),
    scope.resolve<RuntimeHostLogger>('logger'),
  ));
  container.register('settings.service', (scope) => new SettingsService({
    repository: scope.resolve<SettingsRepository>('settings.repository'),
    runtimeConfig: scope.resolve<OpenClawRuntimeConfigService>('openclaw.runtimeConfigService'),
    runtimePlugins: scope.resolve<RuntimePluginRepositoryPort>('plugins.repository'),
    gatewayControl: scope.resolve<GatewayControlPort>('gateway.control'),
    jobs: scope.resolve<SettingsJobPort>('settings.jobs'),
  }));
  container.register('settings.jobs', (scope): SettingsJobPort => createSettingsJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('skills.service', (scope) => {
    const skillsRepository = scope.resolve<SkillsConfigRepository>('skills.configRepository');
    return new SkillsService({
      repository: skillsRepository,
      readmePreviews: scope.resolve<SkillReadmePreviewRepository>('skills.readmePreviewRepository'),
      gateway: context.openclawBridge,
      jobs: scope.resolve<SkillsJobPort>('skills.jobs'),
      clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
      fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
      commandExecutor: scope.resolve<RuntimeCommandExecutorPort>('runtime.commandExecutor'),
      systemEnvironment: scope.resolve('runtime.systemEnvironment'),
      workspace: scope.resolve('openclaw.workspaceService'),
      environment: scope.resolve('openclaw.environmentRepository'),
      logger: scope.resolve<RuntimeHostLogger>('logger'),
    });
  });
  container.register('skills.jobs', (scope): SkillsJobPort => createSkillsJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('subagents.service', (scope) => new SubagentRuntimeService({
    gateway: context.openclawBridge,
    capabilities: scope.resolve<GatewayPluginCapabilityPort>('gateway.capabilities'),
    workspace: scope.resolve('openclaw.workspaceService'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('clawhub.service', (scope) => new ClawHubService({
    parentShell: context.parentShell,
    registryClient: scope.resolve<ClawHubRegistryClient>('clawhub.registryClient'),
    cliRunner: scope.resolve<ClawHubCliRunner>('clawhub.cliRunner'),
    skillInventory: scope.resolve<ClawHubSkillInventory>('clawhub.skillInventory'),
    environment: scope.resolve('openclaw.environmentRepository'),
    commandExecutor: scope.resolve<RuntimeCommandExecutorPort>('runtime.commandExecutor'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    jobs: scope.resolve<ClawHubJobPort>('clawhub.jobs'),
  }));
  container.register('clawhub.jobs', (scope): ClawHubJobPort => createClawHubJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
}

export function resolveOpenClawApplicationServices(container: RuntimeHostContainer): OpenClawApplicationServices {
  return {
    channelService: container.resolve<ChannelService>('channels.service'),
    clawHubService: container.resolve<ClawHubService>('clawhub.service'),
    capabilityRoutingService: container.resolve<CapabilityRoutingApplicationService>('providers.capabilityRoutingService'),
    providerModelsService: container.resolve<ProviderModelsApplicationService>('providers.modelsService'),
    isChannelDerivedPluginId,
    openClawService: container.resolve<OpenClawService>('openclaw.service'),
    providerAccountsService: container.resolve<ProviderAccountsService>('providers.accountsService'),
    settingsService: container.resolve<SettingsService>('settings.service'),
    skillsService: container.resolve<SkillsService>('skills.service'),
    subagentService: container.resolve<SubagentRuntimeService>('subagents.service'),
  };
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
