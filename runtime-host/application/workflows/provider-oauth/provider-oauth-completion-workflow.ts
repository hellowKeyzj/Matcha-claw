import {
  buildBrowserOAuthAccount,
  buildDeviceOAuthAccount,
  type ProviderCredentialLike,
} from '../../providers/provider-oauth-account-service';
import type { ProviderAccountsProjectionPort } from '../../providers/provider-accounts-projection-port';
import type { ProviderProjectionPolicyPort } from '../../providers/provider-projection-sync-plan';
import type { ProviderStoreRepository } from '../../providers/provider-store-repository';
import type { RuntimeClockPort } from '../../common/runtime-ports';

export type BrowserOAuthInput = {
  providerType: 'google' | 'openai';
  accountId: string;
  accountLabel?: string | null;
  oauthProviderTokenKey: string;
  token: {
    access: string;
    refresh: string;
    expires: number;
    email?: string;
    projectId?: string;
    accountId?: string;
  };
};

export type DeviceOAuthInput = {
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

export interface ProviderOAuthTokenProjectionPort {
  saveOAuthToken(provider: string, token: {
    access: string;
    refresh: string;
    expires: number;
    email?: string;
    projectId?: string;
  }): Promise<void>;
}

export interface ProviderOAuthCompletionWorkflowDeps {
  storeRepository: Pick<ProviderStoreRepository, 'read' | 'write'>;
  projection: Pick<ProviderAccountsProjectionPort, 'syncStoreToProjection'>;
  authProfiles: ProviderOAuthTokenProjectionPort;
  projectionPolicy: ProviderProjectionPolicyPort;
  clock: RuntimeClockPort;
}

export class ProviderOAuthCompletionWorkflow {
  constructor(private readonly deps: ProviderOAuthCompletionWorkflowDeps) {}

  async completeBrowser(input: BrowserOAuthInput): Promise<ProviderCredentialLike> {
    const store = await this.deps.storeRepository.read();
    const existing = asProviderCredential(store.accounts[input.accountId]);
    const oauthTokenEmail = typeof input.token.email === 'string' ? input.token.email : undefined;
    const oauthTokenSubject = typeof input.token.projectId === 'string'
      ? input.token.projectId
      : (typeof input.token.accountId === 'string' ? input.token.accountId : undefined);
    const nextAccount = buildBrowserOAuthAccount({
      providerType: input.providerType,
      accountId: input.accountId,
      accountLabel: input.accountLabel,
      oauthProviderTokenKey: input.oauthProviderTokenKey,
      oauthTokenEmail,
      existingAccount: existing ?? undefined,
      clock: this.deps.clock,
    });
    store.accounts[nextAccount.id] = nextAccount;
    await this.deps.storeRepository.write(store);

    await this.deps.authProfiles.saveOAuthToken(input.oauthProviderTokenKey, {
      access: input.token.access,
      refresh: input.token.refresh,
      expires: input.token.expires,
      email: oauthTokenEmail,
      projectId: oauthTokenSubject,
    });
    const syncResult = await this.deps.projection.syncStoreToProjection(store);
    if (syncResult.storeModified) {
      await this.deps.storeRepository.write(store);
    }

    return nextAccount;
  }

  async completeDevice(input: DeviceOAuthInput): Promise<ProviderCredentialLike> {
    const tokenProviderId = this.deps.projectionPolicy.getOAuthProviderTokenKey(input.providerType);

    await this.deps.authProfiles.saveOAuthToken(tokenProviderId, {
      access: input.token.access,
      refresh: input.token.refresh,
      expires: input.token.expires,
    });

    const store = await this.deps.storeRepository.read();
    const existing = asProviderCredential(store.accounts[input.accountId]);
    const normalizedBaseUrl = this.deps.projectionPolicy.normalizeOAuthBaseUrl(
      input.providerType,
      input.token.resourceUrl || this.deps.projectionPolicy.getOAuthProviderDefaultBaseUrl(input.providerType),
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
      existingAccount: existing ?? undefined,
      clock: this.deps.clock,
    });
    store.accounts[nextAccount.id] = nextAccount;
    await this.deps.storeRepository.write(store);
    const syncResult = await this.deps.projection.syncStoreToProjection(store);
    if (syncResult.storeModified) {
      await this.deps.storeRepository.write(store);
    }

    return nextAccount;
  }
}

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, any>;
}

function asProviderCredential(value: unknown): ProviderCredentialLike | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return typeof record.id === 'string'
    && typeof record.vendorId === 'string'
    && typeof record.label === 'string'
    && typeof record.authMode === 'string'
    && typeof record.enabled === 'boolean'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
    ? record as ProviderCredentialLike
    : null;
}
