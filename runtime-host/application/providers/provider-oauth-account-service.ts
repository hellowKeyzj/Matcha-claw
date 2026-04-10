import {
  GOOGLE_BROWSER_OAUTH_DEFAULT_MODEL_REF,
  OPENAI_BROWSER_OAUTH_DEFAULT_MODEL_REF,
} from './provider-runtime-rules';

type ProviderAccountLike = {
  id: string;
  vendorId: string;
  label: string;
  authMode: string;
  baseUrl?: string;
  apiProtocol?: string;
  model?: string;
  fallbackModels?: string[];
  fallbackAccountIds?: string[];
  enabled: boolean;
  isDefault: boolean;
  metadata?: {
    email?: string;
    resourceUrl?: string;
    [key: string]: unknown;
  };
  createdAt: string;
  updatedAt: string;
};

type BrowserOAuthProviderType = 'google' | 'openai';
type DeviceOAuthProviderType = 'minimax-portal' | 'minimax-portal-cn' | 'qwen-portal';
const LEGACY_DEVICE_OAUTH_DEFAULT_MODELS: Record<DeviceOAuthProviderType, string[]> = {
  'minimax-portal': ['MiniMax-M2.5'],
  'minimax-portal-cn': ['MiniMax-M2.5'],
  'qwen-portal': [],
};

function extractModelId(modelRef: string | undefined): string | undefined {
  if (!modelRef) return undefined;
  return modelRef.includes('/') ? modelRef.split('/').pop() : modelRef;
}

function getBrowserOAuthDefaultModelId(providerType: BrowserOAuthProviderType): string {
  const ref = providerType === 'google'
    ? GOOGLE_BROWSER_OAUTH_DEFAULT_MODEL_REF
    : OPENAI_BROWSER_OAUTH_DEFAULT_MODEL_REF;
  return extractModelId(ref) || ref;
}

function normalizeModelString(model: string | undefined): string | undefined {
  const value = model?.trim();
  return value || undefined;
}

function resolveDeviceOAuthModel(
  providerType: DeviceOAuthProviderType,
  existingModel: string | undefined,
  defaultModel: string | undefined,
): string | undefined {
  const normalizedExisting = normalizeModelString(existingModel);
  const normalizedDefault = normalizeModelString(defaultModel);
  if (!normalizedExisting) {
    return normalizedDefault;
  }
  if (!normalizedDefault) {
    return normalizedExisting;
  }

  const legacyDefaults = LEGACY_DEVICE_OAUTH_DEFAULT_MODELS[providerType];
  if (normalizedExisting === normalizedDefault || legacyDefaults.includes(normalizedExisting)) {
    return normalizedDefault;
  }

  return normalizedExisting;
}

export function normalizeBrowserOAuthExistingModel(
  providerType: BrowserOAuthProviderType,
  existingModel?: string,
): string | undefined {
  const value = existingModel?.trim();
  if (!value) {
    return undefined;
  }
  if (providerType === 'google') {
    return extractModelId(value);
  }
  if (value.startsWith('openai/')) {
    return undefined;
  }
  return extractModelId(value);
}

export function buildBrowserOAuthAccount(input: {
  providerType: BrowserOAuthProviderType;
  accountId: string;
  accountLabel?: string | null;
  runtimeProviderId: string;
  oauthTokenEmail?: string;
  existingAccount?: ProviderAccountLike | null;
}): ProviderAccountLike {
  const defaultLabel = input.providerType === 'google' ? 'Google Gemini' : 'OpenAI Codex';
  return {
    id: input.accountId,
    vendorId: input.providerType,
    label: input.accountLabel || input.existingAccount?.label || defaultLabel,
    authMode: 'oauth_browser',
    baseUrl: input.existingAccount?.baseUrl,
    apiProtocol: input.existingAccount?.apiProtocol,
    model: normalizeBrowserOAuthExistingModel(input.providerType, input.existingAccount?.model)
      || getBrowserOAuthDefaultModelId(input.providerType),
    fallbackModels: input.existingAccount?.fallbackModels,
    fallbackAccountIds: input.existingAccount?.fallbackAccountIds,
    enabled: input.existingAccount?.enabled ?? true,
    isDefault: input.existingAccount?.isDefault ?? false,
    metadata: {
      ...input.existingAccount?.metadata,
      ...(input.oauthTokenEmail ? { email: input.oauthTokenEmail } : {}),
      resourceUrl: input.runtimeProviderId,
    },
    createdAt: input.existingAccount?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function buildDeviceOAuthAccount(input: {
  providerType: DeviceOAuthProviderType;
  accountId: string;
  accountLabel?: string | null;
  baseUrl: string;
  defaultModel: string | undefined;
  existingAccount?: ProviderAccountLike | null;
}): ProviderAccountLike {
  const nameMap: Record<DeviceOAuthProviderType, string> = {
    'minimax-portal': 'MiniMax (Global)',
    'minimax-portal-cn': 'MiniMax (CN)',
    'qwen-portal': 'Qwen',
  };

  return {
    id: input.accountId,
    vendorId: input.providerType,
    label: input.accountLabel || input.existingAccount?.label || nameMap[input.providerType],
    authMode: 'oauth_device',
    baseUrl: input.baseUrl,
    apiProtocol: input.existingAccount?.apiProtocol,
    model: resolveDeviceOAuthModel(input.providerType, input.existingAccount?.model, input.defaultModel),
    fallbackModels: input.existingAccount?.fallbackModels,
    fallbackAccountIds: input.existingAccount?.fallbackAccountIds,
    enabled: input.existingAccount?.enabled ?? true,
    isDefault: input.existingAccount?.isDefault ?? false,
    metadata: {
      ...input.existingAccount?.metadata,
      resourceUrl: input.baseUrl,
    },
    createdAt: input.existingAccount?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
