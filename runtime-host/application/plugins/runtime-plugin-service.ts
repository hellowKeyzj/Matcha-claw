import { access, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeHostCatalogPlugin } from '../../bootstrap/runtime-config';
import { normalizePluginIds } from '../../bootstrap/runtime-config';
import {
  getOpenClawConfigDir,
  readOpenClawConfigJson,
  writeOpenClawConfigJson,
} from '../../api/storage/paths';
import { createPluginManifestLoader } from '../../plugin-engine/plugin-manifest-loader';
import { mergePluginCatalogSnapshots } from './catalog';
import { pickCatalogGroup } from './plugin-groups';
import {
  CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS,
  findCapabilityOpenClawPluginDefinition,
  findManagedOpenClawPluginDefinition,
  type ManagedOpenClawPluginDefinition,
} from './managed-plugin-definitions';
import {
  applyManuallyManagedPluginIdsToOpenClawConfig,
  readEnabledPluginIdsFromOpenClawConfig,
  resolveEffectivePluginIdsForConfig,
} from '../openclaw/openclaw-plugin-config-service';
import { withOpenClawConfigLock } from '../openclaw/openclaw-config-mutex';
import { isChannelDerivedPluginId } from '../channels/channel-plugin-bindings';
import {
  applyPluginStartupConfigLifecycles,
  applyPluginTransitionConfigLifecycles,
  runPluginStartupSideEffectLifecycles,
  runPluginTransitionSideEffectLifecycles,
} from './plugin-lifecycle-registry';
import { getCompanionSkillSlugsForPlugin } from './plugin-companion-skill-service';
import type { RuntimePluginTransitionLifecycleState } from './plugin-lifecycle-types';

