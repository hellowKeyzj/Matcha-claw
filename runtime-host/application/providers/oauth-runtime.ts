import { saveOAuthTokenToOpenClaw } from '../openclaw/openclaw-auth-profile-store';
import { buildBrowserOAuthAccount, buildDeviceOAuthAccount } from './provider-oauth-account-service';
import { getProviderDefaultModel } from './provider-registry';
import {
  normalizeOAuthBaseUrl,
} from './provider-runtime-rules';
import { syncProviderStoreToOpenClaw } from './store-sync';
import { readProviderStoreLocal, writeProviderStoreLocal } from '../../api/storage/provider-store';

type BrowserOAuthInput = {
  providerType: 'google' | 'openai';
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
};

type DeviceOAuthInput = {
  providerType: 'minimax-portal' | 'minimax-portal-cn' | 'qwen-portal';
  accountId: string;
  accountLabel?: string | null;
  token: {
    access: string;
    refresh: string;
    expires: number;
    resourceUrl?: string;
    api: 'anthropic-messages' | 'openai-completions';
  };
};

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, any>;
}

function ensureDefaultAccountFlag(store: { defaultAccountId: string | null; accounts: Record<string, any> }, accountId: string) {
  if (!store.defaultAccountId) {
    store.defaultAccountId = accountId;
  }
  for (const account of Object.values(store.accounts)) {
    if (!asRecord(account)) {
      continue;
    }
    account.isDefault = account.id === store.defaultAccountId;
  }
}

export async function completeBrowserOAuthLocal(input: BrowserOAuthInput) {
  const store = await readProviderStoreLocal();
  const existing = asRecord(store.accounts[input.accountId]);
  const oauthTokenEmail = typeof input.token.email === 'string' ? input.token.email : undefined;
  const oauthTokenSubject = typeof input.token.projectId === 'string'
    ? input.token.projectId
    : (typeof input.token.accountId === 'string' ? input.token.accountId : undefined);
  const nextAccount = buildBrowserOAuthAccount({
    providerType: input.providerType,
    accountId: input.accountId,
    accountLabel: input.accountLabel,
    runtimeProviderId: input.runtimeProviderId,
    oauthTokenEmail,
    existingAccount: existing ?? undefined,
  });
  store.accounts[nextAccount.id] = nextAccount;
  ensureDefaultAccountFlag(store, nextAccount.id);
  await writeProviderStoreLocal(store);

  await saveOAuthTokenToOpenClaw(input.runtimeProviderId, {
    access: input.token.access,
    refresh: input.token.refresh,
    expires: input.token.expires,
    email: oauthTokenEmail,
    projectId: oauthTokenSubject,
  });
  const syncResult = await syncProviderStoreToOpenClaw(store);
  if (syncResult.storeModified) {
    await writeProviderStoreLocal(store);
  }

  return nextAccount;
}

export async function completeDeviceOAuthLocal(input: DeviceOAuthInput) {
  const tokenProviderId = input.providerType.startsWith('minimax-portal')
    ? 'minimax-portal'
    : input.providerType;

  await saveOAuthTokenToOpenClaw(tokenProviderId, {
    access: input.token.access,
    refresh: input.token.refresh,
    expires: input.token.expires,
  });

  const store = await readProviderStoreLocal();
  const existing = asRecord(store.accounts[input.accountId]);
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
  const nextAccount = buildDeviceOAuthAccount({
    providerType: input.providerType,
    accountId: input.accountId,
    accountLabel: input.accountLabel,
    baseUrl: baseUrl || '',
    defaultModel: getProviderDefaultModel(input.providerType),
    existingAccount: existing ?? undefined,
  });
  store.accounts[nextAccount.id] = nextAccount;
  ensureDefaultAccountFlag(store, nextAccount.id);
  await writeProviderStoreLocal(store);
  const syncResult = await syncProviderStoreToOpenClaw(store);
  if (syncResult.storeModified) {
    await writeProviderStoreLocal(store);
  }

  return nextAccount;
}
