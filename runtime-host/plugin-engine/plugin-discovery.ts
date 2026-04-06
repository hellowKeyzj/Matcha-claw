import { access, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { RuntimeHostDiscoveredPlugin } from '../shared/types';
import { normalizePluginId } from './plugin-id';
import {
  classifyPluginDiscoverySource,
  classifyPluginKindFromSource,
  classifyPluginPlatformFromManifest,
  getDefaultPluginDiscoveryRoots,
  PLUGIN_MANIFEST_NAMES,
} from './plugin-location-rules';

interface PluginDiscoveryOptions {
  readonly pluginIdAllowlist?: readonly string[];
  readonly roots?: readonly string[];
}

export interface PluginDiscovery {
  readonly discover: () => Promise<readonly RuntimeHostDiscoveredPlugin[]>;
}

async function tryReadJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function resolveManifestPath(pluginDir: string): Promise<string | null> {
  for (const fileName of PLUGIN_MANIFEST_NAMES) {
    const manifestPath = join(pluginDir, fileName);
    try {
      await access(manifestPath);
      return manifestPath;
    } catch {
      // continue
    }
  }
  return null;
}

async function detectPluginId(pluginDir: string, manifestPath: string): Promise<string> {
  const manifest = await tryReadJson(manifestPath);
  return normalizePluginId(manifest?.id)
    ?? normalizePluginId(manifest?.name)
    ?? basename(pluginDir);
}

export function createPluginDiscovery(options: PluginDiscoveryOptions = {}): PluginDiscovery {
  const allowlist = new Set(
    (options.pluginIdAllowlist ?? [])
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );

  const roots = [...new Set((options.roots ?? getDefaultPluginDiscoveryRoots()).map((root) => root.trim()).filter(Boolean))];

  return {
    async discover() {
      const results: RuntimeHostDiscoveredPlugin[] = [];
      const dedupe = new Set<string>();

      for (const root of roots) {
        const source = classifyPluginDiscoverySource(root);
        let entries: Array<import('node:fs').Dirent>;
        try {
          entries = await readdir(root, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (!entry.isDirectory()) {
            continue;
          }
          const pluginDir = join(root, entry.name);
          const manifestPath = await resolveManifestPath(pluginDir);
          if (!manifestPath) {
            continue;
          }

          const pluginId = await detectPluginId(pluginDir, manifestPath);
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
