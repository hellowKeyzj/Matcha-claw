import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  removeProviderMock,
  setDefaultModelMock,
  setDefaultModelWithOverrideMock,
  syncProviderConfigMock,
  getProviderApiKeyMock,
  removeProviderKeyMock,
  saveProviderKeyMock,
} = vi.hoisted(() => ({
  removeProviderMock: vi.fn(),
  setDefaultModelMock: vi.fn(),
  setDefaultModelWithOverrideMock: vi.fn(),
  syncProviderConfigMock: vi.fn(),
  getProviderApiKeyMock: vi.fn(),
  removeProviderKeyMock: vi.fn(),
  saveProviderKeyMock: vi.fn(),
}));

import { ProviderAccountsService } from '../../runtime-host/application/providers/accounts';
import { getOpenClawProviderKeyForType } from '../../runtime-host/application/providers/provider-runtime-rules';
import { ProviderRuntimeSyncService } from '../../runtime-host/application/providers/store-sync';

function createServiceWithStore(store: {
  defaultAccountId: string | null;
  accounts: Record<string, any>;
  apiKeys: Record<string, string>;
}, overrides?: {
}) {
  const writeProviderStore = vi.fn(async () => {});
  const runtimeSync = new ProviderRuntimeSyncService(
    {
      saveProviderKey: saveProviderKeyMock,
      removeProviderKey: removeProviderKeyMock,
    },
    {
      setDefaultModel: setDefaultModelMock,
      setDefaultModelWithOverride: setDefaultModelWithOverrideMock,
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
        if (runtimeApiKey) {
          return runtimeApiKey;
        }
        const localApiKey = runtimeStore.apiKeys[accountId];
        if (typeof localApiKey === 'string' && localApiKey.trim()) {
          return localApiKey.trim();
        }
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
    jobs: {
      submitCreate: vi.fn(() => ({ success: true, job: { id: 'job-create', type: 'providers.createAccount', status: 'queued', queuedAt: 1, attempts: 0, maxAttempts: 1 } })),
      submitSetDefault: vi.fn(() => ({ success: true, job: { id: 'job-default', type: 'providers.setDefaultAccount', status: 'queued', queuedAt: 1, attempts: 0, maxAttempts: 1 } })),
      submitUpdate: vi.fn(() => ({ success: true, job: { id: 'job-update', type: 'providers.updateAccount', status: 'queued', queuedAt: 1, attempts: 0, maxAttempts: 1 } })),
      submitDelete: vi.fn(() => ({ success: true, job: { id: 'job-delete', type: 'providers.deleteAccount', status: 'queued', queuedAt: 1, attempts: 0, maxAttempts: 1 } })),
    },
  });
  return { service, writeProviderStore };
}

