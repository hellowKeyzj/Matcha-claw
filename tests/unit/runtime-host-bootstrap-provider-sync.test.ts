import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  readProviderStoreLocalMock: vi.fn(),
  writeProviderStoreLocalMock: vi.fn(async () => {}),
  saveProviderKeyToOpenClawMock: vi.fn(async () => {}),
  removeProviderKeyFromOpenClawMock: vi.fn(async () => {}),
  setOpenClawDefaultModelMock: vi.fn(async () => {}),
  setOpenClawDefaultModelWithOverrideMock: vi.fn(async () => {}),
  syncProviderConfigToOpenClawMock: vi.fn(async () => {}),
  getOpenClawProviderKeyForTypeMock: vi.fn((type: string, id: string) => `${type}-${id}`),
}));

vi.mock('../../runtime-host/api/storage/provider-store', () => ({
  readProviderStoreLocal: (...args: unknown[]) => hoisted.readProviderStoreLocalMock(...args),
  writeProviderStoreLocal: (...args: unknown[]) => hoisted.writeProviderStoreLocalMock(...args),
}));

vi.mock('../../runtime-host/application/openclaw/openclaw-auth-profile-store', () => ({
  saveProviderKeyToOpenClaw: (...args: unknown[]) => hoisted.saveProviderKeyToOpenClawMock(...args),
  removeProviderKeyFromOpenClaw: (...args: unknown[]) => hoisted.removeProviderKeyFromOpenClawMock(...args),
}));

vi.mock('../../runtime-host/application/openclaw/openclaw-provider-config-service', () => ({
  sanitizeOpenClawConfig: vi.fn(async () => {}),
  setOpenClawDefaultModel: (...args: unknown[]) => hoisted.setOpenClawDefaultModelMock(...args),
  setOpenClawDefaultModelWithOverride: (...args: unknown[]) => hoisted.setOpenClawDefaultModelWithOverrideMock(...args),
  syncProviderConfigToOpenClaw: (...args: unknown[]) => hoisted.syncProviderConfigToOpenClawMock(...args),
  normalizeBrowserMode: vi.fn((value: unknown) => value ?? 'relay'),
  syncBrowserModeToOpenClaw: vi.fn(async () => {}),
  syncGatewayTokenToConfig: vi.fn(async () => {}),
  syncSessionIdleMinutesToOpenClaw: vi.fn(async () => {}),
}));

vi.mock('../../runtime-host/application/openclaw/openclaw-proxy-sync', () => ({
  syncProxyConfigToOpenClaw: vi.fn(async () => {}),
}));

vi.mock('../../runtime-host/application/channels/channel-runtime', () => ({
  listConfiguredChannelsLocal: vi.fn(async () => []),
}));

vi.mock('../../runtime-host/application/providers/provider-registry', () => ({
  getKeyableProviderTypes: vi.fn(() => []),
  getProviderEnvVar: vi.fn(() => undefined),
}));

vi.mock('../../runtime-host/application/providers/provider-runtime-rules', () => ({
  getOpenClawProviderKeyForType: (...args: unknown[]) => hoisted.getOpenClawProviderKeyForTypeMock(...args),
  getOAuthProviderApi: vi.fn(() => undefined),
  getOAuthApiKeyEnv: vi.fn(() => undefined),
  normalizeOAuthBaseUrl: vi.fn((_providerType: string, baseUrl?: string) => baseUrl),
  usesOAuthAuthHeader: vi.fn(() => false),
}));

describe('runtime-host bootstrap provider sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('默认 Ollama 账号会按 openai-completions 协议写入 runtime 覆盖配置', async () => {
    hoisted.readProviderStoreLocalMock.mockResolvedValue({
      defaultAccountId: 'ollama-main',
      accounts: {
        'ollama-main': {
          id: 'ollama-main',
          vendorId: 'ollama',
          model: 'qwen3:30b',
          baseUrl: 'http://localhost:11434/v1',
        },
      },
      apiKeys: {
        'ollama-main': 'ollama-local',
      },
    });

    const { syncProviderAuthBootstrapLocal } = await import('../../runtime-host/application/runtime-host/bootstrap');
    await syncProviderAuthBootstrapLocal();

    expect(hoisted.saveProviderKeyToOpenClawMock).toHaveBeenCalledWith('ollama-ollama-main', 'ollama-local');
    expect(hoisted.syncProviderConfigToOpenClawMock).toHaveBeenCalledWith(
      'ollama-ollama-main',
      'qwen3:30b',
      expect.objectContaining({
        baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions',
      }),
    );
    expect(hoisted.setOpenClawDefaultModelWithOverrideMock).toHaveBeenCalledWith(
      'ollama-ollama-main',
      'qwen3:30b',
      expect.objectContaining({
        baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions',
      }),
      [],
    );
    expect(hoisted.setOpenClawDefaultModelMock).not.toHaveBeenCalled();
  });

  it('custom/ollama 之外的默认账号继续走非 override 分支', async () => {
    hoisted.readProviderStoreLocalMock.mockResolvedValue({
      defaultAccountId: 'openai-main',
      accounts: {
        'openai-main': {
          id: 'openai-main',
          vendorId: 'openai',
          model: 'gpt-5.4',
        },
      },
      apiKeys: {
        'openai-main': 'sk-openai',
      },
    });

    const { syncProviderAuthBootstrapLocal } = await import('../../runtime-host/application/runtime-host/bootstrap');
    await syncProviderAuthBootstrapLocal();

    expect(hoisted.setOpenClawDefaultModelMock).toHaveBeenCalledWith(
      'openai-openai-main',
      'gpt-5.4',
      [],
    );
    expect(hoisted.setOpenClawDefaultModelWithOverrideMock).not.toHaveBeenCalled();
    expect(hoisted.syncProviderConfigToOpenClawMock).not.toHaveBeenCalled();
  });
});
