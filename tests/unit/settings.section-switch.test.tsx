import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Settings } from '@/pages/Settings';
import { useSettingsStore } from '@/stores/settings';
import { useGatewayStore } from '@/stores/gateway';
import { useUpdateStore } from '@/stores/update';
import i18n from '@/i18n';

vi.mock('@/components/settings/ProvidersSettings', () => ({
  ProvidersSettings: () => <div data-testid="providers-settings-panel">mock-providers</div>,
}));

vi.mock('@/components/settings/UpdateSettings', () => ({
  UpdateSettings: () => <div data-testid="update-settings-panel">mock-updates</div>,
}));

vi.mock('@/lib/openclaw/task-manager-client', () => ({
  getTaskPluginStatus: vi.fn().mockResolvedValue({
    installed: false,
    enabled: false,
    skillEnabled: false,
    pluginDir: '/tmp/task-plugin',
  }),
  installTaskPlugin: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(async (path: string) => {
    if (path === '/api/license/gate') {
      return {
        state: 'blocked',
        reason: 'empty',
        checkedAtMs: Date.now(),
        hasStoredKey: false,
        hasUsableCache: false,
        nextRevalidateAtMs: null,
        lastValidation: null,
        renewalAlert: null,
      };
    }
    if (path === '/api/license/stored-key') {
      return { key: null };
    }
    throw new Error(`unhandled hostApiFetch path: ${path}`);
  }),
}));

describe('settings page section switch', () => {
  const renderWithRouter = (entry = '/settings?section=gateway') => render(
    <MemoryRouter initialEntries={[entry]}>
      <Settings />
    </MemoryRouter>,
  );

  beforeEach(() => {
    i18n.changeLanguage('en');

    useSettingsStore.setState((state) => ({
      ...state,
      theme: 'system',
      language: 'en',
      gatewayAutoStart: true,
      proxyEnabled: false,
      proxyServer: '',
      proxyBypassRules: '<local>;localhost;127.0.0.1;::1',
      autoCheckUpdate: true,
      autoDownloadUpdate: false,
      devModeUnlocked: false,
      setupComplete: true,
      userAvatarDataUrl: null,
      initialized: true,
    }));

    useGatewayStore.setState((state) => ({
      ...state,
      status: { state: 'running', port: 18789 },
    }));

    useUpdateStore.setState((state) => ({
      ...state,
      currentVersion: '0.1.23',
    }));
  });

  it('左侧分栏切换后仅显示当前分类内容', async () => {
    await act(async () => {
      renderWithRouter('/settings?section=gateway');
    });

    expect(screen.getByRole('button', { name: 'Gateway' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AI Providers' })).toBeInTheDocument();

    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.queryByTestId('providers-settings-panel')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'AI Providers' }));
    });

    expect(screen.getByTestId('providers-settings-panel')).toBeInTheDocument();
    expect(screen.queryByText('Status')).not.toBeInTheDocument();
  });

  it('URL section=license 时默认落在授权分栏', async () => {
    await act(async () => {
      renderWithRouter('/settings?section=license');
    });

    expect(screen.getByRole('heading', { name: 'License' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Validate License' })).toBeInTheDocument();
  });
});
