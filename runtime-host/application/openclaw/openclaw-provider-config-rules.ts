import {
  OPENCLAW_PROVIDER_KEY_MOONSHOT,
  OPENCLAW_PROVIDER_KEY_MOONSHOT_GLOBAL,
} from '../providers/provider-runtime-rules';
import {
  extractFallbackModelIds,
  extractModelId,
  normalizeModelRef,
} from './openclaw-provider-entry-builder';

export interface ProviderDefaultModelPlan {
  model: string;
  modelId: string;
  fallbackModels: string[];
  fallbackModelIds: string[];
}

export function resolveProviderDefaultModelPlan(
  provider: string,
  modelOverride: string | undefined,
  fallbackModels: string[],
): ProviderDefaultModelPlan | null {
  const model = normalizeModelRef(provider, modelOverride);
  if (!model) {
    return null;
  }
  return {
    model,
    modelId: extractModelId(provider, model),
    fallbackModels,
    fallbackModelIds: extractFallbackModelIds(provider, fallbackModels),
  };
}

export function applyDefaultModelToAgentsConfig(
  config: Record<string, unknown>,
  plan: ProviderDefaultModelPlan,
): void {
  const agents = (config.agents || {}) as Record<string, unknown>;
  const defaults = (agents.defaults || {}) as Record<string, unknown>;
  defaults.model = {
    primary: plan.model,
    fallbacks: plan.fallbackModels,
  };
  agents.defaults = defaults;
  config.agents = agents;
}

export function ensureGatewayLocalMode(config: Record<string, unknown>): void {
  const gateway = (config.gateway || {}) as Record<string, unknown>;
  if (!gateway.mode) {
    gateway.mode = 'local';
  }
  config.gateway = gateway;
}

function upsertMoonshotWebSearchBaseUrl(
  config: Record<string, unknown>,
  baseUrl: string,
): void {
  const tools = (config.tools || {}) as Record<string, unknown>;
  const web = (tools.web || {}) as Record<string, unknown>;
  const search = (web.search || {}) as Record<string, unknown>;
  const kimi = (search.kimi && typeof search.kimi === 'object' && !Array.isArray(search.kimi))
    ? (search.kimi as Record<string, unknown>)
    : {};

  delete kimi.apiKey;
  kimi.baseUrl = baseUrl;
  search.kimi = kimi;
  web.search = search;
  tools.web = web;
  config.tools = tools;
}

export function ensureMoonshotKimiWebSearchBaseUrl(config: Record<string, unknown>, provider: string): void {
  if (provider === OPENCLAW_PROVIDER_KEY_MOONSHOT) {
    upsertMoonshotWebSearchBaseUrl(config, 'https://api.moonshot.cn/v1');
    return;
  }
  if (provider === OPENCLAW_PROVIDER_KEY_MOONSHOT_GLOBAL) {
    upsertMoonshotWebSearchBaseUrl(config, 'https://api.moonshot.ai/v1');
  }
}

export function removeProviderEntryFromModelsConfig(
  config: Record<string, unknown>,
  provider: string,
): boolean {
  const models = config.models as Record<string, unknown> | undefined;
  const providers = (models?.providers ?? {}) as Record<string, unknown>;
  if (!providers[provider]) {
    return false;
  }
  delete providers[provider];
  return true;
}

export function removeProviderAuthProfilesFromConfig(
  config: Record<string, unknown>,
  providerKeys: ReadonlySet<string>,
): string[] {
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
  if (!authProfiles) {
    return [];
  }

  const removedProfileIds: string[] = [];
  for (const [profileId, profile] of Object.entries(authProfiles)) {
    if (!providerKeys.has(profile?.provider as string)) {
      continue;
    }
    delete authProfiles[profileId];
    removedProfileIds.push(profileId);
  }
  return removedProfileIds;
}
