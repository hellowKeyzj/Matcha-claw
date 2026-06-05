import { DEFAULT_ACCOUNT_ID } from '../../../../shared/runtime-host-constants';
import {
  BUILTIN_CHANNEL_IDS,
  EXTERNAL_CHANNEL_PLUGIN_BINDINGS,
  getExternalChannelPluginId,
  isChannelDerivedPluginId,
  STRICT_SCHEMA_CHANNEL_IDS,
} from './openclaw-channel-plugin-bindings';
import type { ChannelActivationMode, ChannelActivationStrategyPort } from '../../../channels/channel-activation-strategy';
import type { ChannelConfigProjectionPort } from '../../../channels/channel-runtime';
import type { CronDeliveryChannelProjectionPort } from '../../../cron/cron-model';
import type { RuntimePluginCatalogProjectionPort } from '../../../plugins/runtime-plugin-service';
import type { PrelaunchChannelPluginProjectionPort } from '../../../runtime-host/prelaunch-plugin-maintenance';

const CHANNEL_UNIQUE_CREDENTIAL_KEY: Record<string, string> = {
  feishu: 'appId',
  wecom: 'botId',
  dingtalk: 'clientId',
  telegram: 'botToken',
  discord: 'token',
  qqbot: 'appId',
  signal: 'phoneNumber',
  imessage: 'serverUrl',
  matrix: 'accessToken',
  line: 'channelAccessToken',
  msteams: 'appId',
  googlechat: 'serviceAccountKey',
  mattermost: 'botToken',
};