describe('ProviderAccountsService list（provider-store 单一显示源）', () => {
  beforeEach(() => {
    removeProviderMock.mockReset();
    setDefaultModelMock.mockReset();
    setDefaultModelWithOverrideMock.mockReset();
    syncProviderConfigMock.mockReset();
    getProviderApiKeyMock.mockReset();
    removeProviderKeyMock.mockReset();
    saveProviderKeyMock.mockReset();
    getProviderApiKeyMock.mockResolvedValue(null);
  });

  it('直接返回 provider-store 的账号列表，并保持 default 排序优先', async () => {
    const store = {
      defaultAccountId: 'openai-main',
      accounts: {
        'openai-main': {
          id: 'openai-main',
          vendorId: 'openai',
          isDefault: true,
          updatedAt: '2026-04-08T00:00:00.000Z',
        },
        'custom-1': {
          id: 'custom-1',
          vendorId: 'custom',
          isDefault: false,
          updatedAt: '2026-04-08T00:00:00.000Z',
        },
      },
      apiKeys: {
        'openai-main': 'sk-openai',
        'custom-1': 'sk-custom',
      },
    };

    const { service, writeProviderStore } = createServiceWithStore(store);
    const result = await service.list();

    expect(result.accounts.map((item) => item.id)).toEqual(['openai-main', 'custom-1']);
    expect(result.statuses.map((item) => item.id)).toEqual(['openai-main', 'custom-1']);
    expect(result.defaultAccountId).toBe('openai-main');
    expect(writeProviderStore).not.toHaveBeenCalled();
  });

  it('清理非法账号并重新选择默认账号', async () => {
    const store = {
      defaultAccountId: 'broken',
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

    expect(result.accounts.map((item) => item.id)).toEqual(['openai-main']);
    expect(result.statuses.map((item) => item.id)).toEqual(['openai-main']);
    expect(result.defaultAccountId).toBe('openai-main');
    expect(store.accounts.broken).toBeUndefined();
    expect(store.accounts.invalid).toBeUndefined();
    expect(store.apiKeys.broken).toBeUndefined();
    expect(store.apiKeys.invalid).toBeUndefined();
    expect(writeProviderStore).toHaveBeenCalledTimes(1);
  });

  it('minimax 发生同 key 重复时优先保留 CN 别名账号并清理重复项', async () => {
    const store = {
      defaultAccountId: 'minimax-portal',
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

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].id).toBe('minimax-portal-cn-uuid');
    expect(store.accounts['minimax-portal']).toBeUndefined();
    expect(store.apiKeys['minimax-portal']).toBeUndefined();
    expect(store.defaultAccountId).toBe('minimax-portal-cn-uuid');
    expect(writeProviderStore).toHaveBeenCalledTimes(1);
  });

  it('列表状态优先使用 OpenClaw auth-profiles 中的 runtime key', async () => {
    const store = {
      defaultAccountId: 'custom-12345678',
      accounts: {
        'custom-12345678': {
          id: 'custom-12345678',
          vendorId: 'custom',
          updatedAt: '2026-04-08T00:00:00.000Z',
        },
      },
      apiKeys: {},
    };
    getProviderApiKeyMock.mockResolvedValueOnce('sk-openclaw');

    const { service } = createServiceWithStore(store);
    const result = await service.list();

    expect(getProviderApiKeyMock).toHaveBeenCalledWith('custom-12345678');
    expect(result.statuses).toEqual([
      expect.objectContaining({ id: 'custom-12345678', hasKey: true }),
    ]);
  });

  it('hasApiKey 在本地 store 无 key 时仍应识别 OpenClaw runtime key', async () => {
    const store = {
      defaultAccountId: 'custom-12345678',
      accounts: {
        'custom-12345678': {
          id: 'custom-12345678',
          vendorId: 'custom',
          updatedAt: '2026-04-08T00:00:00.000Z',
        },
      },
      apiKeys: {},
    };
    getProviderApiKeyMock.mockResolvedValueOnce('sk-openclaw');

    const { service } = createServiceWithStore(store);
    const result = await service.hasApiKey('custom-12345678');

    expect(getProviderApiKeyMock).toHaveBeenCalledWith('custom-12345678');
    expect(result).toEqual({ hasKey: true });
  });
});

