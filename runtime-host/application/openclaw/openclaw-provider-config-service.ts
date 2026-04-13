import { readFile, writeFile } from 'fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'path';
import { homedir } from 'os';
import {
  getProviderEnvVar,
  getProviderDefaultModel,
  getProviderConfig,
} from '../providers/provider-registry';
import {
  OPENCLAW_PROVIDER_KEY_MOONSHOT,
  isOpenClawOAuthPluginProviderKey,
} from '../providers/provider-runtime-rules';
import {
  discoverAgentIds,
  fileExists,
  OPENCLAW_CONFIG_PATH,
  readAuthProfiles,
  readJsonFile,
  readOpenClawJson,
  writeAuthProfiles,
  writeOpenClawJson,
} from './openclaw-auth-store';
import { removeProfilesForProvider } from './openclaw-auth-profile-store';
import { createRuntimeLogger } from '../../shared/logger';
import { withOpenClawConfigLock } from './openclaw-config-mutex';
import { getOpenClawDirPath } from '../../api/storage/paths';

const logger = createRuntimeLogger('openclaw-provider-config-service');
const BUILTIN_CHANNEL_IDS = new Set([
  'discord',
  'telegram',
  'whatsapp',
  'slack',
  'signal',
  'imessage',
  'matrix',
  'line',
  'msteams',
  'googlechat',
  'mattermost',
]);
const AUTH_PROFILE_PROVIDER_KEY_MAP: Record<string, string> = {
  'openai-codex': 'openai',
  'google-gemini-cli': 'google',
};
const AUTH_PROFILE_PROVIDER_KEY_REVERSE_MAP: Record<string, string[]> = Object.entries(
  AUTH_PROFILE_PROVIDER_KEY_MAP,
).reduce<Record<string, string[]>>((accumulator, [rawKey, normalizedKey]) => {
  if (!accumulator[normalizedKey]) {
    accumulator[normalizedKey] = [];
  }
  accumulator[normalizedKey].push(rawKey);
  return accumulator;
}, {});

type BundledPluginDiscovery = {
  dir: string;
  all: Set<string>;
  enabledByDefault: string[];
};

let bundledPluginDiscoveryCache: BundledPluginDiscovery | null = null;

function discoverBundledPlugins(): BundledPluginDiscovery {
  const extensionsDir = join(getOpenClawDirPath(), 'dist', 'extensions');
  if (bundledPluginDiscoveryCache?.dir === extensionsDir) {
    return bundledPluginDiscoveryCache;
  }

  const all = new Set<string>();
  const enabledByDefault: string[] = [];

  if (existsSync(extensionsDir)) {
    try {
      for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const manifestPath = join(extensionsDir, entry.name, 'openclaw.plugin.json');
        if (!existsSync(manifestPath)) {
          continue;
        }
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
          const pluginId = typeof manifest.id === 'string' ? manifest.id.trim() : '';
          if (!pluginId) {
            continue;
          }
          all.add(pluginId);
          if (manifest.enabledByDefault === true) {
            enabledByDefault.push(pluginId);
          }
        } catch {
          // Ignore malformed plugin manifest.
        }
      }
    } catch {
      // Ignore unreadable extension directory.
    }
  }

  bundledPluginDiscoveryCache = {
    dir: extensionsDir,
    all,
    enabledByDefault,
  };
  return bundledPluginDiscoveryCache;
}

function normalizeAuthProfileProviderKey(provider: string): string {
  return AUTH_PROFILE_PROVIDER_KEY_MAP[provider] ?? provider;
}

function expandProviderKeysForDeletion(provider: string): string[] {
  return [provider, ...(AUTH_PROFILE_PROVIDER_KEY_REVERSE_MAP[provider] ?? [])];
}

function addProvidersFromProfileEntries(
  profiles: Record<string, unknown> | undefined,
  target: Set<string>,
): void {
  if (!profiles || typeof profiles !== 'object') {
    return;
  }

  for (const profile of Object.values(profiles)) {
    const provider = typeof (profile as Record<string, unknown>)?.provider === 'string'
      ? ((profile as Record<string, unknown>).provider as string)
      : undefined;
    if (!provider) {
      continue;
    }
    target.add(normalizeAuthProfileProviderKey(provider));
  }
}

async function getProvidersFromAuthProfileStores(): Promise<Set<string>> {
  const providers = new Set<string>();
  const agentIds = await discoverAgentIds();

  for (const agentId of agentIds) {
    const store = await readAuthProfiles(agentId);
    addProvidersFromProfileEntries(store.profiles, providers);
  }

  return providers;
}

function getOAuthPluginId(provider: string): string {
  return `${provider}-auth`;
}

function isProviderModelRef(value: unknown, provider: string): boolean {
  return typeof value === 'string' && value.startsWith(`${provider}/`);
}

