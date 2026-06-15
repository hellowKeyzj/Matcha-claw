import { normalizePluginIds } from '../../../../bootstrap/runtime-config';
import type { PluginFileSystemPort } from '../../../../plugin-engine/plugin-file-system';
import type { OpenClawPluginConfigWorkflow } from '../workflows/openclaw-plugin/openclaw-plugin-config-workflow';
import {
  EXTERNAL_CHANNEL_PLUGIN_BINDINGS,
  getExternalChannelTypeByPluginId,
  isChannelDerivedPluginId,
} from './openclaw-channel-plugin-bindings';
import { CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS } from './openclaw-managed-plugin-catalog';
import type { OpenClawConfigRepositoryPort } from '../infrastructure/openclaw-config-repository';
import {
  LEGACY_PLUGIN_ID_MAP,
  cleanupPluginContainer,
  cloneConfig,
  cloneNormalizedPluginEntries,
  isRecord,
  normalizeCanonicalPluginIds,
  readPluginAllowlist,
} from './openclaw-plugin-config-model';
import {
  discoverBundledPluginIds,
  discoverBundledProviderPluginIds,
  readDiscoveredPluginState,
} from './openclaw-plugin-discovery-state';
import {
  listConfiguredBuiltinChannelIdsFromConfig,
  listConfiguredExternalChannelPluginIdsFromConfig,
  mirrorPluginBackedChannelStateToOpenClawConfig,
} from './openclaw-plugin-channel-config';
import {
  applyPluginSkillStateToConfig,
  syncPluginSkillsToOpenClawConfig,
} from './openclaw-plugin-skill-sync';

export { syncPluginSkillsToOpenClawConfig };

const MATCHACLAW_MANAGED_PLUGIN_IDS = new Set(
  CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS.map((definition) => definition.id),
);
const MATCHACLAW_MANAGED_LEGACY_PLUGIN_IDS = new Set(Object.keys(LEGACY_PLUGIN_ID_MAP));
const TEAM_RUNTIME_PLUGIN_ID = 'team-runtime';
const TEAM_RUNTIME_UNRESTRICTED_TOOL_MARKER = '*';

function isMatchaClawManagedPluginId(pluginId: string): boolean {
  return MATCHACLAW_MANAGED_PLUGIN_IDS.has(pluginId) || MATCHACLAW_MANAGED_LEGACY_PLUGIN_IDS.has(pluginId);
}

export async function readManuallyEnabledPluginIdsFromOpenClawConfig(
  configRepository: Pick<OpenClawConfigRepositoryPort, 'getConfigDir' | 'getOpenClawDirPath'>,
  pluginFileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'listDirectoryEntries'>,
  config: Record<string, unknown>,
  options: {
    userMatchaClawPluginDir?: string;
  } = {},
): Promise<string[]> {
  const allow = new Set(readPluginAllowlist(config));
  const entries = cloneNormalizedPluginEntries(config);
  const bundledPluginIds = await discoverBundledPluginIds(configRepository, pluginFileSystem);
  return normalizePluginIds(
    (await readDiscoveredPluginState(configRepository, pluginFileSystem, options))
      .filter((plugin) => {
        if (bundledPluginIds.has(plugin.id)) {
          return false;
        }
        return allow.has(plugin.id) || entries[plugin.id]?.enabled === true;
      })
      .map((plugin) => plugin.id),
  );
}

