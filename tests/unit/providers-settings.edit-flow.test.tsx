import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/i18n';
import { ProvidersSettings } from '@/components/settings/ProvidersSettings';

const providerStoreState = vi.hoisted(() => ({
  providerSnapshot: {
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
    accounts: [
      {
        id: 'custom-1',
        vendorId: 'custom',
        label: '自定义',
        authMode: 'api_key',
        model: 'claude-sonnet-4.5',
        enabled: true,
        isDefault: true,
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
        showModelId: true,
        modelIdPlaceholder: 'provider/model-id',
        category: 'custom',
        supportedAuthModes: ['api_key'],
        defaultAuthMode: 'api_key',
        supportsMultipleAccounts: true,
      },
    ],
    defaultAccountId: 'custom-1',
  },
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
  setDefaultAccount: vi.fn().mockResolvedValue(undefined),
  validateAccountApiKey: vi.fn().mockResolvedValue({ valid: true }),
}));

const settingsState = vi.hoisted(() => ({
  devModeUnlocked: false,
}));

vi.mock('@/stores/providers', () => ({
  useProviderStore: () => providerStoreState,
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: ((state: typeof settingsState) => unknown) | undefined) => (
    selector ? selector(settingsState) : settingsState
  ),
}));

describe('providers settings edit flow', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
    providerStoreState.refreshProviderSnapshot.mockClear();
  });

  it('编辑态应提供清晰的取消入口', () => {
    render(<ProvidersSettings />);

    fireEvent.click(screen.getByTitle('Edit API key'));

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('按 Escape 键应退出编辑态', () => {
    render(<ProvidersSettings />);

    fireEvent.click(screen.getByTitle('Edit API key'));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('编辑态不再显示 User-Agent，并且回退配置默认折叠', () => {
    render(<ProvidersSettings />);

    fireEvent.click(screen.getByTitle('Edit API key'));

    expect(screen.queryByLabelText('User-Agent')).toBeNull();
    expect(screen.getByLabelText('Context Window')).toBeInTheDocument();
    expect(screen.getByLabelText('Max Tokens')).toBeInTheDocument();
    expect(screen.queryByLabelText('Fallback Model IDs')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Fallback Settings' }));

    expect(screen.getByLabelText('Fallback Model IDs')).toBeInTheDocument();
  });

  it('新增自定义 provider 时支持填写 Context Window 和 Max Tokens', async () => {
    render(<ProvidersSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Provider' }));
    const dialog = screen.getByRole('dialog', { name: 'Add AI Provider' });
    fireEvent.click(within(dialog).getAllByText('Custom')[0]!);

    expect(screen.queryByLabelText('User-Agent')).toBeNull();
    expect(screen.getByLabelText('Context Window')).toBeInTheDocument();
    expect(screen.getByLabelText('Max Tokens')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-custom' } });
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'claude-sonnet-4.5' } });
    fireEvent.change(screen.getByLabelText('Context Window'), { target: { value: '200000' } });
    fireEvent.change(screen.getByLabelText('Max Tokens'), { target: { value: '64000' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add AI Provider' })).getByRole('button', { name: 'Add Provider' }));

    await waitFor(() => {
      expect(providerStoreState.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          vendorId: 'custom',
          model: 'claude-sonnet-4.5',
          contextWindow: 200000,
          maxTokens: 64000,
        }),
        'sk-custom',
      );
    });
  });
});
