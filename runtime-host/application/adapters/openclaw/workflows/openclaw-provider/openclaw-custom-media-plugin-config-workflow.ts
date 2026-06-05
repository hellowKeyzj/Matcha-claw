import { MATCHACLAW_MEDIA_PLUGIN_ID, MATCHACLAW_MEDIA_PROVIDER_ID } from '../../../../providers/custom-media-runtime-projection';
import type { OpenClawConfigRepositoryPort } from '../../infrastructure/openclaw-config-repository';

export interface OpenClawCustomMediaModelEntry {
  readonly modelId: string;
  readonly capabilities: readonly string[];
  readonly timeoutMs?: number;
  readonly aspectRatio?: string;
  readonly resolution?: string;
  readonly quality?: string;
}

export interface OpenClawCustomMediaProviderEntry {
  readonly label?: string;
  readonly baseUrl: string;
  readonly apiProtocol: string;
  readonly headers?: Record<string, string>;
  readonly models: readonly OpenClawCustomMediaModelEntry[];
  readonly replaceProviderKeys?: readonly string[];
}

export type OpenClawCustomMediaProviderMap = Record<string, OpenClawCustomMediaProviderEntry>;

export class OpenClawCustomMediaPluginConfigWorkflow {
  constructor(private readonly configRepository: OpenClawConfigRepositoryPort) {}

  async readAll(): Promise<Record<string, OpenClawCustomMediaModelEntry[]>> {
    const config = await this.configRepository.read();
    const plugins = isRecord(config.plugins) ? config.plugins : {};
    const entries = isRecord(plugins.entries) ? plugins.entries : {};
    const entry = isRecord(entries[MATCHACLAW_MEDIA_PLUGIN_ID]) ? entries[MATCHACLAW_MEDIA_PLUGIN_ID] : {};
    const pluginConfig = isRecord(entry.config) ? entry.config : {};
    const providers = isRecord(pluginConfig.providers) ? pluginConfig.providers : {};
    const out: Record<string, OpenClawCustomMediaModelEntry[]> = {};
    for (const [providerKey, provider] of Object.entries(providers)) {
      if (!isRecord(provider)) continue;
      const models = normalizeModels(provider.models);
      if (models.length > 0) {
        out[providerKey] = models;
      }
    }
    return out;
  }

