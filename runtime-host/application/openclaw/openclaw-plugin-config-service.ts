import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  getOpenClawConfigDir,
  getOpenClawDirPath,
  readOpenClawConfigJson,
  writeOpenClawConfigJson,
} from '../../api/storage/paths';
import { normalizePluginIds } from '../../bootstrap/runtime-config';
import { createPluginDiscovery } from '../../plugin-engine/plugin-discovery';
import { getDefaultPluginDiscoveryRoots, PLUGIN_MANIFEST_NAMES } from '../../plugin-engine/plugin-location-rules';
import { normalizePluginId } from '../../plugin-engine/plugin-id';
import {
  EXTERNAL_CHANNEL_PLUGIN_BINDINGS,
  isBuiltinChannelId,
  isChannelDerivedPluginId,
} from '../channels/channel-plugin-bindings';
import { withOpenClawConfigLock } from './openclaw-config-mutex';

const LEGACY_PLUGIN_ID_MAP: Record<string, string> = {
  'feishu-openclaw-plugin': 'openclaw-lark',
  'wecom-openclaw-plugin': 'wecom',
  qqbot: 'openclaw-qqbot',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

function readPluginAllowlist(config: Record<string, unknown>): string[] {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const allow = Array.isArray(plugins.allow) ? plugins.allow : [];
  return normalizeCanonicalPluginIds(
    allow.filter((item): item is string => typeof item === 'string'),
  );
}

function normalizeCanonicalPluginIds(pluginIds: readonly string[]): string[] {
  const normalized = normalizePluginIds(
    pluginIds.map((pluginId) => LEGACY_PLUGIN_ID_MAP[pluginId] ?? pluginId),
  );
  if (!normalized.includes('openclaw-lark')) {
    return normalized;
  }
  return normalized.filter((pluginId) => pluginId !== 'feishu');
}

function readPluginDenylist(config: Record<string, unknown>): string[] {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const deny = Array.isArray(plugins.deny) ? plugins.deny : [];
  return normalizeCanonicalPluginIds(
    deny.filter((item): item is string => typeof item === 'string'),
  );
}

function cloneNormalizedPluginEntries(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const currentEntries = isRecord(plugins.entries) ? plugins.entries : {};
  const nextEntries: Record<string, Record<string, unknown>> = {};

  for (const [pluginId, rawEntry] of Object.entries(currentEntries)) {
    if (!isRecord(rawEntry)) {
      continue;
    }
    nextEntries[pluginId] = { ...rawEntry };
  }

  for (const [legacyPluginId, canonicalPluginId] of Object.entries(LEGACY_PLUGIN_ID_MAP)) {
    const legacyEntry = nextEntries[legacyPluginId];
    if (!legacyEntry) {
      continue;
    }
    if (!nextEntries[canonicalPluginId]) {
      nextEntries[canonicalPluginId] = { ...legacyEntry };
    }
    delete nextEntries[legacyPluginId];
  }

  return nextEntries;
}

function cleanupPluginContainer(config: Record<string, unknown>): void {
  if (!isRecord(config.plugins)) {
    return;
  }

  const plugins = config.plugins as Record<string, unknown>;
  if (Array.isArray(plugins.allow) && plugins.allow.length === 0) {
    delete plugins.allow;
  }
  if (isRecord(plugins.entries) && Object.keys(plugins.entries).length === 0) {
    delete plugins.entries;
  }
  if (Object.keys(plugins).length === 0) {
    delete config.plugins;
  }
}

type DiscoveredPluginEnableState = {
  readonly id: string;
  readonly source: 'workspace' | 'bundled' | 'openclaw-extension' | 'matchaclaw-extension';
  readonly enabledByDefault: boolean;
};

function resolveManifestPathSync(pluginDir: string): string | null {
  for (const fileName of PLUGIN_MANIFEST_NAMES) {
    const manifestPath = join(pluginDir, fileName);
    if (existsSync(manifestPath)) {
      return manifestPath;
    }
  }
  return null;
}

function resolveDiscoverySourceForRoot(root: string): DiscoveredPluginEnableState['source'] {
  const normalizedRoot = resolve(root);
  if (normalizedRoot === resolve(join(getOpenClawDirPath(), 'dist', 'extensions'))) {
    return 'bundled';
  }
  if (normalizedRoot === resolve(join(getOpenClawConfigDir(), 'extensions'))) {
    return 'openclaw-extension';
  }
  if (normalizedRoot === resolve(join(process.env.USERPROFILE || process.env.HOME || '', '.matchaclaw', 'plugins'))) {
    return 'matchaclaw-extension';
  }
  return 'workspace';
}

function readDiscoveredPluginStateSync(): DiscoveredPluginEnableState[] {
  const discovered = new Map<string, DiscoveredPluginEnableState>();

  for (const root of getDefaultPluginDiscoveryRoots()) {
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    const source = resolveDiscoverySourceForRoot(root);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const pluginDir = join(root, entry.name);
      const manifestPath = resolveManifestPathSync(pluginDir);
      if (!manifestPath) {
        continue;
      }

      let manifest: Record<string, unknown> | null = null;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      } catch {
        manifest = null;
      }

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

export function readEnabledPluginIdsFromOpenClawConfig(): string[] {
  return resolveEnabledPluginIdsFromDiscoveredState(
    readOpenClawConfigJson(),
    readDiscoveredPluginStateSync(),
  );
}

function channelSectionHasEnabledAccount(sectionRaw: unknown): boolean {
  if (!isRecord(sectionRaw) || sectionRaw.enabled === false) {
    return false;
  }
  const accounts = isRecord(sectionRaw.accounts) ? sectionRaw.accounts : null;
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((item) => !isRecord(item) || item.enabled !== false);
}

function listConfiguredBuiltinChannelIdsFromConfig(config: Record<string, unknown>): string[] {
  const channels = isRecord(config.channels) ? config.channels : {};
  const configured: string[] = [];

  for (const [channelType, sectionRaw] of Object.entries(channels)) {
    if (!isBuiltinChannelId(channelType)) {
      continue;
    }
    if (channelSectionHasEnabledAccount(sectionRaw)) {
      configured.push(channelType);
    }
  }

  return configured.sort((left, right) => left.localeCompare(right, 'en'));
}

function listConfiguredExternalChannelPluginIdsFromConfig(config: Record<string, unknown>): string[] {
  const channels = isRecord(config.channels) ? config.channels : {};
  const configured: string[] = [];

  for (const binding of EXTERNAL_CHANNEL_PLUGIN_BINDINGS) {
    if (channelSectionHasEnabledAccount(channels[binding.channelType])) {
      configured.push(binding.pluginId);
    }
  }

  return configured.sort((left, right) => left.localeCompare(right, 'en'));
}

export function readManuallyManagedPluginIdsFromConfig(config: Record<string, unknown>): string[] {
  return readPluginAllowlist(config).filter((pluginId) => !isChannelDerivedPluginId(pluginId));
}

export function resolveEffectivePluginIdsForConfig(
  config: Record<string, unknown>,
  manualPluginIds: readonly string[],
): string[] {
  const manualIds = normalizeCanonicalPluginIds(manualPluginIds).filter((pluginId) => !isChannelDerivedPluginId(pluginId));
  const externalChannelPluginIds = listConfiguredExternalChannelPluginIdsFromConfig(config);
  const corePluginIds = normalizePluginIds([...manualIds, ...externalChannelPluginIds]);

  if (corePluginIds.length === 0) {
    return [];
  }

  const builtinChannelIds = listConfiguredBuiltinChannelIdsFromConfig(config);
  return normalizePluginIds([...corePluginIds, ...builtinChannelIds]);
}

function cloneConfig(config: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

async function collectSkillIdsFromDeclaredPath(rootDir: string, declaredPath: string): Promise<string[]> {
  const resolvedPath = isAbsolute(declaredPath)
    ? declaredPath
    : resolve(join(rootDir, declaredPath));
  const skillManifestPath = join(resolvedPath, 'SKILL.md');
  if (await pathExists(skillManifestPath)) {
    return [basename(resolvedPath)];
  }

  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await readdir(resolvedPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const skillIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const childSkillManifestPath = join(resolvedPath, entry.name, 'SKILL.md');
    if (await pathExists(childSkillManifestPath)) {
      skillIds.push(entry.name);
    }
  }
  return skillIds;
}

async function discoverPluginSkillIdsByPluginId(): Promise<Map<string, string[]>> {
  const discovery = createPluginDiscovery();
  const discoveredPlugins = await discovery.discover();
  const result = new Map<string, string[]>();

  await Promise.all(discoveredPlugins.map(async (plugin) => {
    try {
      const raw = await readFile(plugin.manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const declaredSkills = Array.isArray(parsed.skills)
        ? parsed.skills.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      if (declaredSkills.length === 0) {
        return;
      }
      const skillIds = new Set<string>();
      for (const declaredPath of declaredSkills) {
        const resolved = await collectSkillIdsFromDeclaredPath(plugin.rootDir, declaredPath);
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

export async function syncPluginSkillsToOpenClawConfig(enabledPluginIds: readonly string[]): Promise<void> {
  const enabledSet = new Set(normalizePluginIds(enabledPluginIds));
  const skillIdsByPluginId = await discoverPluginSkillIdsByPluginId();
  await withOpenClawConfigLock(async () => {
    const config = readOpenClawConfigJson();
    const nextSkillEntries = cloneSkillEntries(config);

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

    const skills = isRecord(config.skills) ? { ...config.skills } : {};
    if (Object.keys(nextSkillEntries).length > 0) {
      skills.entries = nextSkillEntries;
    }

    await writeOpenClawConfigJson({
      ...config,
      ...(Object.keys(skills).length > 0 ? { skills } : {}),
    });
  });
}

export async function applyEnabledPluginIdsToOpenClawConfig(
  currentConfig: Record<string, unknown>,
  pluginIds: readonly string[],
): Promise<Record<string, unknown>> {
  const normalizedPluginIds = normalizeCanonicalPluginIds(pluginIds);
  const enabledSet = new Set(normalizedPluginIds);
  const config = cloneConfig(currentConfig);
  const plugins = isRecord(config.plugins) ? { ...config.plugins } : {};
  const nextEntries = cloneNormalizedPluginEntries(config);

  if (enabledSet.has('openclaw-lark') && isRecord(nextEntries.feishu) && nextEntries.feishu.enabled !== false) {
    nextEntries.feishu = {
      ...nextEntries.feishu,
      enabled: false,
    };
  }

  for (const pluginId of normalizedPluginIds) {
    const currentEntry = nextEntries[pluginId] ?? {};
    nextEntries[pluginId] = {
      ...currentEntry,
      enabled: true,
    };
  }

  for (const [pluginId, rawEntry] of Object.entries(nextEntries)) {
    if (enabledSet.has(pluginId)) {
      continue;
    }
    if (rawEntry.enabled === false) {
      continue;
    }
    nextEntries[pluginId] = {
      ...rawEntry,
      enabled: false,
    };
  }

  plugins.allow = normalizedPluginIds;
  plugins.entries = nextEntries;
  config.plugins = plugins;
  cleanupPluginContainer(config);

  const skills = isRecord(config.skills) ? { ...config.skills } : {};
  const nextSkillEntries = cloneSkillEntries(config);
  const skillIdsByPluginId = await discoverPluginSkillIdsByPluginId();
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
    ...(isRecord(config.plugins) ? { plugins } : {}),
    ...(Object.keys(skills).length > 0 ? { skills } : {}),
  };
}

export async function applyManuallyManagedPluginIdsToOpenClawConfig(
  currentConfig: Record<string, unknown>,
  manualPluginIds: readonly string[],
): Promise<Record<string, unknown>> {
  return await applyEnabledPluginIdsToOpenClawConfig(
    currentConfig,
    resolveEffectivePluginIdsForConfig(currentConfig, manualPluginIds),
  );
}

export async function syncEnabledPluginIdsToOpenClawConfig(pluginIds: readonly string[]): Promise<string[]> {
  const normalizedManualPluginIds = normalizePluginIds(pluginIds).filter((pluginId) => !isChannelDerivedPluginId(pluginId));
  let effectivePluginIds: string[] = [];
  await withOpenClawConfigLock(async () => {
    const nextConfig = await applyManuallyManagedPluginIdsToOpenClawConfig(
      readOpenClawConfigJson(),
      normalizedManualPluginIds,
    );
    effectivePluginIds = resolveEffectivePluginIdsForConfig(nextConfig, normalizedManualPluginIds);
    await writeOpenClawConfigJson(nextConfig);
  });
  return effectivePluginIds;
}
