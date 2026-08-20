import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const runtimeHostState = vi.hoisted(() => ({
  runtimeHost: { lifecycle: 'running' },
  isInitialized: true,
}));

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
  useRuntimeHostStore: (selector: (state: typeof runtimeHostState) => unknown) => selector(runtimeHostState),
}));

describe('providers settings edit flow', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
    vi.clearAllMocks();
    providerStoreState.providerSnapshot = structuredClone(hoisted.defaultProviderSnapshot);
    catalogState.models = [];
    catalogState.ready = true;
    catalogState.loading = false;
    catalogState.saving = false;
    catalogState.error = null;
    catalogState.refresh.mockResolvedValue(undefined);
    catalogState.replaceAccountModels.mockResolvedValue(undefined);
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

  it('按 Escape 键应退出编辑态', () => {
    render(<ProvidersSettings />);

    expandProviderCard('Custom');
    fireEvent.click(screen.getByTitle('Edit API key'));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('编辑态只接受私密 API key，不显示旧账号配置字段', () => {
    render(<ProvidersSettings />);

    expandProviderCard('Custom');
    fireEvent.click(screen.getByTitle('Edit API key'));

    expect(screen.getByTestId('provider-edit-key-input-custom-1')).toBeInTheDocument();
    expect(screen.queryByLabelText('Base URL')).toBeNull();
    expect(screen.queryByLabelText('Protocol')).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(catalogState.replaceAccountModels).toHaveBeenCalledWith('custom-1', [
        { modelId: 'gpt-5.4', capabilities: ['chat'], contextWindow: 200000 },
        { modelId: 'gpt-5.5', capabilities: ['chat'] },
      ], 'custom');
    });
  });

  it('模型限制输入框使用 OpenClaw 内部默认值作为 placeholder', () => {
    render(<ProvidersSettings />);

    expandProviderCard('Custom');
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));

    expect(screen.getAllByLabelText('Context window').at(-1)).toHaveAttribute('placeholder', '128000');
    expect(screen.getAllByLabelText('Max output tokens').at(-1)).toHaveAttribute('placeholder', '8192');
  });

  it('只在 Ark provider 卡片内显示 Code Plan 快捷添加', async () => {
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
    }];

    render(<ProvidersSettings />);

    expandProviderCard('Ark');
    fireEvent.click(screen.getByRole('button', { name: 'Add ark-code-latest' }));

    await waitFor(() => {
      expect(catalogState.replaceAccountModels).toHaveBeenCalledWith('ark-main', [
        { modelId: 'ark-code-latest', capabilities: ['chat'] },
      ], 'ark');
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

  it('新增自定义 provider 时只提交固定账号事实和私密 API key', async () => {
    render(<ProvidersSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Provider' }));
    const dialog = screen.getByRole('dialog', { name: 'Add AI Provider' });
    fireEvent.click(within(dialog).getAllByText('Custom')[0]!);

    expect(screen.queryByLabelText('Base URL')).toBeNull();
    expect(screen.queryByLabelText('Protocol')).toBeNull();
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
