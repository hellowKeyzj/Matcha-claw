import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  readProviderStoreLocalMock: vi.fn(),
  writeProviderStoreLocalMock: vi.fn(async () => {}),
  saveProviderKeyToOpenClawMock: vi.fn(async () => {}),
  removeProviderKeyFromOpenClawMock: vi.fn(async () => {}),
  setOpenClawDefaultModelMock: vi.fn(async () => {}),
  setOpenClawDefaultModelWithOverrideMock: vi.fn(async () => {}),
  syncProviderConfigToOpenClawMock: vi.fn(async () => {}),
  sanitizeOpenClawConfigMock: vi.fn(async () => {}),
  syncBrowserModeToOpenClawMock: vi.fn(async () => {}),
  syncGatewayTokenToConfigMock: vi.fn(async () => {}),
  syncSessionIdleMinutesToOpenClawMock: vi.fn(async () => {}),
  syncProxyConfigToOpenClawMock: vi.fn(async () => {}),
  listConfiguredChannelsLocalMock: vi.fn(async () => []),
  getAllSettingsLocalMock: vi.fn(async () => ({ browserMode: 'relay', gatewayToken: '' })),
  setSettingValueLocalMock: vi.fn(async () => {}),
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
  sanitizeOpenClawConfig: (...args: unknown[]) => hoisted.sanitizeOpenClawConfigMock(...args),
  setOpenClawDefaultModel: (...args: unknown[]) => hoisted.setOpenClawDefaultModelMock(...args),
  setOpenClawDefaultModelWithOverride: (...args: unknown[]) => hoisted.setOpenClawDefaultModelWithOverrideMock(...args),
  syncProviderConfigToOpenClaw: (...args: unknown[]) => hoisted.syncProviderConfigToOpenClawMock(...args),
  normalizeBrowserMode: vi.fn((value: unknown) => value ?? 'relay'),
  syncBrowserModeToOpenClaw: (...args: unknown[]) => hoisted.syncBrowserModeToOpenClawMock(...args),
  syncGatewayTokenToConfig: (...args: unknown[]) => hoisted.syncGatewayTokenToConfigMock(...args),
  syncSessionIdleMinutesToOpenClaw: (...args: unknown[]) => hoisted.syncSessionIdleMinutesToOpenClawMock(...args),
}));

vi.mock('../../runtime-host/application/openclaw/openclaw-proxy-sync', () => ({
  syncProxyConfigToOpenClaw: (...args: unknown[]) => hoisted.syncProxyConfigToOpenClawMock(...args),
}));

vi.mock('../../runtime-host/application/channels/channel-runtime', () => ({
  listConfiguredChannelsLocal: (...args: unknown[]) => hoisted.listConfiguredChannelsLocalMock(...args),
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

vi.mock('../../runtime-host/application/settings/store', () => ({
  getAllSettingsLocal: (...args: unknown[]) => hoisted.getAllSettingsLocalMock(...args),
  setSettingValueLocal: (...args: unknown[]) => hoisted.setSettingValueLocalMock(...args),
}));

describe('runtime-host bootstrap provider sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getAllSettingsLocalMock.mockResolvedValue({ browserMode: 'relay', gatewayToken: '' });
    hoisted.listConfiguredChannelsLocalMock.mockResolvedValue([]);
  });

  it('syncGatewayConfigLocal 会同时同步 runtime-host settings 与 openclaw.json 的 gateway token', async () => {
    hoisted.listConfiguredChannelsLocalMock.mockResolvedValue(['openclaw-weixin']);

    const { syncGatewayConfigLocal } = await import('../../runtime-host/application/runtime-host/bootstrap');
    const result = await syncGatewayConfigLocal({
      gatewayToken: 'matchaclaw-token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    });

    expect(hoisted.syncProxyConfigToOpenClawMock).toHaveBeenCalledWith({
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    }, {
      preserveExistingWhenDisabled: true,
    });
    expect(hoisted.setSettingValueLocalMock).toHaveBeenCalledWith('gatewayToken', 'matchaclaw-token-1');
    expect(hoisted.syncGatewayTokenToConfigMock).toHaveBeenCalledWith('matchaclaw-token-1');
    expect(hoisted.sanitizeOpenClawConfigMock).toHaveBeenCalledTimes(1);
    expect(hoisted.syncBrowserModeToOpenClawMock).toHaveBeenCalledWith('relay');
    expect(hoisted.syncSessionIdleMinutesToOpenClawMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      configuredChannels: ['openclaw-weixin'],
    });
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
