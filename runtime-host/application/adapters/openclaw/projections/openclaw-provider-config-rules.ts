import {
  OPENCLAW_PROVIDER_KEY_MOONSHOT,
  OPENCLAW_PROVIDER_KEY_MOONSHOT_GLOBAL,
} from './openclaw-provider-projection-rules';

export function ensureGatewayLocalMode(config: Record<string, unknown>): boolean {
  const gateway = (config.gateway || {}) as Record<string, unknown>;
  let changed = config.gateway !== gateway;
  if (!gateway.mode) {
    gateway.mode = 'local';
    changed = true;
  }
  config.gateway = gateway;
  return changed;
}

function upsertMoonshotWebSearchBaseUrl(
  config: Record<string, unknown>,
  baseUrl: string,
): boolean {
  const tools = (config.tools || {}) as Record<string, unknown>;
  const web = (tools.web || {}) as Record<string, unknown>;
  const search = (web.search || {}) as Record<string, unknown>;
  const kimi = (search.kimi && typeof search.kimi === 'object' && !Array.isArray(search.kimi))
    ? (search.kimi as Record<string, unknown>)
    : {};
  let changed = config.tools !== tools || tools.web !== web || web.search !== search || search.kimi !== kimi;

  if ('apiKey' in kimi) {
    delete kimi.apiKey;
    changed = true;
  }
  if (kimi.baseUrl !== baseUrl) {
    kimi.baseUrl = baseUrl;
    changed = true;
  }
  search.kimi = kimi;
  web.search = search;
  tools.web = web;
  config.tools = tools;
  return changed;
}

export function ensureMoonshotKimiWebSearchBaseUrl(config: Record<string, unknown>, provider: string): boolean {
  if (provider === OPENCLAW_PROVIDER_KEY_MOONSHOT) {
    return upsertMoonshotWebSearchBaseUrl(config, 'https://api.moonshot.cn/v1');
  }
  if (provider === OPENCLAW_PROVIDER_KEY_MOONSHOT_GLOBAL) {
    return upsertMoonshotWebSearchBaseUrl(config, 'https://api.moonshot.ai/v1');
  }
  return false;
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