interface ManagedRegistryPluginSnapshot extends RuntimeHostCatalogPlugin {
  readonly sourceDir: string;
  readonly manifestId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pathExists(pathname: string): Promise<boolean> {
  return access(pathname).then(() => true).catch(() => false);
}

function normalizeManualPluginIds(pluginIds: readonly string[]): string[] {
  return normalizePluginIds(pluginIds).filter((pluginId) => (
    !isChannelDerivedPluginId(pluginId)
    && Boolean(findCapabilityOpenClawPluginDefinition(pluginId))
  ));
}

function filterManagedPluginIds(pluginIds: readonly string[]): string[] {
  return normalizePluginIds(pluginIds).filter((pluginId) => Boolean(findCapabilityOpenClawPluginDefinition(pluginId)));
}

function computeTransitionLifecycleState(
  previousEnabledPluginIds: readonly string[],
  nextEnabledPluginIds: readonly string[],
): RuntimePluginTransitionLifecycleState {
  const previousEnabledSet = new Set(previousEnabledPluginIds);
  const nextEnabledSet = new Set(nextEnabledPluginIds);

  return {
    previousEnabledPluginIds,
    nextEnabledPluginIds,
    newlyEnabledPluginIds: nextEnabledPluginIds.filter((pluginId) => !previousEnabledSet.has(pluginId)),
    newlyDisabledPluginIds: previousEnabledPluginIds.filter((pluginId) => !nextEnabledSet.has(pluginId)),
  };
}

async function syncRuntimeEnabledPluginIds(
  manualPluginIds: readonly string[],
  previousEnabledPluginIds: readonly string[],
): Promise<RuntimePluginTransitionLifecycleState> {
  let transitionState: RuntimePluginTransitionLifecycleState = {
    previousEnabledPluginIds,
    nextEnabledPluginIds: previousEnabledPluginIds,
    newlyEnabledPluginIds: [],
    newlyDisabledPluginIds: [],
  };

  await withOpenClawConfigLock(async () => {
    let nextConfig = await applyManuallyManagedPluginIdsToOpenClawConfig(
      readOpenClawConfigJson(),
      manualPluginIds,
    );
    const nextEnabledPluginIds = resolveEffectivePluginIdsForConfig(nextConfig, manualPluginIds);
    transitionState = computeTransitionLifecycleState(previousEnabledPluginIds, nextEnabledPluginIds);
    nextConfig = await applyPluginTransitionConfigLifecycles(nextConfig, transitionState);
    await writeOpenClawConfigJson(nextConfig);
  });

  await runPluginTransitionSideEffectLifecycles(transitionState);
  return transitionState;
}

async function reconcileStartupPluginLifecycles(enabledPluginIds: readonly string[]): Promise<void> {
  await withOpenClawConfigLock(async () => {
    const currentConfig = readOpenClawConfigJson();
    const previousSerialized = JSON.stringify(currentConfig);
    const nextConfig = await applyPluginStartupConfigLifecycles(currentConfig, enabledPluginIds);
    if (JSON.stringify(nextConfig) !== previousSerialized) {
      await writeOpenClawConfigJson(nextConfig);
    }
  });

  await runPluginStartupSideEffectLifecycles(enabledPluginIds);
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
    return isRecord(parsed) ? parsed : null;
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

async function readPluginInstallVersion(pluginDir: string): Promise<string | null> {
  const [packageJson, manifestJson] = await Promise.all([
    tryReadPackageJson(pluginDir),
    (async () => {
      try {
        const raw = await readFile(join(pluginDir, 'openclaw.plugin.json'), 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        return isRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    })(),
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
      const parsedManifest = JSON.parse(rawManifest) as unknown;
      const description = pickDescription(manifest.description, packageJson);
      const manifestId = isRecord(parsedManifest) && typeof parsedManifest.id === 'string' && parsedManifest.id.trim()
        ? parsedManifest.id.trim()
        : manifest.id;
      const companionSkillSlugs = getCompanionSkillSlugsForPlugin(definition.id);

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
        ...(companionSkillSlugs.length > 0 ? { companionSkillSlugs: [...companionSkillSlugs] } : {}),
        sourceDir,
        manifestId,
      };
    }
  }

  return null;
}

export async function getManagedPluginSourceSignatures(pluginIds: readonly string[]): Promise<Record<string, unknown>> {
  const signatures: Record<string, unknown> = {};
  const definitions = new Map<string, ManagedOpenClawPluginDefinition>();

  for (const pluginId of normalizePluginIds(pluginIds)) {
    const definition = findManagedOpenClawPluginDefinition(pluginId);
    if (definition) {
      definitions.set(definition.id, definition);
    }
  }

  for (const definition of definitions.values()) {
    const registryPlugin = await discoverManagedRegistryPlugin(definition);
    signatures[definition.id] = registryPlugin
      ? {
          sourceDir: registryPlugin.sourceDir,
          version: registryPlugin.version,
          manifestId: registryPlugin.manifestId,
        }
      : 'missing';
  }

  return signatures;
}

async function readPathSignature(pathname: string): Promise<string> {
  try {
    const info = await stat(pathname);
    return `${info.isDirectory() ? 'dir' : 'file'}:${Math.round(info.mtimeMs)}:${info.size}`;
  } catch {
    return 'missing';
  }
}

export async function getManagedPluginTargetSignatures(pluginIds: readonly string[]): Promise<Record<string, unknown>> {
  const signatures: Record<string, unknown> = {};
  const extensionsRoot = join(getOpenClawConfigDir(), 'extensions');

  for (const pluginId of normalizePluginIds(pluginIds)) {
    const targetDir = join(extensionsRoot, pluginId);
    signatures[pluginId] = {
      manifest: await readPathSignature(join(targetDir, 'openclaw.plugin.json')),
      packageJson: await readPathSignature(join(targetDir, 'package.json')),
    };
  }

  return signatures;
}

async function patchInstalledPluginId(
  pluginDir: string,
  sourceManifestId: string,
  targetPluginId: string,
): Promise<void> {
  const manifestPath = join(pluginDir, 'openclaw.plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  if (!isRecord(manifest)) {
    throw new Error(`Invalid plugin manifest JSON: ${manifestPath}`);
  }
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
  const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8')) as unknown;
  const pkgRecord = isRecord(pkg) ? pkg : {};
  const entryFiles = [pkgRecord.main, pkgRecord.module].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);

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

export async function ensureManagedPluginDefinitionInstalled(
  definition: ManagedOpenClawPluginDefinition,
  options: {
    force?: boolean;
  } = {},
): Promise<void> {
  const pluginId = definition.id;
  const extensionsRoot = join(getOpenClawConfigDir(), 'extensions');
  const targetDir = join(extensionsRoot, pluginId);
  const targetManifestPath = join(targetDir, 'openclaw.plugin.json');
  const hasInstalledManifest = await pathExists(targetManifestPath);

  const registryPlugin = await discoverManagedRegistryPlugin(definition);
  if (!registryPlugin) {
    if (options.force !== true && hasInstalledManifest) {
      return;
    }
    throw new Error(`Plugin ${pluginId} is not bundled and no install source is available`);
  }

  if (options.force !== true && hasInstalledManifest) {
    const installedVersion = await readPluginInstallVersion(targetDir);
    if (installedVersion !== null && installedVersion === registryPlugin.version) {
      return;
    }
  }

  await mkdir(extensionsRoot, { recursive: true });
  await rm(targetDir, { recursive: true, force: true });
  await cp(registryPlugin.sourceDir, targetDir, { recursive: true, force: true });
  await patchInstalledPluginId(targetDir, registryPlugin.manifestId, pluginId);

  if (!(await pathExists(targetManifestPath))) {
    throw new Error(`Failed to install plugin ${pluginId}: openclaw.plugin.json missing after copy`);
  }
}

export async function ensureManagedPluginInstalled(
  pluginId: string,
  options: {
    force?: boolean;
  } = {},
): Promise<void> {
  const definition = findCapabilityOpenClawPluginDefinition(pluginId);
  if (!definition) {
    throw new Error(`Plugin ${pluginId} is not managed by the MatchaClaw plugin center`);
  }
  await ensureManagedPluginDefinitionInstalled(definition, options);
}

export async function listRuntimePluginCatalog(): Promise<RuntimeHostCatalogPlugin[]> {
  const managedRegistryCatalog = await Promise.all(
    CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS.map(async (definition) => await discoverManagedRegistryPlugin(definition)),
  );

  return mergePluginCatalogSnapshots(
    [],
    managedRegistryCatalog.filter((plugin): plugin is RuntimeHostCatalogPlugin => Boolean(plugin)),
  );
}

export function listEnabledPluginIdsFromConfig(): string[] {
  return readEnabledPluginIdsFromOpenClawConfig();
}

export function listConfiguredManagedPluginIdsFromConfig(): string[] {
  const config = readOpenClawConfigJson();
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const configuredPluginIds = new Set<string>();

  if (Array.isArray(plugins.allow)) {
    for (const pluginId of plugins.allow) {
      if (typeof pluginId === 'string') {
        configuredPluginIds.add(pluginId);
      }
    }
  }

  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  for (const [pluginId, rawEntry] of Object.entries(entries)) {
    if (isRecord(rawEntry) && rawEntry.enabled === true) {
      configuredPluginIds.add(pluginId);
    }
  }

  return normalizePluginIds([...configuredPluginIds]).filter(
    (pluginId) => Boolean(findManagedOpenClawPluginDefinition(pluginId)),
  );
}

export async function ensureConfiguredManagedPluginsInstalled(
  options: { forceInstall?: boolean } = {},
): Promise<string[]> {
  const enabledPluginIds = filterManagedPluginIds(listConfiguredManagedPluginIdsFromConfig());
  for (const pluginId of enabledPluginIds) {
    await ensureManagedPluginInstalled(pluginId, { force: options.forceInstall === true });
  }
  await reconcileStartupPluginLifecycles(enabledPluginIds);
  return enabledPluginIds;
}

export async function ensureRuntimePluginEnabled(pluginId: string): Promise<string[]> {
  const normalizedPluginId = pluginId.trim();
  if (!normalizedPluginId) {
    return readEnabledPluginIdsFromOpenClawConfig();
  }

  const currentEnabledPluginIds = readEnabledPluginIdsFromOpenClawConfig();
  const nextEnabledPluginIds = currentEnabledPluginIds.includes(normalizedPluginId)
    ? currentEnabledPluginIds
    : [...currentEnabledPluginIds, normalizedPluginId];
  return await setRuntimeEnabledPluginIds(nextEnabledPluginIds);
}

export async function setRuntimeEnabledPluginIds(pluginIds: readonly string[]): Promise<string[]> {
  const previousEnabledPluginIds = readEnabledPluginIdsFromOpenClawConfig();
  const normalizedManualPluginIds = normalizeManualPluginIds(pluginIds);

  for (const pluginId of normalizedManualPluginIds) {
    await ensureManagedPluginInstalled(pluginId);
  }

  const transitionState = await syncRuntimeEnabledPluginIds(normalizedManualPluginIds, previousEnabledPluginIds);
  return [...transitionState.nextEnabledPluginIds];
}
