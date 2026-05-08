import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  removeProviderFromOpenClawMock,
  setOpenClawDefaultModelMock,
  setOpenClawDefaultModelWithOverrideMock,
  syncProviderConfigToOpenClawMock,
  getProviderApiKeyFromOpenClawMock,
  removeProviderKeyFromOpenClawMock,
  saveProviderKeyToOpenClawMock,
} = vi.hoisted(() => ({
  removeProviderFromOpenClawMock: vi.fn(),
  setOpenClawDefaultModelMock: vi.fn(),
  setOpenClawDefaultModelWithOverrideMock: vi.fn(),
  syncProviderConfigToOpenClawMock: vi.fn(),
  getProviderApiKeyFromOpenClawMock: vi.fn(),
  removeProviderKeyFromOpenClawMock: vi.fn(),
  saveProviderKeyToOpenClawMock: vi.fn(),
}));

vi.mock('../../runtime-host/application/openclaw/openclaw-provider-config-service', () => ({
  removeProviderFromOpenClaw: removeProviderFromOpenClawMock,
  setOpenClawDefaultModel: setOpenClawDefaultModelMock,
  setOpenClawDefaultModelWithOverride: setOpenClawDefaultModelWithOverrideMock,
  syncProviderConfigToOpenClaw: syncProviderConfigToOpenClawMock,
}));

vi.mock('../../runtime-host/application/openclaw/openclaw-auth-profile-store', () => ({
  getProviderApiKeyFromOpenClaw: getProviderApiKeyFromOpenClawMock,
  removeProviderKeyFromOpenClaw: removeProviderKeyFromOpenClawMock,
  saveProviderKeyToOpenClaw: saveProviderKeyToOpenClawMock,
}));

import { ProviderAccountsService } from '../../runtime-host/application/providers/accounts';

function createServiceWithStore(store: {
  defaultAccountId: string | null;
  accounts: Record<string, any>;
  apiKeys: Record<string, string>;
}, overrides?: {
  normalizeAccount?: (input: unknown, current?: Record<string, any> | null) => any;
  normalizeFallbackAccount?: (accounts: any[], deletedId: string) => string | null;
}) {
  const writeProviderStore = vi.fn(async () => {});
  const service = new ProviderAccountsService({
    readProviderStore: async () => store,
    writeProviderStore,
    sortAccounts: (accounts, defaultAccountId) => {
      return [...accounts].sort((a, b) => {
        if (a.id === defaultAccountId) return -1;
        if (b.id === defaultAccountId) return 1;
        const byUpdatedAt = String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
        if (byUpdatedAt !== 0) return byUpdatedAt;
        return String(a.id).localeCompare(String(b.id));
      });
    },
    accountToStatus: (account, apiKey) => ({ id: account.id, hasKey: Boolean(apiKey) }),
    normalizeAccount: overrides?.normalizeAccount || (() => null),
    normalizeFallbackAccount: overrides?.normalizeFallbackAccount || (() => null),
    validateApiKey: async () => ({}),
    requestParentShellAction: async () => ({ status: 200, data: {} }),
    mapParentTransportResponse: () => ({ status: 200, data: {} }),
    providerVendorDefinitions: [],
    completeBrowserOAuth: async () => ({}),
    completeDeviceOAuth: async () => ({}),
  });
  return { service, writeProviderStore };
}

