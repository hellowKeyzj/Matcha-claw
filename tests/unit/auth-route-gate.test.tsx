import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ComponentProps } from 'react';
import type { LicenseGateSnapshot } from '@/lib/license';
import App from '@/App';
import { AuthPage } from '@/pages/Auth';
import i18n from '@/i18n';

const hostApiFetchMock = vi.hoisted(() => vi.fn());

const accountState = vi.hoisted(() => ({
  status: 'signedOut',
  user: null,
  subscription: null,
  usage: null,
  platformQuotas: null,
  publicSettings: {
    registrationEnabled: true,
    emailVerifyEnabled: false,
  },
  errorMessage: null,
  twoFactorChallengeId: null,
  twoFactorEmail: null,
  init: vi.fn(),
  refreshSession: vi.fn(),
  login: vi.fn(),
  login2FA: vi.fn(),
  register: vi.fn(),
  sendVerifyCode: vi.fn(),
  logout: vi.fn(),
  loadPublicSettings: vi.fn(),
  clearError: vi.fn(),
}));

const licenseState = vi.hoisted(() => ({
  snapshot: null as LicenseGateSnapshot | null,
  error: null as string | null,
  subscribe: vi.fn(),
}));

const grantedLicense: LicenseGateSnapshot = {
  state: 'granted',
  reason: 'validated',
  checkedAtMs: 1,
  hasStoredKey: true,
  hasUsableCache: true,
  nextRevalidateAtMs: null,
  lastValidation: null,
  renewalAlert: null,
};

const settingsState = vi.hoisted(() => ({
  theme: 'system',
  language: 'zh-CN',
  initialized: true,
  init: vi.fn(),
}));

const gatewayState = vi.hoisted(() => ({
  init: vi.fn(),
}));

const providerState = vi.hoisted(() => ({
  init: vi.fn(),
}));

const updateState = vi.hoisted(() => ({
  init: vi.fn(),
}));

vi.mock('@/stores/account', () => ({
  useAccountStore: Object.assign(
    (selector: (state: typeof accountState) => unknown) => selector(accountState),
    {
      getState: () => accountState,
      setState: (patch: Partial<typeof accountState>) => Object.assign(accountState, patch),
    },
  ),
}));

vi.mock('@/stores/license', () => ({
  useLicenseStore: (selector: (state: typeof licenseState) => unknown) => selector(licenseState),
  useLocalLicenseLocked: () => accountState.status !== 'signedIn' && licenseState.snapshot?.state !== 'granted',
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/stores/providers', () => ({
  useProviderStore: (selector: (state: typeof providerState) => unknown) => selector(providerState),
}));

vi.mock('@/stores/update', () => ({
  useUpdateStore: (selector: (state: typeof updateState) => unknown) => selector(updateState),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/toolchain', () => ({
  prepareToolchain: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/components/layout/MainLayout', async () => {
  const { Outlet } = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    MainLayout: () => (
      <div data-testid="main-layout">
        main-layout
        <Outlet />
      </div>
    ),
  };
});

vi.mock('@/components/update/UpdateNotifier', () => ({
  UpdateNotifier: () => null,
}));

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/lib/route-preload', () => {
  const MockRoute = ({ name }: { name: string }) => <div data-testid={`${name}-route`}>{name}</div>;
  return {
    AuthRoute: () => <MockRoute name="auth" />,
    SkillsRoute: () => <MockRoute name="skills" />,
    SecurityRoute: () => <MockRoute name="security" />,
    SettingsRoute: () => <MockRoute name="settings" />,
    DashboardRoute: () => <MockRoute name="dashboard" />,
    ChannelsRoute: () => <MockRoute name="channels" />,
    TeamsRoute: () => <MockRoute name="teams" />,
    TeamChatRoute: () => <MockRoute name="team-chat" />,
    ProvidersRoute: () => <MockRoute name="providers" />,
    SubAgentsRoute: () => <MockRoute name="subagents" />,
    TasksRoute: () => <MockRoute name="tasks" />,
    PluginsRoute: () => <MockRoute name="plugins" />,
    ExternalConnectorsRoute: () => <MockRoute name="connectors" />,
    RemoteFleetRoute: () => <MockRoute name="remote-fleet" />,
    WikiRoute: () => <MockRoute name="wiki" />,
  };
});

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location-echo">{location.pathname}{location.search}</div>;
}

function renderAuthRoute() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <LocationEcho />
      <Routes>
        <Route path="/login" element={<AuthPage />} />
        <Route path="/" element={<div data-testid="main-entry">main</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderAppRoute(initialEntries: ComponentProps<typeof MemoryRouter>['initialEntries'] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <App />
      <LocationEcho />
    </MemoryRouter>,
  );
}

