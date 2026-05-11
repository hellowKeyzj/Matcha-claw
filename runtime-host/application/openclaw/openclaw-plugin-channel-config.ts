import { join } from 'node:path';
import type { PluginFileSystemPort } from '../../plugin-engine/plugin-file-system';
import {
  EXTERNAL_CHANNEL_PLUGIN_BINDINGS,
  isBuiltinChannelId,
} from '../channels/channel-plugin-bindings';
import type { OpenClawConfigRepositoryPort } from './openclaw-config-repository';
import { isRecord } from './openclaw-plugin-config-model';

function channelSectionHasEnabledAccount(sectionRaw: unknown): boolean {
  if (!isRecord(sectionRaw) || sectionRaw.enabled === false) {
    return false;
  }
  const accounts = isRecord(sectionRaw.accounts) ? sectionRaw.accounts : null;
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((item) => !isRecord(item) || item.enabled !== false);
}

export function listConfiguredBuiltinChannelIdsFromConfig(config: Record<string, unknown>): string[] {
  const channels = isRecord(config.channels) ? config.channels : {};
  const configured: string[] = [];

  for (const [channelType, sectionRaw] of Object.entries(channels)) {
    if (!isBuiltinChannelId(channelType)) {
      continue;
    }
    if (channelSectionHasEnabledAccount(sectionRaw)) {
      configured.push(channelType);
    }
  }

  return configured.sort((left, right) => left.localeCompare(right, 'en'));
}

export function listConfiguredExternalChannelPluginIdsFromConfig(config: Record<string, unknown>): string[] {
  const channels = isRecord(config.channels) ? config.channels : {};
  const configured: string[] = [];

  for (const binding of EXTERNAL_CHANNEL_PLUGIN_BINDINGS) {
    if (channelSectionHasEnabledAccount(channels[binding.channelType])) {
      configured.push(binding.pluginId);
    }
  }

  return configured.sort((left, right) => left.localeCompare(right, 'en'));
}

export async function cleanupUnconfiguredExternalChannelPluginDirs(
  configRepository: OpenClawConfigRepositoryPort,
  pluginFileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'remove'>,
  config: Record<string, unknown>,
): Promise<void> {
  const configuredPluginIds = new Set(listConfiguredExternalChannelPluginIdsFromConfig(config));
  const extensionsDir = join(configRepository.getConfigDir(), 'extensions');

  for (const binding of EXTERNAL_CHANNEL_PLUGIN_BINDINGS) {
    if (configuredPluginIds.has(binding.pluginId)) {
      continue;
    }
    const pluginDir = join(extensionsDir, binding.pluginId);
    if (!(await pluginFileSystem.pathExists(pluginDir))) {
      continue;
    }
    await pluginFileSystem.remove(pluginDir);
  }
}
