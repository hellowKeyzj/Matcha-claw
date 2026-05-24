export interface ExternalChannelPluginBinding {
  readonly channelType: string;
  readonly pluginId: string;
  readonly legacyPluginIds?: readonly string[];
}

export const EXTERNAL_CHANNEL_PLUGIN_BINDINGS: readonly ExternalChannelPluginBinding[] = [
  {
    channelType: 'dingtalk',
    pluginId: 'dingtalk',
  },
  {
    channelType: 'feishu',
    pluginId: 'openclaw-lark',
    legacyPluginIds: ['feishu-openclaw-plugin'],
  },
  {
    channelType: 'wecom',
    pluginId: 'wecom',
    legacyPluginIds: ['wecom-openclaw-plugin'],
  },
  {
    channelType: 'qqbot',
    pluginId: 'qqbot',
  },
  {
    channelType: 'openclaw-weixin',
    pluginId: 'openclaw-weixin',
  },
  {
    channelType: 'discord',
    pluginId: 'discord',
  },
  {
    channelType: 'whatsapp',
    pluginId: 'whatsapp',
  },
] as const;

export const PLUGIN_BACKED_CHANNEL_IDS = new Set(['discord', 'qqbot', 'whatsapp']);

export const BUILTIN_CHANNEL_IDS = new Set([
  'telegram',
  'slack',
  'signal',
  'imessage',
  'matrix',
  'line',
  'msteams',
  'googlechat',
  'mattermost',
]);

export const STRICT_SCHEMA_CHANNEL_IDS = new Set(['dingtalk']);

const externalChannelPluginIdByType = new Map<string, string>();
const externalChannelTypeByPluginId = new Map<string, string>();

for (const binding of EXTERNAL_CHANNEL_PLUGIN_BINDINGS) {
  externalChannelPluginIdByType.set(binding.channelType, binding.pluginId);
  externalChannelTypeByPluginId.set(binding.pluginId, binding.channelType);
  for (const legacyPluginId of binding.legacyPluginIds ?? []) {
    externalChannelTypeByPluginId.set(legacyPluginId, binding.channelType);
  }
}

export function getExternalChannelPluginId(channelType: string): string | undefined {
  return externalChannelPluginIdByType.get(channelType);
}

export function getExternalChannelTypeByPluginId(pluginId: string): string | undefined {
  return externalChannelTypeByPluginId.get(pluginId);
}

export function isBuiltinChannelId(channelId: string): boolean {
  return BUILTIN_CHANNEL_IDS.has(channelId);
}

export function isChannelDerivedPluginId(pluginId: string): boolean {
  return isBuiltinChannelId(pluginId)
    || getExternalChannelTypeByPluginId(pluginId) !== undefined;
}