function resetAccountState(status: 'checking' | 'signedOut' | 'signedIn' | 'offline' = 'signedOut') {
  accountState.status = status;
  accountState.user = status === 'signedIn'
    ? {
      id: 1,
      username: 'matcha',
      email: 'matcha@example.com',
      role: 'user',
      balance: 0,
      concurrency: 1,
      status: 'active',
      allowedGroups: null,
      balanceNotifyEnabled: false,
      balanceNotifyThreshold: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    : null;
  accountState.subscription = null;
  accountState.usage = null;
  accountState.platformQuotas = null;
  accountState.publicSettings = {
    registrationEnabled: true,
    emailVerifyEnabled: false,
  };
  accountState.errorMessage = status === 'offline' ? '网络不可用' : null;
  accountState.twoFactorChallengeId = null;
  accountState.twoFactorEmail = null;

  accountState.init.mockReset().mockResolvedValue(undefined);
  accountState.refreshSession.mockReset().mockResolvedValue(undefined);
  accountState.login.mockReset().mockResolvedValue(undefined);
  accountState.login2FA.mockReset().mockResolvedValue(undefined);
  accountState.register.mockReset().mockResolvedValue(undefined);
  accountState.sendVerifyCode.mockReset().mockResolvedValue({ message: '验证码已发送', countdown: 60 });
  accountState.logout.mockReset().mockResolvedValue(undefined);
  accountState.loadPublicSettings.mockReset().mockResolvedValue(undefined);
  accountState.clearError.mockReset();
}

describe('auth route gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage('zh');
    resetAccountState();
    licenseState.snapshot = null;
    licenseState.error = null;
    licenseState.subscribe.mockReset().mockReturnValue(vi.fn());
    settingsState.theme = 'system';
    settingsState.language = 'zh-CN';
    settingsState.initialized = true;
    settingsState.init.mockReset().mockResolvedValue(undefined);
    gatewayState.init.mockReset();
    providerState.init.mockReset().mockResolvedValue(undefined);
    updateState.init.mockReset().mockResolvedValue(undefined);
    hostApiFetchMock.mockReset();
  });

  it('root shows account boot while account status is checking', async () => {
    resetAccountState('checking');
    renderAppRoute(['/']);

    expect(await screen.findByRole('heading', { name: '正在检查登录状态' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /本地进入/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('main-layout')).not.toBeInTheDocument();
  });

  it('signedOut root waits for licensed local entry before mounting the main route', async () => {
    resetAccountState('signedOut');
    const view = renderAppRoute(['/']);

    expect(await screen.findByRole('heading', { name: '登录', exact: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /本地进入/ })).toBeInTheDocument();
    expect(screen.queryByTestId('main-layout')).not.toBeInTheDocument();
    expect(licenseState.subscribe).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /本地进入/ }));

    expect(screen.getByTestId('location-echo')).toHaveTextContent(/^\/$/);
    expect(screen.queryByTestId('main-layout')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-route')).not.toBeInTheDocument();

    licenseState.snapshot = grantedLicense;
    view.rerender(<MemoryRouter><App /><LocationEcho /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent(/^\/$/);
      expect(screen.getByTestId('main-layout')).toBeInTheDocument();
      expect(screen.queryByTestId('settings-route')).not.toBeInTheDocument();
    });
  });

  it('offline root waits for licensed offline entry before mounting the main route', async () => {
    resetAccountState('offline');
    licenseState.snapshot = grantedLicense;
    renderAppRoute(['/']);

    expect(await screen.findByRole('heading', { name: '无法登录' })).toBeInTheDocument();
    expect(screen.queryByLabelText('邮箱')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /离线进入/ })).toBeInTheDocument();
    expect(screen.queryByTestId('main-layout')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /离线进入/ }));

    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent(/^\/$/);
      expect(screen.getByTestId('main-layout')).toBeInTheDocument();
    });
  });

  it.each([
    ['signedOut', '/', /本地进入/, 'blocked'],
    ['offline', '/', /离线进入/, 'blocked'],
    ['signedOut', '/login', /本地进入/, 'blocked'],
    ['signedOut', '/', /本地进入/, 'error'],
  ] as const)('%s local entry from %s waits before activation on %s (%s)', async (status, path, label, result) => {
    resetAccountState(status);
    const view = renderAppRoute([path]);
    expect(licenseState.subscribe).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: label }));

    expect(screen.getByTestId('location-echo')).toHaveTextContent(/^\/$/);
    expect(screen.queryByTestId('main-layout')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-route')).not.toBeInTheDocument();

    if (result === 'error') {
      licenseState.error = 'License refresh failed';
    } else {
      licenseState.snapshot = { ...grantedLicense, state: 'blocked' };
    }
    view.rerender(<MemoryRouter><App /><LocationEcho /></MemoryRouter>);

    expect(await screen.findByTestId('settings-route')).toBeInTheDocument();
    expect(screen.getByTestId('location-echo')).toHaveTextContent(/^\/settings\?section=license$/);
    expect(licenseState.subscribe).toHaveBeenCalledOnce();
    const unsubscribe = licenseState.subscribe.mock.results[0].value;
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each([null, 'checking', 'blocked'] as const)('local entry with a %s license cannot open a protected route', async (state) => {
    licenseState.snapshot = state === null ? null : { ...grantedLicense, state };
    const view = renderAppRoute([{ pathname: '/dashboard', search: '?source=local', state: { accountEntry: 'local' } }]);

    expect(screen.queryByTestId('dashboard-route')).not.toBeInTheDocument();
    if (state === 'blocked') {
      expect(await screen.findByTestId('settings-route')).toBeInTheDocument();
      expect(screen.getByTestId('location-echo')).toHaveTextContent(/^\/settings\?section=license$/);
    } else {
      expect(await screen.findByText('加载中...')).toBeInTheDocument();
      expect(screen.getByTestId('location-echo')).toHaveTextContent(/^\/dashboard\?source=local$/);
      expect(screen.queryByTestId('main-layout')).not.toBeInTheDocument();
      expect(screen.queryByTestId('settings-route')).not.toBeInTheDocument();

      licenseState.snapshot = grantedLicense;
      view.rerender(<MemoryRouter><App /><LocationEcho /></MemoryRouter>);

      expect(await screen.findByTestId('dashboard-route')).toBeInTheDocument();
      expect(screen.getByTestId('location-echo')).toHaveTextContent(/^\/dashboard\?source=local$/);
      expect(screen.queryByTestId('settings-route')).not.toBeInTheDocument();
    }
  });

  it.each([
    ['/login', '', '登录'],
    ['/register', '', '创建账号'],
    ['/settings', '?section=license', null],
  ] as const)('unlicensed local entry keeps %s reachable', async (path, search, title) => {
    const view = renderAppRoute([{ pathname: path, search, state: { accountEntry: 'local' } }]);

    if (title) {
      expect(await screen.findByRole('heading', { name: title, exact: true })).toBeInTheDocument();
      expect(screen.queryByTestId('settings-route')).not.toBeInTheDocument();
    } else {
      expect(await screen.findByTestId('settings-route')).toBeInTheDocument();
      expect(screen.getByTestId('location-echo').textContent).toBe(path + search);
      licenseState.snapshot = grantedLicense;
      view.rerender(<MemoryRouter><App /><LocationEcho /></MemoryRouter>);
      expect(screen.getByTestId('settings-route')).toBeInTheDocument();
    }
    expect(screen.getByTestId('location-echo').textContent).toBe(path + search);
  });

  it('revoked license redirects an active local session to activation', async () => {
    licenseState.snapshot = grantedLicense;
    const view = renderAppRoute([{ pathname: '/dashboard', state: { accountEntry: 'local' } }]);
    expect(await screen.findByTestId('dashboard-route')).toBeInTheDocument();

    licenseState.snapshot = { ...grantedLicense, state: 'blocked' };
    view.rerender(<MemoryRouter><App /><LocationEcho /></MemoryRouter>);

    expect(await screen.findByTestId('settings-route')).toBeInTheDocument();
    expect(screen.getByTestId('location-echo')).toHaveTextContent(/^\/settings\?section=license$/);
    expect(screen.queryByTestId('dashboard-route')).not.toBeInTheDocument();
    expect(licenseState.subscribe).toHaveBeenCalledOnce();
  });

  it('signedOut login page shows guest entry and enters the main route', async () => {
    resetAccountState('signedOut');
    renderAuthRoute();

    fireEvent.click(await screen.findByRole('button', { name: /本地进入/ }));

    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent(/^\/$/);
      expect(screen.getByTestId('main-entry')).toBeInTheDocument();
    });
  });

  it('offline login page shows offline entry and enters the main route', async () => {
    resetAccountState('offline');
    renderAuthRoute();

    fireEvent.click(await screen.findByRole('button', { name: /离线进入/ }));

    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent(/^\/$/);
      expect(screen.getByTestId('main-entry')).toBeInTheDocument();
    });
  });

  it.each([null, 'checking', 'blocked', 'error'] as const)('signedIn bypasses a %s machine license and redirects from login to the main app', async (state) => {
    resetAccountState('signedIn');
    licenseState.snapshot = state === null || state === 'error' ? null : { ...grantedLicense, state };
    licenseState.error = state === 'error' ? 'License refresh failed' : null;

    render(
      <MemoryRouter initialEntries={[{ pathname: '/login', state: { accountEntry: 'local' } }]}>
        <App />
        <LocationEcho />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent(/^\/$/);
      expect(screen.getByTestId('main-layout')).toBeInTheDocument();
    });
    expect(licenseState.subscribe).not.toHaveBeenCalled();
  });

  it('login success still navigates to the main route', async () => {
    resetAccountState('signedOut');
    accountState.login.mockImplementation(async () => {
      accountState.status = 'signedIn';
      accountState.user = {
        id: 1,
        username: 'matcha',
        email: 'matcha@example.com',
        role: 'user',
        balance: 0,
        concurrency: 1,
        status: 'active',
        allowedGroups: null,
        balanceNotifyEnabled: false,
        balanceNotifyThreshold: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
    });
    renderAuthRoute();

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'matcha@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => {
      expect(accountState.login).toHaveBeenCalledWith({ email: 'matcha@example.com', password: 'password' });
      expect(screen.getByTestId('location-echo')).toHaveTextContent(/^\/$/);
      expect(screen.getByTestId('main-entry')).toBeInTheDocument();
    });
  });
});
