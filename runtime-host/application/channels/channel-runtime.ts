import { DEFAULT_ACCOUNT_ID } from '../../shared/runtime-host-constants';
import type { PluginFileSystemPort } from '../../plugin-engine/plugin-file-system';
import {
  applyManuallyManagedPluginIdsToOpenClawConfig,
  readManuallyManagedPluginIdsFromConfig,
} from '../openclaw/openclaw-plugin-config-service';
import { findChannelOpenClawPluginDefinition } from '../plugins/managed-plugin-definitions';
import type { ManagedPluginInstaller } from '../plugins/managed-plugin-installer';
import type { OpenClawConfigRepositoryPort } from '../openclaw/openclaw-config-repository';
import type { RuntimeClockPort } from '../common/runtime-ports';
import {
  PLUGIN_BACKED_CHANNEL_IDS,
  getExternalChannelPluginId,
  STRICT_SCHEMA_CHANNEL_IDS,
} from './channel-plugin-bindings';

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

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function replaceConfigContents(target: Record<string, any>, source: Record<string, any>): void {
  if (target === source) {
    return;
  }
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
}

function normalizeChannelConfigValueLocal(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function isStrictSchemaChannel(channelType: string): boolean {
  return STRICT_SCHEMA_CHANNEL_IDS.has(channelType);
}

function usesTopLevelDefaultAccount(channelType: string): boolean {
  return channelType === 'feishu';
}

function isPluginBackedChannel(channelType: string): boolean {
  return PLUGIN_BACKED_CHANNEL_IDS.has(channelType);
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

function cloneRecordLocal(value: Record<string, any>): Record<string, any> {
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
    const guildId = normalizeChannelConfigValueLocal(next.guildId).trim();
    const channelId = normalizeChannelConfigValueLocal(next.channelId).trim();
    delete next.guildId;
    delete next.channelId;
    if (guildId) {
      const guilds = isRecord(next.guilds) ? cloneRecordLocal(next.guilds) : {};
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

function sanitizeChannelSectionBeforeMirror(channelType: string, section: Record<string, any>): void {
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

function mirrorPluginBackedChannelState(config: Record<string, any>, channelType: string): void {
  if (!isPluginBackedChannel(channelType) || !isRecord(config.channels)) {
    return;
  }
  const pluginId = getExternalChannelPluginId(channelType);
  const channelSection = config.channels[channelType];
  if (!pluginId || !isRecord(channelSection)) {
    return;
  }
  sanitizeChannelSectionBeforeMirror(channelType, channelSection);
  if (!isRecord(config.plugins)) {
    config.plugins = {};
  }
  const plugins = config.plugins as Record<string, any>;
  if (!isRecord(plugins.entries)) {
    plugins.entries = {};
  }
  const entries = plugins.entries as Record<string, any>;
  const entry = isRecord(entries[pluginId]) ? entries[pluginId] : {};
  entry.enabled = channelSection.enabled !== false;
  if (typeof channelSection.defaultAccount === 'string') {
    entry.defaultAccount = channelSection.defaultAccount;
  } else {
    delete entry.defaultAccount;
  }
  const accounts = getChannelAccountsMap(channelSection);
  if (accounts) {
    entry.accounts = cloneRecordLocal(accounts);
  } else {
    delete entry.accounts;
  }
  entries[pluginId] = entry;
}

function channelHasAnyAccount(channelType: string, channelSection: Record<string, any>): boolean {
  if (typeof channelSection.enabled === 'boolean' && channelSection.enabled === false) {
    return false;
  }
  if (usesTopLevelDefaultAccount(channelType)) {
    const uniqueKey = CHANNEL_UNIQUE_CREDENTIAL_KEY[channelType];
    if (uniqueKey && normalizeChannelConfigValueLocal(channelSection[uniqueKey]).trim().length > 0) {
      return true;
    }
  }
  if (isStrictSchemaChannel(channelType) && !getChannelAccountsMap(channelSection)) {
    return Object.entries(channelSection).some(([key, value]) => (
      key !== 'enabled'
      && key !== 'updatedAt'
      && normalizeChannelConfigValueLocal(value).trim().length > 0
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

async function reconcileChannelDerivedPluginStateLocal(
  configRepository: OpenClawConfigRepositoryPort,
  pluginFileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'listDirectoryEntries'>,
  config: Record<string, any>,
): Promise<Record<string, any>> {
  return await applyManuallyManagedPluginIdsToOpenClawConfig(
    configRepository,
    pluginFileSystem,
    config,
    await readManuallyManagedPluginIdsFromConfig(configRepository, pluginFileSystem, config),
  ) as Record<string, any>;
}

export class ChannelConfigRepository {
  constructor(
    private readonly configRepository: OpenClawConfigRepositoryPort,
    private readonly pluginInstaller: ManagedPluginInstaller,
    private readonly pluginFileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'listDirectoryEntries'>,
    private readonly clock: RuntimeClockPort,
  ) {}

  async listConfiguredChannels() {
    const config = await this.configRepository.read();
    return listConfiguredChannelsFromConfig(config);
  }

  async reconcileConfiguredChannelPlugins(
    configuredChannelsInput?: readonly string[],
    options: { forceInstall?: boolean } = {},
  ): Promise<string[]> {
    const configuredChannels = configuredChannelsInput
      ? [...new Set(configuredChannelsInput)]
      : await this.listConfiguredChannels();

    for (const channelType of configuredChannels) {
      const externalPluginId = getExternalChannelPluginId(channelType);
      if (externalPluginId) {
        await this.ensureChannelPluginInstalled(externalPluginId, { force: options.forceInstall === true });
      }
    }

    await this.configRepository.update(async (config) => {
      const nextConfig = await reconcileChannelDerivedPluginStateLocal(this.configRepository, this.pluginFileSystem, config);
      replaceConfigContents(config, nextConfig);
    });

    return configuredChannels;
  }

  async prepareChannelPlugin(channelType: string): Promise<void> {
    const externalPluginId = getExternalChannelPluginId(channelType.trim());
    if (!externalPluginId) {
      return;
    }
    await this.ensureChannelPluginInstalled(externalPluginId);
  }

  async saveChannelConfig(input: unknown) {
    if (!isRecord(input)) {
      throw new Error('Invalid channel config payload');
    }
    const channelType = typeof input.channelType === 'string' ? input.channelType.trim() : '';
    if (!channelType) {
      throw new Error('channelType is required');
    }

    // OpenClaw watches openclaw.json and reloads on changes. If we write
    // plugins.allow with an external channel plugin id (e.g. openclaw-lark)
    // before that plugin is materialized under ~/.openclaw/extensions/<id>,
    // OpenClaw classifies the config as invalid and reverts it to the
    // last-known-good snapshot, swallowing the user's channel configuration.
    // Install the plugin first so the upcoming reload sees a consistent state.
    await this.prepareChannelPlugin(channelType);

    await this.configRepository.update(async (config) => {
      const accountId = typeof input.accountId === 'string' && input.accountId.trim()
        ? input.accountId.trim()
        : DEFAULT_ACCOUNT_ID;
      const staleAccountIds = Array.isArray(input.staleAccountIds)
        ? input.staleAccountIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      let nextConfig = config;
      if (!isRecord(nextConfig.channels)) {
        nextConfig.channels = {};
      }
      const channels = nextConfig.channels as Record<string, any>;
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
          updatedAt: this.clock.nowIso(),
        });
      } else if (usesTopLevelDefaultAccount(channelType) && isDefaultAccountId(accountId)) {
        const nextAccountConfig = {
          ...section,
          ...bodyConfig,
        };
        assertNoDuplicateCredential(channelType, section, accountId, nextAccountConfig);
        delete nextAccountConfig.accounts;
        delete nextAccountConfig.defaultAccount;
        Object.assign(section, nextAccountConfig, {
          enabled: input.enabled !== false,
          updatedAt: this.clock.nowIso(),
        });
        const accounts = getChannelAccountsMap(section);
        if (accounts && Object.prototype.hasOwnProperty.call(accounts, DEFAULT_ACCOUNT_ID)) {
          delete accounts[DEFAULT_ACCOUNT_ID];
          if (Object.keys(accounts).length === 0) {
            delete section.accounts;
          }
        }
      } else {
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
          updatedAt: this.clock.nowIso(),
        };
        section.defaultAccount = accountId;
        section.enabled = input.enabled !== false;
      }
      mirrorPluginBackedChannelState(nextConfig, channelType);
      nextConfig = await reconcileChannelDerivedPluginStateLocal(this.configRepository, this.pluginFileSystem, nextConfig);
      replaceConfigContents(config, nextConfig);
    });
  }

  async getChannelFormValues(channelType: string, accountId?: string) {
    if (!channelType) {
      return {};
    }
    const config = await this.configRepository.read();
    const channels = isRecord(config.channels) ? config.channels : {};
    const section = isRecord(channels[channelType]) ? channels[channelType] : {};
    const selected = getChannelAccountConfigLocal(channelType, section, accountId || DEFAULT_ACCOUNT_ID);
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(selected)) {
      if (key === 'enabled' || key === 'updatedAt') {
        continue;
      }
      const normalized = normalizeChannelConfigValueLocal(value);
      if (normalized) {
        values[key] = normalized;
      }
    }
    return values;
  }

  async deleteChannelConfig(channelType: string) {
    await this.configRepository.update(async (config) => {
      if (!channelType) {
        throw new Error('channelType is required');
      }
      let nextConfig = config;
      if (isRecord(nextConfig.channels) && Object.prototype.hasOwnProperty.call(nextConfig.channels, channelType)) {
        delete nextConfig.channels[channelType];
      }
      nextConfig = await reconcileChannelDerivedPluginStateLocal(this.configRepository, this.pluginFileSystem, nextConfig);
      replaceConfigContents(config, nextConfig);
    });
  }

  async validateChannelConfig(channelType: string) {
    const configuredChannels = await this.listConfiguredChannels();
    const normalizedType = typeof channelType === 'string' ? channelType.trim() : '';
    if (!normalizedType) {
      return { valid: false, errors: ['channelType is required'], warnings: [] };
    }
    const valid = configuredChannels.includes(normalizedType);
    return {
      valid,
      errors: valid ? [] : [`Channel ${normalizedType} is not configured`],
      warnings: [],
    };
  }

  async validateChannelCredentials(_channelType: string, _config: Record<string, unknown>) {
    return {
      valid: true,
      errors: [],
      warnings: [],
    };
  }

  private async ensureChannelPluginInstalled(
    pluginId: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const definition = findChannelOpenClawPluginDefinition(pluginId);
    if (!definition) {
      return;
    }
    await this.pluginInstaller.ensureDefinitionInstalled(definition, options);
  }
}

export interface ChannelConfigPort extends Pick<
  ChannelConfigRepository,
  | 'listConfiguredChannels'
  | 'validateChannelConfig'
  | 'validateChannelCredentials'
  | 'prepareChannelPlugin'
  | 'saveChannelConfig'
  | 'getChannelFormValues'
  | 'deleteChannelConfig'
> {}

function listConfiguredChannelsFromConfig(config: Record<string, unknown>) {
  const channels: string[] = [];
  const channelsSection = isRecord(config.channels) ? config.channels : {};
  for (const [channelType, sectionRaw] of Object.entries(channelsSection)) {
    if (!isRecord(sectionRaw)) {
      continue;
    }
    if (sectionRaw.enabled === false) {
      continue;
    }
    if (channelHasAnyAccount(channelType, sectionRaw)) {
      channels.push(channelType);
    }
  }

  return [...new Set(channels)];
}

function normalizeCredentialString(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
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

function getChannelAccountConfigLocal(channelType: string, channelSection: Record<string, any>, accountId: string) {
  if (isStrictSchemaChannel(channelType) && !getChannelAccountsMap(channelSection)) {
    return channelSection;
  }
  if (usesTopLevelDefaultAccount(channelType) && isDefaultAccountId(accountId)) {
    const { accounts: _accounts, defaultAccount: _defaultAccount, ...topLevel } = channelSection;
    const uniqueKey = CHANNEL_UNIQUE_CREDENTIAL_KEY[channelType];
    if (uniqueKey && normalizeChannelConfigValueLocal(topLevel[uniqueKey]).trim().length > 0) {
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