export async function readManuallyManagedPluginIdsFromConfig(
  configRepository: Pick<OpenClawConfigRepositoryPort, 'getConfigDir' | 'getOpenClawDirPath'>,
  pluginFileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'listDirectoryEntries'>,
  config: Record<string, unknown>,
): Promise<string[]> {
  const entries = cloneNormalizedPluginEntries(config);
  const bundledPluginIds = await discoverBundledPluginIds(configRepository, pluginFileSystem);
  const disabledPluginIds = new Set(
    Object.entries(entries)
      .filter(([, entry]) => entry.enabled === false)
      .map(([pluginId]) => pluginId),
  );
  const manualEntryPluginIds = Object.entries(entries)
    .filter(([pluginId, entry]) => (
      entry.enabled === true
      && !isChannelDerivedPluginId(pluginId)
      && !bundledPluginIds.has(pluginId)
    ))
    .map(([pluginId]) => pluginId);
  return normalizeCanonicalPluginIds([
    ...readPluginAllowlist(config),
    ...manualEntryPluginIds,
  ]).filter((pluginId) => (
    !isChannelDerivedPluginId(pluginId)
    && !bundledPluginIds.has(pluginId)
    && !disabledPluginIds.has(pluginId)
  ));
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

async function listOwnedPluginIds(
  configRepository: Pick<OpenClawConfigRepositoryPort, 'getConfigDir' | 'getOpenClawDirPath'>,
  pluginFileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'listDirectoryEntries'>,
  pluginIds: readonly string[],
  currentEntries: Record<string, Record<string, unknown>>,
): Promise<Set<string>> {
  const bundledPluginIds = await discoverBundledPluginIds(configRepository, pluginFileSystem);
  return new Set(normalizeCanonicalPluginIds([
    ...pluginIds,
    ...Object.keys(currentEntries).filter((pluginId) => (
      (
        isMatchaClawManagedPluginId(pluginId)
        || isChannelDerivedPluginId(pluginId)
        || pluginId === 'browser'
        || pluginId === 'feishu'
      )
      && !bundledPluginIds.has(pluginId)
    )),
    ...CAPABILITY_OPENCLAW_PLUGIN_DEFINITIONS.map((definition) => definition.id),
    ...Object.keys(LEGACY_PLUGIN_ID_MAP),
    ...Object.values(LEGACY_PLUGIN_ID_MAP),
    ...EXTERNAL_CHANNEL_PLUGIN_BINDINGS.map((binding) => binding.pluginId),
    ...EXTERNAL_CHANNEL_PLUGIN_BINDINGS.flatMap((binding) => [...(binding.legacyPluginIds ?? [])]),
    'browser',
    'browser-relay',
    'feishu',
  ]));
}

async function buildTrustedPluginAllowlist(
  configRepository: Pick<OpenClawConfigRepositoryPort, 'getConfigDir' | 'getOpenClawDirPath'>,
  pluginFileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'listDirectoryEntries'>,
  currentConfig: Record<string, unknown>,
  nextEntries: Record<string, Record<string, unknown>>,
  enabledPluginIds: readonly string[],
  ownedPluginIds: ReadonlySet<string>,
): Promise<string[]> {
  const bundledPluginIds = await discoverBundledPluginIds(configRepository, pluginFileSystem);
  const disabledSet = new Set(
    Object.entries(nextEntries)
      .filter(([, entry]) => entry.enabled === false)
      .map(([pluginId]) => pluginId),
  );
  const trustedIds = new Set<string>();

  for (const pluginId of readPluginAllowlist(currentConfig)) {
    const canonicalPluginId = LEGACY_PLUGIN_ID_MAP[pluginId] ?? pluginId;
    if (
      !ownedPluginIds.has(canonicalPluginId)
      && !disabledSet.has(canonicalPluginId)
    ) {
      trustedIds.add(canonicalPluginId);
    }
  }

  for (const pluginId of enabledPluginIds) {
    if (
      !disabledSet.has(pluginId)
      && canWritePluginToTrustedAllowlist(pluginId, bundledPluginIds)
    ) {
      trustedIds.add(pluginId);
    }
  }

  for (const [pluginId, entry] of Object.entries(nextEntries)) {
    if (
      entry.enabled === true
      && canWritePluginToTrustedAllowlist(pluginId, bundledPluginIds)
    ) {
      trustedIds.add(pluginId);
    }
  }

  return normalizeCanonicalPluginIds([...trustedIds]);
}

function canWritePluginToTrustedAllowlist(pluginId: string, bundledPluginIds: ReadonlySet<string>): boolean {
  if (bundledPluginIds.has(pluginId)) {
    return false;
  }
  return !isChannelDerivedPluginId(pluginId) || getExternalChannelTypeByPluginId(pluginId) !== undefined;
}

function applyTeamRuntimePluginConfig(entry: Record<string, unknown>, config: Record<string, unknown>): Record<string, unknown> {
  const currentPluginConfig = isRecord(entry.config) ? entry.config : {};
  return {
    ...entry,
    config: {
      ...currentPluginConfig,
      availableSkills: readTeamRuntimeAvailableSkills(currentPluginConfig, config),
      availableTools: readTeamRuntimeAvailableTools(currentPluginConfig, config),
    },
  };
}

function readTeamRuntimeAvailableSkills(pluginConfig: Record<string, unknown>, config: Record<string, unknown>): string[] {
  const skills = isRecord(config.skills) ? config.skills : {};
  const entries = isRecord(skills.entries) ? skills.entries : {};
  const enabledSkills = normalizePluginIds(
    Object.entries(entries)
      .filter(([, entry]) => isRecord(entry) && entry.enabled === true)
      .map(([skillKey]) => skillKey),
  );
  return enabledSkills;
}

function readTeamRuntimeAvailableTools(pluginConfig: Record<string, unknown>, _config: Record<string, unknown>): string[] {
  const configured = readNonEmptyStringArray(pluginConfig.availableTools);
  return configured.length > 0 ? configured : [TEAM_RUNTIME_UNRESTRICTED_TOOL_MARKER];
}

function readNonEmptyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

export async function applyEnabledPluginIdsToOpenClawConfig(
  configRepository: Pick<OpenClawConfigRepositoryPort, 'getConfigDir' | 'getOpenClawDirPath'>,
  pluginFileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'listDirectoryEntries'>,
  currentConfig: Record<string, unknown>,
  pluginIds: readonly string[],
): Promise<Record<string, unknown>> {
  const bundledProviderPluginIds = await discoverBundledProviderPluginIds(configRepository, pluginFileSystem);
  const normalizedPluginIds = normalizeCanonicalPluginIds(pluginIds)
    .filter((pluginId) => !bundledProviderPluginIds.has(pluginId));
  const enabledSet = new Set(normalizedPluginIds);
  const config = cloneConfig(currentConfig);
  const plugins = isRecord(config.plugins) ? { ...config.plugins } : {};
  const nextEntries = cloneNormalizedPluginEntries(config);
  const ownedPluginIds = await listOwnedPluginIds(configRepository, pluginFileSystem, normalizedPluginIds, nextEntries);

  if (enabledSet.has('openclaw-lark') && nextEntries.feishu) {
    delete nextEntries.feishu;
  }

  for (const pluginId of normalizedPluginIds) {
    const currentEntry = nextEntries[pluginId] ?? {};
    const enabledEntry = {
      ...currentEntry,
      enabled: true,
    };
    nextEntries[pluginId] = pluginId === TEAM_RUNTIME_PLUGIN_ID
      ? applyTeamRuntimePluginConfig(enabledEntry, config)
      : enabledEntry;
  }

  for (const [pluginId, rawEntry] of Object.entries(nextEntries)) {
    if (!ownedPluginIds.has(pluginId)) {
      continue;
    }
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

  const nextAllow = await buildTrustedPluginAllowlist(configRepository, pluginFileSystem, currentConfig, nextEntries, normalizedPluginIds, ownedPluginIds);
  if (nextAllow.length > 0) {
    plugins.allow = nextAllow;
  } else {
    delete plugins.allow;
  }
  plugins.entries = nextEntries;
  config.plugins = plugins;
  cleanupPluginContainer(config);

  return await applyPluginSkillStateToConfig(configRepository, pluginFileSystem, config, normalizedPluginIds);
}

export async function applyManuallyManagedPluginIdsToOpenClawConfig(
  configRepository: Pick<OpenClawConfigRepositoryPort, 'getConfigDir' | 'getOpenClawDirPath'>,
  pluginFileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'listDirectoryEntries'>,
  currentConfig: Record<string, unknown>,
  manualPluginIds: readonly string[],
): Promise<Record<string, unknown>> {
  const channelMirroredConfig = mirrorPluginBackedChannelStateToOpenClawConfig(currentConfig);
  return await applyEnabledPluginIdsToOpenClawConfig(
    configRepository,
    pluginFileSystem,
    channelMirroredConfig,
    resolveEffectivePluginIdsForConfig(channelMirroredConfig, manualPluginIds),
  );
}

export class OpenClawPluginConfigService {
  constructor(
    private readonly configWorkflow: Pick<OpenClawPluginConfigWorkflow, 'readEnabledPluginIds' | 'syncEnabledPluginIds'>,
  ) {}

  async readEnabledPluginIds(): Promise<string[]> {
    return await this.configWorkflow.readEnabledPluginIds();
  }

  async syncEnabledPluginIds(pluginIds: readonly string[]): Promise<string[]> {
    return await this.configWorkflow.syncEnabledPluginIds(pluginIds);
  }
}
