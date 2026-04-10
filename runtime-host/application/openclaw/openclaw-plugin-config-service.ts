import { access, readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { readOpenClawConfigJson, writeOpenClawConfigJson } from '../../api/storage/paths';
import { normalizePluginIds } from '../../bootstrap/runtime-config';
import { createPluginDiscovery } from '../../plugin-engine/plugin-discovery';
import { withOpenClawConfigLock } from './openclaw-config-mutex';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

function readPluginAllowlist(config: Record<string, unknown>): string[] {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const allow = Array.isArray(plugins.allow) ? plugins.allow : [];
  return normalizePluginIds(
    allow.filter((item): item is string => typeof item === 'string'),
  );
}

export function readEnabledPluginIdsFromOpenClawConfig(): string[] {
  const config = readOpenClawConfigJson();
  const allow = readPluginAllowlist(config);
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const entries = isRecord(plugins.entries) ? plugins.entries : {};

  return allow.filter((pluginId) => {
    const entry = isRecord(entries[pluginId]) ? entries[pluginId] : null;
    return !entry || entry.enabled !== false;
  });
}

function cloneConfig(config: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

async function collectSkillIdsFromDeclaredPath(rootDir: string, declaredPath: string): Promise<string[]> {
  const resolvedPath = isAbsolute(declaredPath)
    ? declaredPath
    : resolve(join(rootDir, declaredPath));
  const skillManifestPath = join(resolvedPath, 'SKILL.md');
  if (await pathExists(skillManifestPath)) {
    return [basename(resolvedPath)];
  }

  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await readdir(resolvedPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const skillIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const childSkillManifestPath = join(resolvedPath, entry.name, 'SKILL.md');
    if (await pathExists(childSkillManifestPath)) {
      skillIds.push(entry.name);
    }
  }
  return skillIds;
}

async function discoverPluginSkillIdsByPluginId(): Promise<Map<string, string[]>> {
  const discovery = createPluginDiscovery();
  const discoveredPlugins = await discovery.discover();
  const result = new Map<string, string[]>();

  await Promise.all(discoveredPlugins.map(async (plugin) => {
    try {
      const raw = await readFile(plugin.manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const declaredSkills = Array.isArray(parsed.skills)
        ? parsed.skills.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      if (declaredSkills.length === 0) {
        return;
      }
      const skillIds = new Set<string>();
      for (const declaredPath of declaredSkills) {
        const resolved = await collectSkillIdsFromDeclaredPath(plugin.rootDir, declaredPath);
        for (const skillId of resolved) {
          if (skillId.trim()) {
            skillIds.add(skillId.trim());
          }
        }
      }
      if (skillIds.size > 0) {
        result.set(plugin.id, [...skillIds].sort((left, right) => left.localeCompare(right, 'en')));
      }
    } catch {
      // ignore malformed manifests
    }
  }));

  return result;
}

function cloneSkillEntries(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const skills = isRecord(config.skills) ? config.skills : {};
  const currentSkillEntries = isRecord(skills.entries) ? skills.entries : {};
  const nextSkillEntries: Record<string, Record<string, unknown>> = {};
  for (const [skillId, rawEntry] of Object.entries(currentSkillEntries)) {
    if (!isRecord(rawEntry)) {
      continue;
    }
    nextSkillEntries[skillId] = { ...rawEntry };
  }
  return nextSkillEntries;
}

export async function syncPluginSkillsToOpenClawConfig(enabledPluginIds: readonly string[]): Promise<void> {
  const enabledSet = new Set(normalizePluginIds(enabledPluginIds));
  const skillIdsByPluginId = await discoverPluginSkillIdsByPluginId();
  await withOpenClawConfigLock(async () => {
    const config = readOpenClawConfigJson();
    const nextSkillEntries = cloneSkillEntries(config);

    for (const [pluginId, skillIds] of skillIdsByPluginId.entries()) {
      const pluginEnabled = enabledSet.has(pluginId);
      for (const skillId of skillIds) {
        const currentEntry = nextSkillEntries[skillId] ?? {};
        nextSkillEntries[skillId] = {
          ...currentEntry,
          enabled: pluginEnabled,
        };
      }
    }

    const skills = isRecord(config.skills) ? { ...config.skills } : {};
    if (Object.keys(nextSkillEntries).length > 0) {
      skills.entries = nextSkillEntries;
    }

    await writeOpenClawConfigJson({
      ...config,
      ...(Object.keys(skills).length > 0 ? { skills } : {}),
    });
  });
}

export async function applyEnabledPluginIdsToOpenClawConfig(
  currentConfig: Record<string, unknown>,
  pluginIds: readonly string[],
): Promise<Record<string, unknown>> {
  const normalizedPluginIds = normalizePluginIds(pluginIds);
  const enabledSet = new Set(normalizedPluginIds);
  const config = cloneConfig(currentConfig);
  const plugins = isRecord(config.plugins) ? { ...config.plugins } : {};
  const currentEntries = isRecord(plugins.entries) ? plugins.entries : {};
  const nextEntries: Record<string, Record<string, unknown>> = {};

  for (const [pluginId, rawEntry] of Object.entries(currentEntries)) {
    if (!isRecord(rawEntry)) {
      continue;
    }
    nextEntries[pluginId] = { ...rawEntry };
  }

  for (const pluginId of normalizedPluginIds) {
    const currentEntry = nextEntries[pluginId] ?? {};
    nextEntries[pluginId] = {
      ...currentEntry,
      enabled: true,
    };
  }

  for (const [pluginId, rawEntry] of Object.entries(nextEntries)) {
    if (enabledSet.has(pluginId)) {
      continue;
    }
    if (rawEntry.enabled === false) {
      continue;
    }
    nextEntries[pluginId] = {
      ...rawEntry,
      enabled: false,
    };
  }

  plugins.allow = normalizedPluginIds;
  plugins.entries = nextEntries;

  const skills = isRecord(config.skills) ? { ...config.skills } : {};
  const nextSkillEntries = cloneSkillEntries(config);
  const skillIdsByPluginId = await discoverPluginSkillIdsByPluginId();
  for (const [pluginId, skillIds] of skillIdsByPluginId.entries()) {
    const pluginEnabled = enabledSet.has(pluginId);
    for (const skillId of skillIds) {
      const currentEntry = nextSkillEntries[skillId] ?? {};
      nextSkillEntries[skillId] = {
        ...currentEntry,
        enabled: pluginEnabled,
      };
    }
  }

  if (Object.keys(nextSkillEntries).length > 0) {
    skills.entries = nextSkillEntries;
  }

  return {
    ...config,
    plugins,
    ...(Object.keys(skills).length > 0 ? { skills } : {}),
  };
}

export async function syncEnabledPluginIdsToOpenClawConfig(pluginIds: readonly string[]): Promise<string[]> {
  const normalizedPluginIds = normalizePluginIds(pluginIds);
  await withOpenClawConfigLock(async () => {
    const nextConfig = await applyEnabledPluginIdsToOpenClawConfig(readOpenClawConfigJson(), normalizedPluginIds);
    await writeOpenClawConfigJson(nextConfig);
  });
  return normalizedPluginIds;
}
