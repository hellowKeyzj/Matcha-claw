/**
 * Root Application Component
 * Handles routing and global providers
 */
import { useNavigate } from 'react-router-dom';
import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Toaster } from 'sonner';
import i18n from './i18n';
import { MainLayout } from './components/layout/MainLayout';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSettingsStore } from '@/plugins/settings/store';
import { useGatewayStore } from '@/plugins/runtime/store';
import { AuthPage } from '@/plugins/account/auth';
import { useAccountGate } from '@/plugins/account/useAccountGate';
import { applicationLifecycle, type ApplicationLifecycleProps } from '@/app/extensions';
import { ApplicationRoutes } from '@/app/routes';
import { useContributions } from '@/plugin-host/react';
import { prepareToolchain } from './lib/toolchain';
import { applyResolvedTheme, useResolvedTheme } from './lib/use-resolved-theme';
import { isTraceEnabled, startupTrace } from '@/lib/trace-logger';

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

function ApplicationLifecycles(props: ApplicationLifecycleProps) {
  const contributions = useContributions(applicationLifecycle);
  const lifecycles = useMemo(() => [...contributions].sort((a, b) => a.order - b.order), [contributions]);
  return lifecycles.map(({ id, component: Lifecycle }) => (
    <Suspense key={id} fallback={null}>
      <Lifecycle {...props} />
    </Suspense>
  ));
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
  const theme = useSettingsStore((state) => state.theme);
  const resolvedTheme = useResolvedTheme(theme);
  const language = useSettingsStore((state) => state.language);
  const settingsInitialized = useSettingsStore((state) => state.initialized);
  const { contentVisible, gateElement, acceptLocalAccountEntry } = useAccountGate();
  const initGateway = useGatewayStore((state) => state.init);
  const runtimeHostReady = useGatewayStore((state) => state.runtimeHost.hostLifecycle === 'ready');
  const [hasObservedHostReady, setHasObservedHostReady] = useState(runtimeHostReady);

  // Latch the first Host ready observation, not peer readiness or lifetime liveness.
  if (runtimeHostReady && !hasObservedHostReady) {
    setHasObservedHostReady(true);
  }

  // Sync i18n language with persisted settings on mount
  useEffect(() => {
    if (language && language !== i18n.language) {
      i18n.changeLanguage(language);
    }
  }, [language]);

  // Platform observers are installed by the plugin host before the first render.
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
        <ApplicationLifecycles
          hostReady={hasObservedHostReady}
          contentVisible={settingsInitialized && contentVisible}
        />
        {gateElement ?? (
          <ApplicationRoutes
            layout={<MainLayoutWithLazyToolchainPrepare />}
            login={<AuthPage onLocalEntry={acceptLocalAccountEntry} />}
            register={<AuthPage />}
          />
        )}

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
