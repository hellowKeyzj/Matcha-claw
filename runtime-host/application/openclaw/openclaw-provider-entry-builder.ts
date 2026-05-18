import {
  getProviderConfig,
  getProviderDefaultModel,
} from '../providers/provider-registry';

export interface RuntimeProviderModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: RuntimeProviderModelCost;
}

export interface RuntimeProviderModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RuntimeProviderConfigOverride {
  baseUrl?: string;
  api?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: RuntimeProviderModel[];
}

export type ProviderEntryBuildOptions = {
  baseUrl: string;
  api: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: RuntimeProviderModel[];
  includeRegistryModels?: boolean;
  mergeExistingModels?: boolean;
};

export function normalizeModelRef(provider: string, modelOverride?: string): string | undefined {
  const rawModel = modelOverride || getProviderDefaultModel(provider);
  if (!rawModel) {
    return undefined;
  }
  return rawModel.startsWith(`${provider}/`) ? rawModel : `${provider}/${rawModel}`;
}

export function extractModelId(provider: string, modelRef: string): string {
  return modelRef.startsWith(`${provider}/`) ? modelRef.slice(provider.length + 1) : modelRef;
}

export function extractFallbackModelIds(provider: string, fallbackModels: string[]): string[] {
  return fallbackModels
    .filter((fallback) => fallback.startsWith(`${provider}/`))
    .map((fallback) => fallback.slice(provider.length + 1));
}

export function buildNamedProviderModels(modelIds: string[]): RuntimeProviderModel[] {
  return modelIds.map((id) => normalizeProviderModel({ id, name: id }));
}

function normalizeCostNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeProviderModelCost(value: unknown): RuntimeProviderModelCost {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    input: normalizeCostNumber(record.input),
    output: normalizeCostNumber(record.output),
    cacheRead: normalizeCostNumber(record.cacheRead),
    cacheWrite: normalizeCostNumber(record.cacheWrite),
  };
}

function normalizeProviderModel(model: RuntimeProviderModel): RuntimeProviderModel {
  return {
    ...model,
    cost: normalizeProviderModelCost(model.cost),
  };
}

function mergeProviderModels(
  ...groups: RuntimeProviderModel[][]
): RuntimeProviderModel[] {
  const merged: RuntimeProviderModel[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const item of group) {
      const id = typeof item?.id === 'string' ? item.id : '';
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      merged.push(normalizeProviderModel(item));
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

export function upsertOpenClawProviderEntry(
  config: Record<string, unknown>,
  provider: string,
  options: ProviderEntryBuildOptions,
): boolean {
  const models = (config.models || {}) as Record<string, unknown>;
  const providers = (models.providers || {}) as Record<string, unknown>;
  const removedLegacyMoonshot = removeLegacyMoonshotProviderEntry(provider, providers);
  const existingProvider = (
    providers[provider] && typeof providers[provider] === 'object'
      ? (providers[provider] as Record<string, unknown>)
      : {}
  );

  const existingModels = options.mergeExistingModels && Array.isArray(existingProvider.models)
    ? (existingProvider.models.filter((model): model is RuntimeProviderModel => (
        Boolean(model)
        && typeof model === 'object'
        && typeof (model as RuntimeProviderModel).id === 'string'
        && typeof (model as RuntimeProviderModel).name === 'string'
      )))
    : [];
  const registryModels = options.includeRegistryModels
    ? (getProviderConfig(provider)?.models ?? []).map((model) => ({ ...model }))
    : [];
  const runtimeModels = (options.models ?? []).map((model) => ({ ...model }));

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

  return removedLegacyMoonshot;
}
