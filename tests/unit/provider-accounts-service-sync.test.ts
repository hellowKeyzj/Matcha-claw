import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  removeProviderMock,
  syncProviderConfigMock,
  saveProviderKeyMock,
  removeProviderKeyMock,
  upsertProviderInAgentModelsMock,
} = vi.hoisted(() => ({
  removeProviderMock: vi.fn(),
  syncProviderConfigMock: vi.fn(),
  saveProviderKeyMock: vi.fn(),
  removeProviderKeyMock: vi.fn(),
  upsertProviderInAgentModelsMock: vi.fn(),
}));

import { ProviderAccountsService } from '../../runtime-host/application/providers/accounts';
import { ProviderAccountMutationWorkflow } from '../../runtime-host/application/workflows/provider-account/provider-account-mutation-workflow';
import {
  getLegacyOpenClawProviderKeys,
  getOAuthApiKeyEnv,
  getOAuthProviderApi,
  getOAuthProviderDefaultBaseUrl,
  getOAuthProviderTokenKey,
  resolveOpenClawProviderKeyForAccount,
  normalizeOAuthBaseUrl,
  usesOAuthAuthHeader,
} from '../../runtime-host/application/adapters/openclaw/projections/openclaw-provider-projection-rules';
import { ProviderProjectionSyncService, type ProviderProjectionKeyResolverPort, type ProviderProjectionPolicyPort } from '../../runtime-host/application/providers/store-sync';
import { ProviderProjectionSyncWorkflow } from '../../runtime-host/application/workflows/provider-projection-sync/provider-projection-sync-workflow';

const projectionKeys: ProviderProjectionKeyResolverPort = {
  resolveProviderKey: ({ vendorId, accountId, account }) => resolveOpenClawProviderKeyForAccount({
    vendorId,
    id: accountId,
    authMode: account?.authMode,
  }),
};

const projectionPolicy: ProviderProjectionPolicyPort = {
  getReplaceProviderKeys: ({ vendorId, accountId }) => getLegacyOpenClawProviderKeys(vendorId, accountId),
  getOAuthProviderApi,
  getOAuthProviderTokenKey,
  getOAuthProviderDefaultBaseUrl,
  normalizeOAuthBaseUrl,
  getOAuthApiKeyEnv,
  usesOAuthAuthHeader,
};

