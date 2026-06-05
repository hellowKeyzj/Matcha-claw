import { join } from 'node:path';
import type { PluginFileSystemPort } from '../../plugin-engine/plugin-file-system';
import type { ManagedPluginCatalogPort, ManagedPluginCompanionSkillDefinition } from '../../plugins/managed-plugin-catalog';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ensureRecord(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const currentValue = target[key];
  if (isRecord(currentValue)) {
    return currentValue;
  }
  const nextValue: Record<string, unknown> = {};
  target[key] = nextValue;
  return nextValue;
}

export interface PluginCompanionSkillWorkspacePort {
  getCompanionSkillRootCandidates(): readonly string[];
  getSkillsRootDir(): string;
}

export interface PluginCompanionSkillWorkflowDeps {
  readonly workspace: PluginCompanionSkillWorkspacePort;
  readonly fileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'ensureDirectory' | 'copyDirectory'>;
  readonly managedPluginCatalog: ManagedPluginCatalogPort;
}

export class PluginCompanionSkillWorkflow {
  constructor(private readonly deps: PluginCompanionSkillWorkflowDeps) {}

  getSlugsForPlugin(pluginId: string): readonly string[] {
    return this.resolveDefinitions(pluginId).map((definition) => definition.slug);
  }

  applyConfigState(
    config: Record<string, unknown>,
    pluginId: string,
    enabled: boolean,
  ): Record<string, unknown> {
    const definitions = this.resolveDefinitions(pluginId).filter((definition) => definition.autoEnable);
    if (definitions.length === 0) {
      return config;
    }

    const skills = ensureRecord(config, 'skills');
    const entries = ensureRecord(skills, 'entries');

    for (const definition of definitions) {
      const currentEntry = isRecord(entries[definition.slug]) ? entries[definition.slug] as Record<string, unknown> : {};
      entries[definition.slug] = {
        ...currentEntry,
        enabled,
      };
    }

    return config;
  }

  reconcileConfigStates(
    config: Record<string, unknown>,
    enabledPluginIds: readonly string[],
  ): Record<string, unknown> {
    const enabledPluginIdSet = new Set(enabledPluginIds);

    for (const definition of this.deps.managedPluginCatalog.listCapabilityDefinitions()) {
      this.applyConfigState(config, definition.id, enabledPluginIdSet.has(definition.id));
    }

    return config;
  }

  async ensureInstalled(pluginId: string): Promise<void> {
    const definitions = this.resolveDefinitions(pluginId);
    if (definitions.length === 0) {
      return;
    }

    const skillsRoot = this.deps.workspace.getSkillsRootDir();
    await this.deps.fileSystem.ensureDirectory(skillsRoot);

    for (const definition of definitions) {
      const targetDir = join(skillsRoot, definition.slug);
      if (await this.deps.fileSystem.pathExists(join(targetDir, 'SKILL.md'))) {
        continue;
      }

      const sourceDir = await this.resolveSourceDir(definition);
      if (!sourceDir) {
        throw new Error(`Companion skill source not found for ${pluginId}: ${definition.slug}`);
      }

      await this.deps.fileSystem.copyDirectory(sourceDir, targetDir);
    }
  }

  private resolveDefinitions(pluginId: string): readonly ManagedPluginCompanionSkillDefinition[] {
    return this.deps.managedPluginCatalog.findCapabilityDefinition(pluginId)?.companionSkills ?? [];
  }

  private async resolveSourceDir(definition: ManagedPluginCompanionSkillDefinition): Promise<string | null> {
    for (const root of this.deps.workspace.getCompanionSkillRootCandidates()) {
      const candidate = join(root, definition.sourceDir);
      if (await this.deps.fileSystem.pathExists(join(candidate, 'SKILL.md'))) {
        return candidate;
      }
    }
    return null;
  }
}
