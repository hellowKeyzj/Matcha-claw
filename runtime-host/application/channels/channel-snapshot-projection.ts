/**
 * Channel snapshot projection.
 *
 * 单一事实源：ChannelConfigPort 提供的已配置渠道列表。
 * gateway `channels.status` 的缓存只用于富化每个已配置渠道的 status / accounts；
 * 缓存里残留但已不在配置中的渠道会被过滤掉，避免出现“删完还在”的视觉错位。
 */

export interface ProjectedChannelsSnapshot {
  channelOrder: string[];
  channels: Record<string, unknown>;
  channelAccounts: Record<string, unknown>;
  channelDefaultAccountId: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readSection(raw: unknown, key: string): Record<string, unknown> {
  if (!isRecord(raw)) {
    return {};
  }
  const section = raw[key];
  return isRecord(section) ? section : {};
}

export function projectChannelsSnapshot(
  configuredChannels: readonly string[],
  raw: unknown,
): ProjectedChannelsSnapshot {
  const rawChannels = readSection(raw, 'channels');
  const rawAccounts = readSection(raw, 'channelAccounts');
  const rawDefaults = readSection(raw, 'channelDefaultAccountId');

  const channels: Record<string, unknown> = {};
  const channelAccounts: Record<string, unknown> = {};
  const channelDefaultAccountId: Record<string, string> = {};

  for (const channelType of configuredChannels) {
    channels[channelType] = isRecord(rawChannels[channelType])
      ? { ...rawChannels[channelType], configured: true }
      : { configured: true };

    channelAccounts[channelType] = Array.isArray(rawAccounts[channelType])
      ? rawAccounts[channelType]
      : [];

    const defaultAccountId = rawDefaults[channelType];
    if (typeof defaultAccountId === 'string' && defaultAccountId.length > 0) {
      channelDefaultAccountId[channelType] = defaultAccountId;
    }
  }

  return {
    channelOrder: [...configuredChannels],
    channels,
    channelAccounts,
    channelDefaultAccountId,
  };
}
