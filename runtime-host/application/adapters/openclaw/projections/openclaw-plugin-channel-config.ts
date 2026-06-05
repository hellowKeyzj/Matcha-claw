import { join } from 'node:path';
import type { PluginFileSystemPort } from '../../../../plugin-engine/plugin-file-system';
import {
  EXTERNAL_CHANNEL_PLUGIN_BINDINGS,
  PLUGIN_BACKED_CHANNEL_IDS,
  getExternalChannelPluginId,
  isBuiltinChannelId,
} from './openclaw-channel-plugin-bindings';
import type { OpenClawConfigRepositoryPort } from '../infrastructure/openclaw-config-repository';
import { cloneConfig, isRecord } from './openclaw-plugin-config-model';

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function getChannelAccountsMap(channelSection: Record<string, unknown>): Record<string, Record<string, unknown>> | null {
  if (!isRecord(channelSection.accounts)) {
    return null;
  }
  return channelSection.accounts as Record<string, Record<string, unknown>>;
}

function channelSectionHasEnabledAccount(sectionRaw: unknown): boolean {
  if (!isRecord(sectionRaw) || sectionRaw.enabled === false) {
    return false;
  }
  const accounts = isRecord(sectionRaw.accounts) ? sectionRaw.accounts : null;
  if (accounts) {
    return Object.values(accounts).some((item) => !isRecord(item) || item.enabled !== false);
  }
  return Object.entries(sectionRaw).some(([key, value]) => (
    key !== 'enabled'
    && key !== 'updatedAt'
    && key !== 'defaultAccount'
    && value !== undefined
    && value !== null
  ));
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

const DISCORD_GUILD_CHANNEL_KEYS_TO_KEEP = new Set([
  'autoArchiveDuration',
  'autoThread',
  'autoThreadName',
  'enabled',
  'ignoreOtherMentions',
  'includeThreadStarter',
  'requireMention',
  'roles',
  'skills',
  'systemPrompt',
  'tools',
  'toolsBySender',
  'users',
]);

function sanitizeDiscordGuildChannelConfig(channelConfig: unknown): void {
  if (!isRecord(channelConfig)) {
    return;
  }
  if (channelConfig.allow === false && channelConfig.enabled === undefined) {
    channelConfig.enabled = false;
  }
  for (const key of Object.keys(channelConfig)) {
    if (key === 'allow' || !DISCORD_GUILD_CHANNEL_KEYS_TO_KEEP.has(key)) {
      delete channelConfig[key];
    }
  }
}

function sanitizeDiscordGuilds(config: unknown): void {
  if (!isRecord(config) || !isRecord(config.guilds)) {
    return;
  }
  for (const guildConfig of Object.values(config.guilds)) {
    if (!isRecord(guildConfig) || !isRecord(guildConfig.channels)) {
      continue;
    }
    for (const channelConfig of Object.values(guildConfig.channels)) {
      sanitizeDiscordGuildChannelConfig(channelConfig);
    }
  }
}

function sanitizePluginBackedChannelSection(channelType: string, section: Record<string, unknown>): void {
  if (channelType !== 'discord') {
    return;
  }
  sanitizeDiscordGuilds(section);
  const accounts = getChannelAccountsMap(section);
  if (!accounts) {
    return;
  }
  for (const accountConfig of Object.values(accounts)) {
    sanitizeDiscordGuilds(accountConfig);
  }
}

function mirrorPluginBackedChannelState(config: Record<string, unknown>, channelType: string): void {
  if (!PLUGIN_BACKED_CHANNEL_IDS.has(channelType) || !isRecord(config.channels)) {
    return;
  }
  const pluginId = getExternalChannelPluginId(channelType);
  const channelSection = config.channels[channelType];
  if (!pluginId || !isRecord(channelSection)) {
    return;
  }
  sanitizePluginBackedChannelSection(channelType, channelSection);
  if (!isRecord(config.plugins)) {
    config.plugins = {};
  }
  const plugins = config.plugins as Record<string, unknown>;
  if (!isRecord(plugins.entries)) {
    plugins.entries = {};
  }
  const entries = plugins.entries as Record<string, unknown>;
  const entry = isRecord(entries[pluginId]) ? entries[pluginId] : {};
  entry.enabled = channelSection.enabled !== false;
  if (typeof channelSection.defaultAccount === 'string') {
    entry.defaultAccount = channelSection.defaultAccount;
  } else {
    delete entry.defaultAccount;
  }
  const accounts = getChannelAccountsMap(channelSection);
  if (accounts) {
    entry.accounts = cloneRecord(accounts);
  } else {
    delete entry.accounts;
  }
  entries[pluginId] = entry;
}

export function mirrorPluginBackedChannelStateToOpenClawConfig(config: Record<string, unknown>): Record<string, unknown> {
  const nextConfig = cloneConfig(config);
  const channels = isRecord(nextConfig.channels) ? nextConfig.channels : {};
  for (const channelType of Object.keys(channels)) {
    mirrorPluginBackedChannelState(nextConfig, channelType);
  }
  return nextConfig;
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
