import { basename, isAbsolute, join, resolve } from 'node:path';
import { normalizePluginIds } from '../../bootstrap/runtime-config';
import { createPluginDiscovery } from '../../plugin-engine/plugin-discovery';
import type { PluginFileSystemPort } from '../../plugin-engine/plugin-file-system';
import type { OpenClawConfigRepositoryPort } from './openclaw-config-repository';
import { isRecord } from './openclaw-plugin-config-model';

type PluginSkillFileSystem = Pick<
  PluginFileSystemPort,
  'pathExists' | 'readJsonRecord' | 'listDirectoryEntries'
>;

async function collectSkillIdsFromDeclaredPath(
  fileSystem: PluginSkillFileSystem,
  rootDir: string,
  declaredPath: string,
): Promise<string[]> {
  const resolvedPath = isAbsolute(declaredPath)
    ? declaredPath
    : resolve(join(rootDir, declaredPath));
  const skillManifestPath = join(resolvedPath, 'SKILL.md');
  if (await fileSystem.pathExists(skillManifestPath)) {
    return [basename(resolvedPath)];
  }

  let entries: Awaited<ReturnType<PluginSkillFileSystem['listDirectoryEntries']>>;
  try {
    entries = await fileSystem.listDirectoryEntries(resolvedPath);
  } catch {
    return [];
  }

  const skillIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) {
      continue;
    }
    const childSkillManifestPath = join(resolvedPath, entry.name, 'SKILL.md');
    if (await fileSystem.pathExists(childSkillManifestPath)) {
      skillIds.push(entry.name);
    }
  }
  return skillIds;
}

async function discoverPluginSkillIdsByPluginId(
  configRepository: Pick<OpenClawConfigRepositoryPort, 'getConfigDir' | 'getOpenClawDirPath'>,
  fileSystem: PluginSkillFileSystem,
  options: {
    workingDir?: string;
    userMatchaClawPluginDir?: string;
  } = {},
): Promise<Map<string, string[]>> {
  const discovery = createPluginDiscovery({
    locationContext: {
      openClawConfigDir: configRepository.getConfigDir(),
      openClawDirPath: configRepository.getOpenClawDirPath(),
      workingDir: options.workingDir ?? '',
      matchaClawPluginsDir: options.userMatchaClawPluginDir,
    },
    fileSystem,
  });
  const discoveredPlugins = await discovery.discover();
  const result = new Map<string, string[]>();

  await Promise.all(discoveredPlugins.map(async (plugin) => {
    try {
      const parsed = await fileSystem.readJsonRecord(plugin.manifestPath) ?? {};
      const declaredSkills = Array.isArray(parsed.skills)
        ? parsed.skills.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      if (declaredSkills.length === 0) {
        return;
      }
      const skillIds = new Set<string>();
      for (const declaredPath of declaredSkills) {
        const resolved = await collectSkillIdsFromDeclaredPath(fileSystem, plugin.rootDir, declaredPath);
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

export async function applyPluginSkillStateToConfig(
  configRepository: Pick<OpenClawConfigRepositoryPort, 'getConfigDir' | 'getOpenClawDirPath'>,
  fileSystem: PluginSkillFileSystem,
  config: Record<string, unknown>,
  enabledPluginIds: readonly string[],
  options: {
    workingDir?: string;
    userMatchaClawPluginDir?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const enabledSet = new Set(normalizePluginIds(enabledPluginIds));
  const skills = isRecord(config.skills) ? { ...config.skills } : {};
  const nextSkillEntries = cloneSkillEntries(config);
  const skillIdsByPluginId = await discoverPluginSkillIdsByPluginId(configRepository, fileSystem, options);

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
    ...(Object.keys(skills).length > 0 ? { skills } : {}),
  };
}

export async function syncPluginSkillsToOpenClawConfig(
  configRepository: OpenClawConfigRepositoryPort,
  fileSystem: PluginSkillFileSystem,
  enabledPluginIds: readonly string[],
): Promise<void> {
  await configRepository.update(async (config) => {
    const nextConfig = await applyPluginSkillStateToConfig(
      configRepository,
      fileSystem,
      config,
      enabledPluginIds,
    );
    if (config !== nextConfig) {
      for (const key of Object.keys(config)) {
        delete config[key];
      }
      Object.assign(config, nextConfig);
    }
  });
}
