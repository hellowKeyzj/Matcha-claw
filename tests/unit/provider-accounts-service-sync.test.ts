import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getOpenClawProvidersSnapshotMock,
  removeProviderFromOpenClawMock,
  setOpenClawDefaultModelMock,
  setOpenClawDefaultModelWithOverrideMock,
  removeProviderKeyFromOpenClawMock,
  saveProviderKeyToOpenClawMock,
} = vi.hoisted(() => ({
  getOpenClawProvidersSnapshotMock: vi.fn(),
  removeProviderFromOpenClawMock: vi.fn(),
  setOpenClawDefaultModelMock: vi.fn(),
  setOpenClawDefaultModelWithOverrideMock: vi.fn(),
  removeProviderKeyFromOpenClawMock: vi.fn(),
  saveProviderKeyToOpenClawMock: vi.fn(),
}));

vi.mock('../../runtime-host/application/openclaw/openclaw-provider-config-service', () => ({
  getOpenClawProvidersSnapshot: getOpenClawProvidersSnapshotMock,
  removeProviderFromOpenClaw: removeProviderFromOpenClawMock,
  setOpenClawDefaultModel: setOpenClawDefaultModelMock,
  setOpenClawDefaultModelWithOverride: setOpenClawDefaultModelWithOverrideMock,
}));

vi.mock('../../runtime-host/application/openclaw/openclaw-auth-profile-store', () => ({
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

describe('ProviderAccountsService list（openclaw.json 单一显示源）', () => {
  beforeEach(() => {
    getOpenClawProvidersSnapshotMock.mockReset();
    removeProviderFromOpenClawMock.mockReset();
    setOpenClawDefaultModelMock.mockReset();
    setOpenClawDefaultModelWithOverrideMock.mockReset();
    removeProviderKeyFromOpenClawMock.mockReset();
    saveProviderKeyToOpenClawMock.mockReset();
    getOpenClawProvidersSnapshotMock.mockResolvedValue({
      providers: {},
      defaultModel: undefined,
      activeProviders: new Set<string>(),
    });
  });

  it('activeProviders 为空时返回空列表（不再把本地 store 当显示源）', async () => {
    getOpenClawProvidersSnapshotMock.mockResolvedValue({
      providers: {},
      defaultModel: undefined,
      activeProviders: new Set<string>(),
    });

    const store = {
      defaultAccountId: 'openai-main',
      accounts: {
        'openai-main': { id: 'openai-main', vendorId: 'openai', updatedAt: '2026-04-08T00:00:00.000Z' },
        'custom-1': { id: 'custom-1', vendorId: 'custom', updatedAt: '2026-04-08T00:00:00.000Z' },
      },
      apiKeys: {
        'openai-main': 'sk-openai',
        'custom-1': 'sk-custom',
      },
    };

    const { service, writeProviderStore } = createServiceWithStore(store);
    const result = await service.list();

    expect(result.accounts).toEqual([]);
    expect(result.statuses).toEqual([]);
    expect(result.defaultAccountId).toBeNull();
    expect(writeProviderStore).not.toHaveBeenCalled();
  });

  it('只展示 activeProviders 内的账号，非激活账号不再显示', async () => {
    getOpenClawProvidersSnapshotMock.mockResolvedValue({
      providers: {
        openai: { baseUrl: 'https://api.openai.com/v1' },
      },
      defaultModel: 'openai/gpt-5.2',
      activeProviders: new Set<string>(['openai']),
    });

    const store = {
      defaultAccountId: 'openai-main',
      accounts: {
        'openai-main': { id: 'openai-main', vendorId: 'openai', updatedAt: '2026-04-08T00:00:00.000Z' },
        'custom-1': { id: 'custom-1', vendorId: 'custom', updatedAt: '2026-04-08T00:00:00.000Z' },
      },
      apiKeys: {
        'openai-main': 'sk-openai',
        'custom-1': 'sk-custom',
      },
    };

    const { service, writeProviderStore } = createServiceWithStore(store);
    const result = await service.list();

    expect(result.accounts.map((item) => item.id)).toEqual(['openai-main']);
    expect(result.statuses.map((item) => item.id)).toEqual(['openai-main']);
    expect(writeProviderStore).toHaveBeenCalledTimes(1);
    expect(store.defaultAccountId).toBe('openai-main');
  });

  it('store 无匹配时会从 openclaw.json 回填 provider（含 headers）', async () => {
    getOpenClawProvidersSnapshotMock.mockResolvedValue({
      providers: {
        'custom-gateway': {
          baseUrl: 'https://gateway.example.com/v1',
          headers: { 'User-Agent': 'MatchaClaw/1.0' },
        },
      },
      defaultModel: 'custom-gateway/gpt-5.4',
      activeProviders: new Set<string>(['custom-gateway']),
    });

    const store = {
      defaultAccountId: null,
      accounts: {},
      apiKeys: {},
    };

    const { service, writeProviderStore } = createServiceWithStore(store);
    const result = await service.list();

    expect(writeProviderStore).toHaveBeenCalledTimes(1);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({
      id: 'custom-gateway',
      vendorId: 'custom',
      baseUrl: 'https://gateway.example.com/v1',
      headers: { 'User-Agent': 'MatchaClaw/1.0' },
      model: 'custom-gateway/gpt-5.4',
      isDefault: true,
    });
    expect(result.defaultAccountId).toBe('custom-gateway');
  });

  it('minimax 发生同 key 重复时优先保留 CN 别名账号并清理重复项', async () => {
    getOpenClawProvidersSnapshotMock.mockResolvedValue({
      providers: {
        'minimax-portal': { baseUrl: 'https://api.minimaxi.com/anthropic' },
      },
      defaultModel: undefined,
      activeProviders: new Set<string>(['minimax-portal']),
    });

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
});

describe('ProviderAccountsService create/setDefault（写入后立即同步 openclaw）', () => {
  beforeEach(() => {
    setOpenClawDefaultModelMock.mockReset();
    setOpenClawDefaultModelWithOverrideMock.mockReset();
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
    expect(setOpenClawDefaultModelWithOverrideMock).toHaveBeenCalledWith(
      'custom-12345678',
      'my-model',
      expect.objectContaining({
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        headers: { 'User-Agent': 'MatchaClaw/1.0' },
      }),
      ['custom-12345678/backup-model'],
    );
    expect(setOpenClawDefaultModelMock).not.toHaveBeenCalled();
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
          model: 'kimi-k2.5',
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
      'kimi-k2.5',
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
