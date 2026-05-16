import { accepted, badRequest, ok, type ApplicationResponse } from '../common/application-response';
import type { ProviderAccountJobPort } from './provider-account-jobs';
import type { ParentShellPort } from '../runtime-host/parent-shell-port';
import type { RuntimeClockPort, RuntimeHttpClientPort } from '../common/runtime-ports';
import type { ProviderOAuthCompletionPort } from './oauth-runtime';
import type { ProviderAccountsRuntimePort } from './provider-accounts-runtime-port';
import type { ProviderStorePort, ProviderStoreRecord } from './provider-store-repository';
import {
  accountToStatusLocal,
  normalizeProviderAccountLocal,
  normalizeProviderFallbackAccountLocal,
  sortProviderAccountsLocal,
  validateProviderApiKeyLocal,
} from './account-runtime';
import { PROVIDER_VENDOR_DEFINITIONS } from './provider-registry';
import {
  isRecord,
  normalizeProviderStoreForRuntime,
} from './provider-store-model';

type ProviderStore = ProviderStoreRecord;

export interface ProviderAccountsServiceDeps {
  readonly store: ProviderStorePort;
  readonly parentShell: ParentShellPort;
  readonly oauthCompletion: ProviderOAuthCompletionPort;
  readonly runtime: ProviderAccountsRuntimePort;
  readonly httpClient: RuntimeHttpClientPort;
  readonly clock: RuntimeClockPort;
  readonly jobs: ProviderAccountJobPort;
}

export class ProviderAccountsService {
  private readonly runtime: ProviderAccountsRuntimePort;

  constructor(private readonly deps: ProviderAccountsServiceDeps) {
    this.runtime = deps.runtime;
  }

  private async syncStoreToOpenClaw(store: ProviderStore): Promise<void> {
    const result = await this.runtime.syncStoreToRuntime(store);
    if (result.storeModified) {
      await this.deps.store.write(store);
    }
  }

  private async resolveAccountApiKey(
    store: ProviderStore,
    accountId: string,
    account: Record<string, any> | null,
  ): Promise<string | undefined> {
    return await this.runtime.resolveAccountApiKey({ store, accountId, account });
  }

  async list() {
    const store = await this.deps.store.read();
    const { accounts: normalizedAccounts, storeModified } = normalizeProviderStoreForRuntime(store);
    if (storeModified) {
      await this.deps.store.write(store);
    }

    const sortedAccounts = sortProviderAccountsLocal(
      normalizedAccounts.map((account) => account.account),
      store.defaultAccountId,
    );
    const statuses = await Promise.all(
      sortedAccounts.map(async (account) => (
        accountToStatusLocal(account, await this.resolveAccountApiKey(store, account.id, account))
      )),
    );
    return {
      accounts: sortedAccounts,
      statuses,
      vendors: PROVIDER_VENDOR_DEFINITIONS,
      defaultAccountId: store.defaultAccountId,
    };
  }

  create(payload: unknown): ApplicationResponse {
    return accepted(this.deps.jobs.submitCreate(payload));
  }

  async executeCreate(payload: unknown): Promise<{ success: true; account: Record<string, unknown> }> {
    const body = isRecord(payload) ? payload : {};
    const account = normalizeProviderAccountLocal(body.account, null, this.deps.clock);
    if (!account) {
      throw new Error('account 参数无效');
    }
    const store = await this.deps.store.read();
    store.accounts[account.id] = account;
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (apiKey) {
      store.apiKeys[account.id] = apiKey;
    }
    if (!store.defaultAccountId) {
      store.defaultAccountId = account.id;
      store.accounts[account.id].isDefault = true;
    }
    await this.deps.store.write(store);
    await this.syncStoreToOpenClaw(store);
    return {
      success: true,
      account: store.accounts[account.id],
    };
  }

  setDefault(payload: unknown): ApplicationResponse {
    return accepted(this.deps.jobs.submitSetDefault(payload));
  }

  async executeSetDefault(payload: unknown): Promise<{ success: true }> {
    const body = isRecord(payload) ? payload : {};
    const accountId = typeof body.accountId === 'string' ? body.accountId : '';
    if (!accountId) {
      throw new Error('accountId 参数无效');
    }
    const store = await this.deps.store.read();
    if (!store.accounts[accountId]) {
      throw new Error('Provider account not found');
    }
    store.defaultAccountId = accountId;
    for (const account of Object.values(store.accounts)) {
      account.isDefault = account.id === accountId;
    }
    await this.deps.store.write(store);
    await this.syncStoreToOpenClaw(store);
    return { success: true };
  }

  async validate(payload: unknown) {
    return await validateProviderApiKeyLocal(payload, this.deps.httpClient);
  }

  async startOAuth(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    if (typeof body.provider !== 'string') {
      return badRequest('provider-accounts/oauth/start 参数无效');
    }
    const shellResponse = await this.deps.parentShell.request('provider_oauth_start', {
      provider: body.provider,
      ...((body.region === 'global' || body.region === 'cn') ? { region: body.region } : {}),
      ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
      ...(typeof body.label === 'string' ? { label: body.label } : {}),
    });
    return this.deps.parentShell.mapResponse(shellResponse);
  }

  async cancelOAuth() {
    const shellResponse = await this.deps.parentShell.request('provider_oauth_cancel');
    return this.deps.parentShell.mapResponse(shellResponse);
  }

  async submitOAuth(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const shellResponse = await this.deps.parentShell.request('provider_oauth_submit', {
      code: typeof body.code === 'string' ? body.code : '',
    });
    return this.deps.parentShell.mapResponse(shellResponse);
  }

