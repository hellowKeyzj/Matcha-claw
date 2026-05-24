import { join } from 'node:path';
import type { RuntimeHostLogger } from '../../shared/logger';
import {
  BUILTIN_CHANNEL_IDS,
  EXTERNAL_CHANNEL_PLUGIN_BINDINGS,
  getExternalChannelPluginId,
} from '../channels/channel-plugin-bindings';
import type { ChannelConfigRepository } from '../channels/channel-runtime';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { OpenClawConfigRepositoryPort } from '../openclaw/openclaw-config-repository';
import type { OpenClawEnvironmentRepository } from '../openclaw/openclaw-environment-repository';
import type { RuntimePluginRepositoryPort } from '../plugins/runtime-plugin-service';
import {
  buildPrelaunchMaintenanceCacheKey,
  type PrelaunchMaintenanceCacheRepository,
} from './prelaunch-maintenance-cache';

async function buildChannelMaintenanceCacheKey(
  configRepository: OpenClawConfigRepositoryPort,
  environment: OpenClawEnvironmentRepository,
  runtimePlugins: RuntimePluginRepositoryPort,
  configuredChannels: readonly string[],
): Promise<string> {
  const configuredPluginIds = configuredChannels
    .map((channelType) => getExternalChannelPluginId(channelType))
    .filter((pluginId): pluginId is string => typeof pluginId === 'string' && pluginId.trim().length > 0)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const knownChannelPluginIds = EXTERNAL_CHANNEL_PLUGIN_BINDINGS
    .flatMap((binding) => [binding.pluginId, ...(binding.legacyPluginIds ?? [])])
    .sort((left, right) => left.localeCompare(right, 'en'));

  return buildPrelaunchMaintenanceCacheKey({
    task: 'configured-channel-plugin-maintenance',
    openclawDir: configRepository.getOpenClawDirPath(),
    configDir: configRepository.getConfigDir(),
    cwd: environment.getWorkingDir(),
    configuredChannels: [...configuredChannels].sort((left, right) => left.localeCompare(right, 'en')),
    configuredPluginIds,
    sources: await runtimePlugins.getManagedPluginSourceSignatures(configuredPluginIds),
    targets: await runtimePlugins.getManagedPluginTargetSignatures(knownChannelPluginIds),
  });
}

async function buildManagedPluginMaintenanceCacheKey(
  configRepository: OpenClawConfigRepositoryPort,
    environment: OpenClawEnvironmentRepository,
    runtimePlugins: RuntimePluginRepositoryPort,
    cacheRepository: Pick<PrelaunchMaintenanceCacheRepository, 'directoryChildrenSignature'>,
  enabledPluginIds: readonly string[],
): Promise<string> {
  const normalizedEnabledPluginIds = [...enabledPluginIds].sort((left, right) => left.localeCompare(right, 'en'));
  return buildPrelaunchMaintenanceCacheKey({
    task: 'configured-managed-plugin-maintenance',
    openclawDir: configRepository.getOpenClawDirPath(),
    configDir: configRepository.getConfigDir(),
    cwd: environment.getWorkingDir(),
    enabledPluginIds: normalizedEnabledPluginIds,
    sources: await runtimePlugins.getManagedPluginSourceSignatures(normalizedEnabledPluginIds),
    targets: await runtimePlugins.getManagedPluginTargetSignatures(normalizedEnabledPluginIds),
    skillsDir: await cacheRepository.directoryChildrenSignature(join(configRepository.getConfigDir(), 'skills')),
  });
}

const STALE_BUILTIN_EXTENSION_IDS = ['telegram'] as const;

export class PrelaunchPluginMaintenanceService {
  constructor(
    private readonly deps: {
      runtimePlugins: RuntimePluginRepositoryPort;
      channels: Pick<ChannelConfigRepository, 'listConfiguredChannels' | 'reconcileConfiguredChannelPlugins'>;
      configRepository: OpenClawConfigRepositoryPort;
      environment: OpenClawEnvironmentRepository;
      cacheRepository: Pick<PrelaunchMaintenanceCacheRepository, 'directoryChildrenSignature' | 'runTask'>;
      fileSystem: Pick<RuntimeFileSystemPort, 'exists' | 'removeDirectory'>;
      logger: RuntimeHostLogger;
    },
  ) {}

  async cleanupStaleBuiltinExtensionsForGatewayLaunch(): Promise<string[]> {
    const removed: string[] = [];
    const configDir = this.deps.configRepository.getConfigDir();
    const result = await this.deps.cacheRepository.runTask(
      'stale-builtin-extension-cleanup',
      () => buildPrelaunchMaintenanceCacheKey({
        task: 'stale-builtin-extension-cleanup',
        configDir,
        staleBuiltinExtensionIds: STALE_BUILTIN_EXTENSION_IDS,
        builtinChannelIds: [...BUILTIN_CHANNEL_IDS].sort((left, right) => left.localeCompare(right, 'en')),
        targets: this.deps.cacheRepository.directoryChildrenSignature(join(configDir, 'extensions')),
      }),
      async () => {
        for (const extensionId of STALE_BUILTIN_EXTENSION_IDS) {
          const extensionDir = join(configDir, 'extensions', extensionId);
          if (!(await this.deps.fileSystem.exists(extensionDir))) {
            continue;
          }
          await this.deps.fileSystem.removeDirectory(extensionDir);
          removed.push(extensionId);
        }
      },
    );
    if (result.executed && removed.length > 0) {
      this.deps.logger.info(`Gateway prelaunch removed stale built-in extensions: ${removed.join(',')}`);
    }
    return removed;
  }

  async reconcileConfiguredChannelPluginsForGatewayLaunch(): Promise<string[]> {
    const configuredChannels = await this.deps.channels.listConfiguredChannels();
    const result = await this.deps.cacheRepository.runTask(
      'configured-channel-plugin-maintenance',
      () => buildChannelMaintenanceCacheKey(this.deps.configRepository, this.deps.environment, this.deps.runtimePlugins, configuredChannels),
      async () => {
        await this.deps.channels.reconcileConfiguredChannelPlugins(configuredChannels, { forceInstall: true });
      },
    );
    if (result.executed) {
      this.deps.logger.info(`Gateway prelaunch channel plugin maintenance executed (${result.reason})`);
    }
    return configuredChannels;
  }

  async ensureConfiguredManagedPluginsForGatewayLaunch(): Promise<string[]> {
    const enabledPluginIds = await this.deps.runtimePlugins.listConfiguredManagedPluginIds();
    const result = await this.deps.cacheRepository.runTask(
      'configured-managed-plugin-maintenance',
      () => buildManagedPluginMaintenanceCacheKey(
        this.deps.configRepository,
        this.deps.environment,
        this.deps.runtimePlugins,
        this.deps.cacheRepository,
        enabledPluginIds,
      ),
      async () => {
        await this.deps.runtimePlugins.ensureConfiguredManagedPluginsInstalled({ forceInstall: true });
      },
    );
    if (result.executed) {
      this.deps.logger.info(`Gateway prelaunch managed plugin maintenance executed (${result.reason})`);
    }
    return enabledPluginIds;
  }
}
