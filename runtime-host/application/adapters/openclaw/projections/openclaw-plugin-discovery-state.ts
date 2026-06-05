import { join, resolve } from 'node:path';
import { normalizePluginIds } from '../../../../bootstrap/runtime-config';
import type { PluginFileSystemPort } from '../../../../plugin-engine/plugin-file-system';
import {
  getOpenClawRuntimePluginDiscoveryRoots,
  type PluginLocationContext,
  PLUGIN_MANIFEST_NAMES,
} from '../../../../plugin-engine/plugin-location-rules';
import { normalizePluginId } from '../../../../plugin-engine/plugin-id';
import type { OpenClawConfigRepositoryPort } from '../infrastructure/openclaw-config-repository';
import {
  cloneNormalizedPluginEntries,
  isRecord,
  readPluginAllowlist,
  readPluginDenylist,
} from './openclaw-plugin-config-model';

export type DiscoveredPluginEnableState = {
  readonly id: string;
  readonly source: 'workspace' | 'bundled' | 'openclaw-extension' | 'matchaclaw-extension';
  readonly enabledByDefault: boolean;
  readonly providers: string[];
};

type PluginDiscoveryFileSystem = Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'listDirectoryEntries'>;

async function resolveManifestPath(
  fileSystem: Pick<PluginFileSystemPort, 'pathExists'>,
  pluginDir: string,
): Promise<string | null> {
  for (const fileName of PLUGIN_MANIFEST_NAMES) {
    const manifestPath = join(pluginDir, fileName);
    if (await fileSystem.pathExists(manifestPath)) {
      return manifestPath;
    }
  }
  return null;
}

function buildLocationContext(
  configRepository: Pick<OpenClawConfigRepositoryPort, 'getConfigDir' | 'getOpenClawDirPath'>,
  options: {
    workingDir?: string;
    userMatchaClawPluginDir?: string;
  },
): PluginLocationContext {
  return {
    openClawConfigDir: configRepository.getConfigDir(),
    openClawDirPath: configRepository.getOpenClawDirPath(),
    workingDir: options.workingDir ?? '',
    matchaClawPluginsDir: options.userMatchaClawPluginDir,
  };
}

function resolveDiscoverySourceForRoot(
  root: string,
  context: PluginLocationContext,
  userMatchaClawPluginDir?: string,
): DiscoveredPluginEnableState['source'] {
  const normalizedRoot = resolve(root);
  if (normalizedRoot === resolve(join(context.openClawDirPath, 'dist', 'extensions'))) {
    return 'bundled';
  }
  if (normalizedRoot === resolve(join(context.openClawConfigDir, 'extensions'))) {
    return 'openclaw-extension';
  }
  if (userMatchaClawPluginDir && normalizedRoot === resolve(userMatchaClawPluginDir)) {
    return 'matchaclaw-extension';
  }
  return 'workspace';
}

export async function readDiscoveredPluginState(
  configRepository: Pick<OpenClawConfigRepositoryPort, 'getConfigDir' | 'getOpenClawDirPath'>,
  fileSystem: PluginDiscoveryFileSystem,
  options: {
    workingDir?: string;
    userMatchaClawPluginDir?: string;
  } = {},
): Promise<DiscoveredPluginEnableState[]> {
  const discovered = new Map<string, DiscoveredPluginEnableState>();
  const locationContext = buildLocationContext(configRepository, options);

  for (const root of getOpenClawRuntimePluginDiscoveryRoots(locationContext)) {
    let entries: Awaited<ReturnType<PluginDiscoveryFileSystem['listDirectoryEntries']>>;
    try {
      entries = await fileSystem.listDirectoryEntries(root);
    } catch {
      continue;
    }

    const source = resolveDiscoverySourceForRoot(root, locationContext, options.userMatchaClawPluginDir);
    for (const entry of entries) {
      if (!entry.isDirectory) {
        continue;
      }
      const pluginDir = join(root, entry.name);
      const manifestPath = await resolveManifestPath(fileSystem, pluginDir);
      if (!manifestPath) {
        continue;
      }

      const manifest = await fileSystem.readJsonRecord(manifestPath);

      const pluginId = normalizePluginId(manifest?.id)
        ?? normalizePluginId(manifest?.name)
        ?? entry.name;
      if (discovered.has(pluginId)) {
        continue;
      }

      discovered.set(pluginId, {
        id: pluginId,
        source,
        enabledByDefault: manifest?.enabledByDefault === true,
        providers: Array.isArray(manifest?.providers)
          ? manifest.providers.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          : [],
      });
    }
  }

  return [...discovered.values()];
}

export function resolveEnabledPluginIdsFromDiscoveredState(
  config: Record<string, unknown>,
  discoveredPlugins: readonly DiscoveredPluginEnableState[],
): string[] {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  if (plugins.enabled === false) {
    return [];
  }

  const allow = readPluginAllowlist(config);
  const allowSet = new Set(allow);
  const denySet = new Set(readPluginDenylist(config));
  const entries = cloneNormalizedPluginEntries(config);
  const enabledPluginIds: string[] = [];

  for (const plugin of discoveredPlugins) {
    if (denySet.has(plugin.id)) {
      continue;
    }

    const entry = entries[plugin.id];
    if (entry?.enabled === false) {
      continue;
    }

    const explicitlyAllowed = allowSet.has(plugin.id);
    if (plugin.source === 'workspace' && !explicitlyAllowed && entry?.enabled !== true) {
      continue;
    }
    if (allow.length > 0 && !explicitlyAllowed) {
      continue;
    }
    if (entry?.enabled === true) {
      enabledPluginIds.push(plugin.id);
      continue;
    }
    if (plugin.source === 'bundled') {
      if (plugin.enabledByDefault) {
        enabledPluginIds.push(plugin.id);
      }
      continue;
    }

    enabledPluginIds.push(plugin.id);
  }

  return normalizePluginIds(enabledPluginIds);
}

function isProviderBackedBundledPlugin(plugin: DiscoveredPluginEnableState): boolean {
  return plugin.source === 'bundled' && plugin.providers.length > 0;
}

export async function discoverBundledProviderPluginIds(
  configRepository: Pick<OpenClawConfigRepositoryPort, 'getConfigDir' | 'getOpenClawDirPath'>,
  fileSystem: PluginDiscoveryFileSystem,
): Promise<Set<string>> {
  return new Set(
    (await readDiscoveredPluginState(configRepository, fileSystem))
      .filter(isProviderBackedBundledPlugin)
      .map((plugin) => plugin.id),
  );
}

export async function discoverBundledPluginIds(
  configRepository: Pick<OpenClawConfigRepositoryPort, 'getConfigDir' | 'getOpenClawDirPath'>,
  fileSystem: PluginDiscoveryFileSystem,
): Promise<Set<string>> {
  return new Set(
    (await readDiscoveredPluginState(configRepository, fileSystem))
      .filter((plugin) => plugin.source === 'bundled')
      .map((plugin) => plugin.id),
  );
}
