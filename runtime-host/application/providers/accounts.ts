import { accepted, badRequest, ok, type ApplicationResponse } from '../common/application-response';
import type { ProviderAccountJobPort } from './provider-account-jobs';
import type { ParentShellPort } from '../runtime-host/parent-shell-port';
import type { RuntimeHttpClientPort } from '../common/runtime-ports';
import type { ProviderOAuthCompletionPort } from './oauth-runtime';
import type { ProviderAccountsProjectionPort } from './provider-accounts-projection-port';
import type { ProviderProjectionKeyResolverPort } from './provider-store-model';
import type { ProviderStorePort, ProviderStoreRecord } from './provider-store-repository';
import type { ProviderAccountMutationWorkflow } from '../workflows/provider-account/provider-account-mutation-workflow';
import {
  accountToStatusLocal,
  sortProviderAccountsLocal,
  validateProviderApiKeyLocal,
} from './account-runtime';
import { PROVIDER_VENDOR_DEFINITIONS } from './provider-registry';
import { resolveProviderModelCapabilities } from './provider-model-capabilities';
import {
  isRecord,
  normalizeProviderStoreForProjection,
} from './provider-store-model';

type ProviderStore = ProviderStoreRecord;

export interface ProviderAccountsServiceDeps {
  readonly store: ProviderStorePort;
  readonly parentShell: ParentShellPort;
  readonly oauthCompletion: ProviderOAuthCompletionPort;
  readonly projection: ProviderAccountsProjectionPort;
  readonly mutations: Pick<ProviderAccountMutationWorkflow, 'executeCreate' | 'executeUpdate' | 'executeDelete'>;
  readonly httpClient: RuntimeHttpClientPort;
  readonly jobs: ProviderAccountJobPort;
  readonly projectionKeys: ProviderProjectionKeyResolverPort;
}

export class ProviderAccountsService {
  private readonly projection: ProviderAccountsProjectionPort;

  constructor(private readonly deps: ProviderAccountsServiceDeps) {
    this.projection = deps.projection;
  }

  private async resolveAccountApiKey(
    store: ProviderStore,
    accountId: string,
    account: Record<string, any> | null,
  ): Promise<string | undefined> {
    return await this.projection.resolveAccountApiKey({ store, accountId, account });
  }

  async list() {
    const store = await this.deps.store.read();
    const { accounts: normalizedAccounts, storeModified } = normalizeProviderStoreForProjection(store, this.deps.projectionKeys);
    if (storeModified) {
      await this.deps.store.write(store);
    }

    const sortedAccounts = sortProviderAccountsLocal(
      normalizedAccounts.map((account) => account.account),
    );
    const statuses = await Promise.all(
      sortedAccounts.map(async (account) => (
        accountToStatusLocal(account, await this.resolveAccountApiKey(store, account.id, account))
      )),
    );
    return {
      credentials: sortedAccounts,
      statuses,
      vendors: PROVIDER_VENDOR_DEFINITIONS.map((vendor) => ({
        ...vendor,
        modelCapabilities: resolveProviderModelCapabilities({ vendorId: vendor.id }),
      })),
    };
  }

  create(payload: unknown): ApplicationResponse {
    return accepted(this.deps.jobs.submitCreate(payload));
  }

  async executeCreate(payload: unknown): Promise<{ success: true; account: Record<string, unknown> }> {
    return await this.deps.mutations.executeCreate(payload);
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
    const oauthProviderTokenKey = typeof body.oauthProviderTokenKey === 'string' ? body.oauthProviderTokenKey.trim() : '';
    const token = isRecord(body.token) ? body.token : null;
    if (!providerType || !accountId || !oauthProviderTokenKey || !token) {
      return badRequest('provider-accounts/oauth/complete-browser 参数无效');
    }
    if (typeof token.access !== 'string' || typeof token.refresh !== 'string' || typeof token.expires !== 'number') {
      return badRequest('provider-accounts/oauth/complete-browser token 参数无效');
    }
    const account = await this.deps.oauthCompletion.completeBrowser({
      providerType,
      accountId,
      ...(typeof body.accountLabel === 'string' ? { accountLabel: body.accountLabel } : {}),
      oauthProviderTokenKey,
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
    return await this.deps.mutations.executeUpdate(accountId, payload);
  }

  delete(accountId: string, apiKeyOnly: boolean): ApplicationResponse {
    return accepted(this.deps.jobs.submitDelete(accountId, apiKeyOnly));
  }

  async executeDelete(accountId: string, apiKeyOnly: boolean): Promise<{ success: true }> {
    return await this.deps.mutations.executeDelete(accountId, apiKeyOnly);
  }
}
