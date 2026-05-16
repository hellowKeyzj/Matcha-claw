import { DEFAULT_ACCOUNT_ID } from '../../shared/runtime-host-constants';
import type { PluginFileSystemPort } from '../../plugin-engine/plugin-file-system';
import {
  applyManuallyManagedPluginIdsToOpenClawConfig,
  readManuallyManagedPluginIdsFromConfig,
} from '../openclaw/openclaw-plugin-config-service';
import { findChannelOpenClawPluginDefinition } from '../plugins/managed-plugin-definitions';
import type { ManagedPluginInstaller } from '../plugins/managed-plugin-installer';
import { withOpenClawConfigLock } from '../openclaw/openclaw-config-mutex';
import type { OpenClawConfigRepositoryPort } from '../openclaw/openclaw-config-repository';
import type { RuntimeClockPort } from '../common/runtime-ports';
import {
  LEGACY_BUILTIN_CHANNEL_PLUGIN_IDS,
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

function normalizeChannelConfigValueLocal(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function cleanupPluginContainer(config: Record<string, any>): void {
  if (!isRecord(config.plugins)) {
    return;
  }
  const plugins = config.plugins as Record<string, unknown>;
  if (Array.isArray(plugins.allow) && plugins.allow.length === 0) {
    delete plugins.allow;
  }
  if (isRecord(plugins.entries) && Object.keys(plugins.entries).length === 0) {
    delete plugins.entries;
  }
  if (Object.keys(plugins).length === 0) {
    delete config.plugins;
  }
}

function removePluginRegistration(config: Record<string, any>, pluginId: string): boolean {
  if (!isRecord(config.plugins)) {
    return false;
  }

  const plugins = config.plugins as Record<string, unknown>;
  let modified = false;

  if (Array.isArray(plugins.allow)) {
    const allow = plugins.allow.filter((item): item is string => typeof item === 'string');
    const nextAllow = allow.filter((item) => item !== pluginId);
    if (nextAllow.length !== allow.length) {
      plugins.allow = nextAllow;
      modified = true;
    }
  }

  if (isRecord(plugins.entries) && Object.prototype.hasOwnProperty.call(plugins.entries, pluginId)) {
    delete (plugins.entries as Record<string, unknown>)[pluginId];
    modified = true;
  }

  if (modified) {
    cleanupPluginContainer(config);
  }

  return modified;
}

function cleanupLegacyBuiltInChannelPluginRegistrationLocal(config: Record<string, any>, channelType: string): boolean {
  if (!LEGACY_BUILTIN_CHANNEL_PLUGIN_IDS.has(channelType)) {
    return false;
  }
  return removePluginRegistration(config, channelType);
}

function isStrictSchemaChannel(channelType: string): boolean {
  return STRICT_SCHEMA_CHANNEL_IDS.has(channelType);
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

function channelHasAnyAccount(channelType: string, channelSection: Record<string, any>): boolean {
  if (typeof channelSection.enabled === 'boolean' && channelSection.enabled === false) {
    return false;
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

    await withOpenClawConfigLock(async () => {
      const config = await reconcileChannelDerivedPluginStateLocal(this.configRepository, this.pluginFileSystem, await this.configRepository.read());
      await this.configRepository.write(config);
    });

    return configuredChannels;
  }

  async saveChannelConfig(input: unknown) {
    if (!isRecord(input)) {
      throw new Error('Invalid channel config payload');
    }
    const channelType = typeof input.channelType === 'string' ? input.channelType.trim() : '';
    if (!channelType) {
      throw new Error('channelType is required');
    }

    await withOpenClawConfigLock(async () => {
      const accountId = typeof input.accountId === 'string' && input.accountId.trim()
        ? input.accountId.trim()
        : DEFAULT_ACCOUNT_ID;
      let config = await this.configRepository.read();
      cleanupLegacyBuiltInChannelPluginRegistrationLocal(config, channelType);
      if (!isRecord(config.channels)) {
        config.channels = {};
      }
      const channels = config.channels as Record<string, any>;
      if (!isRecord(channels[channelType])) {
        channels[channelType] = {};
      }

      const section = channels[channelType] as Record<string, any>;
      const bodyConfig = isRecord(input.config) ? input.config : {};
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
      } else {
        const accounts = ensureChannelAccountsMap(section);
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
        section.defaultAccount = typeof section.defaultAccount === 'string' && section.defaultAccount.trim()
          ? section.defaultAccount
          : accountId;
        section.enabled = input.enabled !== false;
      }
      config = await reconcileChannelDerivedPluginStateLocal(this.configRepository, this.pluginFileSystem, config);
      await this.configRepository.write(config);
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
    await withOpenClawConfigLock(async () => {
      if (!channelType) {
        throw new Error('channelType is required');
      }
      let config = await this.configRepository.read();
      if (isRecord(config.channels) && Object.prototype.hasOwnProperty.call(config.channels, channelType)) {
        delete config.channels[channelType];
      }
      config = await reconcileChannelDerivedPluginStateLocal(this.configRepository, this.pluginFileSystem, config);
      await this.configRepository.write(config);
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
