export const GOOGLE_BROWSER_OAUTH_TOKEN_KEY = 'google-gemini-cli';
export const OPENAI_BROWSER_OAUTH_TOKEN_KEY = 'openai-codex';
export const OPENCLAW_PROVIDER_KEY_MINIMAX = 'minimax-portal';
export const OPENCLAW_PROVIDER_KEY_QWEN = 'qwen-portal';
export const OPENCLAW_PROVIDER_KEY_MOONSHOT = 'moonshot';
export const OPENCLAW_PROVIDER_KEY_MOONSHOT_GLOBAL = 'moonshot-global';
export const OAUTH_PROVIDER_TYPES = ['qwen-portal', 'minimax-portal', 'minimax-portal-cn'] as const;
export const OPENCLAW_OAUTH_PLUGIN_PROVIDER_KEYS = [
  OPENCLAW_PROVIDER_KEY_MINIMAX,
  OPENCLAW_PROVIDER_KEY_QWEN,
] as const;

const MULTI_INSTANCE_PROVIDER_TYPES = new Set(['custom', 'ollama']);
const OAUTH_PROVIDER_TYPE_SET = new Set<string>(OAUTH_PROVIDER_TYPES);
const OPENCLAW_OAUTH_PLUGIN_PROVIDER_KEY_SET = new Set<string>(OPENCLAW_OAUTH_PLUGIN_PROVIDER_KEYS);

function normalizeProviderKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function getMultiInstanceProviderKeySuffix(providerType: string, providerId: string): string {
  const runtimeKeyPrefix = `${providerType}-`;
  const rawSuffix = providerId.startsWith(runtimeKeyPrefix)
    ? providerId.slice(runtimeKeyPrefix.length)
    : providerId;
  const suffix = normalizeProviderKeyPart(rawSuffix);
  const uuidHead = suffix.match(/^([A-Fa-f0-9]{8})-/)?.[1];
  return uuidHead || suffix;
}

export function getBrowserOAuthTokenKey(
  providerType: string,
  authMode?: string,
): string | undefined {
  if (authMode !== 'oauth_browser') {
    return undefined;
  }
  if (providerType === 'google') {
    return GOOGLE_BROWSER_OAUTH_TOKEN_KEY;
  }
  if (providerType === 'openai') {
    return OPENAI_BROWSER_OAUTH_TOKEN_KEY;
  }
  return undefined;
}

export function getOpenClawProviderKey(providerType: string, providerId: string): string {
  if (MULTI_INSTANCE_PROVIDER_TYPES.has(providerType)) {
    if (providerId === providerType) {
      return providerType;
    }
    const runtimeKeyPrefix = `${providerType}-`;
    const suffix = getMultiInstanceProviderKeySuffix(providerType, providerId);
    return `${providerType}-${suffix}`;
  }
  if (providerType === 'minimax-portal-cn') {
    return OPENCLAW_PROVIDER_KEY_MINIMAX;
  }
  return providerType;
}

export function getOpenClawProviderKeyForType(type: string, providerId: string): string {
  return getOpenClawProviderKey(type, providerId);
}

export function getLegacyOpenClawProviderKeys(providerType: string, providerId: string): string[] {
  if (!MULTI_INSTANCE_PROVIDER_TYPES.has(providerType)) {
    return [];
  }
  const normalizedId = normalizeProviderKeyPart(providerId);
  const runtimeKey = getOpenClawProviderKey(providerType, providerId);
  return normalizedId && normalizedId !== runtimeKey ? [normalizedId] : [];
}

export function isPortalOAuthProviderType(providerType: string): boolean {
  return providerType === OPENCLAW_PROVIDER_KEY_QWEN
    || providerType === OPENCLAW_PROVIDER_KEY_MINIMAX
    || providerType === 'minimax-portal-cn';
}

export function isOAuthProviderType(providerType: string): boolean {
  return OAUTH_PROVIDER_TYPE_SET.has(providerType);
}

export function isMiniMaxProviderType(providerType: string): boolean {
  return providerType === OPENCLAW_PROVIDER_KEY_MINIMAX || providerType === 'minimax-portal-cn';
}

export function getOAuthProviderTokenKey(providerType: string): string {
  if (providerType === 'minimax-portal-cn') {
    return OPENCLAW_PROVIDER_KEY_MINIMAX;
  }
  return providerType;
}

export function getOAuthProviderDefaultBaseUrl(providerType: string): string | undefined {
  if (providerType === OPENCLAW_PROVIDER_KEY_MINIMAX) {
    return 'https://api.minimax.io/anthropic';
  }
  if (providerType === 'minimax-portal-cn') {
    return 'https://api.minimaxi.com/anthropic';
  }
  if (providerType === OPENCLAW_PROVIDER_KEY_QWEN) {
    return 'https://portal.qwen.ai/v1';
  }
  return undefined;
}

export function getOAuthProviderApi(
  providerType: string,
): 'anthropic-messages' | 'openai-completions' | undefined {
  if (providerType === OPENCLAW_PROVIDER_KEY_MINIMAX || providerType === 'minimax-portal-cn') {
    return 'anthropic-messages';
  }
  if (providerType === OPENCLAW_PROVIDER_KEY_QWEN) {
    return 'openai-completions';
  }
  return undefined;
}

export function normalizeOAuthBaseUrl(providerType: string, baseUrl?: string): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  if (providerType === OPENCLAW_PROVIDER_KEY_MINIMAX || providerType === 'minimax-portal-cn') {
    return baseUrl.replace(/\/v1$/, '').replace(/\/anthropic$/, '').replace(/\/$/, '') + '/anthropic';
  }
  return baseUrl;
}

export function getOAuthProviderTargetKey(providerType: string): string | undefined {
  if (providerType === OPENCLAW_PROVIDER_KEY_MINIMAX || providerType === 'minimax-portal-cn') {
    return OPENCLAW_PROVIDER_KEY_MINIMAX;
  }
  if (providerType === OPENCLAW_PROVIDER_KEY_QWEN) {
    return OPENCLAW_PROVIDER_KEY_QWEN;
  }
  return undefined;
}

export function usesOAuthAuthHeader(providerKey: string): boolean {
  return providerKey === OPENCLAW_PROVIDER_KEY_MINIMAX;
}

export function getOAuthApiKeyEnv(providerKey: string): string | undefined {
  if (providerKey === OPENCLAW_PROVIDER_KEY_MINIMAX) {
    return 'minimax-oauth';
  }
  if (providerKey === OPENCLAW_PROVIDER_KEY_QWEN) {
    return 'qwen-oauth';
  }
  return undefined;
}

export function isOpenClawOAuthPluginProviderKey(provider: string): boolean {
  return OPENCLAW_OAUTH_PLUGIN_PROVIDER_KEY_SET.has(provider);
}
