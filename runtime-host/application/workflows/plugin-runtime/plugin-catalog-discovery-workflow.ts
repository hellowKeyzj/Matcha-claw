import { join } from 'node:path';
import type { RuntimeHostCatalogPlugin } from '../../../bootstrap/runtime-config';
import { createPluginDiscovery } from '../../../plugin-engine/plugin-discovery';
import { createPluginManifestLoader } from '../../../plugin-engine/plugin-manifest-loader';
import type { PluginFileSystemPort } from '../../../plugin-engine/plugin-file-system';
import type { RuntimeHostDiscoveredPlugin } from '../../../shared/types';
import type { PluginCompanionSkillService } from '../../plugins/plugin-companion-skill-service';
import { pickCatalogGroup } from '../../plugins/plugin-groups';

export interface PluginCatalogKindPolicyPort {
  inferPluginKind(input: {
    discovered: RuntimeHostDiscoveredPlugin;
    packageJson: Record<string, unknown> | null;
  }): RuntimeHostCatalogPlugin['kind'];
}

export interface PluginCatalogLocationPort {
  getRuntimeDataRootDir(): string;
  getRuntimeDistributionDir(): string;
  getWorkingDir(): string;
  getUserMatchaClawPluginDir(): string;
}

export interface PluginCatalogDiscoveryWorkflowDeps {
  readonly locations: PluginCatalogLocationPort;
  readonly companionSkills: Pick<PluginCompanionSkillService, 'getSlugsForPlugin'>;
  readonly fileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'readText' | 'listDirectoryEntries'>;
  readonly kindPolicy: PluginCatalogKindPolicyPort;
}

export class PluginCatalogDiscoveryWorkflow {
  constructor(private readonly deps: PluginCatalogDiscoveryWorkflowDeps) {}

  async discover(): Promise<RuntimeHostCatalogPlugin[]> {
    const discovery = createPluginDiscovery({
      locationContext: {
        openClawConfigDir: this.deps.locations.getRuntimeDataRootDir(),
        openClawDirPath: this.deps.locations.getRuntimeDistributionDir(),
        workingDir: this.deps.locations.getWorkingDir(),
        matchaClawPluginsDir: this.deps.locations.getUserMatchaClawPluginDir(),
      },
      fileSystem: this.deps.fileSystem,
    });
    const manifestLoader = createPluginManifestLoader(this.deps.fileSystem);
    const discovered = await discovery.discover();

    const catalog = await Promise.all(
      discovered.map(async (plugin) => {
        const [manifest, packageJson] = await Promise.all([
          manifestLoader.load(plugin.manifestPath),
          this.deps.fileSystem.readJsonRecord(join(plugin.rootDir, 'package.json')),
        ]);
        const description = pickCatalogDescription(manifest.description, packageJson);
        const companionSkillSlugs = this.deps.companionSkills.getSlugsForPlugin(manifest.id);
        return {
          id: manifest.id,
          name: manifest.name,
          version: pickCatalogVersion(manifest.version, packageJson),
          kind: this.deps.kindPolicy.inferPluginKind({ discovered: plugin, packageJson }),
          platform: plugin.platform,
          source: plugin.source,
          category: manifest.category,
          group: pickCatalogGroup({
            id: manifest.id,
            category: manifest.category,
            description: manifest.description,
            groupHints: manifest.groupHints,
          }),
          controlMode: plugin.source === 'bundled' ? 'managed' : 'manual',
          ...(description ? { description } : {}),
          ...(companionSkillSlugs.length > 0 ? { companionSkillSlugs: [...companionSkillSlugs] } : {}),
        } satisfies RuntimeHostCatalogPlugin;
      }),
    );

    return catalog.sort(compareCatalogPlugins);
  }
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