  async replaceAll(providerMap: OpenClawCustomMediaProviderMap): Promise<void> {
    return await this.configRepository.updateDirty((config) => {
      const providerKeys = new Set(Object.keys(providerMap));
      const providers = buildProvidersConfig(providerMap);
      const changed = applyCustomMediaProviders(config, providers, providerKeys, providerMap);
      return { result: undefined, changed };
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => entry[0].trim().length > 0 && typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .map(([key, item]) => [key, item.trim()] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeModels(value: unknown): OpenClawCustomMediaModelEntry[] {
  if (!Array.isArray(value)) return [];
  const out: OpenClawCustomMediaModelEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const modelId = normalizeString(item.id) ?? normalizeString(item.modelId);
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    out.push({
      modelId,
      capabilities: Array.isArray(item.capabilities)
        ? item.capabilities.filter((capability): capability is string => typeof capability === 'string' && capability.trim().length > 0)
        : [],
      ...(normalizePositiveInteger(item.timeoutMs) !== undefined ? { timeoutMs: normalizePositiveInteger(item.timeoutMs) } : {}),
      ...(normalizeString(item.aspectRatio) !== undefined ? { aspectRatio: normalizeString(item.aspectRatio) } : {}),
      ...(normalizeString(item.resolution) !== undefined ? { resolution: normalizeString(item.resolution) } : {}),
      ...(normalizeString(item.quality) !== undefined ? { quality: normalizeString(item.quality) } : {}),
    });
  }
  return out;
}

function buildProvidersConfig(providerMap: OpenClawCustomMediaProviderMap): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const [providerKey, provider] of Object.entries(providerMap)) {
    const baseUrl = normalizeString(provider.baseUrl);
    const apiProtocol = normalizeString(provider.apiProtocol);
    if (!baseUrl || !apiProtocol) continue;
    const headers = normalizeHeaders(provider.headers);
    providers[providerKey] = {
      ...(provider.label ? { label: provider.label } : {}),
      baseUrl,
      apiProtocol,
      ...(headers ? { headers } : {}),
      models: provider.models.map((model) => ({
        id: model.modelId,
        capabilities: [...model.capabilities],
        ...(model.timeoutMs !== undefined ? { timeoutMs: model.timeoutMs } : {}),
        ...(model.aspectRatio !== undefined ? { aspectRatio: model.aspectRatio } : {}),
        ...(model.resolution !== undefined ? { resolution: model.resolution } : {}),
        ...(model.quality !== undefined ? { quality: model.quality } : {}),
      })),
    };
  }
  return providers;
}

function applyCustomMediaProviders(
  config: Record<string, unknown>,
  providers: Record<string, unknown>,
  providerKeys: ReadonlySet<string>,
  providerMap: OpenClawCustomMediaProviderMap,
): boolean {
  let changed = false;
  if (providerKeys.size > 0 && ensurePluginEnabled(config)) {
    changed = true;
  }
  const entry = ensurePluginEntry(config);
  const pluginConfig = isRecord(entry.config) ? { ...entry.config } : {};
  if (!deepEqual(pluginConfig.providers, providers)) {
    pluginConfig.providers = providers;
    entry.config = pluginConfig;
    changed = true;
  }
  for (const [providerKey, provider] of Object.entries(providerMap)) {
    if (removeModelProviderNode(config, providerKey)) {
      changed = true;
    }
    for (const oldProviderKey of provider.replaceProviderKeys ?? []) {
      if (removeModelProviderNode(config, oldProviderKey)) {
        changed = true;
      }
    }
  }
  return rewriteLegacyMediaRoutes(config, providerKeys) || changed;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ensurePlugins(config: Record<string, unknown>): Record<string, unknown> {
  const plugins = isRecord(config.plugins) ? { ...config.plugins } : {};
  if (config.plugins !== plugins) {
    config.plugins = plugins;
  }
  return plugins;
}

function ensurePluginEntry(config: Record<string, unknown>): Record<string, unknown> {
  const plugins = ensurePlugins(config);
  const entries = isRecord(plugins.entries) ? { ...plugins.entries } : {};
  const entry = isRecord(entries[MATCHACLAW_MEDIA_PLUGIN_ID])
    ? { ...entries[MATCHACLAW_MEDIA_PLUGIN_ID] as Record<string, unknown> }
    : {};
  entries[MATCHACLAW_MEDIA_PLUGIN_ID] = entry;
  plugins.entries = entries;
  return entry;
}

function ensurePluginEnabled(config: Record<string, unknown>): boolean {
  let changed = false;
  const plugins = ensurePlugins(config);
  const allow = Array.isArray(plugins.allow)
    ? plugins.allow.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  if (!allow.includes(MATCHACLAW_MEDIA_PLUGIN_ID)) {
    plugins.allow = [...allow, MATCHACLAW_MEDIA_PLUGIN_ID].sort((left, right) => left.localeCompare(right, 'en'));
    changed = true;
  }
  const entry = ensurePluginEntry(config);
  if (entry.enabled !== true) {
    entry.enabled = true;
    changed = true;
  }
  return changed;
}

function removeModelProviderNode(config: Record<string, unknown>, providerKey: string): boolean {
  const models = isRecord(config.models) ? { ...config.models } : {};
  const providers = isRecord(models.providers) ? { ...models.providers } : {};
  if (!(providerKey in providers)) {
    return false;
  }
  delete providers[providerKey];
  models.providers = providers;
  config.models = models;
  return true;
}

function replaceLegacyMediaRef(value: unknown, providerKeys: ReadonlySet<string>): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1) return { value, changed: false };
    const providerKey = value.slice(0, slash);
    if (!providerKeys.has(providerKey)) return { value, changed: false };
    return { value: `${MATCHACLAW_MEDIA_PROVIDER_ID}/${value}`, changed: true };
  }
  if (!isRecord(value)) return { value, changed: false };
  let changed = false;
  const next = { ...value };
  if (typeof next.primary === 'string') {
    const primary = replaceLegacyMediaRef(next.primary, providerKeys);
    next.primary = primary.value;
    changed = primary.changed || changed;
  }
  if (Array.isArray(next.fallbacks)) {
    const fallbacks = next.fallbacks.map((fallback) => {
      const replaced = replaceLegacyMediaRef(fallback, providerKeys);
      changed = replaced.changed || changed;
      return replaced.value;
    });
    next.fallbacks = fallbacks;
  }
  return { value: changed ? next : value, changed };
}

function rewriteLegacyMediaRoutes(config: Record<string, unknown>, providerKeys: ReadonlySet<string>): boolean {
  let changed = false;
  const agents = isRecord(config.agents) ? { ...config.agents } : {};
  const defaults = isRecord(agents.defaults) ? { ...agents.defaults } : {};
  for (const key of ['imageGenerationModel', 'videoGenerationModel', 'musicGenerationModel']) {
    if (defaults[key] !== undefined) {
      const replaced = replaceLegacyMediaRef(defaults[key], providerKeys);
      defaults[key] = replaced.value;
      changed = replaced.changed || changed;
    }
  }
  if (changed) {
    agents.defaults = defaults;
    config.agents = agents;
  }
  return changed;
}