const WECHAT_CHANNEL_ALIAS = new Set(['wechat', 'openclaw-weixin']);
const LOGIN_SESSION_CHANNEL_TYPES = new Set(['whatsapp', 'openclaw-weixin']);

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

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeChannelConfigValue(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function normalizeCredentialString(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function isStrictSchemaChannel(channelType: string): boolean {
  return STRICT_SCHEMA_CHANNEL_IDS.has(channelType);
}

function usesTopLevelDefaultAccount(channelType: string): boolean {
  return channelType === 'feishu';
}

function isDefaultAccountId(accountId: string): boolean {
  return accountId.trim().toLowerCase() === DEFAULT_ACCOUNT_ID;
}

function getChannelAccountsMap(channelSection: Record<string, any>): Record<string, Record<string, any>> | null {
  if (!isRecord(channelSection.accounts)) {
    return null;
  }
  return channelSection.accounts as Record<string, Record<string, any>>;
}

function ensureChannelAccountsMap(channelSection: Record<string, any>): Record<string, Record<string, any>> {
  const accounts = getChannelAccountsMap(channelSection);
  if (accounts) {
    return accounts;
  }
  channelSection.accounts = {};
  return channelSection.accounts as Record<string, Record<string, any>>;
}

function cloneRecord(value: Record<string, any>): Record<string, any> {
  return JSON.parse(JSON.stringify(value)) as Record<string, any>;
}

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

function normalizeChannelBodyConfig(channelType: string, bodyConfig: Record<string, any>): Record<string, any> {
  const next = { ...bodyConfig };
  if (channelType === 'discord') {
    const guildId = normalizeChannelConfigValue(next.guildId).trim();
    const channelId = normalizeChannelConfigValue(next.channelId).trim();
    delete next.guildId;
    delete next.channelId;
    if (guildId) {
      const guilds = isRecord(next.guilds) ? cloneRecord(next.guilds) : {};
      const guild = isRecord(guilds[guildId]) ? guilds[guildId] : {};
      const channels = isRecord(guild.channels) ? guild.channels : {};
      channels[channelId || '*'] = {
        ...(isRecord(channels[channelId || '*']) ? channels[channelId || '*'] : {}),
        requireMention: true,
      };
      guild.channels = channels;
      guilds[guildId] = guild;
      next.guilds = guilds;
    }
    sanitizeDiscordGuilds(next);
  }
  if (channelType === 'whatsapp') {
    next.enabled = next.enabled ?? true;
  }
  return next;
}

function channelHasAnyAccount(channelType: string, channelSection: Record<string, any>): boolean {
  if (typeof channelSection.enabled === 'boolean' && channelSection.enabled === false) {
    return false;
  }
  if (usesTopLevelDefaultAccount(channelType)) {
    const uniqueKey = CHANNEL_UNIQUE_CREDENTIAL_KEY[channelType];
    if (uniqueKey && normalizeChannelConfigValue(channelSection[uniqueKey]).trim().length > 0) {
      return true;
    }
  }
  if (isStrictSchemaChannel(channelType) && !getChannelAccountsMap(channelSection)) {
    return Object.entries(channelSection).some(([key, value]) => (
      key !== 'enabled'
      && key !== 'updatedAt'
      && normalizeChannelConfigValue(value).trim().length > 0
    ));
  }
  const accounts = getChannelAccountsMap(channelSection);
  if (!accounts) {
    return false;
  }
  return Object.entries(accounts).some(([accountId, item]) => (
    accountId.trim().length > 0
    && (!isRecord(item) || item.enabled !== false)
  ));
}

function assertNoDuplicateCredential(
  channelType: string,
  channelSection: Record<string, any>,
  resolvedAccountId: string,
  nextAccountConfig: Record<string, any>,
): void {
  const uniqueKey = CHANNEL_UNIQUE_CREDENTIAL_KEY[channelType];
  if (!uniqueKey) {
    return;
  }

  const incomingValue = normalizeCredentialString(nextAccountConfig[uniqueKey]);
  if (!incomingValue) {
    return;
  }

  if (
    usesTopLevelDefaultAccount(channelType)
    && !isDefaultAccountId(resolvedAccountId)
    && normalizeCredentialString(channelSection[uniqueKey]) === incomingValue
  ) {
    throw new Error(
      `The ${channelType} bot (${uniqueKey}: ${incomingValue}) is already bound to another agent (account: ${DEFAULT_ACCOUNT_ID}). Each agent must use a unique bot.`,
    );
  }

  const accounts = getChannelAccountsMap(channelSection) ?? {};
  for (const [existingAccountId, accountConfig] of Object.entries(accounts)) {
    if (existingAccountId === resolvedAccountId || !isRecord(accountConfig)) {
      continue;
    }
    const existingValue = normalizeCredentialString(accountConfig[uniqueKey]);
    if (existingValue && existingValue === incomingValue) {
      throw new Error(
        `The ${channelType} bot (${uniqueKey}: ${incomingValue}) is already bound to another agent (account: ${existingAccountId}). Each agent must use a unique bot.`,
      );
    }
  }
}

function getChannelAccountConfig(channelType: string, channelSection: Record<string, any>, accountId: string) {
  if (isStrictSchemaChannel(channelType) && !getChannelAccountsMap(channelSection)) {
    return channelSection;
  }
  if (usesTopLevelDefaultAccount(channelType) && isDefaultAccountId(accountId)) {
    const { accounts: _accounts, defaultAccount: _defaultAccount, ...topLevel } = channelSection;
    const uniqueKey = CHANNEL_UNIQUE_CREDENTIAL_KEY[channelType];
    if (uniqueKey && normalizeChannelConfigValue(topLevel[uniqueKey]).trim().length > 0) {
      return topLevel;
    }
  }
  const accounts = getChannelAccountsMap(channelSection) ?? {};
  if (isRecord(accounts[accountId])) {
    return accounts[accountId];
  }
  if (isRecord(accounts[DEFAULT_ACCOUNT_ID])) {
    return accounts[DEFAULT_ACCOUNT_ID];
  }
  const firstEntry = Object.values(accounts).find((entry) => isRecord(entry));
  return isRecord(firstEntry) ? firstEntry : {};
}

export class OpenClawChannelPluginProjection implements PrelaunchChannelPluginProjectionPort, RuntimePluginCatalogProjectionPort, CronDeliveryChannelProjectionPort, ChannelActivationStrategyPort {
  resolveChannelActivationMode(channelType: string): ChannelActivationMode {
    return LOGIN_SESSION_CHANNEL_TYPES.has(channelType) ? 'login-session' : 'direct-config';
  }

  normalizeDeliveryChannel(channel: string): string {
    const normalized = channel.trim();
    return WECHAT_CHANNEL_ALIAS.has(normalized) ? 'openclaw-weixin' : normalized;
  }

  requiresDeliveryTarget(channel: string): boolean {
    return WECHAT_CHANNEL_ALIAS.has(channel.trim());
  }

  getDeliveryTargetLabel(channel: string): string {
    return WECHAT_CHANNEL_ALIAS.has(channel.trim()) ? 'WeChat' : 'Channel';
  }

  isChannelDerivedPluginId(pluginId: string): boolean {
    return isChannelDerivedPluginId(pluginId);
  }

  getConfiguredPluginIds(configuredChannels: readonly string[]): string[] {
    return configuredChannels
      .map((channelType) => getExternalChannelPluginId(channelType))
      .filter((pluginId): pluginId is string => typeof pluginId === 'string' && pluginId.trim().length > 0)
      .sort((left, right) => left.localeCompare(right, 'en'));
  }

  listKnownPluginIds(): string[] {
    return EXTERNAL_CHANNEL_PLUGIN_BINDINGS
      .flatMap((binding) => [binding.pluginId, ...(binding.legacyPluginIds ?? [])])
      .sort((left, right) => left.localeCompare(right, 'en'));
  }

  listStaleBuiltinExtensionIds(): string[] {
    return ['telegram'];
  }

  listBuiltinChannelIds(): string[] {
    return [...BUILTIN_CHANNEL_IDS].sort((left, right) => left.localeCompare(right, 'en'));
  }
}

export class OpenClawChannelConfigProjection implements ChannelConfigProjectionPort {
  getChannelPluginId(channelType: string): string | null {
    return getExternalChannelPluginId(channelType) ?? null;
  }

  listConfiguredChannels(config: Record<string, unknown>): string[] {
    const channels: string[] = [];
    const channelsSection = isRecord(config.channels) ? config.channels : {};
    for (const [channelType, sectionRaw] of Object.entries(channelsSection)) {
      if (!isRecord(sectionRaw)) {
        continue;
      }
      if (channelHasAnyAccount(channelType, sectionRaw)) {
        channels.push(channelType);
      }
    }

    return [...new Set(channels)];
  }

  saveChannelConfig(config: Record<string, unknown>, input: Record<string, unknown>, nowIso: string): void {
    const channelType = typeof input.channelType === 'string' ? input.channelType.trim() : '';
    if (!channelType) {
      throw new Error('channelType is required');
    }
    const accountId = typeof input.accountId === 'string' && input.accountId.trim()
      ? input.accountId.trim()
      : DEFAULT_ACCOUNT_ID;
    const staleAccountIds = Array.isArray(input.staleAccountIds)
      ? input.staleAccountIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];

    if (!isRecord(config.channels)) {
      config.channels = {};
    }
    const channels = config.channels as Record<string, any>;
    if (!isRecord(channels[channelType])) {
      channels[channelType] = {};
    }

    const section = channels[channelType] as Record<string, any>;
    const bodyConfig = normalizeChannelBodyConfig(channelType, isRecord(input.config) ? input.config : {});
    if (isStrictSchemaChannel(channelType)) {
      const nextAccountConfig = {
        ...section,
        ...bodyConfig,
      };
      assertNoDuplicateCredential(channelType, section, accountId, nextAccountConfig);
      delete section.accounts;
      delete section.defaultAccount;
      delete nextAccountConfig.accounts;
      delete nextAccountConfig.defaultAccount;
      Object.assign(section, nextAccountConfig, {
        enabled: input.enabled !== false,
        updatedAt: nowIso,
      });
      return;
    }
    if (usesTopLevelDefaultAccount(channelType) && isDefaultAccountId(accountId)) {
      const nextAccountConfig = {
        ...section,
        ...bodyConfig,
      };
      assertNoDuplicateCredential(channelType, section, accountId, nextAccountConfig);
      delete nextAccountConfig.accounts;
      delete nextAccountConfig.defaultAccount;
      Object.assign(section, nextAccountConfig, {
        enabled: input.enabled !== false,
        updatedAt: nowIso,
      });
      const accounts = getChannelAccountsMap(section);
      if (accounts && Object.prototype.hasOwnProperty.call(accounts, DEFAULT_ACCOUNT_ID)) {
        delete accounts[DEFAULT_ACCOUNT_ID];
        if (Object.keys(accounts).length === 0) {
          delete section.accounts;
        }
      }
      return;
    }

    const accounts = ensureChannelAccountsMap(section);
    for (const staleAccountId of staleAccountIds) {
      if (staleAccountId !== accountId) {
        delete accounts[staleAccountId];
      }
    }
    const previous = isRecord(accounts[accountId]) ? accounts[accountId] : {};
    const nextAccountConfig = {
      ...previous,
      ...bodyConfig,
    };
    assertNoDuplicateCredential(channelType, section, accountId, nextAccountConfig);
    accounts[accountId] = {
      ...nextAccountConfig,
      enabled: input.enabled !== false,
      updatedAt: nowIso,
    };
    section.defaultAccount = accountId;
    section.enabled = input.enabled !== false;
  }

  getChannelFormValues(config: Record<string, unknown>, channelType: string, accountId?: string): Record<string, string> {
    if (!channelType) {
      return {};
    }
    const channels = isRecord(config.channels) ? config.channels : {};
    const section = isRecord(channels[channelType]) ? channels[channelType] : {};
    const selected = getChannelAccountConfig(channelType, section, accountId || DEFAULT_ACCOUNT_ID);
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(selected)) {
      if (key === 'enabled' || key === 'updatedAt') {
        continue;
      }
      const normalized = normalizeChannelConfigValue(value);
      if (normalized) {
        values[key] = normalized;
      }
    }
    return values;
  }

  deleteChannelConfig(config: Record<string, unknown>, channelType: string): void {
    if (!channelType) {
      throw new Error('channelType is required');
    }
    if (isRecord(config.channels) && Object.prototype.hasOwnProperty.call(config.channels, channelType)) {
      delete config.channels[channelType];
    }
  }
}
