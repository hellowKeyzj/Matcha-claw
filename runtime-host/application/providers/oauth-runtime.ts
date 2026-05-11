import type { OpenClawAuthProfileService } from '../openclaw/openclaw-auth-profile-store';
import {
  buildBrowserOAuthAccount,
  buildDeviceOAuthAccount,
  type ProviderAccountLike,
} from './provider-oauth-account-service';
import { getProviderDefaultModel } from './provider-registry';
import {
  normalizeOAuthBaseUrl,
} from './provider-runtime-rules';
import type { ProviderAccountsRuntimePort } from './provider-accounts-runtime-port';
import type { ProviderStoreRepository } from './provider-store-repository';
import type { RuntimeClockPort } from '../common/runtime-ports';

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

export interface ProviderOAuthCompletionPort {
  completeBrowser(input: BrowserOAuthInput): Promise<unknown>;
  completeDevice(input: DeviceOAuthInput): Promise<unknown>;
}

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, any>;
}

function asProviderAccount(value: unknown): ProviderAccountLike | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return typeof record.id === 'string'
    && typeof record.vendorId === 'string'
    && typeof record.label === 'string'
    && typeof record.authMode === 'string'
    && typeof record.enabled === 'boolean'
    && typeof record.isDefault === 'boolean'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
    ? record as ProviderAccountLike
    : null;
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

export class ProviderOAuthCompletionService implements ProviderOAuthCompletionPort {
  constructor(
    private readonly deps: {
      storeRepository: Pick<ProviderStoreRepository, 'read' | 'write'>;
      runtime: Pick<ProviderAccountsRuntimePort, 'syncStoreToRuntime'>;
      authProfiles: Pick<OpenClawAuthProfileService, 'saveOAuthToken'>;
      clock: RuntimeClockPort;
    },
  ) {}

  async completeBrowser(input: BrowserOAuthInput) {
    const store = await this.deps.storeRepository.read();
    const existing = asProviderAccount(store.accounts[input.accountId]);
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
      clock: this.deps.clock,
    });
    store.accounts[nextAccount.id] = nextAccount;
    ensureDefaultAccountFlag(store, nextAccount.id);
    await this.deps.storeRepository.write(store);

    await this.deps.authProfiles.saveOAuthToken(input.runtimeProviderId, {
      access: input.token.access,
      refresh: input.token.refresh,
      expires: input.token.expires,
      email: oauthTokenEmail,
      projectId: oauthTokenSubject,
    });
    const syncResult = await this.deps.runtime.syncStoreToRuntime(store);
    if (syncResult.storeModified) {
      await this.deps.storeRepository.write(store);
    }

    return nextAccount;
  }

  async completeDevice(input: DeviceOAuthInput) {
    const tokenProviderId = input.providerType.startsWith('minimax-portal')
      ? 'minimax-portal'
      : input.providerType;

    await this.deps.authProfiles.saveOAuthToken(tokenProviderId, {
      access: input.token.access,
      refresh: input.token.refresh,
      expires: input.token.expires,
    });

    const store = await this.deps.storeRepository.read();
    const existing = asProviderAccount(store.accounts[input.accountId]);
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
      clock: this.deps.clock,
    });
    store.accounts[nextAccount.id] = nextAccount;
    ensureDefaultAccountFlag(store, nextAccount.id);
    await this.deps.storeRepository.write(store);
    const syncResult = await this.deps.runtime.syncStoreToRuntime(store);
    if (syncResult.storeModified) {
      await this.deps.storeRepository.write(store);
    }

    return nextAccount;
  }
}
