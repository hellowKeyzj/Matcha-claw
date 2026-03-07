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

describe('settings page section switch', () => {
  const renderWithRouter = () => render(
    <MemoryRouter initialEntries={['/settings?section=gateway']}>
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
      proxyHttpServer: '',
      proxyHttpsServer: '',
      proxyAllServer: '',
      proxyBypassRules: '<local>;localhost;127.0.0.1;::1',
      autoCheckUpdate: true,
      autoDownloadUpdate: false,
      devModeUnlocked: false,
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

  it('左侧分类切换时仅显示当前分类内容', async () => {
    await act(async () => {
      renderWithRouter();
    });

    const navButtons = screen.getAllByRole('button');
    expect(navButtons[0]).toHaveTextContent('Gateway');
    expect(navButtons[1]).toHaveTextContent('Appearance');
    expect(navButtons[2]).toHaveTextContent('AI Providers');

    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.queryByTestId('providers-settings-panel')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'AI Providers' }));
    });

    expect(screen.getByTestId('providers-settings-panel')).toBeInTheDocument();
    expect(screen.queryByText('Status')).not.toBeInTheDocument();
  });

  it('开发者工具合并到高级分类中', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      devModeUnlocked: true,
    }));

    await act(async () => {
      renderWithRouter();
    });

    expect(screen.queryByRole('button', { name: 'Developer' })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    });

    expect(screen.getByRole('button', { name: 'Open Developer Console' })).toBeInTheDocument();
  });
});
