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

export const MANAGED_OPENCLAW_PLUGIN_DEFINITIONS: readonly ManagedOpenClawPluginDefinition[] = [
  {
    id: 'dingtalk',
    sourceDirs: ['dingtalk'],
  },
  {
    id: 'openclaw-lark',
    sourceDirs: ['openclaw-lark', 'feishu-openclaw-plugin'],
  },
  {
    id: 'wecom',
    sourceDirs: ['wecom', 'wecom-openclaw-plugin'],
  },
  {
    id: 'openclaw-qqbot',
    sourceDirs: ['openclaw-qqbot', 'qqbot'],
  },
  {
    id: 'openclaw-weixin',
    sourceDirs: ['openclaw-weixin'],
  },
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
] as const;

export function findManagedOpenClawPluginDefinition(
  pluginId: string,
): ManagedOpenClawPluginDefinition | undefined {
  return MANAGED_OPENCLAW_PLUGIN_DEFINITIONS.find((definition) => definition.id === pluginId);
}
