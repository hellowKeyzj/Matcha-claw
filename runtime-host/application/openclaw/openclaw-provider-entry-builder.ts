export interface RuntimeProviderConfigOverride {
  baseUrl?: string;
  api?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  replaceProviderKeys?: readonly string[];
}

export type ProviderEntryBuildOptions = {
  baseUrl: string;
  api: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  replaceProviderKeys?: readonly string[];
};

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
  for (const oldProviderKey of options.replaceProviderKeys ?? []) {
    if (oldProviderKey && oldProviderKey !== provider) {
      delete providers[oldProviderKey];
    }
  }
  const existingProvider = (
    providers[provider] && typeof providers[provider] === 'object'
      ? (providers[provider] as Record<string, unknown>)
      : {}
  );

  const nextProvider: Record<string, unknown> = {
    ...existingProvider,
    baseUrl: options.baseUrl,
    api: options.api,
    models: Array.isArray(existingProvider.models) ? existingProvider.models : [],
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
