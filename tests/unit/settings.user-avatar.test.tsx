import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
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

describe('settings user avatar', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');

    useSettingsStore.setState((state) => ({
      ...state,
      theme: 'system',
      language: 'en',
      userAvatarDataUrl: null,
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

  it('外观分类显示用户头像上传入口', async () => {
    await act(async () => {
      render(<Settings />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    });

    expect(screen.getByText('User Avatar')).toBeInTheDocument();
    expect(screen.getByLabelText('Upload User Avatar')).toHaveAttribute('type', 'file');
  });

  it('已设置头像时可以清除头像', async () => {
    useSettingsStore.setState((state) => ({
      ...state,
      userAvatarDataUrl: 'data:image/png;base64,abc',
    }));

    await act(async () => {
      render(<Settings />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear Avatar' }));
    expect(useSettingsStore.getState().userAvatarDataUrl).toBeNull();
  });
});
