import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeHostCatalogPlugin } from '../../bootstrap/runtime-config';
import { createPluginDiscovery } from '../../plugin-engine/plugin-discovery';
import { createPluginManifestLoader } from '../../plugin-engine/plugin-manifest-loader';
import type { RuntimeHostDiscoveredPlugin } from '../../shared/types';
import { getCompanionSkillSlugsForPlugin } from './plugin-companion-skill-service';
import { pickCatalogGroup } from './plugin-groups';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function tryReadPackageJson(pluginDir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(pluginDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function inferPluginKind(
  discovered: RuntimeHostDiscoveredPlugin,
  packageJson: Record<string, unknown> | null,
): RuntimeHostCatalogPlugin['kind'] {
  if (discovered.source === 'openclaw-extension' || discovered.source === 'matchaclaw-extension') {
    return 'third-party';
  }

  const packageName = typeof packageJson?.name === 'string' ? packageJson.name.trim() : '';
  if (packageName.startsWith('@matchaclaw/')) {
    return 'builtin';
  }

  return discovered.platform === 'matchaclaw' ? 'builtin' : 'third-party';
}

function pickCatalogVersion(
  manifestVersion: string,
  packageJson: Record<string, unknown> | null,
): string {
  if (manifestVersion && manifestVersion !== '0.0.0') {
    return manifestVersion;
  }
  return typeof packageJson?.version === 'string' && packageJson.version.trim().length > 0
    ? packageJson.version.trim()
    : manifestVersion;
}

function pickCatalogDescription(
  manifestDescription: string | undefined,
  packageJson: Record<string, unknown> | null,
): string | undefined {
  if (manifestDescription && manifestDescription.trim().length > 0) {
    return manifestDescription.trim();
  }
  return typeof packageJson?.description === 'string' && packageJson.description.trim().length > 0
    ? packageJson.description.trim()
    : undefined;
}

function compareCatalogPlugins(
  left: RuntimeHostCatalogPlugin,
  right: RuntimeHostCatalogPlugin,
): number {
  if (left.platform !== right.platform) {
    return left.platform.localeCompare(right.platform, 'en');
  }
  if (left.kind !== right.kind) {
    return left.kind.localeCompare(right.kind, 'en');
  }
  return left.id.localeCompare(right.id, 'en');
}

export function mergePluginCatalogSnapshots(
  preferred: readonly RuntimeHostCatalogPlugin[],
  fallback: readonly RuntimeHostCatalogPlugin[],
): RuntimeHostCatalogPlugin[] {
  const merged = new Map<string, RuntimeHostCatalogPlugin>();
  for (const plugin of fallback) {
    merged.set(plugin.id, plugin);
  }
  for (const plugin of preferred) {
    merged.set(plugin.id, plugin);
  }
  return Array.from(merged.values()).sort(compareCatalogPlugins);
}

export async function discoverPluginCatalogLocal(): Promise<RuntimeHostCatalogPlugin[]> {
  const discovery = createPluginDiscovery();
  const manifestLoader = createPluginManifestLoader();
  const discovered = await discovery.discover();

  const catalog = await Promise.all(
    discovered.map(async (plugin) => {
      const [manifest, packageJson] = await Promise.all([
        manifestLoader.load(plugin.manifestPath),
        tryReadPackageJson(plugin.rootDir),
      ]);
      const description = pickCatalogDescription(manifest.description, packageJson);
      const companionSkillSlugs = getCompanionSkillSlugsForPlugin(manifest.id);
      return {
        id: manifest.id,
        name: manifest.name,
        version: pickCatalogVersion(manifest.version, packageJson),
        kind: inferPluginKind(plugin, packageJson),
        platform: plugin.platform,
        category: manifest.category,
        group: pickCatalogGroup({
          id: manifest.id,
          category: manifest.category,
          description: manifest.description,
          groupHints: manifest.groupHints,
        }),
        controlMode: 'manual',
        ...(description ? { description } : {}),
        ...(companionSkillSlugs.length > 0 ? { companionSkillSlugs: [...companionSkillSlugs] } : {}),
      } satisfies RuntimeHostCatalogPlugin;
    }),
  );

  return catalog.sort(compareCatalogPlugins);
}
