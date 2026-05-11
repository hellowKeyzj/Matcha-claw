import { basename, join } from 'node:path';
import type { RuntimeHostDiscoveredPlugin } from '../shared/types';
import { normalizePluginId } from './plugin-id';
import type { PluginFileSystemPort } from './plugin-file-system';
import {
  classifyPluginDiscoverySource,
  classifyPluginKindFromSource,
  classifyPluginPlatformFromManifest,
  getDefaultPluginDiscoveryRoots,
  type PluginLocationContext,
  PLUGIN_MANIFEST_NAMES,
} from './plugin-location-rules';

interface PluginDiscoveryOptions {
  readonly pluginIdAllowlist?: readonly string[];
  readonly roots?: readonly string[];
  readonly locationContext: PluginLocationContext;
  readonly fileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'listDirectoryEntries'>;
}

export interface PluginDiscovery {
  readonly discover: () => Promise<readonly RuntimeHostDiscoveredPlugin[]>;
}

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

async function detectPluginId(
  fileSystem: Pick<PluginFileSystemPort, 'readJsonRecord'>,
  pluginDir: string,
  manifestPath: string,
): Promise<string> {
  const manifest = await fileSystem.readJsonRecord(manifestPath);
  return normalizePluginId(manifest?.id)
    ?? normalizePluginId(manifest?.name)
    ?? basename(pluginDir);
}

export function createPluginDiscovery(options: PluginDiscoveryOptions): PluginDiscovery {
  const allowlist = new Set(
    (options.pluginIdAllowlist ?? [])
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );

  const roots = [...new Set((options.roots ?? getDefaultPluginDiscoveryRoots(options.locationContext)).map((root) => root.trim()).filter(Boolean))];

  return {
    async discover() {
      const results: RuntimeHostDiscoveredPlugin[] = [];
      const dedupe = new Set<string>();

      for (const root of roots) {
        const source = classifyPluginDiscoverySource(root, options.locationContext);
        let entries: Awaited<ReturnType<typeof options.fileSystem.listDirectoryEntries>>;
        try {
          entries = await options.fileSystem.listDirectoryEntries(root);
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (!entry.isDirectory) {
            continue;
          }
          const pluginDir = join(root, entry.name);
          const manifestPath = await resolveManifestPath(options.fileSystem, pluginDir);
          if (!manifestPath) {
            continue;
          }

          const pluginId = await detectPluginId(options.fileSystem, pluginDir, manifestPath);
          if (allowlist.size > 0 && !allowlist.has(pluginId)) {
            continue;
          }
          if (dedupe.has(pluginId)) {
            continue;
          }
          dedupe.add(pluginId);

          results.push({
            id: pluginId,
            kind: classifyPluginKindFromSource(source),
            platform: classifyPluginPlatformFromManifest(manifestPath),
            source,
            rootDir: pluginDir,
            manifestPath,
          });
        }
      }

      return results.sort((a, b) => a.id.localeCompare(b.id, 'en'));
    },
  };
}
