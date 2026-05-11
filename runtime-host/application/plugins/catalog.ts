import { join } from 'node:path';
import type { RuntimeHostCatalogPlugin } from '../../bootstrap/runtime-config';
import { createPluginDiscovery } from '../../plugin-engine/plugin-discovery';
import { createPluginManifestLoader } from '../../plugin-engine/plugin-manifest-loader';
import type { PluginFileSystemPort } from '../../plugin-engine/plugin-file-system';
import type { RuntimeHostDiscoveredPlugin } from '../../shared/types';
import type { OpenClawConfigRepositoryPort } from '../openclaw/openclaw-config-repository';
import type { OpenClawEnvironmentRepository } from '../openclaw/openclaw-environment-repository';
import type { PluginCompanionSkillService } from './plugin-companion-skill-service';
import { pickCatalogGroup } from './plugin-groups';

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

export class PluginCatalogRepository {
  constructor(
    private readonly configRepository: Pick<OpenClawConfigRepositoryPort, 'getConfigDir' | 'getOpenClawDirPath'>,
    private readonly companionSkills: Pick<PluginCompanionSkillService, 'getSlugsForPlugin'>,
    private readonly environment: Pick<OpenClawEnvironmentRepository, 'getWorkingDir' | 'getUserMatchaClawPluginDir'>,
    private readonly fileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'readText' | 'listDirectoryEntries'>,
  ) {}

  async discover(): Promise<RuntimeHostCatalogPlugin[]> {
    const discovery = createPluginDiscovery({
      locationContext: {
        openClawConfigDir: this.configRepository.getConfigDir(),
        openClawDirPath: this.configRepository.getOpenClawDirPath(),
        workingDir: this.environment.getWorkingDir(),
        matchaClawPluginsDir: this.environment.getUserMatchaClawPluginDir(),
      },
      fileSystem: this.fileSystem,
    });
    const manifestLoader = createPluginManifestLoader(this.fileSystem);
    const discovered = await discovery.discover();

    const catalog = await Promise.all(
      discovered.map(async (plugin) => {
        const [manifest, packageJson] = await Promise.all([
          manifestLoader.load(plugin.manifestPath),
          this.fileSystem.readJsonRecord(join(plugin.rootDir, 'package.json')),
        ]);
        const description = pickCatalogDescription(manifest.description, packageJson);
        const companionSkillSlugs = this.companionSkills.getSlugsForPlugin(manifest.id);
        return {
          id: manifest.id,
          name: manifest.name,
          version: pickCatalogVersion(manifest.version, packageJson),
          kind: inferPluginKind(plugin, packageJson),
          platform: plugin.platform,
          source: plugin.source,
          category: manifest.category,
          group: pickCatalogGroup({
            id: manifest.id,
            category: manifest.category,
            description: manifest.description,
            groupHints: manifest.groupHints,
          }),
          controlMode: plugin.source === 'bundled' ? 'openclaw-managed' : 'manual',
          ...(description ? { description } : {}),
          ...(companionSkillSlugs.length > 0 ? { companionSkillSlugs: [...companionSkillSlugs] } : {}),
        } satisfies RuntimeHostCatalogPlugin;
      }),
    );

    return catalog.sort(compareCatalogPlugins);
  }
}
