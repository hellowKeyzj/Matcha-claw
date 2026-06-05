import { join } from 'node:path';
import type { RuntimeHostCatalogPlugin } from '../../../../bootstrap/runtime-config';
import { normalizePluginIds } from '../../../../bootstrap/runtime-config';
import { createPluginManifestLoader } from '../../../../plugin-engine/plugin-manifest-loader';
import type { PluginFileSystemPort } from '../../../../plugin-engine/plugin-file-system';
import type { ManagedPluginCatalogPort, ManagedPluginDefinition, ManagedPluginInstallerPort, ManagedRegistryPluginSnapshot } from '../../../plugins/managed-plugin-catalog';
import { pickCatalogGroup } from '../../../plugins/plugin-groups';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickKind(packageJson: Record<string, unknown> | null): RuntimeHostCatalogPlugin['kind'] {
  const packageName = typeof packageJson?.name === 'string' ? packageJson.name.trim() : '';
  return packageName.startsWith('@matchaclaw/') ? 'builtin' : 'third-party';
}

function pickVersion(
  manifestVersion: string,
  packageJson: Record<string, unknown> | null,
): string {
  if (manifestVersion && manifestVersion !== '0.0.0') {
    return manifestVersion;
  }
  return typeof packageJson?.version === 'string' && packageJson.version.trim()
    ? packageJson.version.trim()
    : manifestVersion;
}

async function readPluginInstallVersion(
  fileSystem: Pick<PluginFileSystemPort, 'readJsonRecord'>,
  pluginDir: string,
): Promise<string | null> {
  const [packageJson, manifestJson] = await Promise.all([
    fileSystem.readJsonRecord(join(pluginDir, 'package.json')),
    fileSystem.readJsonRecord(join(pluginDir, 'openclaw.plugin.json')),
  ]);

  const packageVersion = typeof packageJson?.version === 'string' ? packageJson.version.trim() : '';
  if (packageVersion) {
    return packageVersion;
  }

  const manifestVersion = typeof manifestJson?.version === 'string' ? manifestJson.version.trim() : '';
  return manifestVersion || null;
}

function pickDescription(
  manifestDescription: string | undefined,
  packageJson: Record<string, unknown> | null,
): string | undefined {
  if (manifestDescription && manifestDescription.trim()) {
    return manifestDescription.trim();
  }
  return typeof packageJson?.description === 'string' && packageJson.description.trim()
    ? packageJson.description.trim()
    : undefined;
}

export interface OpenClawManagedPluginInstallLocationPort {
  getManagedPluginRegistryRootCandidates(): readonly string[];
  getExtensionsRootDir(): string;
}

export class OpenClawManagedPluginInstaller implements ManagedPluginInstallerPort {
  constructor(
    private readonly locations: OpenClawManagedPluginInstallLocationPort,
    private readonly fileSystem: Pick<
      PluginFileSystemPort,
      | 'pathExists'
      | 'readJsonRecord'
      | 'readText'
      | 'ensureDirectory'
      | 'remove'
      | 'copyDirectory'
      | 'writeText'
      | 'readPathSignature'
    >,
    private readonly catalog: ManagedPluginCatalogPort,
  ) {}

  async discoverRegistryPlugin(
    definition: ManagedPluginDefinition,
  ): Promise<ManagedRegistryPluginSnapshot | null> {
    const manifestLoader = createPluginManifestLoader(this.fileSystem);

    for (const root of this.locations.getManagedPluginRegistryRootCandidates()) {
      for (const sourceDirName of definition.sourceDirs) {
        const sourceDir = join(root, sourceDirName);
        const manifestPath = join(sourceDir, 'openclaw.plugin.json');
        if (!(await this.fileSystem.pathExists(manifestPath))) {
          continue;
        }

        const [manifest, packageJson, rawManifest] = await Promise.all([
          manifestLoader.load(manifestPath),
          this.fileSystem.readJsonRecord(join(sourceDir, 'package.json')),
          this.fileSystem.readText(manifestPath),
        ]);
        const parsedManifest = JSON.parse(rawManifest) as unknown;
        const description = pickDescription(manifest.description, packageJson);
        const manifestId = isRecord(parsedManifest) && typeof parsedManifest.id === 'string' && parsedManifest.id.trim()
          ? parsedManifest.id.trim()
          : manifest.id;

        return {
          id: definition.id,
          name: manifest.name,
          version: pickVersion(manifest.version, packageJson),
          kind: pickKind(packageJson),
          platform: 'openclaw',
          source: 'openclaw-extension',
          category: manifest.category,
          group: pickCatalogGroup({
            id: definition.id,
            category: manifest.category,
            description: manifest.description,
            groupHints: manifest.groupHints,
          }),
          controlMode: 'manual',
          ...(description ? { description } : {}),
          sourceDir,
          manifestId,
        };
      }
    }

    return null;
  }

