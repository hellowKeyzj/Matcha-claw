import { join } from 'node:path';
import type { RuntimeHostLogger } from '../../shared/logger';
import type { ChannelConfigRepository } from '../channels/channel-runtime';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { RuntimePluginRepositoryPort } from '../plugins/runtime-plugin-service';
import {
  buildPrelaunchMaintenanceCacheKey,
  type PrelaunchMaintenanceCacheRepository,
} from './prelaunch-maintenance-cache';

export interface PrelaunchPluginMaintenanceRuntimePort {
  getRuntimeDataRootDir(): string;
  getRuntimeDistributionDir(): string;
  getWorkingDir(): string;
}

export interface PrelaunchChannelPluginProjectionPort {
  getConfiguredPluginIds(configuredChannels: readonly string[]): string[];
  listKnownPluginIds(): string[];
  listStaleBuiltinExtensionIds(): string[];
  listBuiltinChannelIds(): string[];
}

async function buildChannelMaintenanceCacheKey(
  runtime: PrelaunchPluginMaintenanceRuntimePort,
  runtimePlugins: RuntimePluginRepositoryPort,
  channelPluginProjection: PrelaunchChannelPluginProjectionPort,
  configuredChannels: readonly string[],
): Promise<string> {
  const configuredPluginIds = channelPluginProjection.getConfiguredPluginIds(configuredChannels);
  const knownChannelPluginIds = channelPluginProjection.listKnownPluginIds();

  return buildPrelaunchMaintenanceCacheKey({
    task: 'configured-channel-plugin-maintenance',
    runtimeDistributionDir: runtime.getRuntimeDistributionDir(),
    configDir: runtime.getRuntimeDataRootDir(),
    cwd: runtime.getWorkingDir(),
    configuredChannels: [...configuredChannels].sort((left, right) => left.localeCompare(right, 'en')),
    configuredPluginIds,
    sources: await runtimePlugins.getManagedPluginSourceSignatures(configuredPluginIds),
    targets: await runtimePlugins.getManagedPluginTargetSignatures(knownChannelPluginIds),
  });
}

async function buildManagedPluginMaintenanceCacheKey(
  runtime: PrelaunchPluginMaintenanceRuntimePort,
  runtimePlugins: RuntimePluginRepositoryPort,
  cacheRepository: Pick<PrelaunchMaintenanceCacheRepository, 'directoryChildrenSignature'>,
  enabledPluginIds: readonly string[],
): Promise<string> {
  const normalizedEnabledPluginIds = [...enabledPluginIds].sort((left, right) => left.localeCompare(right, 'en'));
  return buildPrelaunchMaintenanceCacheKey({
    task: 'configured-managed-plugin-maintenance',
    runtimeDistributionDir: runtime.getRuntimeDistributionDir(),
    configDir: runtime.getRuntimeDataRootDir(),
    cwd: runtime.getWorkingDir(),
    enabledPluginIds: normalizedEnabledPluginIds,
    sources: await runtimePlugins.getManagedPluginSourceSignatures(normalizedEnabledPluginIds),
    targets: await runtimePlugins.getManagedPluginTargetSignatures(normalizedEnabledPluginIds),
    skillsDir: await cacheRepository.directoryChildrenSignature(join(runtime.getRuntimeDataRootDir(), 'skills')),
  });
}

export class PrelaunchPluginMaintenanceService {
  constructor(
    private readonly deps: {
      runtimePlugins: RuntimePluginRepositoryPort;
      channels: Pick<ChannelConfigRepository, 'listConfiguredChannels' | 'reconcileConfiguredChannelPlugins'>;
      channelPluginProjection: PrelaunchChannelPluginProjectionPort;
      runtime: PrelaunchPluginMaintenanceRuntimePort;
      cacheRepository: Pick<PrelaunchMaintenanceCacheRepository, 'directoryChildrenSignature' | 'runTask'>;
      fileSystem: Pick<RuntimeFileSystemPort, 'exists' | 'removeDirectory'>;
      logger: RuntimeHostLogger;
    },
  ) {}

  async cleanupStaleBuiltinExtensionsForGatewayLaunch(): Promise<string[]> {
    const removed: string[] = [];
    const configDir = this.deps.runtime.getRuntimeDataRootDir();
    const result = await this.deps.cacheRepository.runTask(
      'stale-builtin-extension-cleanup',
      () => buildPrelaunchMaintenanceCacheKey({
        task: 'stale-builtin-extension-cleanup',
        configDir,
        staleBuiltinExtensionIds: this.deps.channelPluginProjection.listStaleBuiltinExtensionIds(),
        builtinChannelIds: this.deps.channelPluginProjection.listBuiltinChannelIds(),
        targets: this.deps.cacheRepository.directoryChildrenSignature(join(configDir, 'extensions')),
      }),
      async () => {
        for (const extensionId of this.deps.channelPluginProjection.listStaleBuiltinExtensionIds()) {
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
      () => buildChannelMaintenanceCacheKey(
        this.deps.runtime,
        this.deps.runtimePlugins,
        this.deps.channelPluginProjection,
        configuredChannels,
      ),
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
        this.deps.runtime,
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