function pruneModelValueForProvider(value: unknown, provider: string): unknown | undefined {
  if (typeof value === 'string') {
    return isProviderModelRef(value, provider) ? undefined : value;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const modelObject = { ...(value as Record<string, unknown>) };
  const primary = typeof modelObject.primary === 'string' ? modelObject.primary : undefined;
  const rawFallbacks = Array.isArray(modelObject.fallbacks) ? modelObject.fallbacks : [];

  const filteredFallbacks: string[] = [];
  const seenFallbacks = new Set<string>();
  for (const fallback of rawFallbacks) {
    if (typeof fallback !== 'string') {
      continue;
    }
    if (isProviderModelRef(fallback, provider) || seenFallbacks.has(fallback)) {
      continue;
    }
    seenFallbacks.add(fallback);
    filteredFallbacks.push(fallback);
  }

  let nextPrimary = primary;
  if (!nextPrimary || isProviderModelRef(nextPrimary, provider)) {
    nextPrimary = filteredFallbacks.shift();
  }
  if (nextPrimary && filteredFallbacks[0] === nextPrimary) {
    filteredFallbacks.shift();
  }

  if (!nextPrimary) {
    return undefined;
  }

  modelObject.primary = nextPrimary;
  if (filteredFallbacks.length > 0) {
    modelObject.fallbacks = filteredFallbacks;
  } else {
    delete modelObject.fallbacks;
  }

  return modelObject;
}

export function pruneProviderModelRefsInAgentsConfig(config: Record<string, unknown>, provider: string): boolean {
  const agents = config.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
    return false;
  }

  const agentsObject = agents as Record<string, unknown>;
  let changed = false;

  const defaults = agentsObject.defaults;
  if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
    const defaultsObject = defaults as Record<string, unknown>;
    if ('model' in defaultsObject) {
      const previous = defaultsObject.model;
      const next = pruneModelValueForProvider(previous, provider);
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        changed = true;
        if (next === undefined) {
          delete defaultsObject.model;
        } else {
          defaultsObject.model = next;
        }
      }
    }
  }

  const list = agentsObject.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const entryObject = entry as Record<string, unknown>;
      if (!('model' in entryObject)) {
        continue;
      }
      const previous = entryObject.model;
      const next = pruneModelValueForProvider(previous, provider);
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        changed = true;
        if (next === undefined) {
          delete entryObject.model;
        } else {
          entryObject.model = next;
        }
      }
    }
  }

  return changed;
}

export async function removeProviderFromOpenClaw(provider: string): Promise<void> {
  const providerKeysToRemove = expandProviderKeysForDeletion(provider);
  const agentIds = await discoverAgentIds();
  if (agentIds.length === 0) {
    agentIds.push('main');
  }

  for (const id of agentIds) {
    const store = await readAuthProfiles(id);
    let modified = false;
    for (const providerKey of providerKeysToRemove) {
      if (removeProfilesForProvider(store, providerKey)) {
        modified = true;
      }
    }
    if (modified) {
      await writeAuthProfiles(store, id);
    }
  }

  for (const id of agentIds) {
    const modelsPath = join(homedir(), '.openclaw', 'agents', id, 'agent', 'models.json');
    try {
      if (await fileExists(modelsPath)) {
        const raw = await readFile(modelsPath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        const providers = data.providers as Record<string, unknown> | undefined;
        if (providers && providers[provider]) {
          delete providers[provider];
          await writeFile(modelsPath, JSON.stringify(data, null, 2), 'utf-8');
          logger.info(`Removed models.json entry for provider "${provider}" (agent "${id}")`);
        }
      }
    } catch (error) {
      logger.warn(`Failed to remove provider ${provider} from models.json (agent "${id}"):`, error);
    }
  }

  try {
    await withOpenClawConfigLock(async () => {
      const config = await readOpenClawJson();
      let modified = false;

      const plugins = config.plugins as Record<string, unknown> | undefined;
      const entries = (plugins?.entries ?? {}) as Record<string, Record<string, unknown>>;
      const pluginName = `${provider}-auth`;
      if (entries[pluginName]) {
        entries[pluginName].enabled = false;
        modified = true;
        logger.info(`Disabled OpenClaw plugin: ${pluginName}`);
      }

      const models = config.models as Record<string, unknown> | undefined;
      const providers = (models?.providers ?? {}) as Record<string, unknown>;
      if (providers[provider]) {
        delete providers[provider];
        modified = true;
        logger.info(`Removed OpenClaw provider config: ${provider}`);
      }

      const auth = (
        config.auth && typeof config.auth === 'object' && !Array.isArray(config.auth)
          ? (config.auth as Record<string, unknown>)
          : undefined
      );
      const authProfiles = (
        auth?.profiles && typeof auth.profiles === 'object' && !Array.isArray(auth.profiles)
          ? (auth.profiles as Record<string, Record<string, unknown>>)
          : undefined
      );
      if (authProfiles) {
        const providerKeysToClean = new Set(expandProviderKeysForDeletion(provider));
        for (const [profileId, profile] of Object.entries(authProfiles)) {
          if (!providerKeysToClean.has(profile?.provider)) {
            continue;
          }
          delete authProfiles[profileId];
          modified = true;
          logger.info(`Removed OpenClaw auth profile: ${profileId}`);
        }
      }

      if (pruneProviderModelRefsInAgentsConfig(config, provider)) {
        modified = true;
        logger.info(`Pruned stale agent model references for provider "${provider}"`);
      }

      if (modified) {
        await writeOpenClawJson(config);
      }
    });
  } catch (error) {
    logger.warn(`Failed to remove provider ${provider} from openclaw.json:`, error);
  }
}

export function buildProviderEnvVars(providers: Array<{ type: string; apiKey: string }>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { type, apiKey } of providers) {
    const envVar = getProviderEnvVar(type);
    if (envVar && apiKey) {
      env[envVar] = apiKey;
    }
  }
  return env;
}

