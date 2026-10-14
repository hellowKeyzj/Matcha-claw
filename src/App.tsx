/**
 * Root Application Component
 * Handles routing and global providers
 */
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Component, Suspense, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Toaster } from 'sonner';
import i18n from './i18n';
import { MainLayout } from './components/layout/MainLayout';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSettingsStore } from './stores/settings';
import { useGatewayStore } from './stores/gateway';
import { useProviderStore } from './stores/providers';
import { useUpdateStore } from './stores/update';
import { useAccountStore } from './stores/account';
import { useLicenseStore, useLocalLicenseLocked } from './stores/license';
import { buildSettingsSectionLink, parseSettingsSectionFromSearch } from './lib/sections';
import { AuthPage } from './pages/Auth';
import { AccountOrbitCore } from './components/account/AccountOrbitCore';
import { prepareToolchain } from './lib/toolchain';
import { useDelayedFlag } from './lib/use-delayed-flag';
import { applyResolvedTheme, useResolvedTheme } from './lib/use-resolved-theme';
import { UpdateNotifier } from './components/update/UpdateNotifier';
import { ProviderRecoveryDialog } from './components/settings/ProviderRecoveryDialog';
import { TEAMS_FEATURE_ENABLED } from '@/features/teams/feature-flag';
import { isTraceEnabled, startupTrace } from '@/lib/trace-logger';
import {
  SkillsRoute,
  SecurityRoute,
  SettingsRoute,
  DashboardRoute,
  ChannelsRoute,
  TeamsRoute,
  TeamChatRoute,
  ProvidersRoute,
  SubAgentsRoute,
  TasksRoute,
  PluginsRoute,
  ExternalConnectorsRoute,
  RemoteFleetRoute,
  WikiRoute,
} from './lib/route-preload';

function RouteLoadingFallback() {
  const visible = useDelayedFlag(true, 160);
  if (!visible) {
    return null;
  }
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center text-sm text-muted-foreground">
      加载中...
    </div>
  );
}

function AccountBootSplash() {
  const { t } = useTranslation('common');

  return (
    <main className="relative grid min-h-[100dvh] place-items-center overflow-hidden bg-card px-6 text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_46%,hsl(var(--ring)/0.10),transparent_34%)]" />
      <section className="relative grid place-items-center text-center" role="status" aria-live="polite">
        <div className="mb-7 text-2xl font-semibold tracking-[-0.04em] text-foreground">Matcha</div>
        <AccountOrbitCore size="boot" />
        <h1 className="mt-8 text-xl font-semibold tracking-[-0.03em] text-foreground">{t('auth.boot.title')}</h1>
      </section>
    </main>
  );
}

let toolchainPrepareStarted = false;

function MainLayoutWithLazyToolchainPrepare() {
  useLayoutEffect(() => {
    if (!isTraceEnabled()) return;
    const committedAt = performance.now();
    startupTrace('renderer.layout', 'commit.setup');
    return () => startupTrace('renderer.layout', 'commit.cleanup', () => ({
      durationMs: Math.round(performance.now() - committedAt),
    }));
  }, []);

  useEffect(() => {
    if (toolchainPrepareStarted) {
      return;
    }
    toolchainPrepareStarted = true;
    void prepareToolchain().catch((error) => {
      if (isTraceEnabled()) console.debug('Toolchain prepare failed', error);
    });
  }, []);

  return <MainLayout />;
}