  async getSourceSignatures(pluginIds: readonly string[]): Promise<Record<string, unknown>> {
    const signatures: Record<string, unknown> = {};
    const definitions = new Map<string, ManagedPluginDefinition>();

    for (const pluginId of normalizePluginIds(pluginIds)) {
      const definition = this.catalog.findDefinition(pluginId);
      if (definition) {
        definitions.set(definition.id, definition);
      }
    }

    for (const definition of definitions.values()) {
      const registryPlugin = await this.discoverRegistryPlugin(definition);
      signatures[definition.id] = registryPlugin
        ? {
            sourceDir: registryPlugin.sourceDir,
            version: registryPlugin.version,
            manifestId: registryPlugin.manifestId,
            manifest: await this.readPathSignature(join(registryPlugin.sourceDir, 'openclaw.plugin.json')),
            packageJson: await this.readPathSignature(join(registryPlugin.sourceDir, 'package.json')),
            dist: await this.readPathSignature(join(registryPlugin.sourceDir, 'dist')),
          }
        : 'missing';
    }

    return signatures;
  }

  async getTargetSignatures(pluginIds: readonly string[]): Promise<Record<string, unknown>> {
    const signatures: Record<string, unknown> = {};
    const extensionsRoot = this.locations.getExtensionsRootDir();

    for (const pluginId of normalizePluginIds(pluginIds)) {
      const targetDir = join(extensionsRoot, pluginId);
      signatures[pluginId] = {
        manifest: await this.readPathSignature(join(targetDir, 'openclaw.plugin.json')),
        packageJson: await this.readPathSignature(join(targetDir, 'package.json')),
      };
    }

    return signatures;
  }

  async ensureDefinitionInstalled(
    definition: ManagedPluginDefinition,
    options: {
      force?: boolean;
    } = {},
  ): Promise<void> {
    const pluginId = definition.id;
    const extensionsRoot = this.locations.getExtensionsRootDir();
    const targetDir = join(extensionsRoot, pluginId);
    const targetManifestPath = join(targetDir, 'openclaw.plugin.json');
    const hasInstalledManifest = await this.fileSystem.pathExists(targetManifestPath);

    const registryPlugin = await this.discoverRegistryPlugin(definition);
    if (!registryPlugin) {
      if (options.force !== true && hasInstalledManifest) {
        return;
      }
      throw new Error(`Plugin ${pluginId} is not bundled and no install source is available`);
    }

    if (options.force !== true && hasInstalledManifest) {
      const installedVersion = await readPluginInstallVersion(this.fileSystem, targetDir);
      if (installedVersion !== null && installedVersion === registryPlugin.version) {
        return;
      }
    }

    await this.fileSystem.ensureDirectory(extensionsRoot);
    await this.fileSystem.remove(targetDir);
    await this.fileSystem.copyDirectory(registryPlugin.sourceDir, targetDir);
    await patchInstalledPluginId(this.fileSystem, targetDir, registryPlugin.manifestId, pluginId);

    if (!(await this.fileSystem.pathExists(targetManifestPath))) {
      throw new Error(`Failed to install plugin ${pluginId}: openclaw.plugin.json missing after copy`);
    }
  }

  private async readPathSignature(pathname: string): Promise<string> {
    const signature = await this.fileSystem.readPathSignature(pathname);
    return signature
      ? `${signature.kind}:${Math.round(signature.mtimeMs)}:${signature.size}`
      : 'missing';
  }
}

async function patchInstalledPluginId(
  fileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'readText' | 'writeText'>,
  pluginDir: string,
  sourceManifestId: string,
  targetPluginId: string,
): Promise<void> {
  const manifestPath = join(pluginDir, 'openclaw.plugin.json');
  const manifest = await fileSystem.readJsonRecord(manifestPath);
  if (!isRecord(manifest)) {
    throw new Error(`Invalid plugin manifest JSON: ${manifestPath}`);
  }
  if (manifest.id !== targetPluginId) {
    manifest.id = targetPluginId;
    await fileSystem.writeText(manifestPath, JSON.stringify(manifest, null, 2));
  }

  if (!sourceManifestId || sourceManifestId === targetPluginId) {
    return;
  }

  const pkgJsonPath = join(pluginDir, 'package.json');
  if (!(await fileSystem.pathExists(pkgJsonPath))) {
    return;
  }
  const pkg = await fileSystem.readJsonRecord(pkgJsonPath);
  const pkgRecord = isRecord(pkg) ? pkg : {};
  const entryFiles = [pkgRecord.main, pkgRecord.module].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);

  for (const entryFile of entryFiles) {
    const entryPath = join(pluginDir, entryFile);
    if (!(await fileSystem.pathExists(entryPath))) {
      continue;
    }
    const content = await fileSystem.readText(entryPath);
    const replaced = content.replace(
      new RegExp(`(\\bid\\s*:\\s*)(["'])${sourceManifestId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\2`, 'g'),
      `$1$2${targetPluginId}$2`,
    );
    if (replaced !== content) {
      await fileSystem.writeText(entryPath, replaced);
    }
  }
}
