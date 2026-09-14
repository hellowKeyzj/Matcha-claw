import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ComponentProps } from 'react';
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
  hostToolchainPrepare: vi.fn().mockResolvedValue(undefined),
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
  };
});

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location-echo">{location.pathname}</div>;
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

    expect(await screen.findByText('正在初始化工作区')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /游客进入/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('main-layout')).not.toBeInTheDocument();
  });

  it('signedOut root waits for guest entry before mounting the main route', async () => {
    resetAccountState('signedOut');
    renderAppRoute(['/']);

    expect(await screen.findByText('登录 Matcha')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /游客进入/ })).toBeInTheDocument();
    expect(screen.queryByTestId('main-layout')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /游客进入/ }));

    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/');
      expect(screen.getByTestId('main-layout')).toBeInTheDocument();
    });
  });

  it('offline root waits for offline entry before mounting the main route', async () => {
    resetAccountState('offline');
    renderAppRoute(['/']);

    expect(await screen.findByText('暂时无法登录')).toBeInTheDocument();
    expect(screen.queryByLabelText('邮箱')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /离线进入/ })).toBeInTheDocument();
    expect(screen.queryByTestId('main-layout')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /离线进入/ }));

    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/');
      expect(screen.getByTestId('main-layout')).toBeInTheDocument();
    });
  });

  it('signedOut login page shows guest entry and enters the main route', async () => {
    resetAccountState('signedOut');
    renderAuthRoute();

    fireEvent.click(await screen.findByRole('button', { name: /游客进入/ }));

    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/');
      expect(screen.getByTestId('main-entry')).toBeInTheDocument();
    });
  });

  it('offline login page shows offline entry and enters the main route', async () => {
    resetAccountState('offline');
    renderAuthRoute();

    fireEvent.click(await screen.findByRole('button', { name: /离线进入/ }));

    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/');
      expect(screen.getByTestId('main-entry')).toBeInTheDocument();
    });
  });

  it('signedIn still redirects from login to the main app', async () => {
    resetAccountState('signedIn');

    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
        <LocationEcho />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/');
      expect(screen.getByTestId('main-layout')).toBeInTheDocument();
    });
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
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/');
      expect(screen.getByTestId('main-entry')).toBeInTheDocument();
    });
  });
});
