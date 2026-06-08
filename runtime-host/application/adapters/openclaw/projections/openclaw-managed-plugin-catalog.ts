import type { ManagedPluginCatalogPort, ManagedPluginCompanionSkillDefinition, ManagedPluginDefinition } from '../../../plugins/managed-plugin-catalog';

export type OpenClawManagedPluginCompanionSkillDefinition = ManagedPluginCompanionSkillDefinition;
export type OpenClawManagedPluginDefinition = ManagedPluginDefinition;

export const CHANNEL_OPENCLAW_PLUGIN_DEFINITIONS: readonly OpenClawManagedPluginDefinition[] = [
  { id: 'dingtalk', sourceDirs: ['dingtalk'] },
  { id: 'openclaw-lark', sourceDirs: ['openclaw-lark', 'feishu-openclaw-plugin'] },
  { id: 'wecom', sourceDirs: ['wecom', 'wecom-openclaw-plugin'] },
  { id: 'qqbot', sourceDirs: ['qqbot'] },
  { id: 'openclaw-weixin', sourceDirs: ['openclaw-weixin'] },
  { id: 'discord', sourceDirs: ['discord'] },
  { id: 'whatsapp', sourceDirs: ['whatsapp'] },
] as const;

export const CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS: readonly OpenClawManagedPluginDefinition[] = [
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
  {
    id: 'team-runtime',
    sourceDirs: ['team-runtime'],
  },
] as const;

export const MANAGED_OPENCLAW_PLUGIN_DEFINITIONS: readonly OpenClawManagedPluginDefinition[] = [
  ...CHANNEL_OPENCLAW_PLUGIN_DEFINITIONS,
  ...CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS,
] as const;

export class OpenClawManagedPluginCatalog implements ManagedPluginCatalogPort {
  listCapabilityDefinitions(): readonly ManagedPluginDefinition[] {
    return CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS;
  }

  listChannelDefinitions(): readonly ManagedPluginDefinition[] {
    return CHANNEL_OPENCLAW_PLUGIN_DEFINITIONS;
  }

  findCapabilityDefinition(pluginId: string): ManagedPluginDefinition | undefined {
    return CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS.find((definition) => definition.id === pluginId);
  }

  findChannelDefinition(pluginId: string): ManagedPluginDefinition | undefined {
    return CHANNEL_OPENCLAW_PLUGIN_DEFINITIONS.find((definition) => definition.id === pluginId);
  }

  findDefinition(pluginId: string): ManagedPluginDefinition | undefined {
    return this.findCapabilityDefinition(pluginId) ?? this.findChannelDefinition(pluginId);
  }
}
