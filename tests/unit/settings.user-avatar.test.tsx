import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Settings } from '@/pages/Settings';
import { useSettingsStore } from '@/stores/settings';
import { useRuntimeHostStore } from '@/stores/gateway';
import { useUpdateStore } from '@/stores/update';
import i18n from '@/i18n';

vi.mock('@/components/settings/ProvidersSettings', () => ({
  ProvidersSettings: () => <div data-testid="providers-settings-panel">mock-providers</div>,
}));

vi.mock('@/components/settings/UpdateSettings', () => ({
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

describe('settings user avatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage('en');

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
        <MemoryRouter initialEntries={['/settings?section=appearance']}>
          <Settings />
        </MemoryRouter>,
      );
    });

    expect(screen.getByText('User Avatar')).toBeInTheDocument();
    expect(screen.getByLabelText('Upload User Avatar')).toHaveAttribute('type', 'file');
    expect(screen.getByRole('button', { name: 'Clear Avatar' })).toBeInTheDocument();
  });

  it('点击清除头像后会清空 settings store 中的头像数据', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/settings?section=appearance']}>
          <Settings />
        </MemoryRouter>,
      );
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear Avatar' }));
    });

    expect(useSettingsStore.getState().userAvatarDataUrl).toBeNull();
  });
});