  async completeBrowser(payload: unknown): Promise<ApplicationResponse> {
    const body = isRecord(payload) ? payload : {};
    const providerType = body.providerType === 'google' || body.providerType === 'openai'
      ? body.providerType
      : null;
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    const runtimeProviderId = typeof body.runtimeProviderId === 'string' ? body.runtimeProviderId.trim() : '';
    const token = isRecord(body.token) ? body.token : null;
    if (!providerType || !accountId || !runtimeProviderId || !token) {
      return badRequest('provider-accounts/oauth/complete-browser 参数无效');
    }
    if (typeof token.access !== 'string' || typeof token.refresh !== 'string' || typeof token.expires !== 'number') {
      return badRequest('provider-accounts/oauth/complete-browser token 参数无效');
    }
    const account = await this.deps.oauthCompletion.completeBrowser({
      providerType,
      accountId,
      ...(typeof body.accountLabel === 'string' ? { accountLabel: body.accountLabel } : {}),
      runtimeProviderId,
      token: {
        access: token.access,
        refresh: token.refresh,
        expires: token.expires,
        ...(typeof token.email === 'string' ? { email: token.email } : {}),
        ...(typeof token.projectId === 'string' ? { projectId: token.projectId } : {}),
        ...(typeof token.accountId === 'string' ? { accountId: token.accountId } : {}),
      },
    });
    return ok({ success: true, account });
  }

  async completeDevice(payload: unknown): Promise<ApplicationResponse> {
    const body = isRecord(payload) ? payload : {};
    const providerType = body.providerType === 'minimax-portal'
      || body.providerType === 'minimax-portal-cn'
      || body.providerType === 'qwen-portal'
      ? body.providerType
      : null;
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    const token = isRecord(body.token) ? body.token : null;
    if (!providerType || !accountId || !token) {
      return badRequest('provider-accounts/oauth/complete-device 参数无效');
    }
    if (
      typeof token.access !== 'string'
      || typeof token.refresh !== 'string'
      || typeof token.expires !== 'number'
      || (token.api !== 'anthropic-messages' && token.api !== 'openai-completions')
    ) {
      return badRequest('provider-accounts/oauth/complete-device token 参数无效');
    }
    const account = await this.deps.oauthCompletion.completeDevice({
      providerType,
      accountId,
      ...(typeof body.accountLabel === 'string' ? { accountLabel: body.accountLabel } : {}),
      token: {
        access: token.access,
        refresh: token.refresh,
        expires: token.expires,
        api: token.api,
        ...(typeof token.resourceUrl === 'string' ? { resourceUrl: token.resourceUrl } : {}),
      },
    });
    return ok({ success: true, account });
  }

  async getApiKey(accountId: string) {
    const store = await this.deps.store.read();
    return { apiKey: typeof store.apiKeys[accountId] === 'string' ? store.apiKeys[accountId] : null };
  }

  async hasApiKey(accountId: string) {
    const store = await this.deps.store.read();
    const account = isRecord(store.accounts[accountId]) ? store.accounts[accountId] : null;
    return { hasKey: Boolean(await this.resolveAccountApiKey(store, accountId, account)) };
  }

  async get(accountId: string) {
    const store = await this.deps.store.read();
    return store.accounts[accountId] || null;
  }

  update(accountId: string, payload: unknown): ApplicationResponse {
    return accepted(this.deps.jobs.submitUpdate(accountId, payload));
  }

  async executeUpdate(accountId: string, payload: unknown): Promise<{ success: true; account: Record<string, unknown> }> {
    const store = await this.deps.store.read();
    const existing = isRecord(store.accounts[accountId]) ? store.accounts[accountId] : null;
    if (!existing) {
      throw new Error('Provider account not found');
    }
    const body = isRecord(payload) ? payload : {};
    const updates = isRecord(body.updates) ? body.updates : null;
    if (!updates) {
      throw new Error('updates 参数无效');
    }
    const next = normalizeProviderAccountLocal({
      ...existing,
      ...updates,
      id: accountId,
    }, existing, this.deps.clock);
    if (!next) {
      throw new Error('provider account 参数无效');
    }
    store.accounts[accountId] = next;
    if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) {
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (apiKey) {
        store.apiKeys[accountId] = apiKey;
      } else {
        delete store.apiKeys[accountId];
      }
    }
    await this.deps.store.write(store);
    await this.syncStoreToOpenClaw(store);
    return { success: true, account: next };
  }

  delete(accountId: string, apiKeyOnly: boolean): ApplicationResponse {
    return accepted(this.deps.jobs.submitDelete(accountId, apiKeyOnly));
  }

  async executeDelete(accountId: string, apiKeyOnly: boolean): Promise<{ success: true }> {
    const store = await this.deps.store.read();
    const existingAccount = isRecord(store.accounts[accountId]) ? store.accounts[accountId] : null;
    const cleanupProviderKeys = this.runtime.resolveCleanupProviderKeys({
      accountId,
      account: existingAccount,
    });

    if (apiKeyOnly) {
      delete store.apiKeys[accountId];
      for (const providerKey of cleanupProviderKeys) {
        await this.runtime.removeProviderKey(providerKey);
      }
      await this.deps.store.write(store);
      await this.syncStoreToOpenClaw(store);
      return { success: true };
    }
    delete store.accounts[accountId];
    delete store.apiKeys[accountId];
    if (store.defaultAccountId === accountId) {
      store.defaultAccountId = normalizeProviderFallbackAccountLocal(Object.values(store.accounts), accountId);
      for (const account of Object.values(store.accounts)) {
        account.isDefault = Boolean(store.defaultAccountId) && account.id === store.defaultAccountId;
      }
    }
    for (const providerKey of cleanupProviderKeys) {
      await this.runtime.removeProviderConfig(providerKey);
    }
    await this.deps.store.write(store);
    await this.syncStoreToOpenClaw(store);
    return { success: true };
  }
}
