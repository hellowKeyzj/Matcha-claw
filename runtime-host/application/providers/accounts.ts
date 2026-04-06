import type { ParentShellAction, ParentTransportUpstreamPayload } from '../../api/dispatch/parent-transport';

type LocalDispatchResponse = {
  status: number;
  data: unknown;
};

type ProviderStore = {
  defaultAccountId: string | null;
  accounts: Record<string, any>;
  apiKeys: Record<string, string>;
};

export interface ProviderAccountsServiceDeps {
  readonly readProviderStore: () => Promise<ProviderStore>;
  readonly writeProviderStore: (store: ProviderStore) => Promise<void>;
  readonly sortAccounts: (accounts: any[], defaultAccountId: string | null) => any[];
  readonly accountToStatus: (account: any, apiKey: string | undefined) => any;
  readonly normalizeAccount: (input: any, current?: any) => any;
  readonly normalizeFallbackAccount: (accounts: any[], deletedId: string) => string | null;
  readonly validateApiKey: (input: unknown) => unknown;
  readonly requestParentShellAction: (action: ParentShellAction, payload?: unknown) => Promise<ParentTransportUpstreamPayload>;
  readonly mapParentTransportResponse: (upstream: ParentTransportUpstreamPayload) => LocalDispatchResponse;
  readonly providerVendorDefinitions: unknown;
  readonly completeBrowserOAuth: (input: {
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
  }) => Promise<unknown>;
  readonly completeDeviceOAuth: (input: {
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
  }) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class ProviderAccountsService {
  constructor(private readonly deps: ProviderAccountsServiceDeps) {}

  async list() {
    const store = await this.deps.readProviderStore();
    const accounts = Object.values(store.accounts).filter((entry) => isRecord(entry));
    const sortedAccounts = this.deps.sortAccounts(accounts, store.defaultAccountId);
    const statuses = sortedAccounts.map((account) => this.deps.accountToStatus(account, store.apiKeys[account.id]));
    return {
      accounts: sortedAccounts,
      statuses,
      vendors: this.deps.providerVendorDefinitions,
      defaultAccountId: store.defaultAccountId,
    };
  }

  async create(payload: unknown): Promise<LocalDispatchResponse> {
    const body = isRecord(payload) ? payload : {};
    const account = this.deps.normalizeAccount(body.account);
    if (!account) {
      return {
        status: 400,
        data: { success: false, error: 'account 参数无效' },
      };
    }
    const store = await this.deps.readProviderStore();
    store.accounts[account.id] = account;
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (apiKey) {
      store.apiKeys[account.id] = apiKey;
    }
    if (!store.defaultAccountId) {
      store.defaultAccountId = account.id;
      store.accounts[account.id].isDefault = true;
    }
    await this.deps.writeProviderStore(store);
    return {
      status: 200,
      data: {
        success: true,
        account: store.accounts[account.id],
      },
    };
  }

  async setDefault(payload: unknown): Promise<LocalDispatchResponse> {
    const body = isRecord(payload) ? payload : {};
    const accountId = typeof body.accountId === 'string' ? body.accountId : '';
    if (!accountId) {
      return {
        status: 400,
        data: { success: false, error: 'accountId 参数无效' },
      };
    }
    const store = await this.deps.readProviderStore();
    if (!store.accounts[accountId]) {
      return {
        status: 404,
        data: { success: false, error: 'Provider account not found' },
      };
    }
    store.defaultAccountId = accountId;
    for (const account of Object.values(store.accounts)) {
      account.isDefault = account.id === accountId;
    }
    await this.deps.writeProviderStore(store);
    return {
      status: 200,
      data: { success: true },
    };
  }

  validate(payload: unknown) {
    return this.deps.validateApiKey(payload);
  }

  async startOAuth(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    if (typeof body.provider !== 'string') {
      return {
        status: 400,
        data: { success: false, error: 'provider-accounts/oauth/start 参数无效' },
      } satisfies LocalDispatchResponse;
    }
    const shellResponse = await this.deps.requestParentShellAction('provider_oauth_start', {
      provider: body.provider,
      ...((body.region === 'global' || body.region === 'cn') ? { region: body.region } : {}),
      ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
      ...(typeof body.label === 'string' ? { label: body.label } : {}),
    });
    return this.deps.mapParentTransportResponse(shellResponse);
  }

  async cancelOAuth() {
    const shellResponse = await this.deps.requestParentShellAction('provider_oauth_cancel');
    return this.deps.mapParentTransportResponse(shellResponse);
  }

  async submitOAuth(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const shellResponse = await this.deps.requestParentShellAction('provider_oauth_submit', {
      code: typeof body.code === 'string' ? body.code : '',
    });
    return this.deps.mapParentTransportResponse(shellResponse);
  }

  async completeBrowser(payload: unknown): Promise<LocalDispatchResponse> {
    const body = isRecord(payload) ? payload : {};
    const providerType = body.providerType === 'google' || body.providerType === 'openai'
      ? body.providerType
      : null;
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    const runtimeProviderId = typeof body.runtimeProviderId === 'string' ? body.runtimeProviderId.trim() : '';
    const token = isRecord(body.token) ? body.token : null;
    if (!providerType || !accountId || !runtimeProviderId || !token) {
      return {
        status: 400,
        data: { success: false, error: 'provider-accounts/oauth/complete-browser 参数无效' },
      };
    }
    if (typeof token.access !== 'string' || typeof token.refresh !== 'string' || typeof token.expires !== 'number') {
      return {
        status: 400,
        data: { success: false, error: 'provider-accounts/oauth/complete-browser token 参数无效' },
      };
    }
    const account = await this.deps.completeBrowserOAuth({
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
    return {
      status: 200,
      data: { success: true, account },
    };
  }

  async completeDevice(payload: unknown): Promise<LocalDispatchResponse> {
    const body = isRecord(payload) ? payload : {};
    const providerType = body.providerType === 'minimax-portal'
      || body.providerType === 'minimax-portal-cn'
      || body.providerType === 'qwen-portal'
      ? body.providerType
      : null;
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    const token = isRecord(body.token) ? body.token : null;
    if (!providerType || !accountId || !token) {
      return {
        status: 400,
        data: { success: false, error: 'provider-accounts/oauth/complete-device 参数无效' },
      };
    }
    if (
      typeof token.access !== 'string'
      || typeof token.refresh !== 'string'
      || typeof token.expires !== 'number'
      || (token.api !== 'anthropic-messages' && token.api !== 'openai-completions')
    ) {
      return {
        status: 400,
        data: { success: false, error: 'provider-accounts/oauth/complete-device token 参数无效' },
      };
    }
    const account = await this.deps.completeDeviceOAuth({
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
    return {
      status: 200,
      data: { success: true, account },
    };
  }

  async getApiKey(accountId: string) {
    const store = await this.deps.readProviderStore();
    return { apiKey: typeof store.apiKeys[accountId] === 'string' ? store.apiKeys[accountId] : null };
  }

  async hasApiKey(accountId: string) {
    const store = await this.deps.readProviderStore();
    return { hasKey: typeof store.apiKeys[accountId] === 'string' && store.apiKeys[accountId].trim().length > 0 };
  }

  async get(accountId: string) {
    const store = await this.deps.readProviderStore();
    return store.accounts[accountId] || null;
  }

  async update(accountId: string, payload: unknown): Promise<LocalDispatchResponse> {
    const store = await this.deps.readProviderStore();
    const existing = isRecord(store.accounts[accountId]) ? store.accounts[accountId] : null;
    if (!existing) {
      return {
        status: 404,
        data: { success: false, error: 'Provider account not found' },
      };
    }
    const body = isRecord(payload) ? payload : {};
    const updates = isRecord(body.updates) ? body.updates : null;
    if (!updates) {
      return {
        status: 400,
        data: { success: false, error: 'updates 参数无效' },
      };
    }
    const next = this.deps.normalizeAccount({
      ...existing,
      ...updates,
      id: accountId,
    }, existing);
    if (!next) {
      return {
        status: 400,
        data: { success: false, error: 'provider account 参数无效' },
      };
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
    await this.deps.writeProviderStore(store);
    return {
      status: 200,
      data: { success: true, account: next },
    };
  }

  async delete(accountId: string, apiKeyOnly: boolean): Promise<LocalDispatchResponse> {
    const store = await this.deps.readProviderStore();
    if (apiKeyOnly) {
      delete store.apiKeys[accountId];
      await this.deps.writeProviderStore(store);
      return {
        status: 200,
        data: { success: true },
      };
    }
    delete store.accounts[accountId];
    delete store.apiKeys[accountId];
    if (store.defaultAccountId === accountId) {
      store.defaultAccountId = this.deps.normalizeFallbackAccount(Object.values(store.accounts), accountId);
      for (const account of Object.values(store.accounts)) {
        account.isDefault = Boolean(store.defaultAccountId) && account.id === store.defaultAccountId;
      }
    }
    await this.deps.writeProviderStore(store);
    return {
      status: 200,
      data: { success: true },
    };
  }
}