describe('ProviderAccountsService list（provider-store 单一显示源）', () => {
  beforeEach(() => {
    removeProviderFromOpenClawMock.mockReset();
    setOpenClawDefaultModelMock.mockReset();
    setOpenClawDefaultModelWithOverrideMock.mockReset();
    syncProviderConfigToOpenClawMock.mockReset();
    getProviderApiKeyFromOpenClawMock.mockReset();
    removeProviderKeyFromOpenClawMock.mockReset();
    saveProviderKeyToOpenClawMock.mockReset();
    getProviderApiKeyFromOpenClawMock.mockResolvedValue(null);
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
    getProviderApiKeyFromOpenClawMock.mockResolvedValueOnce('sk-openclaw');

    const { service } = createServiceWithStore(store);
    const result = await service.list();

    expect(getProviderApiKeyFromOpenClawMock).toHaveBeenCalledWith('custom-12345678');
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
    getProviderApiKeyFromOpenClawMock.mockResolvedValueOnce('sk-openclaw');

    const { service } = createServiceWithStore(store);
    const result = await service.hasApiKey('custom-12345678');

    expect(getProviderApiKeyFromOpenClawMock).toHaveBeenCalledWith('custom-12345678');
    expect(result).toEqual({ hasKey: true });
  });
});

describe('ProviderAccountsService create/setDefault（写入后立即同步 openclaw）', () => {
  beforeEach(() => {
    setOpenClawDefaultModelMock.mockReset();
    setOpenClawDefaultModelWithOverrideMock.mockReset();
    syncProviderConfigToOpenClawMock.mockReset();
    saveProviderKeyToOpenClawMock.mockReset();
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

    const { service, writeProviderStore } = createServiceWithStore(store, {
      normalizeAccount: () => normalizedAccount,
    });

    const result = await service.create({
      account: normalizedAccount,
      apiKey: 'sk-custom',
    });

    expect(result.status).toBe(200);
    expect(writeProviderStore).toHaveBeenCalledTimes(1);
    expect(saveProviderKeyToOpenClawMock).toHaveBeenCalledWith('custom-12345678', 'sk-custom');
    expect(syncProviderConfigToOpenClawMock).toHaveBeenCalledWith(
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
    expect(setOpenClawDefaultModelWithOverrideMock).toHaveBeenCalledWith(
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
    expect(setOpenClawDefaultModelMock).not.toHaveBeenCalled();
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

    const { service } = createServiceWithStore(store, {
      normalizeAccount: () => normalizedAccount,
    });

    const result = await service.create({
      account: normalizedAccount,
      apiKey: 'sk-custom',
    });

    expect(result.status).toBe(200);
    expect(syncProviderConfigToOpenClawMock).toHaveBeenCalledWith(
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
    expect(setOpenClawDefaultModelMock).toHaveBeenCalledWith(
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

    const result = await service.setDefault({ accountId: 'moonshot-main' });

    expect(result.status).toBe(200);
    expect(setOpenClawDefaultModelMock).toHaveBeenCalledWith(
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

    const result = await service.setDefault({ accountId: 'moonshot-global-main' });

    expect(result.status).toBe(200);
    expect(setOpenClawDefaultModelMock).toHaveBeenCalledWith(
      'moonshot-global',
      'kimi-k2.6',
      [],
    );
  });
});

describe('ProviderAccountsService delete（删除后状态清理）', () => {
  beforeEach(() => {
    removeProviderFromOpenClawMock.mockReset();
    removeProviderKeyFromOpenClawMock.mockReset();
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

    const result = await service.delete('moonshot-cn', false);

    expect(result.status).toBe(200);
    expect(removeProviderFromOpenClawMock).toHaveBeenCalledWith('custom-moonshot');
    expect(removeProviderFromOpenClawMock).toHaveBeenCalledWith('moonshot-cn');
    expect(removeProviderFromOpenClawMock).toHaveBeenCalledTimes(2);
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

    const result = await service.delete('openai-main', true);

    expect(result.status).toBe(200);
    expect(removeProviderKeyFromOpenClawMock).toHaveBeenCalledWith('openai');
    expect(removeProviderKeyFromOpenClawMock).toHaveBeenCalledWith('openai-main');
    expect(removeProviderFromOpenClawMock).not.toHaveBeenCalled();
    expect(store.accounts['openai-main']).toBeDefined();
    expect(store.apiKeys['openai-main']).toBeUndefined();
  });
});