describe('ProviderAccountsService create/setDefault（写入后立即同步 openclaw）', () => {
  beforeEach(() => {
    setDefaultModelMock.mockReset();
    setDefaultModelWithOverrideMock.mockReset();
    syncProviderConfigMock.mockReset();
    saveProviderKeyMock.mockReset();
  });

  it('新增第一个 custom 账号后，会同步 auth profile 与默认模型覆盖配置', async () => {
    const store = {
      defaultAccountId: null,
      accounts: {},
      apiKeys: {},
    };
    const normalizedAccount = {
      id: 'custom-12345678',
      vendorId: 'custom',
      label: '自定义',
      authMode: 'api_key',
      baseUrl: 'https://api.example.com/v1',
      apiProtocol: 'openai-completions',
      headers: { 'User-Agent': 'MatchaClaw/1.0' },
      model: 'my-model',
      contextWindow: 200000,
      maxTokens: 64000,
      fallbackModels: ['backup-model'],
      enabled: true,
      isDefault: false,
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
    };

    const { service, writeProviderStore } = createServiceWithStore(store);

    const result = await service.executeCreate({
      account: normalizedAccount,
      apiKey: 'sk-custom',
    });

    expect(result.success).toBe(true);
    expect(writeProviderStore).toHaveBeenCalledTimes(1);
    expect(saveProviderKeyMock).toHaveBeenCalledWith('custom-12345678', 'sk-custom');
    expect(syncProviderConfigMock).toHaveBeenCalledWith(
      'custom-12345678',
      expect.objectContaining({
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        headers: { 'User-Agent': 'MatchaClaw/1.0' },
        models: [
          {
            id: 'my-model',
            name: 'my-model',
            contextWindow: 200000,
            maxTokens: 64000,
          },
          {
            id: 'backup-model',
            name: 'backup-model',
          },
        ],
      }),
    );
    expect(setDefaultModelWithOverrideMock).toHaveBeenCalledWith(
      'custom-12345678',
      'my-model',
      expect.objectContaining({
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        headers: { 'User-Agent': 'MatchaClaw/1.0' },
        models: [
          {
            id: 'my-model',
            name: 'my-model',
            contextWindow: 200000,
            maxTokens: 64000,
          },
          {
            id: 'backup-model',
            name: 'backup-model',
          },
        ],
      }),
      ['custom-12345678/backup-model'],
    );
    expect(setDefaultModelMock).not.toHaveBeenCalled();
  });

  it('新增非默认 custom 账号时也会同步 runtime provider 模型配置', async () => {
    const store = {
      defaultAccountId: 'openai-main',
      accounts: {
        'openai-main': {
          id: 'openai-main',
          vendorId: 'openai',
          model: 'gpt-5.4',
          updatedAt: '2026-04-09T00:00:00.000Z',
        },
      },
      apiKeys: {
        'openai-main': 'sk-openai',
      },
    };
    const normalizedAccount = {
      id: 'custom-87654321',
      vendorId: 'custom',
      label: 'Codex',
      authMode: 'api_key',
      baseUrl: 'https://custom.example.com/v1',
      apiProtocol: 'openai-completions',
      headers: { 'x-foo': 'bar' },
      model: 'gpt-5.4',
      fallbackModels: [],
      enabled: true,
      isDefault: false,
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
    };

    const { service } = createServiceWithStore(store);

    const result = await service.executeCreate({
      account: normalizedAccount,
      apiKey: 'sk-custom',
    });

    expect(result.success).toBe(true);
    expect(syncProviderConfigMock).toHaveBeenCalledWith(
      'custom-87654321',
      expect.objectContaining({
        baseUrl: 'https://custom.example.com/v1',
        api: 'openai-completions',
        headers: { 'x-foo': 'bar' },
        models: [
          {
            id: 'gpt-5.4',
            name: 'gpt-5.4',
          },
        ],
      }),
    );
    expect(setDefaultModelMock).toHaveBeenCalledWith(
      'openai',
      'gpt-5.4',
      [],
    );
  });

  it('切换默认账号后，会重新同步默认模型到 openclaw', async () => {
    const store = {
      defaultAccountId: 'openai-main',
      accounts: {
        'openai-main': {
          id: 'openai-main',
          vendorId: 'openai',
          model: 'gpt-5.4',
          updatedAt: '2026-04-09T00:00:00.000Z',
        },
        'moonshot-main': {
          id: 'moonshot-main',
          vendorId: 'moonshot',
          model: 'kimi-k2.6',
          updatedAt: '2026-04-10T00:00:00.000Z',
        },
      },
      apiKeys: {
        'openai-main': 'sk-openai',
        'moonshot-main': 'sk-moonshot',
      },
    };
    const { service } = createServiceWithStore(store);

    const result = await service.executeSetDefault({ accountId: 'moonshot-main' });

    expect(result.success).toBe(true);
    expect(setDefaultModelMock).toHaveBeenCalledWith(
      'moonshot',
      'kimi-k2.6',
      [],
    );
  });

  it('切换到 Moonshot Global 默认账号后，会同步全局 provider key 而不是 CN key', async () => {
    const store = {
      defaultAccountId: 'moonshot-global-main',
      accounts: {
        'moonshot-global-main': {
          id: 'moonshot-global-main',
          vendorId: 'moonshot-global',
          model: 'kimi-k2.6',
          updatedAt: '2026-04-10T00:00:00.000Z',
        },
      },
      apiKeys: {
        'moonshot-global-main': 'sk-moonshot-global',
      },
    };
    const { service } = createServiceWithStore(store);

    const result = await service.executeSetDefault({ accountId: 'moonshot-global-main' });

    expect(result.success).toBe(true);
    expect(setDefaultModelMock).toHaveBeenCalledWith(
      'moonshot-global',
      'kimi-k2.6',
      [],
    );
  });
});

describe('ProviderAccountsService delete（删除后状态清理）', () => {
  beforeEach(() => {
    removeProviderMock.mockReset();
    removeProviderKeyMock.mockReset();
  });

  it('删除 custom 账号时会同时清理 runtime key 与原账号 key', async () => {
    const store = {
      defaultAccountId: 'moonshot-cn',
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
    expect(removeProviderMock).toHaveBeenCalledWith('custom-moonshot');
    expect(removeProviderMock).toHaveBeenCalledWith('moonshot-cn');
    expect(removeProviderMock).toHaveBeenCalledTimes(2);
    expect(writeProviderStore).toHaveBeenCalledTimes(1);
  });

  it('apiKeyOnly 删除只清理 provider key，不删除账号记录', async () => {
    const store = {
      defaultAccountId: 'openai-main',
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

