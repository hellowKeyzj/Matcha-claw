export interface ManagedPluginCompanionSkillDefinition {
  readonly slug: string;
  readonly sourceDir: string;
  readonly autoEnable: boolean;
}

export interface ManagedOpenClawPluginDefinition {
  readonly id: string;
  readonly sourceDirs: readonly string[];
  readonly companionSkills?: readonly ManagedPluginCompanionSkillDefinition[];
}

export const CHANNEL_OPENCLAW_PLUGIN_DEFINITIONS: readonly ManagedOpenClawPluginDefinition[] = [
  { id: 'dingtalk', sourceDirs: ['dingtalk'] },
  { id: 'openclaw-lark', sourceDirs: ['openclaw-lark', 'feishu-openclaw-plugin'] },
  { id: 'wecom', sourceDirs: ['wecom', 'wecom-openclaw-plugin'] },
  { id: 'openclaw-qqbot', sourceDirs: ['openclaw-qqbot', 'qqbot'] },
  { id: 'openclaw-weixin', sourceDirs: ['openclaw-weixin'] },
] as const;

export const CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS: readonly ManagedOpenClawPluginDefinition[] = [
  {
    id: 'task-manager',
    sourceDirs: ['task-manager'],
  },
  {
    id: 'security-core',
    sourceDirs: ['security-core'],
  },
  {
    id: 'browser-relay',
    sourceDirs: ['browser-relay'],
    companionSkills: [
      {
        slug: 'browser-relay-skill',
        sourceDir: 'browser-relay-skill',
        autoEnable: true,
      },
    ],
  },
  {
    id: 'memory-lancedb-pro',
    sourceDirs: ['memory-lancedb-pro'],
    companionSkills: [
      {
        slug: 'memory-lancedb-pro-skill',
        sourceDir: 'memory-lancedb-pro-skill',
        autoEnable: true,
      },
    ],
  },
  {
    id: 'matchaclaw-media',
    sourceDirs: ['matchaclaw-media'],
  },
] as const;

export const MANAGED_OPENCLAW_PLUGIN_DEFINITIONS: readonly ManagedOpenClawPluginDefinition[] = [
  ...CHANNEL_OPENCLAW_PLUGIN_DEFINITIONS,
  ...CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS,
] as const;

export function findCapabilityOpenClawPluginDefinition(
  pluginId: string,
): ManagedOpenClawPluginDefinition | undefined {
  return CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS.find((definition) => definition.id === pluginId);
}

export function findChannelOpenClawPluginDefinition(
  pluginId: string,
): ManagedOpenClawPluginDefinition | undefined {
  return CHANNEL_OPENCLAW_PLUGIN_DEFINITIONS.find((definition) => definition.id === pluginId);
}

export function findManagedOpenClawPluginDefinition(
  pluginId: string,
): ManagedOpenClawPluginDefinition | undefined {
  return findCapabilityOpenClawPluginDefinition(pluginId)
    ?? findChannelOpenClawPluginDefinition(pluginId);
}
