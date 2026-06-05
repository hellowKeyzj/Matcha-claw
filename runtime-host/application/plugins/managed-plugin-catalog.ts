import type { RuntimeHostCatalogPlugin } from '../../bootstrap/runtime-config';

export interface ManagedPluginCompanionSkillDefinition {
  readonly slug: string;
  readonly sourceDir: string;
  readonly autoEnable: boolean;
}

export interface ManagedPluginDefinition {
  readonly id: string;
  readonly sourceDirs: readonly string[];
  readonly companionSkills?: readonly ManagedPluginCompanionSkillDefinition[];
}

export interface ManagedRegistryPluginSnapshot extends RuntimeHostCatalogPlugin {
  readonly sourceDir: string;
  readonly manifestId: string;
}

export interface ManagedPluginCatalogPort {
  listCapabilityDefinitions(): readonly ManagedPluginDefinition[];
  listChannelDefinitions(): readonly ManagedPluginDefinition[];
  findCapabilityDefinition(pluginId: string): ManagedPluginDefinition | undefined;
  findChannelDefinition(pluginId: string): ManagedPluginDefinition | undefined;
  findDefinition(pluginId: string): ManagedPluginDefinition | undefined;
}

export interface ManagedPluginInstallerPort {
  discoverRegistryPlugin(definition: ManagedPluginDefinition): Promise<ManagedRegistryPluginSnapshot | null>;
  getSourceSignatures(pluginIds: readonly string[]): Promise<Record<string, unknown>>;
  getTargetSignatures(pluginIds: readonly string[]): Promise<Record<string, unknown>>;
  ensureDefinitionInstalled(definition: ManagedPluginDefinition, options?: { force?: boolean }): Promise<void>;
}
