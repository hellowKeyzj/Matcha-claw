import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
});
