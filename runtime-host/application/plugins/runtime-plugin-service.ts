import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeHostCatalogPlugin } from '../../bootstrap/runtime-config';
import { getOpenClawConfigDir } from '../../api/storage/paths';
import { createPluginManifestLoader } from '../../plugin-engine/plugin-manifest-loader';
import {
  discoverPluginCatalogLocal,
  mergePluginCatalogSnapshots,
} from './catalog';
import {
  MANAGED_OPENCLAW_PLUGIN_DEFINITIONS,
  findManagedOpenClawPluginDefinition,
  type ManagedOpenClawPluginDefinition,
} from './managed-plugin-definitions';
import {
  readEnabledPluginIdsFromOpenClawConfig,
  syncEnabledPluginIdsToOpenClawConfig,
} from '../openclaw/openclaw-plugin-config-service';

interface ManagedRegistryPluginSnapshot extends RuntimeHostCatalogPlugin {
  readonly sourceDir: string;
  readonly manifestId: string;
}

function pathExists(pathname: string): Promise<boolean> {
  return access(pathname).then(() => true).catch(() => false);
}

function getManagedRegistryRoots(): string[] {
  const roots = [
    join(process.cwd(), 'build', 'openclaw-plugins'),
  ];

  if (typeof process.resourcesPath === 'string' && process.resourcesPath.trim()) {
    roots.push(
      join(process.resourcesPath, 'openclaw-plugins'),
      join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins'),
      join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins'),
    );
  }

  return [...new Set(roots.map((root) => root.trim()).filter(Boolean))];
}

async function tryReadPackageJson(pluginDir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(pluginDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
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

async function discoverManagedRegistryPlugin(
  definition: ManagedOpenClawPluginDefinition,
): Promise<ManagedRegistryPluginSnapshot | null> {
  const manifestLoader = createPluginManifestLoader();

  for (const root of getManagedRegistryRoots()) {
    for (const sourceDirName of definition.sourceDirs) {
      const sourceDir = join(root, sourceDirName);
      const manifestPath = join(sourceDir, 'openclaw.plugin.json');
      if (!(await pathExists(manifestPath))) {
        continue;
      }

      const [manifest, packageJson, rawManifest] = await Promise.all([
        manifestLoader.load(manifestPath),
        tryReadPackageJson(sourceDir),
        readFile(manifestPath, 'utf8'),
      ]);
      const parsedManifest = JSON.parse(rawManifest) as Record<string, unknown>;
      const description = pickDescription(manifest.description, packageJson);
      const manifestId = typeof parsedManifest.id === 'string' && parsedManifest.id.trim()
        ? parsedManifest.id.trim()
        : manifest.id;

      return {
        id: definition.id,
        name: manifest.name,
        version: pickVersion(manifest.version, packageJson),
        kind: pickKind(packageJson),
        platform: 'openclaw',
        category: manifest.category,
        controlMode: 'manual',
        ...(description ? { description } : {}),
        sourceDir,
        manifestId,
      };
    }
  }

  return null;
}

async function patchInstalledPluginId(
  pluginDir: string,
  sourceManifestId: string,
  targetPluginId: string,
): Promise<void> {
  const manifestPath = join(pluginDir, 'openclaw.plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  if (manifest.id !== targetPluginId) {
    manifest.id = targetPluginId;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  if (!sourceManifestId || sourceManifestId === targetPluginId) {
    return;
  }

  const pkgJsonPath = join(pluginDir, 'package.json');
  if (!(await pathExists(pkgJsonPath))) {
    return;
  }
  const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8')) as { main?: unknown; module?: unknown };
  const entryFiles = [pkg.main, pkg.module].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);

  for (const entryFile of entryFiles) {
    const entryPath = join(pluginDir, entryFile);
    if (!(await pathExists(entryPath))) {
      continue;
    }
    const content = await readFile(entryPath, 'utf8');
    const replaced = content.replace(
      new RegExp(`(\\bid\\s*:\\s*)(["'])${sourceManifestId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\2`, 'g'),
      `$1$2${targetPluginId}$2`,
    );
    if (replaced !== content) {
      await writeFile(entryPath, replaced, 'utf8');
    }
  }
}

export async function ensureManagedPluginInstalled(
  pluginId: string,
  options: {
    force?: boolean;
  } = {},
): Promise<void> {
  const definition = findManagedOpenClawPluginDefinition(pluginId);
  if (!definition) {
    return;
  }

  const extensionsRoot = join(getOpenClawConfigDir(), 'extensions');
  const targetDir = join(extensionsRoot, pluginId);
  const targetManifestPath = join(targetDir, 'openclaw.plugin.json');
  if (options.force !== true && await pathExists(targetManifestPath)) {
    return;
  }

  const registryPlugin = await discoverManagedRegistryPlugin(definition);
  if (!registryPlugin) {
    throw new Error(`Plugin ${pluginId} is not bundled and no install source is available`);
  }

  await mkdir(extensionsRoot, { recursive: true });
  await rm(targetDir, { recursive: true, force: true });
  await cp(registryPlugin.sourceDir, targetDir, { recursive: true, force: true });
  await patchInstalledPluginId(targetDir, registryPlugin.manifestId, pluginId);

  if (!(await pathExists(targetManifestPath))) {
    throw new Error(`Failed to install plugin ${pluginId}: openclaw.plugin.json missing after copy`);
  }
}

export async function listRuntimePluginCatalog(): Promise<RuntimeHostCatalogPlugin[]> {
  const [runtimeCatalog, managedRegistryCatalog] = await Promise.all([
    discoverPluginCatalogLocal(),
    Promise.all(
      MANAGED_OPENCLAW_PLUGIN_DEFINITIONS.map(async (definition) => await discoverManagedRegistryPlugin(definition)),
    ),
  ]);

  return mergePluginCatalogSnapshots(
    runtimeCatalog,
    managedRegistryCatalog.filter((plugin): plugin is RuntimeHostCatalogPlugin => Boolean(plugin)),
  );
}

export function listEnabledPluginIdsFromConfig(): string[] {
  return readEnabledPluginIdsFromOpenClawConfig();
}

export async function ensureConfiguredManagedPluginsInstalled(): Promise<string[]> {
  const enabledPluginIds = readEnabledPluginIdsFromOpenClawConfig();
  for (const pluginId of enabledPluginIds) {
    await ensureManagedPluginInstalled(pluginId);
  }
  return enabledPluginIds;
}

export async function ensureRuntimePluginEnabled(pluginId: string): Promise<string[]> {
  const normalizedPluginId = pluginId.trim();
  if (!normalizedPluginId) {
    return readEnabledPluginIdsFromOpenClawConfig();
  }

  await ensureManagedPluginInstalled(normalizedPluginId);

  const currentEnabledPluginIds = readEnabledPluginIdsFromOpenClawConfig();
  const nextEnabledPluginIds = currentEnabledPluginIds.includes(normalizedPluginId)
    ? currentEnabledPluginIds
    : [...currentEnabledPluginIds, normalizedPluginId];
  return await syncEnabledPluginIdsToOpenClawConfig(nextEnabledPluginIds);
}

export async function setRuntimeEnabledPluginIds(pluginIds: readonly string[]): Promise<string[]> {
  for (const pluginId of pluginIds) {
    await ensureManagedPluginInstalled(pluginId);
  }
  return await syncEnabledPluginIdsToOpenClawConfig(pluginIds);
}