interface RuntimeProviderConfigOverride {
  baseUrl?: string;
  api?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
}

type ProviderEntryBuildOptions = {
  baseUrl: string;
  api: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  modelIds?: string[];
  includeRegistryModels?: boolean;
  mergeExistingModels?: boolean;
};

function normalizeModelRef(provider: string, modelOverride?: string): string | undefined {
  const rawModel = modelOverride || getProviderDefaultModel(provider);
  if (!rawModel) {
    return undefined;
  }
  return rawModel.startsWith(`${provider}/`) ? rawModel : `${provider}/${rawModel}`;
}

function extractModelId(provider: string, modelRef: string): string {
  return modelRef.startsWith(`${provider}/`) ? modelRef.slice(provider.length + 1) : modelRef;
}

function extractFallbackModelIds(provider: string, fallbackModels: string[]): string[] {
  return fallbackModels
    .filter((fallback) => fallback.startsWith(`${provider}/`))
    .map((fallback) => fallback.slice(provider.length + 1));
}

function mergeProviderModels(
  ...groups: Array<Array<Record<string, unknown>>>
): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const item of group) {
      const id = typeof item?.id === 'string' ? item.id : '';
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      merged.push(item);
    }
  }
  return merged;
}

function removeLegacyMoonshotProviderEntry(
  _provider: string,
  _providers: Record<string, unknown>,
): boolean {
  return false;
}

function upsertOpenClawProviderEntry(
  config: Record<string, unknown>,
  provider: string,
  options: ProviderEntryBuildOptions,
): void {
  const models = (config.models || {}) as Record<string, unknown>;
  const providers = (models.providers || {}) as Record<string, unknown>;
  const removedLegacyMoonshot = removeLegacyMoonshotProviderEntry(provider, providers);
  const existingProvider = (
    providers[provider] && typeof providers[provider] === 'object'
      ? (providers[provider] as Record<string, unknown>)
      : {}
  );

  const existingModels = options.mergeExistingModels && Array.isArray(existingProvider.models)
    ? (existingProvider.models as Array<Record<string, unknown>>)
    : [];
  const registryModels = options.includeRegistryModels
    ? ((getProviderConfig(provider)?.models ?? []).map((model) => ({ ...model })) as Array<Record<string, unknown>>)
    : [];
  const runtimeModels = (options.modelIds ?? []).map((id) => ({ id, name: id }));

  const nextProvider: Record<string, unknown> = {
    ...existingProvider,
    baseUrl: options.baseUrl,
    api: options.api,
    models: mergeProviderModels(registryModels, existingModels, runtimeModels),
  };
  if (options.apiKeyEnv) nextProvider.apiKey = options.apiKeyEnv;
  if (options.headers !== undefined) {
    if (Object.keys(options.headers).length > 0) {
      nextProvider.headers = options.headers;
    } else {
      delete nextProvider.headers;
    }
  }
  if (options.authHeader !== undefined) {
    nextProvider.authHeader = options.authHeader;
  } else {
    delete nextProvider.authHeader;
  }

  providers[provider] = nextProvider;
  models.providers = providers;
  config.models = models;

  if (removedLegacyMoonshot) {
    logger.info('Removed legacy models.providers.moonshot alias entry');
  }
}

function ensureMoonshotKimiWebSearchCnBaseUrl(config: Record<string, unknown>, provider: string): void {
  if (provider !== OPENCLAW_PROVIDER_KEY_MOONSHOT) {
    return;
  }

  const tools = (config.tools || {}) as Record<string, unknown>;
  const web = (tools.web || {}) as Record<string, unknown>;
  const search = (web.search || {}) as Record<string, unknown>;
  const kimi = (search.kimi && typeof search.kimi === 'object' && !Array.isArray(search.kimi))
    ? (search.kimi as Record<string, unknown>)
    : {};

  delete kimi.apiKey;
  kimi.baseUrl = 'https://api.moonshot.cn/v1';
  search.kimi = kimi;
  web.search = search;
  tools.web = web;
  config.tools = tools;
}

