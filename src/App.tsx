/**
 * Root Application Component
 * Handles routing and global providers
 */
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Component, useCallback, useEffect, useRef } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Toaster } from 'sonner';
import i18n from './i18n';
import { MainLayout } from './components/layout/MainLayout';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Dashboard } from './pages/Dashboard';
import { Chat } from './pages/Chat';
import { Channels } from './pages/Channels';
import { Skills } from './pages/Skills';
import { SubAgents } from './pages/SubAgents';
import { TeamsPage } from './pages/Teams';
import { TeamChatPage } from './pages/Teams/TeamChat';
import { TasksPage } from './pages/Tasks';
import { Settings } from './pages/Settings';
import { Setup } from './pages/Setup';
import { useSettingsStore } from './stores/settings';
import { useGatewayStore } from './stores/gateway';
import { useSkillsStore } from './stores/skills';
import { applyGatewayTransportPreference } from './lib/api-client';
import { hostApiFetch } from './lib/host-api';
import { TeamsRuntimeDaemon } from './components/runtime/TeamsRuntimeDaemon';


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

interface LicenseGateSnapshot {
  state: 'checking' | 'granted' | 'blocked';
  reason: string;
  checkedAtMs: number;
  hasStoredKey: boolean;
  hasUsableCache: boolean;
  nextRevalidateAtMs: number | null;
}

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const initSettings = useSettingsStore((state) => state.init);
  const theme = useSettingsStore((state) => state.theme);
  const language = useSettingsStore((state) => state.language);
  const setupComplete = useSettingsStore((state) => state.setupComplete);
  const settingsInitialized = useSettingsStore((state) => state.initialized);
  const initGateway = useGatewayStore((state) => state.init);
  const gatewayState = useGatewayStore((state) => state.status.state);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const skillsPrefetchedRef = useRef(false);

  const fetchLicenseGateSnapshot = useCallback(async (): Promise<LicenseGateSnapshot | null> => {
    try {
      const result = await hostApiFetch<LicenseGateSnapshot>('/api/license/gate');
      if (!result || typeof result !== 'object' || typeof result.state !== 'string') {
        return null;
      }
      return result;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    initSettings();
  }, [initSettings]);

  // Sync i18n language with persisted settings on mount
  useEffect(() => {
    if (language && language !== i18n.language) {
      i18n.changeLanguage(language);
    }
  }, [language]);

  // Initialize Gateway connection on mount
  useEffect(() => {
    initGateway();
  }, [initGateway]);

  useEffect(() => {
    if (!settingsInitialized) {
      return;
    }

    let cancelled = false;

    const enforceRouteGuard = async () => {
      if (!setupComplete) {
        if (!location.pathname.startsWith('/setup')) {
          navigate('/setup', { replace: true });
        }
        return;
      }

      const gateSnapshot = await fetchLicenseGateSnapshot();
      if (cancelled || !gateSnapshot) {
        return;
      }

      if (gateSnapshot.state !== 'granted' && !location.pathname.startsWith('/settings')) {
        navigate('/settings?section=license', { replace: true });
        return;
      }

      if (gateSnapshot.state === 'granted' && location.pathname.startsWith('/setup')) {
        navigate('/', { replace: true });
      }
    };

    void enforceRouteGuard();
    return () => {
      cancelled = true;
    };
  }, [fetchLicenseGateSnapshot, location.pathname, navigate, settingsInitialized, setupComplete]);

  // Listen for navigation events from main process
  useEffect(() => {
    const handleNavigate = (...args: unknown[]) => {
      const path = args[0];
      if (typeof path === 'string') {
        navigate(path);
      }
    };

    const unsubscribe = window.electron.ipcRenderer.on('navigate', handleNavigate);

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [navigate]);

  // Apply theme
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }
  }, [theme]);

  useEffect(() => {
    applyGatewayTransportPreference();
  }, []);

  useEffect(() => {
    if (!settingsInitialized || !setupComplete || gatewayState !== 'running') {
      return;
    }
    if (skillsPrefetchedRef.current) {
      return;
    }
    skillsPrefetchedRef.current = true;

    let cancelled = false;
    let timeoutId: number | undefined;
    let idleId: number | undefined;

    const prewarm = () => {
      if (cancelled) {
        return;
      }
      void fetchSkills();
    };

    if ('requestIdleCallback' in window && typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(() => prewarm(), { timeout: 1500 });
    } else {
      timeoutId = window.setTimeout(prewarm, 600);
    }

    return () => {
      cancelled = true;
      if (typeof timeoutId === 'number') {
        window.clearTimeout(timeoutId);
      }
      if (typeof idleId === 'number' && 'cancelIdleCallback' in window && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      }
    };
  }, [fetchSkills, gatewayState, settingsInitialized, setupComplete]);

  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={300}>
        <TeamsRuntimeDaemon />
        <Routes>
          {/* Setup wizard (shown on first launch) */}
          <Route path="/setup/*" element={<Setup />} />

          {/* Main application routes */}
          <Route element={<MainLayout />}>
            <Route path="/" element={<Chat />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/channels" element={<Channels />} />
            <Route path="/subagents" element={<SubAgents />} />
            <Route path="/teams" element={<TeamsPage />} />
            <Route path="/teams/:teamId" element={<TeamChatPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/skills" element={<Skills />} />
            <Route path="/cron" element={<Navigate to="/tasks?tab=scheduled" replace />} />
            <Route path="/settings/*" element={<Settings />} />
          </Route>
        </Routes>

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
