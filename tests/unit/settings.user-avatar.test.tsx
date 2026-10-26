import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { applicationShellPlugin } from '@/app/extensions';
import { createPluginHost } from '@/plugin-host/core';
import { PluginHostProvider } from '@/plugin-host/react';
import { accountPlugin } from '@/plugins/account/plugin';
import { callsPlugin } from '@/plugins/calls/plugin';
import { searchPlugin } from '@/plugins/search/plugin';
import { settingsPlugin } from '@/plugins/settings/plugin';
import { Settings } from '@/plugins/settings/page';
import { useSettingsStore } from '@/plugins/settings/store';
import { useAccountStore } from '@/plugins/account/stores/account';
import { useLicenseStore } from '@/plugins/account/stores/license';
import { useRuntimeHostStore } from '@/plugins/runtime/store';
import { useUpdateStore } from '@/plugins/settings/update/store';
import i18n from '@/i18n';

vi.mock('@/plugins/providers/components/ProvidersSettings', () => ({
  ProvidersSettings: () => <div data-testid="providers-settings-panel">mock-providers</div>,
}));

vi.mock('@/plugins/settings/update/UpdateSettings', () => ({
  UpdateSettings: () => <div data-testid="update-settings-panel">mock-updates</div>,
}));

vi.mock('@/lib/host-api', () => ({
  hostCapabilityExecute: vi.fn().mockResolvedValue(undefined),
  resolveSingleCapabilityScope: vi.fn().mockResolvedValue({ kind: 'app' }),
  hostApiFetch: vi.fn(async (path: string) => {
    if (path === '/api/capabilities/execute') {
      return { success: true };
    }
    throw new Error(`unhandled hostApiFetch path: ${path}`);
  }),
}));

const pluginsHost = createPluginHost([
  applicationShellPlugin,
  accountPlugin,
  callsPlugin,
  searchPlugin,
  settingsPlugin,
]);

describe('settings user avatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage('en');
    useAccountStore.setState({ status: 'signedIn' });
    useLicenseStore.setState({ snapshot: null, error: null });

    useSettingsStore.setState((state) => ({
      ...state,
      theme: 'system',
      language: 'en',
      userAvatarDataUrl: 'data:image/png;base64,avatar',
      gatewayAutoStart: true,
      proxyEnabled: false,
      proxyServer: '',
      proxyBypassRules: '<local>;localhost;127.0.0.1;::1',
      autoCheckUpdate: true,
      devModeUnlocked: false,
      initialized: true,
    }));

    useRuntimeHostStore.setState((state) => ({
      ...state,
      runtimeHost: { lifecycle: 'running' },
    }));

    useUpdateStore.setState((state) => ({
      ...state,
      currentVersion: '0.1.23',
    }));
  });

  it('外观分栏显示用户头像管理入口', async () => {
    await act(async () => {
      render(
        <PluginHostProvider host={pluginsHost}>
          <MemoryRouter initialEntries={['/settings?section=appearance']}>
            <Settings />
          </MemoryRouter>
        </PluginHostProvider>,
      );
    });

    expect(await screen.findByText('User Avatar')).toBeInTheDocument();
    expect(screen.getByLabelText('Upload User Avatar')).toHaveAttribute('type', 'file');
    expect(screen.getByRole('button', { name: 'Clear Avatar' })).toBeInTheDocument();
  });

  it('点击清除头像后会清空 settings store 中的头像数据', async () => {
    await act(async () => {
      render(
        <PluginHostProvider host={pluginsHost}>
          <MemoryRouter initialEntries={['/settings?section=appearance']}>
            <Settings />
          </MemoryRouter>
        </PluginHostProvider>,
      );
    });

    const clearAvatarButton = await screen.findByRole('button', { name: 'Clear Avatar' });
    await act(async () => {
      fireEvent.click(clearAvatarButton);
    });

    expect(useSettingsStore.getState().userAvatarDataUrl).toBeNull();
  });
});