export async function setOpenClawDefaultModel(
  provider: string,
  modelOverride?: string,
  fallbackModels: string[] = [],
): Promise<void> {
  await withOpenClawConfigLock(async () => {
    const config = await readOpenClawJson();
    ensureMoonshotKimiWebSearchCnBaseUrl(config, provider);

    const model = normalizeModelRef(provider, modelOverride);
    if (!model) {
      logger.warn(`No default model mapping for provider "${provider}"`);
      return;
    }

    const modelId = extractModelId(provider, model);
    const fallbackModelIds = extractFallbackModelIds(provider, fallbackModels);

    const agents = (config.agents || {}) as Record<string, unknown>;
    const defaults = (agents.defaults || {}) as Record<string, unknown>;
    defaults.model = {
      primary: model,
      fallbacks: fallbackModels,
    };
    agents.defaults = defaults;
    config.agents = agents;

    const providerCfg = getProviderConfig(provider);
    if (providerCfg) {
      upsertOpenClawProviderEntry(config, provider, {
        baseUrl: providerCfg.baseUrl,
        api: providerCfg.api,
        apiKeyEnv: providerCfg.apiKeyEnv,
        headers: providerCfg.headers,
        modelIds: [modelId, ...fallbackModelIds],
        includeRegistryModels: true,
        mergeExistingModels: true,
      });
      logger.info(`Configured models.providers.${provider} with baseUrl=${providerCfg.baseUrl}, model=${modelId}`);
    } else {
      const models = (config.models || {}) as Record<string, unknown>;
      const providers = (models.providers || {}) as Record<string, unknown>;
      if (providers[provider]) {
        delete providers[provider];
        logger.info(`Removed stale models.providers.${provider} (built-in provider)`);
        models.providers = providers;
        config.models = models;
      }
    }

    const gateway = (config.gateway || {}) as Record<string, unknown>;
    if (!gateway.mode) gateway.mode = 'local';
    config.gateway = gateway;

    await writeOpenClawJson(config);
    logger.info(`Set OpenClaw default model to "${model}" for provider "${provider}"`);
  });
}

export async function syncProviderConfigToOpenClaw(
  provider: string,
  modelId: string | undefined,
  override: RuntimeProviderConfigOverride,
): Promise<void> {
  await withOpenClawConfigLock(async () => {
    const config = await readOpenClawJson();
    ensureMoonshotKimiWebSearchCnBaseUrl(config, provider);

    if (override.baseUrl && override.api) {
      upsertOpenClawProviderEntry(config, provider, {
        baseUrl: override.baseUrl,
        api: override.api,
        apiKeyEnv: override.apiKeyEnv,
        headers: override.headers,
        modelIds: modelId ? [modelId] : [],
      });
    }

    if (isOpenClawOAuthPluginProviderKey(provider)) {
      const plugins = (config.plugins || {}) as Record<string, unknown>;
      const allow = Array.isArray(plugins.allow) ? [...plugins.allow as string[]] : [];
      const entries = (plugins.entries || {}) as Record<string, unknown>;
      const pluginId = getOAuthPluginId(provider);
      if (!allow.includes(pluginId)) {
        allow.push(pluginId);
      }
      entries[pluginId] = { enabled: true };
      plugins.allow = allow;
      plugins.entries = entries;
      config.plugins = plugins;
    }

    await writeOpenClawJson(config);
  });
}

export async function setOpenClawDefaultModelWithOverride(
  provider: string,
  modelOverride: string | undefined,
  override: RuntimeProviderConfigOverride,
  fallbackModels: string[] = [],
): Promise<void> {
  await withOpenClawConfigLock(async () => {
    const config = await readOpenClawJson();
    ensureMoonshotKimiWebSearchCnBaseUrl(config, provider);

    const model = normalizeModelRef(provider, modelOverride);
    if (!model) {
      logger.warn(`No default model mapping for provider "${provider}"`);
      return;
    }

    const modelId = extractModelId(provider, model);
    const fallbackModelIds = extractFallbackModelIds(provider, fallbackModels);

    const agents = (config.agents || {}) as Record<string, unknown>;
    const defaults = (agents.defaults || {}) as Record<string, unknown>;
    defaults.model = {
      primary: model,
      fallbacks: fallbackModels,
    };
    agents.defaults = defaults;
    config.agents = agents;

    if (override.baseUrl && override.api) {
      upsertOpenClawProviderEntry(config, provider, {
        baseUrl: override.baseUrl,
        api: override.api,
        apiKeyEnv: override.apiKeyEnv,
        headers: override.headers,
        authHeader: override.authHeader,
        modelIds: [modelId, ...fallbackModelIds],
      });
    }

    const gateway = (config.gateway || {}) as Record<string, unknown>;
    if (!gateway.mode) gateway.mode = 'local';
    config.gateway = gateway;

    if (isOpenClawOAuthPluginProviderKey(provider)) {
      const plugins = (config.plugins || {}) as Record<string, unknown>;
      const allow = Array.isArray(plugins.allow) ? [...plugins.allow as string[]] : [];
      const entries = (plugins.entries || {}) as Record<string, unknown>;
      const pluginId = getOAuthPluginId(provider);
      if (!allow.includes(pluginId)) {
        allow.push(pluginId);
      }
      entries[pluginId] = { enabled: true };
      plugins.allow = allow;
      plugins.entries = entries;
      config.plugins = plugins;
    }

    await writeOpenClawJson(config);
    logger.info(`Set OpenClaw default model to "${model}" for provider "${provider}" (runtime override)`);
  });
}

