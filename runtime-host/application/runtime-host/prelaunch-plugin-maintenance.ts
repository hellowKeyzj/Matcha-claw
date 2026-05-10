import { join } from 'node:path';
import { getOpenClawConfigDir, getOpenClawDirPath } from '../../api/storage/paths';
import { createRuntimeLogger } from '../../shared/logger';
import {
  EXTERNAL_CHANNEL_PLUGIN_BINDINGS,
  getExternalChannelPluginId,
} from '../channels/channel-plugin-bindings';
import { listConfiguredChannelsLocal, reconcileConfiguredChannelPluginsLocal } from '../channels/channel-runtime';
import {
  ensureConfiguredManagedPluginsInstalled,
  getManagedPluginSourceSignatures,
  getManagedPluginTargetSignatures,
  listConfiguredManagedPluginIdsFromConfig,
} from '../plugins/runtime-plugin-service';
import {
  buildPrelaunchMaintenanceCacheKey,
  directoryChildrenSignature,
  runCachedPrelaunchMaintenanceTask,
} from './prelaunch-maintenance-cache';

const logger = createRuntimeLogger('prelaunch-plugin-maintenance');

async function buildChannelMaintenanceCacheKey(configuredChannels: readonly string[]): Promise<string> {
  const configuredPluginIds = configuredChannels
    .map((channelType) => getExternalChannelPluginId(channelType))
    .filter((pluginId): pluginId is string => typeof pluginId === 'string' && pluginId.trim().length > 0)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const knownChannelPluginIds = EXTERNAL_CHANNEL_PLUGIN_BINDINGS
    .flatMap((binding) => [binding.pluginId, ...(binding.legacyPluginIds ?? [])])
    .sort((left, right) => left.localeCompare(right, 'en'));

  return buildPrelaunchMaintenanceCacheKey({
    task: 'configured-channel-plugin-maintenance',
    openclawDir: getOpenClawDirPath(),
    configDir: getOpenClawConfigDir(),
    cwd: process.cwd(),
    configuredChannels: [...configuredChannels].sort((left, right) => left.localeCompare(right, 'en')),
    configuredPluginIds,
    sources: await getManagedPluginSourceSignatures(configuredPluginIds),
    targets: await getManagedPluginTargetSignatures(knownChannelPluginIds),
  });
}

async function buildManagedPluginMaintenanceCacheKey(enabledPluginIds: readonly string[]): Promise<string> {
  const normalizedEnabledPluginIds = [...enabledPluginIds].sort((left, right) => left.localeCompare(right, 'en'));
  return buildPrelaunchMaintenanceCacheKey({
    task: 'configured-managed-plugin-maintenance',
    openclawDir: getOpenClawDirPath(),
    configDir: getOpenClawConfigDir(),
    cwd: process.cwd(),
    enabledPluginIds: normalizedEnabledPluginIds,
    sources: await getManagedPluginSourceSignatures(normalizedEnabledPluginIds),
    targets: await getManagedPluginTargetSignatures(normalizedEnabledPluginIds),
    skillsDir: directoryChildrenSignature(join(getOpenClawConfigDir(), 'skills')),
  });
}

export async function reconcileConfiguredChannelPluginsForGatewayLaunch(): Promise<string[]> {
  const configuredChannels = await listConfiguredChannelsLocal();
  const result = await runCachedPrelaunchMaintenanceTask(
    'configured-channel-plugin-maintenance',
    () => buildChannelMaintenanceCacheKey(configuredChannels),
    async () => {
      await reconcileConfiguredChannelPluginsLocal(configuredChannels, { forceInstall: true });
    },
  );
  if (result.executed) {
    logger.info(`Gateway prelaunch channel plugin maintenance executed (${result.reason})`);
  }
  return configuredChannels;
}

export async function ensureConfiguredManagedPluginsForGatewayLaunch(): Promise<string[]> {
  const enabledPluginIds = listConfiguredManagedPluginIdsFromConfig();
  const result = await runCachedPrelaunchMaintenanceTask(
    'configured-managed-plugin-maintenance',
    () => buildManagedPluginMaintenanceCacheKey(enabledPluginIds),
    async () => {
      await ensureConfiguredManagedPluginsInstalled({ forceInstall: true });
    },
  );
  if (result.executed) {
    logger.info(`Gateway prelaunch managed plugin maintenance executed (${result.reason})`);
  }
  return enabledPluginIds;
}
