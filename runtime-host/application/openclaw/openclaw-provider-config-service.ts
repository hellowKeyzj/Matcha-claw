import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
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
  readAuthProfiles,
  readOpenClawJson,
  writeAuthProfiles,
  writeOpenClawJson,
} from './openclaw-auth-store';
import { createRuntimeLogger } from '../../shared/logger';

const logger = createRuntimeLogger('openclaw-provider-config-service');

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
  const agentIds = await discoverAgentIds();
  if (agentIds.length === 0) {
    agentIds.push('main');
  }

  for (const id of agentIds) {
    const store = await readAuthProfiles(id);
    const profileId = `${provider}:default`;
    if (store.profiles[profileId]) {
      delete store.profiles[profileId];
      if (store.order?.[provider]) {
        store.order[provider] = store.order[provider].filter((entryId) => entryId !== profileId);
        if (store.order[provider].length === 0) {
          delete store.order[provider];
        }
      }
      if (store.lastGood?.[provider] === profileId) {
        delete store.lastGood[provider];
      }
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

    if (pruneProviderModelRefsInAgentsConfig(config, provider)) {
      modified = true;
      logger.info(`Pruned stale agent model references for provider "${provider}"`);
    }

    if (modified) {
      await writeOpenClawJson(config);
    }
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
  if (options.headers && Object.keys(options.headers).length > 0) {
    nextProvider.headers = options.headers;
  } else {
    delete nextProvider.headers;
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
}

export async function syncProviderConfigToOpenClaw(
  provider: string,
  modelId: string | undefined,
  override: RuntimeProviderConfigOverride,
): Promise<void> {
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
}

export async function setOpenClawDefaultModelWithOverride(
  provider: string,
  modelOverride: string | undefined,
  override: RuntimeProviderConfigOverride,
  fallbackModels: string[] = [],
): Promise<void> {
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
}

export async function getActiveOpenClawProviders(): Promise<Set<string>> {
  const activeProviders = new Set<string>();

  try {
    const config = await readOpenClawJson();
    const providers = (config.models as Record<string, unknown> | undefined)?.providers;
    if (providers && typeof providers === 'object') {
      for (const key of Object.keys(providers as Record<string, unknown>)) {
        activeProviders.add(key);
      }
    }

    const plugins = (config.plugins as Record<string, unknown> | undefined)?.entries;
    if (plugins && typeof plugins === 'object') {
      for (const [pluginId, meta] of Object.entries(plugins as Record<string, unknown>)) {
        if (pluginId.endsWith('-auth') && (meta as Record<string, unknown>).enabled) {
          activeProviders.add(pluginId.replace(/-auth$/, ''));
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to read openclaw.json for active providers:', error);
  }

  return activeProviders;
}

export async function syncGatewayTokenToConfig(token: string): Promise<void> {
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
}

export async function syncBrowserConfigToOpenClaw(): Promise<void> {
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
}

export async function sanitizeOpenClawConfig(): Promise<void> {
  const config = await readOpenClawJson();
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

  const plugins = config.plugins;
  if (plugins && typeof plugins === 'object' && !Array.isArray(plugins)) {
    const pluginsObj = plugins as Record<string, unknown>;
    const entries = pluginsObj.entries as Record<string, Record<string, unknown>> | undefined;
    if (entries && typeof entries === 'object') {
      let cleaned = false;
      if (entries.feishu) {
        logger.info('[sanitize] Removing stale plugins.entries.feishu that blocks the official feishu plugin channel');
        delete entries.feishu;
        cleaned = true;
      }
      if (cleaned) {
        if (Object.keys(entries).length === 0) {
          delete pluginsObj.entries;
        }
        modified = true;
      }
    }
  }

  if (modified) {
    await writeOpenClawJson(config);
    logger.info('[sanitize] openclaw.json sanitized successfully');
  }
}

export { getProviderEnvVar } from '../providers/provider-registry';
