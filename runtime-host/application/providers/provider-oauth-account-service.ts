import type { RuntimeClockPort } from '../common/runtime-ports';

export type ProviderCredentialLike = {
  id: string;
  vendorId: string;
  label: string;
  authMode: string;
  baseUrl?: string;
  apiProtocol?: string;
  enabled: boolean;
  metadata?: {
    email?: string;
    resourceUrl?: string;
    [key: string]: unknown;
  };
  createdAt: string;
  updatedAt: string;
};

type BrowserOAuthProviderType = 'openai';
type DeviceOAuthProviderType = 'minimax-portal' | 'minimax-portal-cn' | 'qwen-portal';

export function buildBrowserOAuthAccount(input: {
  providerType: BrowserOAuthProviderType;
  accountId: string;
  accountLabel?: string | null;
  oauthProviderTokenKey: string;
  oauthTokenEmail?: string;
  existingAccount?: ProviderCredentialLike | null;
  clock: RuntimeClockPort;
}): ProviderCredentialLike {
  const defaultLabel = 'OpenAI Codex';
  const nowIso = input.clock.nowIso();
  return {
    id: input.accountId,
    vendorId: input.providerType,
    label: input.accountLabel || input.existingAccount?.label || defaultLabel,
    authMode: 'oauth_browser',
    baseUrl: input.existingAccount?.baseUrl,
    apiProtocol: input.existingAccount?.apiProtocol,
    enabled: input.existingAccount?.enabled ?? true,
    metadata: {
      ...input.existingAccount?.metadata,
      ...(input.oauthTokenEmail ? { email: input.oauthTokenEmail } : {}),
      resourceUrl: input.oauthProviderTokenKey,
    },
    createdAt: input.existingAccount?.createdAt || nowIso,
    updatedAt: nowIso,
  };
}

export function buildDeviceOAuthAccount(input: {
  providerType: DeviceOAuthProviderType;
  accountId: string;
  accountLabel?: string | null;
  baseUrl: string;
  existingAccount?: ProviderCredentialLike | null;
  clock: RuntimeClockPort;
}): ProviderCredentialLike {
  const nameMap: Record<DeviceOAuthProviderType, string> = {
    'minimax-portal': 'MiniMax (Global)',
    'minimax-portal-cn': 'MiniMax (CN)',
    'qwen-portal': 'Qwen',
  };

  const nowIso = input.clock.nowIso();
  return {
    id: input.accountId,
    vendorId: input.providerType,
    label: input.accountLabel || input.existingAccount?.label || nameMap[input.providerType],
    authMode: 'oauth_device',
    baseUrl: input.baseUrl,
    apiProtocol: input.existingAccount?.apiProtocol,
    enabled: input.existingAccount?.enabled ?? true,
    metadata: {
      ...input.existingAccount?.metadata,
      resourceUrl: input.baseUrl,
    },
    createdAt: input.existingAccount?.createdAt || nowIso,
    updatedAt: nowIso,
  };
}