export async function getOpenClawProvidersSnapshot(): Promise<{
  providers: Record<string, Record<string, unknown>>;
  defaultModel: string | undefined;
  activeProviders: Set<string>;
}> {
  try {
    const config = await readOpenClawJson();
    const models = (config.models && typeof config.models === 'object' && !Array.isArray(config.models))
      ? (config.models as Record<string, unknown>)
      : {};
    const providersRaw = (models.providers && typeof models.providers === 'object' && !Array.isArray(models.providers))
      ? (models.providers as Record<string, unknown>)
      : {};
    const providers = Object.fromEntries(
      Object.entries(providersRaw).map(([providerId, providerEntry]) => (
        [
          providerId,
          providerEntry && typeof providerEntry === 'object' && !Array.isArray(providerEntry)
            ? { ...(providerEntry as Record<string, unknown>) }
            : {},
        ] as const
      )),
    ) as Record<string, Record<string, unknown>>;
    const activeProviders = new Set<string>(Object.keys(providers));

    const agents = (config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents))
      ? (config.agents as Record<string, unknown>)
      : {};
    const defaults = (agents.defaults && typeof agents.defaults === 'object' && !Array.isArray(agents.defaults))
      ? (agents.defaults as Record<string, unknown>)
      : {};
    const modelConfig = (defaults.model && typeof defaults.model === 'object' && !Array.isArray(defaults.model))
      ? (defaults.model as Record<string, unknown>)
      : {};
    const defaultModel = typeof modelConfig.primary === 'string' ? modelConfig.primary : undefined;
    if (defaultModel?.includes('/')) {
      activeProviders.add(defaultModel.split('/')[0]);
    }

    const plugins = (config.plugins as Record<string, unknown> | undefined)?.entries;
    if (plugins && typeof plugins === 'object') {
      for (const [pluginId, meta] of Object.entries(plugins as Record<string, unknown>)) {
        if (pluginId.endsWith('-auth') && (meta as Record<string, unknown>).enabled) {
          activeProviders.add(pluginId.replace(/-auth$/, ''));
        }
      }
    }

    const authProviders = new Set<string>();
    const auth = config.auth as Record<string, unknown> | undefined;
    addProvidersFromProfileEntries(auth?.profiles as Record<string, unknown> | undefined, authProviders);

    const authProfileProviders = await getProvidersFromAuthProfileStores();
    for (const provider of authProfileProviders) {
      authProviders.add(provider);
    }

    for (const provider of authProviders) {
      if (!providers[provider]) {
        providers[provider] = {};
      }
      activeProviders.add(provider);
    }

    return { providers, defaultModel, activeProviders };
  } catch (error) {
    logger.warn('Failed to read openclaw provider snapshot:', error);
    return { providers: {}, defaultModel: undefined, activeProviders: new Set<string>() };
  }
}

export async function getActiveOpenClawProviders(): Promise<Set<string>> {
  const { activeProviders } = await getOpenClawProvidersSnapshot();
  return activeProviders;
}

export async function getOpenClawProvidersConfig(): Promise<{
  providers: Record<string, Record<string, unknown>>;
  defaultModel: string | undefined;
}> {
  const { providers, defaultModel } = await getOpenClawProvidersSnapshot();
  return { providers, defaultModel };
}

function isBundledPluginLoadPath(pathname: string): boolean {
  const normalized = pathname.replace(/\\/g, '/');
  if (normalized.includes('node_modules/openclaw/extensions')) {
    return true;
  }
  if (!isAbsolute(pathname)) {
    return false;
  }
  const localBuildPluginsRoot = join(process.cwd(), 'build', 'openclaw-plugins').replace(/\\/g, '/');
  return normalized === localBuildPluginsRoot || normalized.startsWith(`${localBuildPluginsRoot}/`);
}