function createServiceWithStore(store: {
  accounts: Record<string, any>;
  apiKeys: Record<string, string>;
}) {
  const writeProviderStore = vi.fn(async () => {});
  const syncRuntimeModelProjectionMock = vi.fn(async () => {});
  const removeCredentialModelsMock = vi.fn(async () => {});
  const runtimeSync = new ProviderProjectionSyncService(new ProviderProjectionSyncWorkflow({
    authProfiles: {
      saveProviderKey: saveProviderKeyMock,
      removeProviderKey: removeProviderKeyMock,
    },
    providerConfig: {
      syncProviderConfig: syncProviderConfigMock,
      removeProvider: removeProviderMock,
    },
    projectionState: {
      getActiveProviders: async () => new Set<string>(),
    },
    authRepository: {
      discoverAgentIds: async () => ['main'],
    },
    agentModels: {
      upsertProviderInAgentModels: upsertProviderInAgentModelsMock,
    },
    projectionKeys,
    projectionPolicy,
  }));
  const resolveRuntimeConfigProviderKey = (accountId: string, account: Record<string, any> | null) => {
    const providerType = typeof account?.vendorId === 'string' ? account.vendorId.trim() : '';
    return providerType ? projectionKeys.resolveProviderKey({ vendorId: providerType, accountId, account: account ?? undefined }) : accountId;
  };
  const storePort = {
    read: async () => store,
    write: writeProviderStore,
  };
  const projectionPort = {
    syncStoreToProjection: async (runtimeStore) => await runtimeSync.syncProviderStore(runtimeStore),
    resolveAccountApiKey: async ({ store: runtimeStore, accountId, account }) => {
      const runtimeConfigProviderKey = resolveRuntimeConfigProviderKey(accountId, account as Record<string, any> | null);
      const localApiKey = runtimeStore.apiKeys[accountId];
      if (typeof localApiKey === 'string' && localApiKey.trim()) return localApiKey.trim();
      if (runtimeConfigProviderKey !== accountId) {
        const aliasedApiKey = runtimeStore.apiKeys[runtimeConfigProviderKey];
        return typeof aliasedApiKey === 'string' && aliasedApiKey.trim() ? aliasedApiKey.trim() : undefined;
      }
      return undefined;
    },
    resolveCleanupProviderKeys: ({ accountId, account }) => (
      Array.from(new Set([resolveRuntimeConfigProviderKey(accountId, account as Record<string, any> | null), accountId]))
    ),
    removeProviderKey: async (providerKey) => {
      await removeProviderKeyMock(providerKey);
    },
    removeProviderConfig: async (providerKey) => {
      await removeProviderMock(providerKey);
    },
  };
  const providerModels = {
    removeCredentialModels: removeCredentialModelsMock,
    syncRuntimeProjection: syncRuntimeModelProjectionMock,
  };
  const capabilityRouting = {
    removeCredentialRoutes: vi.fn(),
  };
  const mutationWorkflow = new ProviderAccountMutationWorkflow({
    store: storePort,
    projection: projectionPort,
    providerModels,
    capabilityRouting,
    clock: {
      nowMs: () => 1_700_000_000_000,
      nowIso: () => '2023-11-14T22:13:20.000Z',
    },
  });
  const httpClientRequest = vi.fn(async () => ({
    status: 200,
    json: async () => ({}),
  }));
  const service = new ProviderAccountsService({
    store: storePort,
    parentShell: {
      request: async () => ({ version: 1, success: true, status: 200, data: {} }),
      mapResponse: () => ({ status: 200, data: {} }),
    },
    oauthCompletion: {
      completeBrowser: async () => ({}),
      completeDevice: async () => ({}),
    },
    httpClient: {
      request: httpClientRequest,
    },
    projection: projectionPort,
    mutations: mutationWorkflow,
    jobs: {
      submitCreate: vi.fn(() => ({ success: true, job: { id: 'job-create', type: 'providers.createAccount', status: 'queued', queuedAt: 1, attempts: 0, maxAttempts: 1 } })),
      submitUpdate: vi.fn(() => ({ success: true, job: { id: 'job-update', type: 'providers.updateAccount', status: 'queued', queuedAt: 1, attempts: 0, maxAttempts: 1 } })),
      submitDelete: vi.fn(() => ({ success: true, job: { id: 'job-delete', type: 'providers.deleteAccount', status: 'queued', queuedAt: 1, attempts: 0, maxAttempts: 1 } })),
    },
    projectionKeys,
  });
  return { service, writeProviderStore, syncRuntimeModelProjectionMock, removeCredentialModelsMock, httpClientRequest };
}

