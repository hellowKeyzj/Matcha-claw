import {
  isAnthropicMessagesApi,
  normalizePositiveMaxTokens,
  resolveAnthropicMessagesDefaultMaxTokens,
  withAnthropicMessagesModelMaxTokens,
} from './openclaw-anthropic-messages-max-tokens';

export interface RuntimeConfigProviderOverride {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolvePinnedAgentRuntime(provider: string): Record<string, string> | undefined {
  return provider === 'openai' || provider === 'openai-codex' ? { id: 'pi' } : undefined;
}

function normalizeProviderModels(
  provider: string,
  options: ProviderEntryBuildOptions,
  existingProvider: Record<string, unknown>,
): unknown[] {
  const existingModels = Array.isArray(existingProvider.models) ? existingProvider.models : [];
  if (!isAnthropicMessagesApi(options.api)) {
    return existingModels;
  }
  return existingModels.map((model) => (
    model && typeof model === 'object' && !Array.isArray(model)
      ? withAnthropicMessagesModelMaxTokens(model as Record<string, unknown>, provider, {
        ...existingProvider,
        baseUrl: options.baseUrl,
        api: options.api,
      })
      : model
  ));
}

export function upsertOpenClawProviderEntry(
  config: Record<string, unknown>,
  provider: string,
  options: ProviderEntryBuildOptions,
): boolean {
  const models = (config.models || {}) as Record<string, unknown>;
  const providers = (models.providers || {}) as Record<string, unknown>;
  let changed = config.models !== models || models.providers !== providers;
  if (removeLegacyMoonshotProviderEntry(provider, providers)) {
    changed = true;
  }
  for (const oldProviderKey of options.replaceProviderKeys ?? []) {
    if (oldProviderKey && oldProviderKey !== provider && oldProviderKey in providers) {
      delete providers[oldProviderKey];
      changed = true;
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
    models: normalizeProviderModels(provider, options, existingProvider),
  };
  if (isAnthropicMessagesApi(options.api)) {
    nextProvider.maxTokens = normalizePositiveMaxTokens(nextProvider.maxTokens)
      ?? resolveAnthropicMessagesDefaultMaxTokens(provider, nextProvider);
  } else {
    delete nextProvider.maxTokens;
  }
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
  if (!isRecord(nextProvider.agentRuntime)) {
    const pinnedAgentRuntime = resolvePinnedAgentRuntime(provider);
    if (pinnedAgentRuntime) {
      nextProvider.agentRuntime = pinnedAgentRuntime;
    }
  }

  for (const [key, value] of Object.entries(nextProvider)) {
    if (existingProvider[key] !== value) {
      changed = true;
      break;
    }
  }
  for (const key of Object.keys(existingProvider)) {
    if (!(key in nextProvider)) {
      changed = true;
      break;
    }
  }
  providers[provider] = nextProvider;
  models.providers = providers;
  config.models = models;

  return changed;
}
