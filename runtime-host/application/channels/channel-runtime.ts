import { DEFAULT_ACCOUNT_ID } from '../../api/common/constants';
import { readOpenClawConfigJson, writeOpenClawConfigJson } from '../../api/storage/paths';

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
    const accounts = isRecord(sectionRaw.accounts) ? sectionRaw.accounts : null;
    if (accounts) {
      const hasEnabledAccount = Object.values(accounts).some((item) => !isRecord(item) || item.enabled !== false);
      if (hasEnabledAccount) {
        channels.push(channelType);
        continue;
      }
    }
    if (Object.keys(sectionRaw).length > 0) {
      channels.push(channelType);
    }
  }

  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  if (isRecord(entries.whatsapp) && entries.whatsapp.enabled !== false && !channels.includes('whatsapp')) {
    channels.push('whatsapp');
  }
  if (isRecord(entries['openclaw-weixin']) && entries['openclaw-weixin'].enabled !== false && !channels.includes('openclaw-weixin')) {
    channels.push('openclaw-weixin');
  }

  return [...new Set(channels)];
}

function ensurePluginAllowlistLocal(config: Record<string, any>, channelType: string) {
  if (!isRecord(config.plugins)) {
    config.plugins = {};
  }
  if (!Array.isArray(config.plugins.allow)) {
    config.plugins.allow = [];
  }
  const allowSet = new Set(config.plugins.allow.filter((item: unknown) => typeof item === 'string'));
  allowSet.add(channelType);
  config.plugins.allow = [...allowSet];
}

function getChannelAccountConfigLocal(channelSection: Record<string, any>, accountId: string) {
  const accounts = isRecord(channelSection.accounts) ? channelSection.accounts : {};
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
  const accountId = typeof input.accountId === 'string' && input.accountId.trim()
    ? input.accountId.trim()
    : DEFAULT_ACCOUNT_ID;
  const config = readOpenClawConfigJson();
  ensurePluginAllowlistLocal(config, channelType);
  if (!isRecord(config.channels)) {
    config.channels = {};
  }
  if (!isRecord(config.channels[channelType])) {
    config.channels[channelType] = {};
  }

  const section = config.channels[channelType];
  if (!isRecord(section.accounts)) {
    section.accounts = {};
  }
  const previous = isRecord(section.accounts[accountId]) ? section.accounts[accountId] : {};
  const bodyConfig = isRecord(input.config) ? input.config : {};
  section.accounts[accountId] = {
    ...previous,
    ...bodyConfig,
    enabled: input.enabled !== false,
    updatedAt: new Date().toISOString(),
  };
  section.enabled = input.enabled !== false;
  await writeOpenClawConfigJson(config);
}

export async function setChannelEnabledLocal(channelType: string, enabled: boolean) {
  if (!channelType) {
    throw new Error('channelType is required');
  }
  const config = readOpenClawConfigJson();
  if (!isRecord(config.channels)) {
    config.channels = {};
  }
  if (!isRecord(config.channels[channelType])) {
    config.channels[channelType] = {};
  }
  const section = config.channels[channelType];
  section.enabled = enabled;
  if (isRecord(section.accounts)) {
    for (const account of Object.values(section.accounts)) {
      if (!isRecord(account)) {
        continue;
      }
      account.enabled = enabled;
      account.updatedAt = new Date().toISOString();
    }
  }
  await writeOpenClawConfigJson(config);
}

export async function getChannelFormValuesLocal(channelType: string, accountId?: string) {
  if (!channelType) {
    return {};
  }
  const config = readOpenClawConfigJson();
  const channels = isRecord(config.channels) ? config.channels : {};
  const section = isRecord(channels[channelType]) ? channels[channelType] : {};
  const selected = getChannelAccountConfigLocal(section, accountId || DEFAULT_ACCOUNT_ID);
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
  if (!channelType) {
    throw new Error('channelType is required');
  }
  const config = readOpenClawConfigJson();
  if (isRecord(config.channels) && Object.prototype.hasOwnProperty.call(config.channels, channelType)) {
    delete config.channels[channelType];
    await writeOpenClawConfigJson(config);
  }
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
