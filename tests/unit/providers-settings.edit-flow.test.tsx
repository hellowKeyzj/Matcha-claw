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
        baseUrl: 'https://api.example.com/v1',
        apiProtocol: 'openai-completions',
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
  validateAccountApiKey: vi.fn().mockResolvedValue({ valid: true }),
}));

const catalogState = vi.hoisted(() => ({
  models: [] as ProviderModel[],
  ready: true,
  loading: false,
  saving: false,
  error: null as string | null,
  refresh: vi.fn().mockResolvedValue(undefined),
  replaceCredentialModels: vi.fn().mockResolvedValue(undefined),
}));

const settingsState = vi.hoisted(() => ({
  devModeUnlocked: false,
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

describe('providers settings edit flow', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
    vi.clearAllMocks();
    providerStoreState.providerSnapshot = structuredClone(hoisted.defaultProviderSnapshot);
    providerStoreState.validateAccountApiKey.mockResolvedValue({ valid: true });
    catalogState.models = [];
    catalogState.ready = true;
    catalogState.loading = false;
    catalogState.saving = false;
    catalogState.error = null;
    catalogState.refresh.mockResolvedValue(undefined);
    catalogState.replaceCredentialModels.mockResolvedValue(undefined);
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

  it('编辑态只显示凭证配置，不再显示模型和回退配置', () => {
    render(<ProvidersSettings />);

    expandProviderCard('Custom');
    fireEvent.click(screen.getByTitle('Edit API key'));

    expect(screen.queryByLabelText('User-Agent')).toBeNull();
    expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Protocol')).toBeInTheDocument();
    expect(screen.queryByLabelText('Model ID')).toBeNull();
    expect(screen.queryByLabelText('Context Window')).toBeNull();
    expect(screen.queryByLabelText('Max Tokens')).toBeNull();
    expect(screen.queryByLabelText('Fallback Model IDs')).toBeNull();
  });

  it('在 provider 卡片内管理模型清单', async () => {
    catalogState.models = [{
      credentialId: 'custom-1',
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
      expect(catalogState.replaceCredentialModels).toHaveBeenCalledWith('custom-1', [
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
      expect(catalogState.replaceCredentialModels).toHaveBeenCalledWith('ark-main', [
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

  it('新增自定义 provider 时只提交凭证配置', async () => {
    render(<ProvidersSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Provider' }));
    const dialog = screen.getByRole('dialog', { name: 'Add AI Provider' });
    fireEvent.click(within(dialog).getAllByText('Custom')[0]!);

    expect(screen.queryByLabelText('User-Agent')).toBeNull();
    expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Protocol')).toBeInTheDocument();
    expect(screen.queryByLabelText('Model ID')).toBeNull();
    expect(screen.queryByLabelText('Context Window')).toBeNull();
    expect(screen.queryByLabelText('Max Tokens')).toBeNull();

    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-custom' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://custom.example/v1' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add AI Provider' })).getByRole('button', { name: 'Add Provider' }));

    await waitFor(() => {
      expect(providerStoreState.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          vendorId: 'custom',
          baseUrl: 'https://custom.example/v1',
          apiProtocol: 'openai-completions',
        }),
        'sk-custom',
      );
    });
  });

  it('新增自定义媒体 provider 时只提交接口契约，不登记模型', async () => {
    render(<ProvidersSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Provider' }));
    const dialog = screen.getByRole('dialog', { name: 'Add AI Provider' });
    fireEvent.click(within(dialog).getAllByText('Custom')[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Media provider' }));

    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-media' } });
    fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'OpenAI Images' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add AI Provider' })).getByRole('button', { name: 'Add Provider' }));

    await waitFor(() => {
      expect(providerStoreState.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          vendorId: 'custom',
          providerKind: 'media',
          label: 'OpenAI Images',
          mediaApiProtocol: 'openai',
          apiProtocol: undefined,
        }),
        'sk-media',
      );
    });
    expect(catalogState.replaceCredentialModels).not.toHaveBeenCalled();
  });

  it('媒体 provider 的图像生成模型不显示聊天模型限制字段', () => {
    providerStoreState.providerSnapshot.credentials = [
      {
        id: 'custom-media-1',
        vendorId: 'custom',
        providerKind: 'media',
        label: 'Images',
        authMode: 'api_key',
        baseUrl: 'https://media.example/v1beta',
        mediaApiProtocol: 'google',
        enabled: true,
        createdAt: '2026-05-19T00:00:00.000Z',
        updatedAt: '2026-05-19T00:00:00.000Z',
      },
    ];
    providerStoreState.providerSnapshot.statuses = [];
    catalogState.models = [{
      credentialId: 'custom-media-1',
      modelId: 'gemini-2.5-flash-image',
      capabilities: ['imageGenerate'],
      contextWindow: 128000,
      maxTokens: 8192,
      timeoutMs: 90000,
      aspectRatio: '16:9',
      resolution: '2K',
    }];

    render(<ProvidersSettings />);

    expandProviderCard('Images');

    expect(screen.getByDisplayValue('gemini-2.5-flash-image')).toBeInTheDocument();
    expect(screen.getByLabelText('Timeout ms')).toBeInTheDocument();
    expect(screen.getByLabelText('Ratio')).toBeInTheDocument();
    expect(screen.getByLabelText('Resolution')).toBeInTheDocument();
    expect(screen.queryByLabelText('Context window')).toBeNull();
    expect(screen.queryByLabelText('Max output tokens')).toBeNull();
  });

  it('编辑 provider 时验证失败应显示行内错误且不保存', async () => {
    providerStoreState.validateAccountApiKey.mockResolvedValueOnce({
      valid: false,
      error: 'Invalid API key',
    });

    render(<ProvidersSettings />);

    expandProviderCard('Custom');
    fireEvent.click(screen.getByTitle('Edit API key'));
    fireEvent.change(screen.getByTestId('provider-edit-key-input-custom-1'), {
      target: { value: 'sk-bad' },
    });
    fireEvent.click(screen.getByTestId('provider-edit-save-custom-1'));

    expect(await screen.findByTestId('provider-edit-validation-error-custom-1')).toHaveTextContent('Failed: Invalid API key');
    expect(providerStoreState.updateAccount).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('provider-edit-key-input-custom-1'), {
      target: { value: 'sk-good' },
    });
    expect(screen.queryByTestId('provider-edit-validation-error-custom-1')).toBeNull();
  });
});