async function sanitizePluginsLoadPaths(config: Record<string, unknown>): Promise<boolean> {
  const plugins = config.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    return false;
  }

  const pluginsObj = plugins as Record<string, unknown>;
  let modified = false;

  const sanitizePathList = async (list: unknown[]): Promise<unknown[]> => {
    const retained: unknown[] = [];
    for (const entry of list) {
      if (typeof entry !== 'string' || !isAbsolute(entry)) {
        retained.push(entry);
        continue;
      }
      if (isBundledPluginLoadPath(entry) || !(await fileExists(entry))) {
        logger.info(`[sanitize] Removing stale/bundled plugin path "${entry}"`);
        modified = true;
        continue;
      }
      retained.push(entry);
    }
    return retained;
  };

  if (Array.isArray(pluginsObj.load)) {
    const sanitized = await sanitizePathList(pluginsObj.load as unknown[]);
    if (sanitized.length !== (pluginsObj.load as unknown[]).length) {
      pluginsObj.load = sanitized;
      modified = true;
    }
    return modified;
  }

  if (!pluginsObj.load || typeof pluginsObj.load !== 'object' || Array.isArray(pluginsObj.load)) {
    return modified;
  }

  const loadObject = pluginsObj.load as Record<string, unknown>;
  if (!Array.isArray(loadObject.paths)) {
    return modified;
  }

  const original = loadObject.paths as unknown[];
  const sanitized = await sanitizePathList(original);
  if (sanitized.length !== original.length) {
    loadObject.paths = sanitized;
    modified = true;
  }
  return modified;
}

