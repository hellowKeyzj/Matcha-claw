export const PLUGIN_GROUP_REGISTRY = [
  {
    id: 'channel',
    labelKey: 'plugins:catalog.groups.channel',
  },
  {
    id: 'model',
    labelKey: 'plugins:catalog.groups.model',
  },
  {
    id: 'general',
    labelKey: 'plugins:catalog.groups.general',
  },
] as const;

export type PluginGroupId = (typeof PLUGIN_GROUP_REGISTRY)[number]['id'];

export const DEFAULT_PLUGIN_GROUP_ID: PluginGroupId = PLUGIN_GROUP_REGISTRY[0].id;
