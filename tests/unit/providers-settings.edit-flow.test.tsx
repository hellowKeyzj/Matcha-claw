import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { ProvidersSettings } from '@/components/settings/ProvidersSettings';
import type { ProviderModel } from '@/lib/provider-model-catalog';

const hoisted = vi.hoisted(() => {
  const defaultProviderSnapshot = {
    statuses: [
      {
        id: 'custom-1',
        type: 'custom',
        name: 'Custom',
        hasKey: true,
        keyMasked: 'sk-****-key',
        enabled: true,
        createdAt: '2026-03-15T00:00:00.000Z',
        updatedAt: '2026-03-15T00:00:00.000Z',
      },
    ],
    credentials: [
      {
        id: 'custom-1',
        vendorId: 'custom',
        label: '自定义',
        authMode: 'api_key',
        enabled: true,
        createdAt: '2026-03-15T00:00:00.000Z',
        updatedAt: '2026-03-15T00:00:00.000Z',
      },
    ],
    vendors: [
      {
        id: 'custom',
        name: 'Custom',
        icon: '⚙️',
        placeholder: 'API key...',
        requiresApiKey: true,
        showBaseUrl: true,
        category: 'custom',
        supportedAuthModes: ['api_key'],
        defaultAuthMode: 'api_key',
        supportsMultipleAccounts: true,
        modelCapabilities: ['chat', 'imageUnderstand'],
      },
    ],
  };
  return { defaultProviderSnapshot };
});

const providerStoreState = vi.hoisted(() => ({
  providerSnapshot: structuredClone(hoisted.defaultProviderSnapshot),
  snapshotReady: true,
  initialLoading: false,
  refreshing: false,
  mutating: false,
  mutatingActionsByAccountId: {},
  error: null,
  warning: null,
  refreshProviderSnapshot: vi.fn().mockResolvedValue(undefined),
  createAccount: vi.fn().mockResolvedValue(undefined),
  removeAccount: vi.fn().mockResolvedValue(undefined),
  updateAccount: vi.fn().mockResolvedValue(undefined),
}));

const catalogState = vi.hoisted(() => ({
  models: [] as ProviderModel[],
  ready: true,
  loading: false,
  saving: false,
  error: null as string | null,
  refresh: vi.fn().mockResolvedValue(undefined),
  replaceAccountModels: vi.fn().mockResolvedValue(undefined),
}));

const settingsState = vi.hoisted(() => ({
  devModeUnlocked: false,
}));

const gatewayState = vi.hoisted(() => ({
  status: {
    processState: 'running',
    transportState: 'connected',
    gatewayReady: true,
    healthSummary: 'healthy',
  },
}));

const providerModelCatalogMock = vi.hoisted(() => ({
  discoverProviderModels: vi.fn(),
}));

vi.mock('@/lib/provider-model-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/provider-model-catalog')>();
  return {
    ...actual,
    discoverProviderModels: providerModelCatalogMock.discoverProviderModels,
  };
});

vi.mock('@/stores/providers', () => ({
  useProviderStore: () => providerStoreState,
}));