export async function syncGatewayTokenToConfig(token: string): Promise<void> {
  await withOpenClawConfigLock(async () => {
    const config = await readOpenClawJson();

    const gateway = (
      config.gateway && typeof config.gateway === 'object'
        ? { ...(config.gateway as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;

    const auth = (
      gateway.auth && typeof gateway.auth === 'object'
        ? { ...(gateway.auth as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;

    auth.mode = 'token';
    auth.token = token;
    gateway.auth = auth;

    const controlUi = (
      gateway.controlUi && typeof gateway.controlUi === 'object'
        ? { ...(gateway.controlUi as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    const allowedOrigins = Array.isArray(controlUi.allowedOrigins)
      ? (controlUi.allowedOrigins as unknown[]).filter((value): value is string => typeof value === 'string')
      : [];
    if (!allowedOrigins.includes('file://')) {
      controlUi.allowedOrigins = [...allowedOrigins, 'file://'];
    }
    gateway.controlUi = controlUi;

    if (!gateway.mode) gateway.mode = 'local';
    config.gateway = gateway;

    await writeOpenClawJson(config);
    logger.info('Synced gateway token to openclaw.json');
  });
}

export async function syncBrowserConfigToOpenClaw(): Promise<void> {
  await withOpenClawConfigLock(async () => {
    const config = await readOpenClawJson();

    const browser = (
      config.browser && typeof config.browser === 'object'
        ? { ...(config.browser as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;

    let changed = false;

    if (browser.enabled === undefined) {
      browser.enabled = true;
      changed = true;
    }

    if (browser.defaultProfile === undefined) {
      browser.defaultProfile = 'openclaw';
      changed = true;
    }

    if (!changed) {
      return;
    }

    config.browser = browser;
    await writeOpenClawJson(config);
    logger.info('Synced browser config to openclaw.json');
  });
}

export async function syncSessionIdleMinutesToOpenClaw(): Promise<void> {
  const DEFAULT_IDLE_MINUTES = 10_080;
  await withOpenClawConfigLock(async () => {
    const config = await readOpenClawJson();
    const session = (
      config.session && typeof config.session === 'object'
        ? { ...(config.session as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;

    if (session.idleMinutes !== undefined) {
      return;
    }
    if (
      session.reset !== undefined
      || session.resetByType !== undefined
      || session.resetByChannel !== undefined
    ) {
      return;
    }

    session.idleMinutes = DEFAULT_IDLE_MINUTES;
    config.session = session;
    await writeOpenClawJson(config);
    logger.info(`Synced session.idleMinutes=${DEFAULT_IDLE_MINUTES} to openclaw.json`);
  });
}

export async function sanitizeOpenClawConfig(): Promise<void> {
  await withOpenClawConfigLock(async () => {
    if (!(await fileExists(OPENCLAW_CONFIG_PATH))) {
      logger.info('[sanitize] openclaw.json does not exist yet, skipping sanitization');
      return;
    }
    const rawConfig = await readJsonFile<Record<string, unknown>>(OPENCLAW_CONFIG_PATH);
    if (rawConfig === null) {
      logger.warn('[sanitize] openclaw.json is unreadable, skipping sanitization to avoid accidental overwrite');
      return;
    }
    const config = rawConfig;
    let modified = false;

    const skills = config.skills;
    if (skills && typeof skills === 'object' && !Array.isArray(skills)) {
      const skillsObj = skills as Record<string, unknown>;
      for (const key of ['enabled', 'disabled']) {
        if (key in skillsObj) {
          logger.info(`[sanitize] Removing misplaced key "skills.${key}" from openclaw.json`);
          delete skillsObj[key];
          modified = true;
        }
      }
    }

    const commands = (
      config.commands && typeof config.commands === 'object'
        ? { ...(config.commands as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    if (commands.restart !== true) {
      commands.restart = true;
      config.commands = commands;
      modified = true;
      logger.info('[sanitize] Enabling commands.restart for graceful reload support');
    }

    const providers = ((config.models as Record<string, unknown> | undefined)?.providers as Record<string, unknown> | undefined) || {};
    if (providers[OPENCLAW_PROVIDER_KEY_MOONSHOT]) {
      const tools = (config.tools as Record<string, unknown> | undefined) || {};
      const web = (tools.web as Record<string, unknown> | undefined) || {};
      const search = (web.search as Record<string, unknown> | undefined) || {};
      const kimi = (search.kimi as Record<string, unknown> | undefined) || {};
      if ('apiKey' in kimi) {
        logger.info('[sanitize] Removing stale key "tools.web.search.kimi.apiKey" from openclaw.json');
        delete kimi.apiKey;
        search.kimi = kimi;
        web.search = search;
        tools.web = web;
        config.tools = tools;
        modified = true;
      }
    }

    const toolsConfig = (config.tools as Record<string, unknown> | undefined) || {};
    let toolsModified = false;

    if (toolsConfig.profile !== 'full') {
      toolsConfig.profile = 'full';
      toolsModified = true;
    }

    const sessions = (toolsConfig.sessions as Record<string, unknown> | undefined) || {};
    if (sessions.visibility !== 'all') {
      sessions.visibility = 'all';
      toolsConfig.sessions = sessions;
      toolsModified = true;
    }

    if (toolsModified) {
      config.tools = toolsConfig;
      modified = true;
      logger.info('[sanitize] Enforced tools.profile="full" and tools.sessions.visibility="all" for OpenClaw 3.8+');
    }

    if (await sanitizePluginsLoadPaths(config)) {
      modified = true;
    }

    const plugins = config.plugins;
    if (plugins && typeof plugins === 'object' && !Array.isArray(plugins)) {
      const pluginsObj = plugins as Record<string, unknown>;
      const entries = pluginsObj.entries as Record<string, Record<string, unknown>> | undefined;
      const LEGACY_FEISHU_ID = 'feishu-openclaw-plugin';
      const NEW_FEISHU_ID = 'openclaw-lark';
      const LEGACY_WECOM_ID = 'wecom-openclaw-plugin';
      const NEW_WECOM_ID = 'wecom';
      const LEGACY_QQBOT_ID = 'qqbot';
      const NEW_QQBOT_ID = 'openclaw-qqbot';

      const allowList = Array.isArray(pluginsObj.allow)
        ? (pluginsObj.allow as unknown[]).filter((item): item is string => typeof item === 'string')
        : [];
      const legacyAllowIndex = allowList.indexOf(LEGACY_FEISHU_ID);
      if (legacyAllowIndex !== -1) {
        if (!allowList.includes(NEW_FEISHU_ID)) {
          allowList[legacyAllowIndex] = NEW_FEISHU_ID;
        } else {
          allowList.splice(legacyAllowIndex, 1);
        }
        pluginsObj.allow = allowList;
        modified = true;
        logger.info(`[sanitize] Migrated plugins.allow: ${LEGACY_FEISHU_ID} -> ${NEW_FEISHU_ID}`);
      }
      const legacyWeComAllowIndex = allowList.indexOf(LEGACY_WECOM_ID);
      if (legacyWeComAllowIndex !== -1) {
        if (!allowList.includes(NEW_WECOM_ID)) {
          allowList[legacyWeComAllowIndex] = NEW_WECOM_ID;
        } else {
          allowList.splice(legacyWeComAllowIndex, 1);
        }
        pluginsObj.allow = allowList;
        modified = true;
        logger.info(`[sanitize] Migrated plugins.allow: ${LEGACY_WECOM_ID} -> ${NEW_WECOM_ID}`);
      }
      const legacyQqbotAllowIndex = allowList.indexOf(LEGACY_QQBOT_ID);
      if (legacyQqbotAllowIndex !== -1) {
        if (!allowList.includes(NEW_QQBOT_ID)) {
          allowList[legacyQqbotAllowIndex] = NEW_QQBOT_ID;
        } else {
          allowList.splice(legacyQqbotAllowIndex, 1);
        }
        pluginsObj.allow = allowList;
        modified = true;
        logger.info(`[sanitize] Migrated plugins.allow: ${LEGACY_QQBOT_ID} -> ${NEW_QQBOT_ID}`);
      }

      if (entries && typeof entries === 'object') {
        if (entries[LEGACY_FEISHU_ID]) {
          if (!entries[NEW_FEISHU_ID]) {
            entries[NEW_FEISHU_ID] = entries[LEGACY_FEISHU_ID];
          }
          delete entries[LEGACY_FEISHU_ID];
          modified = true;
          logger.info(`[sanitize] Migrated plugins.entries: ${LEGACY_FEISHU_ID} -> ${NEW_FEISHU_ID}`);
        }
        if (entries[LEGACY_WECOM_ID]) {
          if (!entries[NEW_WECOM_ID]) {
            entries[NEW_WECOM_ID] = entries[LEGACY_WECOM_ID];
          }
          delete entries[LEGACY_WECOM_ID];
          modified = true;
          logger.info(`[sanitize] Migrated plugins.entries: ${LEGACY_WECOM_ID} -> ${NEW_WECOM_ID}`);
        }
        if (entries[LEGACY_QQBOT_ID]) {
          if (!entries[NEW_QQBOT_ID]) {
            entries[NEW_QQBOT_ID] = entries[LEGACY_QQBOT_ID];
          }
          delete entries[LEGACY_QQBOT_ID];
          modified = true;
          logger.info(`[sanitize] Migrated plugins.entries: ${LEGACY_QQBOT_ID} -> ${NEW_QQBOT_ID}`);
        }

        const hasNewFeishu = allowList.includes(NEW_FEISHU_ID) || Boolean(entries[NEW_FEISHU_ID]);
        if (hasNewFeishu) {
          const bareFeishuIndex = allowList.indexOf('feishu');
          if (bareFeishuIndex !== -1) {
            allowList.splice(bareFeishuIndex, 1);
            pluginsObj.allow = allowList;
            modified = true;
            logger.info('[sanitize] Removed bare "feishu" from plugins.allow because openclaw-lark is configured');
          }
        }
        if (hasNewFeishu && entries.feishu && entries.feishu.enabled !== false) {
          entries.feishu = {
            ...entries.feishu,
            enabled: false,
          };
          modified = true;
          logger.info('[sanitize] Disabled plugins.entries.feishu because openclaw-lark is configured');
        }

        if (entries.whatsapp) {
          delete entries.whatsapp;
          modified = true;
          logger.info('[sanitize] Removed legacy plugins.entries.whatsapp for built-in channel');
        }
      }

      const configuredBuiltIns = new Set<string>();
      const channelsObj = (
        config.channels && typeof config.channels === 'object' && !Array.isArray(config.channels)
          ? config.channels as Record<string, Record<string, unknown>>
          : {}
      );
      for (const [channelId, section] of Object.entries(channelsObj)) {
        if (!BUILTIN_CHANNEL_IDS.has(channelId)) {
          continue;
        }
        if (!section || section.enabled === false) {
          continue;
        }
        if (Object.keys(section).length > 0) {
          configuredBuiltIns.add(channelId);
        }
      }

      const bundledPlugins = discoverBundledPlugins();
      const externalPluginIds = allowList.filter(
        (pluginId) => !BUILTIN_CHANNEL_IDS.has(pluginId) && !bundledPlugins.all.has(pluginId),
      );
      const nextAllow = [...externalPluginIds];
      if (externalPluginIds.length > 0) {
        for (const channelId of configuredBuiltIns) {
          if (!nextAllow.includes(channelId)) {
            nextAllow.push(channelId);
          }
        }
        for (const pluginId of bundledPlugins.enabledByDefault) {
          if (!nextAllow.includes(pluginId)) {
            nextAllow.push(pluginId);
          }
        }
      }

      if (JSON.stringify(nextAllow) !== JSON.stringify(allowList)) {
        if (nextAllow.length > 0) {
          pluginsObj.allow = nextAllow;
        } else {
          delete pluginsObj.allow;
        }
        modified = true;
      }

      if (Array.isArray(pluginsObj.allow) && pluginsObj.allow.length === 0) {
        delete pluginsObj.allow;
        modified = true;
      }
      if (
        pluginsObj.entries
        && typeof pluginsObj.entries === 'object'
        && !Array.isArray(pluginsObj.entries)
        && Object.keys(pluginsObj.entries as Record<string, unknown>).length === 0
      ) {
        delete pluginsObj.entries;
        modified = true;
      }
      const pluginKeysExcludingEnabled = Object.keys(pluginsObj).filter((key) => key !== 'enabled');
      if (pluginsObj.enabled === true && pluginKeysExcludingEnabled.length === 0) {
        delete pluginsObj.enabled;
        modified = true;
      }
      if (Object.keys(pluginsObj).length === 0) {
        delete config.plugins;
        modified = true;
      }
    }

    if (modified) {
      await writeOpenClawJson(config);
      logger.info('[sanitize] openclaw.json sanitized successfully');
    }
  });
}

export { getProviderEnvVar } from '../providers/provider-registry';