/**
 * Error Boundary to catch and display React rendering errors
 */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    startupTrace('renderer.app', 'render.error', () => ({ outcome: 'error' }));
    console.error('React Error Boundary caught error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '40px',
          color: '#f87171',
          background: '#0f172a',
          minHeight: '100vh',
          fontFamily: 'monospace'
        }}>
          <h1 style={{ fontSize: '24px', marginBottom: '16px' }}>Something went wrong</h1>
          <pre style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            background: '#1e293b',
            padding: '16px',
            borderRadius: '8px',
            fontSize: '14px'
          }}>
            {this.state.error?.message}
            {'\n\n'}
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{
              marginTop: '16px',
              padding: '8px 16px',
              background: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function isLocalAccountEntryState(state: unknown): boolean {
  return !!state && typeof state === 'object' && (state as { accountEntry?: unknown }).accountEntry === 'local';
}

function App() {
  if (isTraceEnabled() && performance.getEntriesByName('matchaclaw.app.first-render').length === 0) {
    performance.mark('matchaclaw.app.first-render');
    startupTrace('renderer.app', 'render.first');
  }
  useLayoutEffect(() => {
    if (!isTraceEnabled()) return;
    const committedAt = performance.now();
    startupTrace('renderer.app', 'commit.setup', () => ({
      renderToCommitMs: Math.round(committedAt
        - (performance.getEntriesByName('matchaclaw.app.first-render')[0]?.startTime ?? committedAt)),
    }));
    return () => startupTrace('renderer.app', 'commit.cleanup', () => ({
      durationMs: Math.round(performance.now() - committedAt),
    }));
  }, []);

  const navigate = useNavigate();
  const location = useLocation();
  const initSettings = useSettingsStore((state) => state.init);
  const theme = useSettingsStore((state) => state.theme);
  const resolvedTheme = useResolvedTheme(theme);
  const language = useSettingsStore((state) => state.language);
  const settingsInitialized = useSettingsStore((state) => state.initialized);
  const isAuthRoute = location.pathname === '/login' || location.pathname === '/register';
  const [localAccountEntryAccepted, setLocalAccountEntryAccepted] = useState(() =>
    isLocalAccountEntryState(location.state)
  );
  const initGateway = useGatewayStore((state) => state.init);
  const initProviders = useProviderStore((state) => state.init);
  const initUpdate = useUpdateStore((state) => state.init);
  const initAccount = useAccountStore((state) => state.init);
  const accountStatus = useAccountStore((state) => state.status);
  const licenseLocked = useLocalLicenseLocked();
  const licenseSnapshot = useLicenseStore((state) => state.snapshot);
  const licenseError = useLicenseStore((state) => state.error);
  const subscribeLicense = useLicenseStore((state) => state.subscribe);

  useEffect(() => {
    if (!isTraceEnabled()) {
      initSettings();
      return;
    }
    const startedAt = performance.now();
    startupTrace('renderer.app', 'settings.init.start');
    initSettings().finally(() => startupTrace('renderer.app', 'settings.init.end', () => ({
      durationMs: Math.round(performance.now() - startedAt),
      initialized: useSettingsStore.getState().initialized,
    })));
    return () => startupTrace('renderer.app', 'settings.init.cleanup');
  }, [initSettings]);

  useEffect(() => {
    if (!settingsInitialized) {
      return;
    }
    if (!isTraceEnabled()) {
      void initUpdate();
      return;
    }
    const startedAt = performance.now();
    startupTrace('renderer.app', 'update.init.start');
    void initUpdate().finally(() => startupTrace('renderer.app', 'update.init.end', () => ({
      durationMs: Math.round(performance.now() - startedAt),
      initialized: useUpdateStore.getState().isInitialized,
      outcome: useUpdateStore.getState().error ? 'error' : 'settled',
    })));
    return () => startupTrace('renderer.app', 'update.init.cleanup');
  }, [initUpdate, settingsInitialized]);

  useEffect(() => {
    if (!isTraceEnabled()) {
      void initAccount();
      return;
    }
    const startedAt = performance.now();
    startupTrace('renderer.app', 'account.init.start');
    void initAccount().finally(() => startupTrace('renderer.app', 'account.init.end', () => ({
      durationMs: Math.round(performance.now() - startedAt),
      accountStatus: useAccountStore.getState().status,
      outcome: useAccountStore.getState().errorMessage ? 'error' : 'settled',
    })));
    return () => startupTrace('renderer.app', 'account.init.cleanup');
  }, [initAccount]);

  // Sync i18n language with persisted settings on mount
  useEffect(() => {
    if (language && language !== i18n.language) {
      i18n.changeLanguage(language);
    }
  }, [language]);

  // Initialize Gateway connection on mount
  useEffect(() => {
    if (!isTraceEnabled()) {
      initGateway();
      return;
    }
    const startedAt = performance.now();
    startupTrace('renderer.app', 'gateway.init.start');
    initGateway().finally(() => startupTrace('renderer.app', 'gateway.init.end', () => ({
      durationMs: Math.round(performance.now() - startedAt),
      initialized: useGatewayStore.getState().isInitialized,
      outcome: useGatewayStore.getState().lastError ? 'error' : 'settled',
    })));
    return () => startupTrace('renderer.app', 'gateway.init.cleanup');
  }, [initGateway]);

  // Initialize provider snapshot on mount so provider display state
  // survives app restarts without requiring settings page entry.
  useEffect(() => {
    if (!isTraceEnabled()) {
      void initProviders();
      return;
    }
    const startedAt = performance.now();
    startupTrace('renderer.app', 'providers.init.start');
    void initProviders().finally(() => startupTrace('renderer.app', 'providers.init.end', () => ({
      durationMs: Math.round(performance.now() - startedAt),
      snapshotReady: useProviderStore.getState().snapshotReady,
      outcome: useProviderStore.getState().error ? 'error' : 'settled',
    })));
    return () => startupTrace('renderer.app', 'providers.init.cleanup');
  }, [initProviders]);

  useEffect(() => {
    if (accountStatus === 'signedIn' && isAuthRoute) {
      navigate('/', { replace: true });
    }
  }, [accountStatus, isAuthRoute, navigate]);

  const acceptLocalAccountEntry = useCallback(() => {
    setLocalAccountEntryAccepted(true);
  }, []);

  if (accountStatus === 'signedIn' && localAccountEntryAccepted) {
    setLocalAccountEntryAccepted(false);
  }
  const localAccountEntryRequested = localAccountEntryAccepted || isLocalAccountEntryState(location.state);

  const licenseRequired = localAccountEntryRequested && accountStatus !== 'signedIn';
  const licenseChecking = licenseRequired && !licenseError
    && (licenseSnapshot === null || licenseSnapshot.state === 'checking');
  const licenseBlocked = localAccountEntryRequested && licenseLocked && !licenseChecking;
  const isLicenseRoute = location.pathname === '/settings'
    && parseSettingsSectionFromSearch(location.search) === 'license';
  const observeLicense = licenseRequired || (accountStatus === 'signedIn' && isLicenseRoute);
  useEffect(() => {
    if (observeLicense) return subscribeLicense();
  }, [observeLicense, subscribeLicense]);
  const shouldApplyAccountGate = !isAuthRoute;
  const showAccountBoot = shouldApplyAccountGate
    && accountStatus === 'checking'
    && !localAccountEntryRequested;
  const showAuthGate = shouldApplyAccountGate
    && (accountStatus === 'signedOut' || accountStatus === 'offline' || accountStatus === 'requires2fa')
    && !localAccountEntryRequested;

  const gate = showAccountBoot ? 'account-checking'
    : showAuthGate ? 'auth'
    : licenseChecking && !isAuthRoute && !isLicenseRoute ? 'license-checking'
    : licenseBlocked && !isAuthRoute && !isLicenseRoute ? 'license-blocked'
    : 'routes';
  const licenseState = licenseSnapshot?.state ?? 'unobserved';
  useLayoutEffect(() => {
    if (!isTraceEnabled()) return;
    const startedAt = performance.now();
    const detail = () => ({ gate, accountStatus, licenseState, isAuthRoute, isLicenseRoute });
    startupTrace('renderer.app', 'gate.setup', detail);
    return () => startupTrace('renderer.app', 'gate.cleanup', () => ({
      ...detail(), durationMs: Math.round(performance.now() - startedAt),
    }));
  }, [gate, accountStatus, licenseState, isAuthRoute, isLicenseRoute]);

  // Listen for navigation events from main process
  useEffect(() => {
    const handleNavigate = (...args: unknown[]) => {
      const path = args[0];
      if (typeof path === 'string') {
        navigate(path);
      }
    };

    const ipcRenderer = window.electron?.ipcRenderer;
    if (typeof ipcRenderer?.on !== 'function') {
      return undefined;
    }

    const unsubscribe = ipcRenderer.on('navigate', handleNavigate);

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [navigate]);

  // Apply theme
  useLayoutEffect(() => {
    const root = window.document.documentElement;
    const body = window.document.body;
    const staleTheme = resolvedTheme === 'dark' ? 'light' : 'dark';

    const enforceTheme = () => {
      if (
        root.classList.contains(resolvedTheme)
        && !root.classList.contains(staleTheme)
        && !body.classList.contains('light')
        && !body.classList.contains('dark')
        && root.dataset.themeSurface === resolvedTheme
      ) {
        return;
      }
      applyResolvedTheme(resolvedTheme);
    };

    enforceTheme();
    const observer = new MutationObserver(enforceTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    observer.observe(body, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
    };
  }, [resolvedTheme]);

  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={300}>
        {showAccountBoot ? (
          <AccountBootSplash />
        ) : showAuthGate ? (
          <AuthPage onLocalEntry={acceptLocalAccountEntry} />
        ) : licenseChecking && !isAuthRoute && !isLicenseRoute ? (
          <RouteLoadingFallback />
        ) : licenseBlocked && !isAuthRoute && !isLicenseRoute ? (
          <Navigate to={buildSettingsSectionLink('license')} replace state={{ accountEntry: 'local' }} />
        ) : (
          <Routes>
            <Route path="/login" element={<AuthPage onLocalEntry={acceptLocalAccountEntry} />} />
            <Route path="/register" element={<AuthPage />} />

            {/* Main application routes */}
            <Route element={<MainLayoutWithLazyToolchainPrepare />}>
              <Route index element={null} />
              <Route
                path="/dashboard"
                element={(
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <DashboardRoute />
                  </Suspense>
                )}
              />
              <Route
                path="/channels"
                element={(
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ChannelsRoute />
                  </Suspense>
                )}
              />
              <Route
                path="/subagents"
                element={(
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <SubAgentsRoute />
                  </Suspense>
                )}
              />
              <Route
                path="/teams"
                element={TEAMS_FEATURE_ENABLED ? (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <TeamsRoute />
                  </Suspense>
                ) : <Navigate to="/" replace />}
              />
              <Route
                path="/teams/:teamId"
                element={TEAMS_FEATURE_ENABLED ? (
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <TeamChatRoute />
                  </Suspense>
                ) : <Navigate to="/" replace />}
              />
              <Route
                path="/tasks"
                element={(
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <TasksRoute />
                  </Suspense>
                )}
              />
              <Route
                path="/providers"
                element={(
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ProvidersRoute />
                  </Suspense>
                )}
              />
              <Route
                path="/plugins"
                element={(
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <PluginsRoute />
                  </Suspense>
                )}
              />
              <Route
                path="/connectors"
                element={(
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <ExternalConnectorsRoute />
                  </Suspense>
                )}
              />
              <Route
                path="/remote-fleet"
                element={(
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <RemoteFleetRoute />
                  </Suspense>
                )}
              />
              <Route
                path="/wiki"
                element={(
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <WikiRoute />
                  </Suspense>
                )}
              />
              <Route
                path="/skills"
                element={(
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <SkillsRoute />
                  </Suspense>
                )}
              />
              <Route
                path="/security"
                element={(
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <SecurityRoute />
                  </Suspense>
                )}
              />
              <Route path="/cron" element={<Navigate to="/tasks?tab=scheduled" replace />} />
              <Route
                path="/settings/*"
                element={(
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <SettingsRoute />
                  </Suspense>
                )}
              />
            </Route>
          </Routes>
        )}

        <ProviderRecoveryDialog ready={settingsInitialized && !isAuthRoute
          && !showAccountBoot && !showAuthGate && !licenseChecking && !licenseBlocked} />
        <UpdateNotifier />

        {/* Global toast notifications */}
        <Toaster
          position="bottom-right"
          richColors
          closeButton
          style={{ zIndex: 99999 }}
        />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

export default App;