describe('ProviderAccountsService list', () => {
  beforeEach(() => {
    removeProviderMock.mockReset();
    syncProviderConfigMock.mockReset();
    saveProviderKeyMock.mockReset();
    removeProviderKeyMock.mockReset();
    upsertProviderInAgentModelsMock.mockReset();
  });

  it('返回 credentials/statuses/vendors，不再返回 defaultAccountId 或 secret-bearing headers', async () => {
    const store = {
      accounts: {
        'openai-main': {
          id: 'openai-main',
          vendorId: 'openai',
          updatedAt: '2026-04-08T00:00:00.000Z',
        },
        'custom-1': {
          id: 'custom-1',
          vendorId: 'custom',
          headers: { Authorization: 'Bearer secret-header' },
          customHeaders: { 'x-api-key': 'custom-header-secret' },
          metadata: { refreshToken: 'refresh-secret', publicLabel: 'custom metadata' },
          updatedAt: '2026-04-09T00:00:00.000Z',
        },
      },
      apiKeys: {
        'openai-main': 'sk-openai',
        'custom-1': 'sk-custom',
      },
    };

    const { service, writeProviderStore } = createServiceWithStore(store);
    const result = await service.list();

    expect(result.credentials.map((item) => item.id)).toEqual(['custom-1', 'openai-main']);
    expect(result.statuses.map((item) => item.id)).toEqual(['custom-1', 'openai-main']);
    expect(result.vendors.find((item) => item.id === 'custom')?.modelCapabilities).toEqual(['chat', 'imageUnderstand']);
    expect(result.vendors.find((item) => item.id === 'openai')?.modelCapabilities).toContain('imageGenerate');
    expect(result).not.toHaveProperty('defaultAccountId');
    expect(result.credentials[0]).not.toHaveProperty('headers');
    expect(result.credentials[0]).not.toHaveProperty('customHeaders');
    expect(result.credentials[0].metadata).toEqual({ publicLabel: 'custom metadata' });
    expect(JSON.stringify(result.credentials)).not.toContain('secret-header');
    expect(JSON.stringify(result.credentials)).not.toContain('custom-header-secret');
    expect(JSON.stringify(result.credentials)).not.toContain('refresh-secret');
    expect(writeProviderStore).not.toHaveBeenCalled();
  });

  it('清理非法账号但不维护默认账号字段', async () => {
    const store = {
      accounts: {
        broken: { id: 'broken' },
        'openai-main': { id: 'openai-main', vendorId: 'openai', updatedAt: '2026-04-08T00:00:00.000Z' },
        invalid: null,
      },
      apiKeys: {
        broken: 'sk-broken',
        'openai-main': 'sk-openai',
        invalid: 'sk-invalid',
      },
    };

    const { service, writeProviderStore } = createServiceWithStore(store);
    const result = await service.list();

    expect(result.credentials.map((item) => item.id)).toEqual(['openai-main']);
    expect(store.accounts.broken).toBeUndefined();
    expect(store.accounts.invalid).toBeUndefined();
    expect(store.apiKeys.broken).toBeUndefined();
    expect(store.apiKeys.invalid).toBeUndefined();
    expect(writeProviderStore).toHaveBeenCalledTimes(1);
  });

  it('同 runtime key 重复时只保留一条凭证', async () => {
    const store = {
      accounts: {
        'minimax-portal': {
          id: 'minimax-portal',
          vendorId: 'minimax-portal',
          updatedAt: '2026-04-08T00:00:00.000Z',
        },
        'minimax-portal-cn-uuid': {
          id: 'minimax-portal-cn-uuid',
          vendorId: 'minimax-portal-cn',
          updatedAt: '2026-04-09T00:00:00.000Z',
        },
      },
      apiKeys: {
        'minimax-portal': 'sk-old',
        'minimax-portal-cn-uuid': 'sk-cn',
      },
    };

    const { service, writeProviderStore } = createServiceWithStore(store);
    const result = await service.list();

    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0].id).toBe('minimax-portal-cn-uuid');
    expect(store.accounts['minimax-portal']).toBeUndefined();
    expect(store.apiKeys['minimax-portal']).toBeUndefined();
    expect(writeProviderStore).toHaveBeenCalledTimes(1);
  });

  it('getApiKey returns masked metadata instead of the full secret', async () => {
    const store = {
      accounts: {
        'openai-main': { id: 'openai-main', vendorId: 'openai', updatedAt: '2026-04-08T00:00:00.000Z' },
      },
      apiKeys: {
        'openai-main': 'sk-1234567890abcdef',
      },
    };

    const { service } = createServiceWithStore(store);
    const result = await service.getApiKey('openai-main');

    expect(result).toEqual({
      hasKey: true,
      keyMasked: 'sk-1***********cdef',
      last4: 'cdef',
    });
    expect(result).not.toHaveProperty('apiKey');
    expect(JSON.stringify(result)).not.toContain('sk-1234567890abcdef');
  });

  it('get sanitizes sensitive provider account headers', async () => {
    const store = {
      accounts: {
        'custom-1': {
          id: 'custom-1',
          vendorId: 'custom',
          headers: { Authorization: 'Bearer secret' },
          updatedAt: '2026-04-08T00:00:00.000Z',
        },
      },
      apiKeys: {},
    };

    const { service } = createServiceWithStore(store);
    const result = await service.get('custom-1');

    expect(result).toEqual({
      id: 'custom-1',
      vendorId: 'custom',
      updatedAt: '2026-04-08T00:00:00.000Z',
    });
    expect(result).not.toHaveProperty('headers');
  });

  it('validate rejects account/vendor mismatch before probing provider API', async () => {
    const store = {
      accounts: {
        'openai-main': { id: 'openai-main', vendorId: 'openai', updatedAt: '2026-04-08T00:00:00.000Z' },
      },
      apiKeys: {},
    };

    const { service, httpClientRequest } = createServiceWithStore(store);
    const result = await service.validate({ accountId: 'openai-main', vendorId: 'anthropic', apiKey: 'sk-test' });

    expect(result).toEqual({ valid: false, error: 'Provider account does not match vendor' });
    expect(httpClientRequest).not.toHaveBeenCalled();
  });
});

