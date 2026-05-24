import { normalizePluginIds } from '../../bootstrap/runtime-config';

export const LEGACY_PLUGIN_ID_MAP: Record<string, string> = {
  'feishu-openclaw-plugin': 'openclaw-lark',
  'wecom-openclaw-plugin': 'wecom',
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeCanonicalPluginIds(pluginIds: readonly string[]): string[] {
  const normalized = normalizePluginIds(
    pluginIds.map((pluginId) => LEGACY_PLUGIN_ID_MAP[pluginId] ?? pluginId),
  );
  if (!normalized.includes('openclaw-lark')) {
    return normalized;
  }
  return normalized.filter((pluginId) => pluginId !== 'feishu');
}

export function readPluginAllowlist(config: Record<string, unknown>): string[] {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const allow = Array.isArray(plugins.allow) ? plugins.allow : [];
  return normalizeCanonicalPluginIds(
    allow.filter((item): item is string => typeof item === 'string'),
  );
}

export function readPluginDenylist(config: Record<string, unknown>): string[] {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const deny = Array.isArray(plugins.deny) ? plugins.deny : [];
  return normalizeCanonicalPluginIds(
    deny.filter((item): item is string => typeof item === 'string'),
  );
}

export function cloneNormalizedPluginEntries(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
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

export function cleanupPluginContainer(config: Record<string, unknown>): void {
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

export function cloneConfig(config: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}
