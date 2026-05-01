import { access, cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getOpenClawConfigDir } from '../../api/storage/paths';
import {
  MANAGED_OPENCLAW_PLUGIN_DEFINITIONS,
  findManagedOpenClawPluginDefinition,
  type ManagedPluginCompanionSkillDefinition,
} from './managed-plugin-definitions';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pathExists(pathname: string): Promise<boolean> {
  return access(pathname).then(() => true).catch(() => false);
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

function getCompanionSkillsRootCandidates(): string[] {
  const roots = [
    join(process.cwd(), 'resources', 'skills', 'plugin-companion-skills'),
  ];

  if (typeof process.resourcesPath === 'string' && process.resourcesPath.trim()) {
    roots.push(
      join(process.resourcesPath, 'resources', 'skills', 'plugin-companion-skills'),
      join(process.resourcesPath, 'skills', 'plugin-companion-skills'),
    );
  }

  return [...new Set(roots)];
}

async function resolveCompanionSkillSourceDir(
  definition: ManagedPluginCompanionSkillDefinition,
): Promise<string | null> {
  for (const root of getCompanionSkillsRootCandidates()) {
    const candidate = join(root, definition.sourceDir);
    if (await pathExists(join(candidate, 'SKILL.md'))) {
      return candidate;
    }
  }
  return null;
}

function resolveCompanionSkillDefinitions(pluginId: string): readonly ManagedPluginCompanionSkillDefinition[] {
  return findManagedOpenClawPluginDefinition(pluginId)?.companionSkills ?? [];
}

export function getCompanionSkillSlugsForPlugin(pluginId: string): readonly string[] {
  return resolveCompanionSkillDefinitions(pluginId).map((definition) => definition.slug);
}

export function applyCompanionSkillConfigState(
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

export function reconcileCompanionSkillConfigStates(
  config: Record<string, unknown>,
  enabledPluginIds: readonly string[],
): Record<string, unknown> {
  const enabledPluginIdSet = new Set(enabledPluginIds);

  for (const definition of MANAGED_OPENCLAW_PLUGIN_DEFINITIONS) {
    applyCompanionSkillConfigState(config, definition.id, enabledPluginIdSet.has(definition.id));
  }

  return config;
}

export async function ensureCompanionSkillsInstalled(pluginId: string): Promise<void> {
  const definitions = resolveCompanionSkillDefinitions(pluginId);
  if (definitions.length === 0) {
    return;
  }

  const skillsRoot = join(getOpenClawConfigDir(), 'skills');
  await mkdir(skillsRoot, { recursive: true });

  for (const definition of definitions) {
    const targetDir = join(skillsRoot, definition.slug);
    if (existsSync(join(targetDir, 'SKILL.md'))) {
      continue;
    }

    const sourceDir = await resolveCompanionSkillSourceDir(definition);
    if (!sourceDir) {
      throw new Error(`Companion skill source not found for ${pluginId}: ${definition.slug}`);
    }

    await cp(sourceDir, targetDir, { recursive: true, force: true });
  }
}
