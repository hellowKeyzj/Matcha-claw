import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  removeProviderMock,
  syncProviderConfigMock,
  getProviderApiKeyMock,
  removeProviderKeyMock,
  saveProviderKeyMock,
} = vi.hoisted(() => ({
  removeProviderMock: vi.fn(),
  syncProviderConfigMock: vi.fn(),
  getProviderApiKeyMock: vi.fn(),
  removeProviderKeyMock: vi.fn(),
  saveProviderKeyMock: vi.fn(),
}));

import { ProviderAccountsService } from '../../runtime-host/application/providers/accounts';
import { getOpenClawProviderKeyForType } from '../../runtime-host/application/providers/provider-runtime-rules';
import { ProviderRuntimeSyncService } from '../../runtime-host/application/providers/store-sync';

function createServiceWithStore(store: {
  accounts: Record<string, any>;
  apiKeys: Record<string, string>;
}) {
  const writeProviderStore = vi.fn(async () => {});
  const syncOpenClawModelsMock = vi.fn(async () => {});
  const removeCredentialModelsMock = vi.fn(async () => {});
  const runtimeSync = new ProviderRuntimeSyncService(
    {
      saveProviderKey: saveProviderKeyMock,
      removeProviderKey: removeProviderKeyMock,
    },
    {
      syncProviderConfig: syncProviderConfigMock,
    },
  );
  const resolveRuntimeProviderKey = (accountId: string, account: Record<string, any> | null) => {
    const providerType = typeof account?.vendorId === 'string' ? account.vendorId.trim() : '';
    return providerType ? getOpenClawProviderKeyForType(providerType, accountId) : accountId;
  };
  const service = new ProviderAccountsService({
    store: {
      read: async () => store,
      write: writeProviderStore,
    },
    parentShell: {
      request: async () => ({ version: 1, success: true, status: 200, data: {} }),
      mapResponse: () => ({ status: 200, data: {} }),
    },
    oauthCompletion: {
      completeBrowser: async () => ({}),
      completeDevice: async () => ({}),
    },
    httpClient: {
      request: vi.fn(),
    },
    clock: {
      nowMs: () => 1_700_000_000_000,
      nowIso: () => '2023-11-14T22:13:20.000Z',
    },
    runtime: {
      syncStoreToRuntime: async (runtimeStore) => await runtimeSync.syncProviderStore(runtimeStore),
      resolveAccountApiKey: async ({ store: runtimeStore, accountId, account }) => {
        const runtimeProviderKey = resolveRuntimeProviderKey(accountId, account as Record<string, any> | null);
        const runtimeApiKey = await getProviderApiKeyMock(runtimeProviderKey);
        if (runtimeApiKey) return runtimeApiKey;
        const localApiKey = runtimeStore.apiKeys[accountId];
        if (typeof localApiKey === 'string' && localApiKey.trim()) return localApiKey.trim();
        if (runtimeProviderKey !== accountId) {
          const aliasedApiKey = runtimeStore.apiKeys[runtimeProviderKey];
          return typeof aliasedApiKey === 'string' && aliasedApiKey.trim() ? aliasedApiKey.trim() : undefined;
        }
        return undefined;
      },
      resolveCleanupProviderKeys: ({ accountId, account }) => (
        Array.from(new Set([resolveRuntimeProviderKey(accountId, account as Record<string, any> | null), accountId]))
      ),
      removeProviderKey: async (providerKey) => {
        await removeProviderKeyMock(providerKey);
      },
      removeProviderConfig: async (providerKey) => {
        await removeProviderMock(providerKey);
      },
    },
    providerModels: {
      removeCredentialModels: removeCredentialModelsMock,
      syncOpenClaw: syncOpenClawModelsMock,
    } as any,
    capabilityRouting: {
      removeCredentialRoutes: vi.fn(),
    } as any,
    jobs: {
      submitCreate: vi.fn(() => ({ success: true, job: { id: 'job-create', type: 'providers.createAccount', status: 'queued', queuedAt: 1, attempts: 0, maxAttempts: 1 } })),
      submitUpdate: vi.fn(() => ({ success: true, job: { id: 'job-update', type: 'providers.updateAccount', status: 'queued', queuedAt: 1, attempts: 0, maxAttempts: 1 } })),
      submitDelete: vi.fn(() => ({ success: true, job: { id: 'job-delete', type: 'providers.deleteAccount', status: 'queued', queuedAt: 1, attempts: 0, maxAttempts: 1 } })),
    },
  });
  return { service, writeProviderStore, syncOpenClawModelsMock, removeCredentialModelsMock };
}

describe('ProviderAccountsService list', () => {
  beforeEach(() => {
    removeProviderMock.mockReset();
    syncProviderConfigMock.mockReset();
    getProviderApiKeyMock.mockReset();
    removeProviderKeyMock.mockReset();
    saveProviderKeyMock.mockReset();
    getProviderApiKeyMock.mockResolvedValue(null);
  });

  it('返回 credentials/statuses/vendors，不再返回 defaultAccountId', async () => {
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
});

describe('ProviderAccountsService mutations', () => {
  beforeEach(() => {
    syncProviderConfigMock.mockReset();
    saveProviderKeyMock.mockReset();
    removeProviderMock.mockReset();
    removeProviderKeyMock.mockReset();
    getProviderApiKeyMock.mockReset();
    getProviderApiKeyMock.mockResolvedValue(null);
  });

  it('新增 custom 凭证只同步 auth profile 与 provider config', async () => {
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

    const { service, writeProviderStore, syncOpenClawModelsMock } = createServiceWithStore(store);
    const result = await service.executeCreate({ account, apiKey: 'sk-custom' });

    expect(result.success).toBe(true);
    expect(writeProviderStore).toHaveBeenCalledTimes(1);
    expect(saveProviderKeyMock).toHaveBeenCalledWith('custom-12345678', 'sk-custom');
    expect(syncProviderConfigMock).toHaveBeenCalledWith(
      'custom-12345678',
      expect.objectContaining({
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        headers: { 'User-Agent': 'MatchaClaw/1.0' },
      }),
    );
    expect(syncProviderConfigMock.mock.calls[0][1]).not.toHaveProperty('models');
    expect(syncOpenClawModelsMock).toHaveBeenCalledTimes(1);
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

    const { service, syncOpenClawModelsMock } = createServiceWithStore(store);
    const result = await service.executeCreate({ account, apiKey: 'sk-openai-media' });

    expect(result.success).toBe(true);
    expect(saveProviderKeyMock).toHaveBeenCalledWith('custom-media-openai', 'sk-openai-media');
    expect(syncProviderConfigMock).not.toHaveBeenCalled();
    expect(syncOpenClawModelsMock).toHaveBeenCalledTimes(1);
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
