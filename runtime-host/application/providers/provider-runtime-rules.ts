export const GOOGLE_BROWSER_OAUTH_RUNTIME_PROVIDER = 'google-gemini-cli';
export const GOOGLE_BROWSER_OAUTH_DEFAULT_MODEL_REF = `${GOOGLE_BROWSER_OAUTH_RUNTIME_PROVIDER}/gemini-3-pro-preview`;
export const OPENAI_BROWSER_OAUTH_RUNTIME_PROVIDER = 'openai-codex';
export const OPENAI_BROWSER_OAUTH_DEFAULT_MODEL_REF = `${OPENAI_BROWSER_OAUTH_RUNTIME_PROVIDER}/gpt-5.4`;
export const OPENCLAW_PROVIDER_KEY_MINIMAX = 'minimax-portal';
export const OPENCLAW_PROVIDER_KEY_QWEN = 'qwen-portal';
export const OPENCLAW_PROVIDER_KEY_MOONSHOT = 'moonshot';
export const OAUTH_PROVIDER_TYPES = ['qwen-portal', 'minimax-portal', 'minimax-portal-cn'] as const;
export const OPENCLAW_OAUTH_PLUGIN_PROVIDER_KEYS = [
  OPENCLAW_PROVIDER_KEY_MINIMAX,
  OPENCLAW_PROVIDER_KEY_QWEN,
] as const;

const MULTI_INSTANCE_PROVIDER_TYPES = new Set(['custom', 'ollama']);
const OAUTH_PROVIDER_TYPE_SET = new Set<string>(OAUTH_PROVIDER_TYPES);
const OPENCLAW_OAUTH_PLUGIN_PROVIDER_KEY_SET = new Set<string>(OPENCLAW_OAUTH_PLUGIN_PROVIDER_KEYS);

export function getBrowserOAuthRuntimeProviderKey(
  providerType: string,
  authMode?: string,
): string | undefined {
  if (authMode !== 'oauth_browser') {
    return undefined;
  }
  if (providerType === 'google') {
    return GOOGLE_BROWSER_OAUTH_RUNTIME_PROVIDER;
  }
  if (providerType === 'openai') {
    return OPENAI_BROWSER_OAUTH_RUNTIME_PROVIDER;
  }
  return undefined;
}

export function getOpenClawProviderKey(providerType: string, providerId: string): string {
  if (MULTI_INSTANCE_PROVIDER_TYPES.has(providerType)) {
    const runtimeKeyPrefix = `${providerType}-`;
    if (providerId.startsWith(runtimeKeyPrefix)) {
      const suffix = providerId.slice(runtimeKeyPrefix.length);
      if (/^[A-Za-z0-9]{8}$/.test(suffix)) {
        return providerId;
      }
    }
    const suffix = providerId.replace(/-/g, '').slice(0, 8);
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

export function getBrowserOAuthDefaultModelRef(runtimeProviderKey: string): string | undefined {
  if (runtimeProviderKey === GOOGLE_BROWSER_OAUTH_RUNTIME_PROVIDER) {
    return GOOGLE_BROWSER_OAUTH_DEFAULT_MODEL_REF;
  }
  if (runtimeProviderKey === OPENAI_BROWSER_OAUTH_RUNTIME_PROVIDER) {
    return OPENAI_BROWSER_OAUTH_DEFAULT_MODEL_REF;
  }
  return undefined;
}

export function buildProviderModelRef(
  providerKey: string,
  explicitModel?: string,
  defaultModel?: string,
): string | undefined {
  const rawModel = explicitModel || defaultModel;
  if (!rawModel) {
    return undefined;
  }
  return rawModel.startsWith(`${providerKey}/`)
    ? rawModel
    : `${providerKey}/${rawModel}`;
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
