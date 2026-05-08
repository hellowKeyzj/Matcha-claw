import { DEFAULT_ACCOUNT_ID } from '../../api/common/constants';
import { readOpenClawConfigJson, writeOpenClawConfigJson } from '../../api/storage/paths';
import {
  applyManuallyManagedPluginIdsToOpenClawConfig,
  readManuallyManagedPluginIdsFromConfig,
} from '../openclaw/openclaw-plugin-config-service';
import { ensureManagedPluginInstalled } from '../plugins/runtime-plugin-service';
import { withOpenClawConfigLock } from '../openclaw/openclaw-config-mutex';
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

async function reconcileChannelDerivedPluginStateLocal(config: Record<string, any>): Promise<Record<string, any>> {
  return await applyManuallyManagedPluginIdsToOpenClawConfig(
    config,
    readManuallyManagedPluginIdsFromConfig(config),
  ) as Record<string, any>;
}

export async function listConfiguredChannelsLocal() {
  const config = readOpenClawConfigJson();
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

export async function saveChannelConfigLocal(input: unknown) {
  if (!isRecord(input)) {
    throw new Error('Invalid channel config payload');
  }
  const channelType = typeof input.channelType === 'string' ? input.channelType.trim() : '';
  if (!channelType) {
    throw new Error('channelType is required');
  }
  const externalPluginId = getExternalChannelPluginId(channelType);
  if (externalPluginId && input.enabled !== false) {
    await ensureManagedPluginInstalled(externalPluginId);
  }

  await withOpenClawConfigLock(async () => {
    const accountId = typeof input.accountId === 'string' && input.accountId.trim()
      ? input.accountId.trim()
      : DEFAULT_ACCOUNT_ID;
    let config = readOpenClawConfigJson();
    cleanupLegacyBuiltInChannelPluginRegistrationLocal(config, channelType);
    if (!isRecord(config.channels)) {
      config.channels = {};
    }
    if (!isRecord(config.channels[channelType])) {
      config.channels[channelType] = {};
    }

    const section = config.channels[channelType];
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
        updatedAt: new Date().toISOString(),
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
        updatedAt: new Date().toISOString(),
      };
      section.defaultAccount = typeof section.defaultAccount === 'string' && section.defaultAccount.trim()
        ? section.defaultAccount
        : accountId;
      section.enabled = input.enabled !== false;
    }
    config = await reconcileChannelDerivedPluginStateLocal(config);
    await writeOpenClawConfigJson(config);
  });
}

export async function setChannelEnabledLocal(channelType: string, enabled: boolean) {
  const externalPluginId = getExternalChannelPluginId(channelType);
  if (enabled && externalPluginId) {
    await ensureManagedPluginInstalled(externalPluginId);
  }
  await withOpenClawConfigLock(async () => {
    if (!channelType) {
      throw new Error('channelType is required');
    }
    let config = readOpenClawConfigJson();
    if (!isRecord(config.channels)) {
      config.channels = {};
    }
    if (!isRecord(config.channels[channelType])) {
      config.channels[channelType] = {};
    }
    const section = config.channels[channelType];
    section.enabled = enabled;
    const accounts = getChannelAccountsMap(section);
    if (accounts) {
      for (const account of Object.values(accounts)) {
        if (!isRecord(account)) {
          continue;
        }
        account.enabled = enabled;
        account.updatedAt = new Date().toISOString();
      }
    }
    config = await reconcileChannelDerivedPluginStateLocal(config);
    await writeOpenClawConfigJson(config);
  });
}

export async function getChannelFormValuesLocal(channelType: string, accountId?: string) {
  if (!channelType) {
    return {};
  }
  const config = readOpenClawConfigJson();
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

export async function deleteChannelConfigLocal(channelType: string) {
  await withOpenClawConfigLock(async () => {
    if (!channelType) {
      throw new Error('channelType is required');
    }
    let config = readOpenClawConfigJson();
    if (isRecord(config.channels) && Object.prototype.hasOwnProperty.call(config.channels, channelType)) {
      delete config.channels[channelType];
    }
    config = await reconcileChannelDerivedPluginStateLocal(config);
    await writeOpenClawConfigJson(config);
  });
}

export async function validateChannelConfigLocal(channelType: string) {
  const configuredChannels = await listConfiguredChannelsLocal();
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

export async function validateChannelCredentialsLocal(_channelType: string, _config: Record<string, unknown>) {
  return {
    valid: true,
    errors: [],
    warnings: [],
  };
}
