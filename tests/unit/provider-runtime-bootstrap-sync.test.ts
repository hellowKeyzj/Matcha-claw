import { beforeEach, describe, expect, it, vi } from 'vitest';

const listProviderAccountsMock = vi.fn();
const getProviderAccountMock = vi.fn();
const getProviderSecretMock = vi.fn();
const getAllProvidersMock = vi.fn();
const getApiKeyMock = vi.fn();
const getDefaultProviderMock = vi.fn();
const getProviderMock = vi.fn();

const saveProviderKeyToOpenClawMock = vi.fn();
const saveOAuthTokenToOpenClawMock = vi.fn();
const setOpenClawDefaultModelMock = vi.fn();
const setOpenClawDefaultModelWithOverrideMock = vi.fn();
const syncProviderConfigToOpenClawMock = vi.fn();
const updateAgentModelProviderMock = vi.fn();
const removeProviderFromOpenClawMock = vi.fn();

vi.mock('../../electron/services/providers/provider-store', () => ({
  listProviderAccounts: listProviderAccountsMock,
  getProviderAccount: getProviderAccountMock,
}));

vi.mock('../../electron/services/secrets/secret-store', () => ({
  getProviderSecret: getProviderSecretMock,
}));

vi.mock('../../electron/utils/secure-storage', () => ({
  getAllProviders: getAllProvidersMock,
  getApiKey: getApiKeyMock,
  getDefaultProvider: getDefaultProviderMock,
  getProvider: getProviderMock,
}));

vi.mock('../../electron/utils/openclaw-auth', () => ({
  removeProviderFromOpenClaw: removeProviderFromOpenClawMock,
  saveOAuthTokenToOpenClaw: saveOAuthTokenToOpenClawMock,
  saveProviderKeyToOpenClaw: saveProviderKeyToOpenClawMock,
  setOpenClawDefaultModel: setOpenClawDefaultModelMock,
  setOpenClawDefaultModelWithOverride: setOpenClawDefaultModelWithOverrideMock,
  syncProviderConfigToOpenClaw: syncProviderConfigToOpenClawMock,
  updateAgentModelProvider: updateAgentModelProviderMock,
}));

describe('provider runtime bootstrap sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('启动同步后会补齐默认模型配置', async () => {
    listProviderAccountsMock.mockResolvedValue([
      {
        id: 'openai-default',
        vendorId: 'openai',
        label: 'OpenAI',
        authMode: 'api_key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1',
        enabled: true,
        createdAt: '2026-03-15T00:00:00.000Z',
        updatedAt: '2026-03-15T00:00:00.000Z',
      },
    ]);
    getProviderAccountMock.mockResolvedValue({
      authMode: 'api_key',
    });
    getProviderSecretMock.mockResolvedValue({
      type: 'api_key',
      apiKey: 'sk-test',
    });
    getDefaultProviderMock.mockResolvedValue('openai-default');
    getAllProvidersMock.mockResolvedValue([]);
    getApiKeyMock.mockResolvedValue('sk-test');
    getProviderMock.mockResolvedValue({
      id: 'openai-default',
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1',
      enabled: true,
      createdAt: '2026-03-15T00:00:00.000Z',
      updatedAt: '2026-03-15T00:00:00.000Z',
    });

    const { syncAllProviderAuthToRuntime } = await import('../../electron/services/providers/provider-runtime-sync');
    await syncAllProviderAuthToRuntime();

    expect(saveProviderKeyToOpenClawMock).toHaveBeenCalledWith('openai', 'sk-test');
    expect(setOpenClawDefaultModelMock).toHaveBeenCalledWith('openai', 'openai/gpt-4.1', []);
  });
});