vi.mock('@/stores/provider-model-catalog', () => ({
  useProviderModelCatalogStore: (selector: (state: typeof catalogState) => unknown) => selector(catalogState),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: ((state: typeof settingsState) => unknown) | undefined) => (
    selector ? selector(settingsState) : settingsState
  ),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('providers settings edit flow', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
    vi.clearAllMocks();
    providerStoreState.providerSnapshot = structuredClone(hoisted.defaultProviderSnapshot);
    providerStoreState.refreshProviderSnapshot.mockResolvedValue(undefined);
    providerStoreState.createAccount.mockResolvedValue(undefined);
    providerStoreState.removeAccount.mockResolvedValue(undefined);
    providerStoreState.updateAccount.mockResolvedValue(undefined);
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    catalogState.models = [];
    catalogState.ready = true;
    catalogState.loading = false;
    catalogState.saving = false;
    catalogState.error = null;
    catalogState.refresh.mockResolvedValue(undefined);
    catalogState.replaceAccountModels.mockResolvedValue(undefined);
    providerModelCatalogMock.discoverProviderModels.mockResolvedValue({ models: [] });
    gatewayState.status = {
      processState: 'running',
      port: 31415,
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
      diagnostics: { consecutiveHeartbeatMisses: 0, consecutiveRpcFailures: 0 },
      updatedAt: Date.now(),
    };
  });

  function expandProviderCard(label: string) {
    const trigger = screen.getByRole('button', { name: new RegExp(label) });
    fireEvent.click(trigger);
  }

  it('编辑态应提供清晰的取消入口', () => {
    render(<ProvidersSettings />);

    expandProviderCard('Custom');
    fireEvent.click(screen.getByTitle('Edit API key'));

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('provider 卡片默认收起', () => {
    render(<ProvidersSettings />);

    expect(screen.queryByTitle('Edit API key')).toBeNull();
    expect(screen.queryByText('Model catalog')).toBeNull();
  });

  it('Gateway 未就绪时仍可打开新增 provider', () => {
    gatewayState.status = {
      processState: 'stopped',
      port: 0,
      gatewayReady: false,
      healthSummary: 'unresponsive',
      transportState: 'disconnected',
      portReachable: false,
      diagnostics: { consecutiveHeartbeatMisses: 0, consecutiveRpcFailures: 0 },
      updatedAt: Date.now(),
    };

    render(<ProvidersSettings />);

    const addButton = screen.getByRole('button', { name: 'Add Provider' });
    expect(addButton).toBeEnabled();
    fireEvent.click(addButton);

    expect(screen.getByRole('dialog', { name: 'Add AI Provider' })).toBeInTheDocument();
  });

  it('按 Escape 键应退出编辑态', () => {
    render(<ProvidersSettings />);

    expandProviderCard('Custom');
    fireEvent.click(screen.getByTitle('Edit API key'));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('编辑态保留私密 API key 和运行时配置，不显示旧模型字段', () => {
    render(<ProvidersSettings />);

    expandProviderCard('Custom');
    fireEvent.click(screen.getByTitle('Edit API key'));

    expect(screen.getByTestId('provider-edit-key-input-custom-1')).toBeInTheDocument();
    expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Protocol')).toBeInTheDocument();
    expect(screen.queryByLabelText('User-Agent')).toBeNull();
    expect(screen.queryByLabelText('Model ID')).toBeNull();
    expect(screen.queryByLabelText('Context Window')).toBeNull();
    expect(screen.queryByLabelText('Max Tokens')).toBeNull();
    expect(screen.queryByLabelText('Fallback Model IDs')).toBeNull();
  });

  it('在 provider 卡片内管理模型清单', async () => {
    catalogState.models = [{
      accountId: 'custom-1',
      modelId: 'gpt-5.4',
      capabilities: ['chat'],
      contextWindow: 200000,
    }];

    render(<ProvidersSettings />);

    expandProviderCard('Custom');
    expect(screen.getByText('Model catalog')).toBeInTheDocument();
    expect(screen.getByDisplayValue('gpt-5.4')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('200000')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByDisplayValue('200000')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    const textboxes = screen.getAllByRole('textbox');
    const newModelInput = textboxes.find((input) => (
      input instanceof HTMLInputElement
      && input.placeholder === 'gpt-5.5'
      && input.value === ''
    ));
    expect(newModelInput).toBeDefined();
    fireEvent.change(newModelInput!, { target: { value: 'gpt-5.5' } });
    expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByText('1 unsaved change')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    const resetTextboxes = screen.getAllByRole('textbox');
    const resetModelInput = resetTextboxes.find((input) => (
      input instanceof HTMLInputElement
      && input.placeholder === 'gpt-5.5'
      && input.value === ''
    ));
    expect(resetModelInput).toBeDefined();
    fireEvent.change(resetModelInput!, { target: { value: 'gpt-5.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(catalogState.replaceAccountModels).toHaveBeenCalledWith('custom-1', [
        { modelId: 'gpt-5.4', capabilities: ['chat'], contextWindow: 200000 },
        { modelId: 'gpt-5.5', capabilities: ['chat'] },
      ]);
    });
  });

  it('模型限制输入框使用 OpenClaw 内部默认值作为 placeholder', () => {
    render(<ProvidersSettings />);

    expandProviderCard('Custom');
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));

    expect(screen.getAllByLabelText('Context window').at(-1)).toHaveAttribute('placeholder', '128000');
    expect(screen.getAllByLabelText('Max output tokens').at(-1)).toHaveAttribute('placeholder', '8192');
  });

  it('discover 只导入本地草稿且保存前不持久化，并跳过重复模型', async () => {
    catalogState.models = [{
      accountId: 'custom-1',
      modelId: 'gpt-5.4',
      capabilities: ['chat'],
    }];
    providerModelCatalogMock.discoverProviderModels.mockResolvedValue({
      models: [
        { modelId: 'gpt-5.4', capabilities: ['chat'] },
        { modelId: 'gpt-5.5', capabilities: ['chat'], contextWindow: 128000 },
      ],
    });

    render(<ProvidersSettings />);

    expandProviderCard('Custom');
    fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));

    await waitFor(() => {
      expect(providerModelCatalogMock.discoverProviderModels).toHaveBeenCalledWith('custom-1', expect.any(AbortSignal));
      expect(screen.getByText('Models available to import')).toBeInTheDocument();
    });
    expect(catalogState.replaceAccountModels).not.toHaveBeenCalled();
    expect(screen.getByText('Already in catalog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Models available to import/ }));
    expect(screen.queryByText('Already in catalog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import selected' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Models available to import/ }));
    expect(screen.getByText('Already in catalog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Import selected' }));
    expect(screen.getByDisplayValue('gpt-5.5')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import selected' })).toBeNull();
    expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
    expect(catalogState.replaceAccountModels).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(catalogState.replaceAccountModels).toHaveBeenCalledWith('custom-1', [
        { modelId: 'gpt-5.4', capabilities: ['chat'] },
        { modelId: 'gpt-5.5', capabilities: ['chat'], contextWindow: 128000 },
      ]);
    });
  });

  it('Ark provider 卡片保留 Code Plan 快捷添加', async () => {
    providerStoreState.providerSnapshot.credentials = [
      {
        id: 'ark-main',
        vendorId: 'ark',
        label: 'Ark',
        authMode: 'api_key',
        enabled: true,
        createdAt: '2026-05-19T00:00:00.000Z',
        updatedAt: '2026-05-19T00:00:00.000Z',
      },
    ];
    providerStoreState.providerSnapshot.statuses = [];
    providerStoreState.providerSnapshot.vendors = [{
      id: 'ark',
      name: 'Ark',
      icon: 'A',
      placeholder: 'API key...',
      requiresApiKey: true,
      showBaseUrl: false,
      category: 'api',
      supportedAuthModes: ['api_key'],
      defaultAuthMode: 'api_key',
      supportsMultipleAccounts: true,
      modelCapabilities: ['chat', 'imageUnderstand'],
      codePlan: { modelId: 'ark-code-latest' },
    }];

    render(<ProvidersSettings />);

    expandProviderCard('Ark');
    fireEvent.click(screen.getByRole('button', { name: 'Add ark-code-latest' }));

    await waitFor(() => {
      expect(catalogState.replaceAccountModels).toHaveBeenCalledWith('ark-main', [
        { modelId: 'ark-code-latest', capabilities: ['chat'] },
      ]);
    });
  });

  it('自定义 provider 可登记聊天和图像理解，但不显示生成类媒体能力', () => {
    render(<ProvidersSettings />);

    expandProviderCard('Custom');
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));

    expect(screen.getAllByRole('button', { name: 'Chat' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Image' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Image generation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Video generation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Music generation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'TTS' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Transcription' })).toBeNull();
  });

  it('新增自定义 provider 时只提交账号事实、运行时配置和私密 API key', async () => {
    render(<ProvidersSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Provider' }));
    const dialog = screen.getByRole('dialog', { name: 'Add AI Provider' });
    fireEvent.click(within(dialog).getAllByText('Custom')[0]!);

    expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Protocol')).toBeInTheDocument();
    expect(screen.queryByLabelText('User-Agent')).toBeNull();
    expect(screen.queryByLabelText('Model ID')).toBeNull();
    expect(screen.queryByLabelText('Context Window')).toBeNull();
    expect(screen.queryByLabelText('Max Tokens')).toBeNull();

    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-custom' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add AI Provider' })).getByRole('button', { name: 'Add Provider' }));

    await waitFor(() => {
      expect(providerStoreState.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.any(String),
          vendorId: 'custom',
          label: 'Custom',
          authMode: 'api_key',
          enabled: true,
        }),
        'sk-custom',
      );
    });
  });

  it('Z.AI CN 已存在时隐藏 Z.AI Global 添加卡片', () => {
    providerStoreState.providerSnapshot.credentials = [{
      id: 'zai',
      vendorId: 'zai',
      label: 'Z.AI (CN)',
      authMode: 'api_key',
      enabled: true,
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    }];
    providerStoreState.providerSnapshot.statuses = [];
    providerStoreState.providerSnapshot.vendors = [
      {
        id: 'zai',
        name: 'Z.AI (CN)',
        icon: 'Z',
        placeholder: 'zai-...',
        model: 'glm-5.2',
        requiresApiKey: true,
        defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        showBaseUrl: true,
        codePlan: { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', modelId: 'glm-5.2' },
        runtimeProviderKey: 'zai',
        category: 'official',
        envVar: 'ZAI_API_KEY',
        supportedAuthModes: ['api_key'],
        defaultAuthMode: 'api_key',
        supportsMultipleAccounts: false,
        modelCapabilities: ['chat', 'imageUnderstand'],
      },
      {
        id: 'zai-global',
        name: 'Z.AI (Global)',
        icon: 'Z',
        placeholder: 'zai-...',
        model: 'glm-5.2',
        requiresApiKey: true,
        defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
        showBaseUrl: true,
        codePlan: { baseUrl: 'https://api.z.ai/api/coding/paas/v4', modelId: 'glm-5.2' },
        runtimeProviderKey: 'zai',
        category: 'official',
        envVar: 'ZAI_API_KEY',
        supportedAuthModes: ['api_key'],
        defaultAuthMode: 'api_key',
        supportsMultipleAccounts: false,
        modelCapabilities: ['chat', 'imageUnderstand'],
      },
    ];

    render(<ProvidersSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Provider' }));
    const dialog = screen.getByRole('dialog', { name: 'Add AI Provider' });

    expect(within(dialog).queryByText('Z.AI (CN)')).toBeNull();
    expect(within(dialog).queryByText('Z.AI (Global)')).toBeNull();
  });

  it('Z.AI CN/Global 在保存前再次阻断互斥冲突', async () => {
    providerStoreState.providerSnapshot.credentials = [];
    providerStoreState.providerSnapshot.statuses = [];
    providerStoreState.providerSnapshot.vendors = [
      {
        id: 'zai',
        name: 'Z.AI (CN)',
        icon: 'Z',
        placeholder: 'zai-...',
        model: 'glm-5.2',
        requiresApiKey: true,
        defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        showBaseUrl: true,
        codePlan: { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', modelId: 'glm-5.2' },
        runtimeProviderKey: 'zai',
        category: 'official',
        envVar: 'ZAI_API_KEY',
        supportedAuthModes: ['api_key'],
        defaultAuthMode: 'api_key',
        supportsMultipleAccounts: false,
        modelCapabilities: ['chat', 'imageUnderstand'],
      },
      {
        id: 'zai-global',
        name: 'Z.AI (Global)',
        icon: 'Z',
        placeholder: 'zai-...',
        model: 'glm-5.2',
        requiresApiKey: true,
        defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
        showBaseUrl: true,
        codePlan: { baseUrl: 'https://api.z.ai/api/coding/paas/v4', modelId: 'glm-5.2' },
        runtimeProviderKey: 'zai',
        category: 'official',
        envVar: 'ZAI_API_KEY',
        supportedAuthModes: ['api_key'],
        defaultAuthMode: 'api_key',
        supportsMultipleAccounts: false,
        modelCapabilities: ['chat', 'imageUnderstand'],
      },
    ];
    const view = render(<ProvidersSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Provider' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add AI Provider' })).getByText('Z.AI (Global)'));
    providerStoreState.providerSnapshot.credentials = [{
      id: 'zai',
      vendorId: 'zai',
      label: 'Z.AI (CN)',
      authMode: 'api_key',
      enabled: true,
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    }];
    view.rerender(<ProvidersSettings />);
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'zai-secret' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add AI Provider' })).getByRole('button', { name: 'Add Provider' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Cannot add both Z.AI (CN) and Z.AI (Global) providers.');
      expect(providerStoreState.createAccount).not.toHaveBeenCalled();
    });
  });

  it('新增 Z.AI Global 开启 Code Plan 时保存 coding endpoint', async () => {
    providerStoreState.providerSnapshot.credentials = [];
    providerStoreState.providerSnapshot.statuses = [];
    providerStoreState.providerSnapshot.vendors = [{
      id: 'zai-global',
      name: 'Z.AI (Global)',
      icon: 'Z',
      placeholder: 'zai-...',
      model: 'glm-5.2',
      requiresApiKey: true,
      defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
      showBaseUrl: true,
      codePlan: { baseUrl: 'https://api.z.ai/api/coding/paas/v4', modelId: 'glm-5.2' },
      runtimeProviderKey: 'zai',
      category: 'official',
      envVar: 'ZAI_API_KEY',
      supportedAuthModes: ['api_key'],
      defaultAuthMode: 'api_key',
      supportsMultipleAccounts: false,
      modelCapabilities: ['chat', 'imageUnderstand'],
    }];

    render(<ProvidersSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Provider' }));
    const dialog = screen.getByRole('dialog', { name: 'Add AI Provider' });
    fireEvent.click(within(dialog).getByText('Z.AI (Global)'));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'zai-secret' } });
    fireEvent.click(screen.getByLabelText('Code Plan endpoint'));
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.z.ai/api/coding/paas/v4');
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add AI Provider' })).getByRole('button', { name: 'Add Provider' }));

    await waitFor(() => {
      expect(providerStoreState.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'zai',
          vendorId: 'zai-global',
          label: 'Z.AI (Global)',
          baseUrl: 'https://api.z.ai/api/coding/paas/v4',
          authMode: 'api_key',
        }),
        'zai-secret',
      );
    });
  });

  it('新增 OpenAI provider 时显示 OAuth 与 API Key 切换', async () => {
    providerStoreState.providerSnapshot.credentials = [];
    providerStoreState.providerSnapshot.statuses = [];
    providerStoreState.providerSnapshot.vendors = [{
      id: 'openai',
      name: 'OpenAI',
      icon: '💚',
      placeholder: 'sk-proj-...',
      requiresApiKey: true,
      isOAuth: true,
      supportsApiKey: true,
      category: 'official',
      supportedAuthModes: ['oauth_browser', 'api_key'],
      defaultAuthMode: 'oauth_browser',
      supportsMultipleAccounts: true,
    }];

    render(<ProvidersSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Provider' }));
    const dialog = screen.getByRole('dialog', { name: 'Add AI Provider' });
    fireEvent.click(within(dialog).getByText('OpenAI'));

    expect(screen.getByRole('button', { name: 'OAuth Login' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'API Key' })).toBeInTheDocument();
    expect(screen.queryByLabelText('API Key')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'API Key' }));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-openai' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add AI Provider' })).getByRole('button', { name: 'Add Provider' }));

    await waitFor(() => {
      expect(providerStoreState.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          vendorId: 'openai',
          authMode: 'api_key',
        }),
        'sk-openai',
      );
    });
  });

  it('OAuth provider 启动时提交聊天账号 kind', async () => {
    providerStoreState.providerSnapshot.credentials = [];
    providerStoreState.providerSnapshot.statuses = [];
    providerStoreState.providerSnapshot.vendors = [{
      id: 'openai',
      name: 'OpenAI',
      icon: '💚',
      placeholder: 'sk-proj-...',
      requiresApiKey: true,
      isOAuth: true,
      supportsApiKey: true,
      category: 'official',
      supportedAuthModes: ['oauth_browser', 'api_key'],
      defaultAuthMode: 'oauth_browser',
      supportsMultipleAccounts: true,
    }];
    vi.mocked(window.electron.ipcRenderer.invoke).mockResolvedValue({
      flowId: 'flow-1',
      status: 'started',
    });

    render(<ProvidersSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Provider' }));
    const dialog = screen.getByRole('dialog', { name: 'Add AI Provider' });
    fireEvent.click(within(dialog).getByText('OpenAI'));
    fireEvent.click(screen.getByRole('button', { name: 'Login with Browser' }));

    await waitFor(() => {
      expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledWith(
        'providers:startOAuth',
        expect.objectContaining({
          provider: 'openai',
          account: {
            id: expect.any(String),
            provider: 'openai',
            label: 'OpenAI',
            enabled: true,
            kind: 'chat',
            authMode: 'oauthBrowser',
            revision: 1,
          },
        }),
      );
    });
  });

  it('编辑 Z.AI CN 开启 Code Plan 时更新 baseUrl', async () => {
    providerStoreState.providerSnapshot.credentials = [{
      id: 'zai',
      vendorId: 'zai',
      label: 'Z.AI (CN)',
      authMode: 'api_key',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      enabled: true,
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    }];
    providerStoreState.providerSnapshot.statuses = [{
      id: 'zai',
      type: 'zai',
      name: 'Z.AI (CN)',
      hasKey: true,
      keyMasked: 'zai-****',
      enabled: true,
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    }];
    providerStoreState.providerSnapshot.vendors = [{
      id: 'zai',
      name: 'Z.AI (CN)',
      icon: 'Z',
      placeholder: 'zai-...',
      model: 'glm-5.2',
      requiresApiKey: true,
      defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      showBaseUrl: true,
      codePlan: { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', modelId: 'glm-5.2' },
      runtimeProviderKey: 'zai',
      category: 'official',
      envVar: 'ZAI_API_KEY',
      supportedAuthModes: ['api_key'],
      defaultAuthMode: 'api_key',
      supportsMultipleAccounts: false,
      modelCapabilities: ['chat', 'imageUnderstand'],
    }];

    render(<ProvidersSettings />);

    expandProviderCard('Z.AI');
    fireEvent.click(screen.getByTitle('Edit API key'));
    fireEvent.click(screen.getByLabelText('Code Plan endpoint'));
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://open.bigmodel.cn/api/coding/paas/v4');
    fireEvent.click(screen.getByTestId('provider-edit-save-zai'));

    await waitFor(() => expect(providerStoreState.updateAccount).toHaveBeenCalledWith(
      'zai',
      { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
      undefined,
    ));
  });

  it('Z.AI provider 卡片显示通用 Code Plan 模型快捷添加', async () => {
    providerStoreState.providerSnapshot.credentials = [{
      id: 'zai',
      vendorId: 'zai',
      label: 'Z.AI (CN)',
      authMode: 'api_key',
      enabled: true,
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    }];
    providerStoreState.providerSnapshot.statuses = [];
    providerStoreState.providerSnapshot.vendors = [{
      id: 'zai',
      name: 'Z.AI (CN)',
      icon: 'Z',
      placeholder: 'zai-...',
      model: 'glm-5.2',
      requiresApiKey: true,
      defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      showBaseUrl: true,
      codePlan: { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', modelId: 'glm-5.2' },
      runtimeProviderKey: 'zai',
      category: 'official',
      envVar: 'ZAI_API_KEY',
      supportedAuthModes: ['api_key'],
      defaultAuthMode: 'api_key',
      supportsMultipleAccounts: false,
      modelCapabilities: ['chat', 'imageUnderstand'],
    }];

    render(<ProvidersSettings />);

    expandProviderCard('Z.AI');
    fireEvent.click(screen.getByRole('button', { name: 'Add glm-5.2' }));

    await waitFor(() => {
      expect(catalogState.replaceAccountModels).toHaveBeenCalledWith('zai', [
        { modelId: 'glm-5.2', capabilities: ['chat'] },
      ]);
    });
  });

  it('删除 provider 时将当前 accountId 交给 store mutation', async () => {
    render(<ProvidersSettings />);

    expandProviderCard('Custom');
    fireEvent.click(screen.getByTitle('Delete provider'));

    await waitFor(() => {
      expect(providerStoreState.removeAccount).toHaveBeenCalledWith('custom-1');
    });
  });

  it('编辑 provider 时直接将新的 API key 交给私密 Main ingress', async () => {
    render(<ProvidersSettings />);

    expandProviderCard('Custom');
    fireEvent.click(screen.getByTitle('Edit API key'));
    fireEvent.change(screen.getByTestId('provider-edit-key-input-custom-1'), {
      target: { value: 'sk-next' },
    });
    fireEvent.click(screen.getByTestId('provider-edit-save-custom-1'));

    await waitFor(() => expect(providerStoreState.updateAccount).toHaveBeenCalledWith(
      'custom-1',
      {},
      'sk-next',
    ));
  });
});