describe('ProviderAccountsService mutations', () => {
  beforeEach(() => {
    syncProviderConfigMock.mockReset();
    removeProviderMock.mockReset();
    saveProviderKeyMock.mockReset();
    removeProviderKeyMock.mockReset();
    upsertProviderInAgentModelsMock.mockReset();
  });

  it('新增 custom 凭证同步 provider config 与 per-agent models.json provider', async () => {
    const store = {
      accounts: {},
      apiKeys: {},
    };
    const account = {
      id: 'custom-12345678',
      vendorId: 'custom',
      label: '自定义',
      authMode: 'api_key',
      baseUrl: 'https://api.example.com/v1',
      apiProtocol: 'openai-completions',
      headers: { 'User-Agent': 'MatchaClaw/1.0' },
      enabled: true,
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
    };

    const { service, writeProviderStore, syncRuntimeModelProjectionMock } = createServiceWithStore(store);
    const result = await service.executeCreate({ account, apiKey: 'sk-custom' });

    expect(result.success).toBe(true);
    expect(writeProviderStore).toHaveBeenCalledTimes(1);
    expect(saveProviderKeyMock).toHaveBeenCalledWith('custom-12345678', 'sk-custom');
    expect(removeProviderKeyMock).not.toHaveBeenCalledWith('custom-12345678');
    expect(syncProviderConfigMock).toHaveBeenCalledWith(
      'custom-12345678',
      expect.objectContaining({
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        headers: { 'User-Agent': 'MatchaClaw/1.0' },
      }),
    );
    expect(upsertProviderInAgentModelsMock).toHaveBeenCalledWith({
      agentIds: ['main'],
      provider: 'custom-12345678',
      entry: expect.objectContaining({
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        headers: { 'User-Agent': 'MatchaClaw/1.0' },
      }),
    });
    expect(syncProviderConfigMock.mock.calls[0][1]).not.toHaveProperty('models');
    expect(syncRuntimeModelProjectionMock).toHaveBeenCalledTimes(1);
  });

  it('OpenAI browser OAuth 凭证同步到 openai-codex runtime provider', async () => {
    const store = {
      accounts: {},
      apiKeys: {},
    };
    const account = {
      id: 'openai-oauth',
      vendorId: 'openai',
      label: 'OpenAI Codex',
      authMode: 'oauth_browser',
      enabled: true,
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
    };

    const { service } = createServiceWithStore(store);
    const result = await service.executeCreate({ account });

    expect(result.success).toBe(true);
    expect(syncProviderConfigMock).toHaveBeenCalledWith(
      'openai-codex',
      expect.objectContaining({
        baseUrl: 'https://api.openai.com/v1',
        api: 'openai-codex-responses',
      }),
    );
    expect(saveProviderKeyMock).not.toHaveBeenCalled();
  });

  it('新增 custom 媒体凭证以自定义 providerKey 同步中转接口契约', async () => {
    const store = {
      accounts: {},
      apiKeys: {},
    };
    const account = {
      id: 'custom-media-openai',
      vendorId: 'custom',
      providerKind: 'media',
      label: 'OpenAI Images',
      authMode: 'api_key',
      baseUrl: 'https://api.openai.com/v1',
      mediaApiProtocol: 'openai',
      enabled: true,
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
    };

    const { service, syncRuntimeModelProjectionMock } = createServiceWithStore(store);
    const result = await service.executeCreate({ account, apiKey: 'sk-openai-media' });

    expect(result.success).toBe(true);
    expect(saveProviderKeyMock).toHaveBeenCalledWith('custom-media-openai', 'sk-openai-media');
    expect(removeProviderKeyMock).not.toHaveBeenCalledWith('custom-media-openai');
    expect(upsertProviderInAgentModelsMock).not.toHaveBeenCalled();
    expect(syncProviderConfigMock).not.toHaveBeenCalled();
    expect(syncRuntimeModelProjectionMock).toHaveBeenCalledTimes(1);
  });

  it('删除 custom 凭证时清理 runtime key 与原账号 key', async () => {
    const store = {
      accounts: {
        'moonshot-cn': {
          id: 'moonshot-cn',
          vendorId: 'custom',
          updatedAt: '2026-04-08T00:00:00.000Z',
        },
      },
      apiKeys: {
        'moonshot-cn': 'sk-custom',
      },
    };
    const { service, writeProviderStore } = createServiceWithStore(store);

    const result = await service.executeDelete('moonshot-cn', false);

    expect(result.success).toBe(true);
    expect(removeProviderMock).toHaveBeenCalledWith('custom-moonshot-cn');
    expect(removeProviderMock).toHaveBeenCalledWith('moonshot-cn');
    expect(writeProviderStore).toHaveBeenCalledTimes(1);
  });

  it('删除 custom 媒体凭证不删除共享 OpenClaw contract provider config', async () => {
    const store = {
      accounts: {
        'custom-media-openai': {
          id: 'custom-media-openai',
          vendorId: 'custom',
          providerKind: 'media',
          mediaApiProtocol: 'openai',
          updatedAt: '2026-04-08T00:00:00.000Z',
        },
      },
      apiKeys: {
        'custom-media-openai': 'sk-media',
      },
    };
    const { service } = createServiceWithStore(store);

    const result = await service.executeDelete('custom-media-openai', false);

    expect(result.success).toBe(true);
    expect(removeProviderMock).not.toHaveBeenCalled();
    expect(store.accounts['custom-media-openai']).toBeUndefined();
    expect(store.apiKeys['custom-media-openai']).toBeUndefined();
  });

  it('apiKeyOnly 删除只清理 provider key，不删除凭证记录', async () => {
    const store = {
      accounts: {
        'openai-main': {
          id: 'openai-main',
          vendorId: 'openai',
          updatedAt: '2026-04-08T00:00:00.000Z',
        },
      },
      apiKeys: {
        'openai-main': 'sk-openai',
      },
    };
    const { service } = createServiceWithStore(store);

    const result = await service.executeDelete('openai-main', true);

    expect(result.success).toBe(true);
    expect(removeProviderKeyMock).toHaveBeenCalledWith('openai');
    expect(removeProviderKeyMock).toHaveBeenCalledWith('openai-main');
    expect(removeProviderMock).not.toHaveBeenCalled();
    expect(store.accounts['openai-main']).toBeDefined();
    expect(store.apiKeys['openai-main']).toBeUndefined();
  });
});
