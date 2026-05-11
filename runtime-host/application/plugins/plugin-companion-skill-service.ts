import { join } from 'node:path';
import type { PluginFileSystemPort } from '../../plugin-engine/plugin-file-system';
import type { OpenClawEnvironmentRepository } from '../openclaw/openclaw-environment-repository';
import type { OpenClawConfigRepositoryPort } from '../openclaw/openclaw-config-repository';
import {
  CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS,
  findCapabilityOpenClawPluginDefinition,
  type ManagedPluginCompanionSkillDefinition,
} from './managed-plugin-definitions';

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

async function resolveCompanionSkillSourceDir(
  environment: OpenClawEnvironmentRepository,
  fileSystem: Pick<PluginFileSystemPort, 'pathExists'>,
  definition: ManagedPluginCompanionSkillDefinition,
): Promise<string | null> {
  for (const root of environment.getCompanionSkillRootCandidates()) {
    const candidate = join(root, definition.sourceDir);
    if (await fileSystem.pathExists(join(candidate, 'SKILL.md'))) {
      return candidate;
    }
  }
  return null;
}

function resolveCompanionSkillDefinitions(pluginId: string): readonly ManagedPluginCompanionSkillDefinition[] {
  return findCapabilityOpenClawPluginDefinition(pluginId)?.companionSkills ?? [];
}

export class PluginCompanionSkillService {
  constructor(
    private readonly environment: OpenClawEnvironmentRepository,
    private readonly configRepository: OpenClawConfigRepositoryPort,
    private readonly fileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'ensureDirectory' | 'copyDirectory'>,
  ) {}

  getSlugsForPlugin(pluginId: string): readonly string[] {
    return resolveCompanionSkillDefinitions(pluginId).map((definition) => definition.slug);
  }

  applyConfigState(
  config: Record<string, unknown>,
  pluginId: string,
  enabled: boolean,
): Record<string, unknown> {
    const definitions = resolveCompanionSkillDefinitions(pluginId).filter((definition) => definition.autoEnable);
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

    for (const definition of CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS) {
      this.applyConfigState(config, definition.id, enabledPluginIdSet.has(definition.id));
    }

    return config;
  }

  async ensureInstalled(pluginId: string): Promise<void> {
    const definitions = resolveCompanionSkillDefinitions(pluginId);
    if (definitions.length === 0) {
      return;
    }

    const skillsRoot = join(this.configRepository.getConfigDir(), 'skills');
    await this.fileSystem.ensureDirectory(skillsRoot);

    for (const definition of definitions) {
      const targetDir = join(skillsRoot, definition.slug);
      if (await this.fileSystem.pathExists(join(targetDir, 'SKILL.md'))) {
        continue;
      }

      const sourceDir = await resolveCompanionSkillSourceDir(this.environment, this.fileSystem, definition);
      if (!sourceDir) {
        throw new Error(`Companion skill source not found for ${pluginId}: ${definition.slug}`);
      }

      await this.fileSystem.copyDirectory(sourceDir, targetDir);
    }
  }
}
