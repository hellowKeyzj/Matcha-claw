import {
  getOAuthApiKeyEnv,
  getOAuthProviderTargetKey,
  normalizeOAuthBaseUrl,
} from './provider-runtime-rules';
import {
  buildBrowserOAuthAccount,
  buildDeviceOAuthAccount,
} from './provider-oauth-account-service';

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
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type ProviderSecretLike =
  | {
      type: 'oauth';
      accountId: string;
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      email?: string;
      subject?: string;
    };

type BrowserOAuthProviderType = 'google' | 'openai';
type DeviceOAuthProviderType = 'minimax-portal' | 'minimax-portal-cn' | 'qwen-portal';

type OAuthRuntimeToken = {
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  projectId?: string;
};

export interface ProviderOAuthAccountPort {
  readonly getAccount: (accountId: string) => Promise<ProviderAccountLike | null>;
  readonly createAccount: (account: ProviderAccountLike) => Promise<ProviderAccountLike>;
}

export interface ProviderOAuthSecretPort {
  readonly saveOAuthSecret: (secret: ProviderSecretLike) => Promise<void>;
}

export interface ProviderOAuthRuntimeWritePort {
  readonly saveOAuthTokenToRuntime: (providerId: string, token: OAuthRuntimeToken) => Promise<void>;
  readonly setDefaultModelWithOverride: (
    providerId: string,
    modelOverride: string | undefined,
    override: {
      baseUrl?: string;
      api?: string;
      apiKeyEnv?: string;
      authHeader?: boolean;
    },
  ) => Promise<void>;
}

export interface ProviderOAuthRegistryPort {
  readonly getProviderDefaultModel: (providerType: string) => string | undefined;
}

export interface ProviderOAuthCompletionServiceDeps {
  readonly accountPort: ProviderOAuthAccountPort;
  readonly secretPort: ProviderOAuthSecretPort;
  readonly runtimeWritePort: ProviderOAuthRuntimeWritePort;
  readonly registryPort: ProviderOAuthRegistryPort;
}

export function createRuntimeHostProviderOAuthCompletionService(
  deps: ProviderOAuthCompletionServiceDeps,
) {
  async function completeBrowserOAuth(input: {
    providerType: BrowserOAuthProviderType;
    accountId: string;
    accountLabel?: string | null;
    runtimeProviderId: string;
    token: {
      access: string;
      refresh: string;
      expires: number;
      email?: string;
      projectId?: string;
      accountId?: string;
    };
  }): Promise<ProviderAccountLike> {
    const existing = await deps.accountPort.getAccount(input.accountId);
    const oauthTokenEmail = typeof input.token.email === 'string' ? input.token.email : undefined;
    const oauthTokenSubject = typeof input.token.projectId === 'string'
      ? input.token.projectId
      : (typeof input.token.accountId === 'string' ? input.token.accountId : undefined);

    const nextAccount = await deps.accountPort.createAccount(buildBrowserOAuthAccount({
      providerType: input.providerType,
      accountId: input.accountId,
      accountLabel: input.accountLabel,
      runtimeProviderId: input.runtimeProviderId,
      oauthTokenEmail,
      existingAccount: existing,
    }));

    await deps.secretPort.saveOAuthSecret({
      type: 'oauth',
      accountId: input.accountId,
      accessToken: input.token.access,
      refreshToken: input.token.refresh,
      expiresAt: input.token.expires,
      email: oauthTokenEmail,
      subject: oauthTokenSubject,
    });

    await deps.runtimeWritePort.saveOAuthTokenToRuntime(input.runtimeProviderId, {
      access: input.token.access,
      refresh: input.token.refresh,
      expires: input.token.expires,
      email: oauthTokenEmail,
      projectId: oauthTokenSubject,
    });

    return nextAccount;
  }

  async function completeDeviceOAuth(input: {
    providerType: DeviceOAuthProviderType;
    accountId: string;
    accountLabel?: string | null;
    token: {
      access: string;
      refresh: string;
      expires: number;
      resourceUrl?: string;
      api: 'anthropic-messages' | 'openai-completions';
    };
  }): Promise<void> {
    const tokenProviderId = input.providerType.startsWith('minimax-portal')
      ? 'minimax-portal'
      : input.providerType;

    await deps.runtimeWritePort.saveOAuthTokenToRuntime(tokenProviderId, {
      access: input.token.access,
      refresh: input.token.refresh,
      expires: input.token.expires,
    });

    const targetProviderKey = getOAuthProviderTargetKey(input.providerType);
    if (!targetProviderKey) {
      return;
    }

    const normalizedBaseUrl = normalizeOAuthBaseUrl(
      input.providerType,
      input.token.resourceUrl || (input.providerType === 'minimax-portal'
        ? 'https://api.minimax.io/anthropic'
        : input.providerType === 'minimax-portal-cn'
          ? 'https://api.minimaxi.com/anthropic'
          : 'https://portal.qwen.ai/v1'),
    );
    const baseUrl = normalizedBaseUrl
      && !normalizedBaseUrl.startsWith('http://')
      && !normalizedBaseUrl.startsWith('https://')
      ? `https://${normalizedBaseUrl}`
      : normalizedBaseUrl;

    await deps.runtimeWritePort.setDefaultModelWithOverride(targetProviderKey, undefined, {
      baseUrl,
      api: input.token.api,
      authHeader: input.providerType.startsWith('minimax-portal') ? true : undefined,
      apiKeyEnv: getOAuthApiKeyEnv(targetProviderKey),
    });

    const existing = await deps.accountPort.getAccount(input.accountId);
    await deps.accountPort.createAccount(buildDeviceOAuthAccount({
      providerType: input.providerType,
      accountId: input.accountId,
      accountLabel: input.accountLabel,
      baseUrl: baseUrl || '',
      defaultModel: deps.registryPort.getProviderDefaultModel(input.providerType),
      existingAccount: existing,
    }));
  }

  return {
    completeBrowserOAuth,
    completeDeviceOAuth,
  };
}
