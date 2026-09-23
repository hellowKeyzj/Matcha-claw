/**
 * Settings Page
 * Application configuration
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Sun,
  Moon,
  Monitor,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronRight,
  Terminal,
  ExternalLink,
  Download,
  Copy,
  FileText,
  Upload,
  Trash2,
  User,
  FolderOpen,
} from 'lucide-react';
import { StableScrollArea } from '@/components/scroll';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useSettingsStore } from '@/stores/settings';
import { useGatewayStore } from '@/stores/gateway';
import {
  findRuntimeEndpointByAdapter,
  runtimeEndpointBadgeVariant,
  runtimeEndpointStatusLabel,
  useRuntimeEndpointsStore,
} from '@/stores/runtime-endpoints';
import { usePluginsStore } from '@/stores/plugins-store';
import { UpdateSettings } from '@/components/settings/UpdateSettings';
import {
  invokeIpc,
  toUserMessage,
} from '@/lib/api-client';
import {
  clearUiTelemetry,
  getUiTelemetrySnapshot,
  subscribeUiTelemetry,
  trackUiEvent,
  type UiTelemetryEntry,
} from '@/lib/telemetry';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import {
  hostApiFetch,
  hostOpenClawGetCliCommand,
} from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import {
  collectDiagnosticsArchive,
  exportDiagnosticsArchive,
} from '@/lib/diagnostics-archive';
import {
  hostSettingsPutPatch,
} from '@/lib/settings-runtime';
import {
  DEFAULT_SETTINGS_SECTION,
  parseSettingsSectionFromSearch,
  type SettingsSectionKey,
} from '@/lib/sections';
type ControlUiInfo = {
  url: string;
  token?: string;
  port: number;
};

type MatchaAgentAppServerStatus = {
  processState: string;
  port: number | null;
  pid: number | null;
  ready: boolean;
  lastError: string | null;
  updatedAt: number | string;
};

const STARTUP_TRACE_PREFIX = '[startup-trace]';

function summarizeMatchaAgentAppServerTrace(status: MatchaAgentAppServerStatus | null | undefined) {
  if (!status) return null;
  return {
    processState: status.processState,
    ready: status.ready,
    port: status.port,
    pid: status.pid,
    updatedAt: status.updatedAt,
    hasLastError: Boolean(status.lastError),
  };
}

function summarizeSettingsTraceError(error: unknown): { errorName: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    message: message
      .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|private)\/)[^\s"'<>)]*/g, '[path]')
      .replace(/(token|authorization|password|secret|api[-_ ]?key)(["'\s:=]+)[^\s"',}]+/gi, '$1$2[redacted]')
      .slice(0, 200),
  };
}

function traceSettingsStartup(phase: string, payload: Record<string, unknown>): void {
  console.info(JSON.stringify({
    prefix: STARTUP_TRACE_PREFIX,
    source: 'settings-page',
    phase,
    atMs: Date.now(),
    ...payload,
  }));
}

function formatMatchaAgentAppServerStatusLabel(
  status: MatchaAgentAppServerStatus | null,
  loading: boolean,
  loadingLabel: string,
): string {
  if (status) return status.processState;
  return loading ? loadingLabel : 'unknown';
}

function matchaAgentAppServerBadgeVariantForStatus(
  status: MatchaAgentAppServerStatus | null,
  loading: boolean,
): 'success' | 'outline' | 'destructive' | 'secondary' {
  if (!status) return loading ? 'outline' : 'secondary';
  if (status.processState === 'running' && status.ready) return 'success';
  if (status.processState === 'failed' || status.processState === 'unavailable' || status.processState === 'shutDown') return 'destructive';
  return 'outline';
}

type BrowserRelayInfo = {
  relativeDir: string;
  extensionDir: string;
  exists: boolean;
  chromeExtensionsUrl: string;
};

type BrowserMode = 'off' | 'relay' | 'native';

const TELEMETRY_WINDOW_MINUTES_OPTIONS = [0, 5, 15, 60] as const;
const HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN = 5;
const HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN_MAX = 999;
const HISTORY_STRATEGY_SORT_KEYS = ['count', 'avgMs', 'p95Ms', 'p99Ms'] as const;

type HistoryStrategySortKey = (typeof HISTORY_STRATEGY_SORT_KEYS)[number];
type HistoryStrategySortDirection = 'asc' | 'desc';

const HISTORY_STRATEGY_SORT_LABEL_KEY: Record<HistoryStrategySortKey, string> = {
  count: 'developer.telemetrySortCount',
  avgMs: 'developer.telemetrySortAvg',
  p95Ms: 'developer.telemetrySortP95',
  p99Ms: 'developer.telemetrySortP99',
};

type RuntimeStatusTone = 'success' | 'pending' | 'warning' | 'destructive' | 'neutral';

type RuntimeStatusVariant = 'success' | 'outline' | 'destructive' | 'secondary';

type RuntimeStatusAction = {
  id: string;
  label: string;
  icon: 'refresh' | 'logs';
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
};

type RuntimeStatusItem = {
  id: string;
  title: string;
  status: string;
  tone: RuntimeStatusTone;
  actions: RuntimeStatusAction[];
  activity?: ReactNode;
  details?: ReactNode;
};

const RUNTIME_STATUS_TONE_CLASS_NAMES: Record<RuntimeStatusTone, { dot: string; pill: string }> = {
  success: {
    dot: 'bg-emerald-500 ring-4 ring-emerald-500/10',
    pill: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200',
  },
  pending: {
    dot: 'bg-amber-500 ring-4 ring-amber-500/10',
    pill: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200',
  },
  warning: {
    dot: 'bg-orange-500 ring-4 ring-orange-500/10',
    pill: 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-500/20 dark:bg-orange-500/10 dark:text-orange-200',
  },
  destructive: {
    dot: 'bg-destructive ring-4 ring-destructive/10',
    pill: 'border-destructive/25 bg-destructive/10 text-destructive',
  },
  neutral: {
    dot: 'bg-muted-foreground ring-4 ring-muted',
    pill: 'border-border bg-secondary text-muted-foreground',
  },
};

function RuntimeStatusDot({ tone }: { tone: RuntimeStatusTone }) {
  return (
    <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', RUNTIME_STATUS_TONE_CLASS_NAMES[tone].dot)} />
  );
}

function RuntimeStatusPill({ tone, children }: { tone: RuntimeStatusTone; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-[var(--radius-pill)] border px-2.5 py-1 text-xs font-medium', RUNTIME_STATUS_TONE_CLASS_NAMES[tone].pill)}>
      {children}
    </span>
  );
}

function RuntimeStatusActionIcon({ action }: { action: RuntimeStatusAction }) {
  if (action.loading) {
    return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  }
  if (action.icon === 'logs') {
    return <FileText className="h-3.5 w-3.5" />;
  }
  return <RefreshCw className="h-3.5 w-3.5" />;
}

function RuntimeStatusActionButton({ action }: { action: RuntimeStatusAction }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 w-20 justify-center px-3 text-xs shadow-none"
      onClick={action.onClick}
      disabled={action.disabled}
    >
      <RuntimeStatusActionIcon action={action} />
      {action.label}
    </Button>
  );
}

function RuntimeStatusList({ items }: { items: RuntimeStatusItem[] }) {
  return (
    <div className="overflow-hidden rounded-[1rem] border border-border/80 bg-background/45" role="list">
      {items.map((item, index) => (
        <div
          key={item.id}
          role="listitem"
          className={cn(
            'grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center',
            index > 0 && 'border-t border-border/70',
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            <RuntimeStatusDot tone={item.tone} />
            <span className="truncate text-sm font-medium tracking-[-0.01em] text-foreground">{item.title}</span>
          </div>
          <div className="sm:justify-self-end">
            <RuntimeStatusPill tone={item.tone}>{item.status}</RuntimeStatusPill>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-self-end">
            {item.activity}
            {item.actions.map((action) => <RuntimeStatusActionButton key={action.id} action={action} />)}
          </div>
          {item.details ? <div className="space-y-2 sm:col-span-3 sm:pl-5">{item.details}</div> : null}
        </div>
      ))}
    </div>
  );
}

function runtimeStatusToneForVariant(variant: RuntimeStatusVariant): RuntimeStatusTone {
  if (variant === 'success') return 'success';
  if (variant === 'destructive') return 'destructive';
  if (variant === 'outline') return 'pending';
  return 'neutral';
}

function runtimeHostStatusTone(status: string): RuntimeStatusTone {
  if (status === 'running') return 'success';
  if (status === 'starting' || status === 'restarting' || status === 'stopping') return 'pending';
  if (status === 'degraded') return 'warning';
  if (status === 'stopped' || status === 'error') return 'destructive';
  return 'neutral';
}

function summarizeRuntimeStatusTone(items: RuntimeStatusItem[]): RuntimeStatusTone {
  if (items.some((item) => item.tone === 'destructive')) return 'destructive';
  if (items.some((item) => item.tone === 'warning')) return 'warning';
  if (items.some((item) => item.tone === 'pending')) return 'pending';
  if (items.length > 0 && items.every((item) => item.tone === 'success')) return 'success';
  return 'neutral';
}

function runtimeHostStatusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case 'running':
      return t('plugins:state.hostRunning');
    case 'starting':
      return t('plugins:state.hostStarting');
    case 'restarting':
      return t('plugins:state.hostRestarting');
    case 'stopping':
      return t('plugins:state.hostStopping');
    case 'degraded':
      return t('plugins:state.hostDegraded');
    case 'stopped':
    case 'error':
      return t('plugins:state.hostStopped');
    default:
      return status;
  }
}

function runtimeStatusSummaryLabel(tone: RuntimeStatusTone, t: (key: string) => string): string {
  if (tone === 'success') return t('gateway.runtimeSummaryReady');
  if (tone === 'pending') return t('gateway.runtimeSummaryPending');
  if (tone === 'warning' || tone === 'destructive') return t('gateway.runtimeSummaryIssue');
  return t('gateway.runtimeSummaryUnknown');
}

function formatIsoTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function computePercentile(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1),
  );
  const value = sorted[position];
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result) {
        reject(new Error('avatar_invalid_data_url'));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => reject(new Error('avatar_file_read_failed'));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('avatar_image_decode_failed'));
    image.src = src;
  });
}

async function cropImageToSquareDataUrl(src: string, size = 128): Promise<string> {
  const image = await loadImageElement(src);
  const cropSize = Math.min(image.width, image.height);
  const sx = (image.width - cropSize) / 2;
  const sy = (image.height - cropSize) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('avatar_canvas_unavailable');
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.clearRect(0, 0, size, size);
  context.drawImage(image, sx, sy, cropSize, cropSize, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}

export function Settings() {
  const { t } = useTranslation(['settings', 'plugins', 'common']);
  const location = useLocation();
  const navigate = useNavigate();
  const theme = useSettingsStore((state) => state.theme);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const language = useSettingsStore((state) => state.language);
  const setLanguage = useSettingsStore((state) => state.setLanguage);
  const userAvatarDataUrl = useSettingsStore((state) => state.userAvatarDataUrl);
  const setUserAvatarDataUrl = useSettingsStore((state) => state.setUserAvatarDataUrl);
  const clearUserAvatar = useSettingsStore((state) => state.clearUserAvatar);
  const launchAtStartup = useSettingsStore((state) => state.launchAtStartup);
  const setLaunchAtStartup = useSettingsStore((state) => state.setLaunchAtStartup);
  const gatewayAutoStart = useSettingsStore((state) => state.gatewayAutoStart);
  const setGatewayAutoStart = useSettingsStore((state) => state.setGatewayAutoStart);
  const browserMode = useSettingsStore((state) => state.browserMode);
  const proxyEnabled = useSettingsStore((state) => state.proxyEnabled);
  const proxyServer = useSettingsStore((state) => state.proxyServer);
  const proxyBypassRules = useSettingsStore((state) => state.proxyBypassRules);
  const autoCheckUpdate = useSettingsStore((state) => state.autoCheckUpdate);
  const setAutoCheckUpdate = useSettingsStore((state) => state.setAutoCheckUpdate);
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const setDevModeUnlocked = useSettingsStore((state) => state.setDevModeUnlocked);

  const runtimeHostEventState = useGatewayStore((state) => state.runtimeHost);
  const runtimeEndpoints = useRuntimeEndpointsStore((state) => state.endpoints);
  const runtimeEndpointsStatus = useRuntimeEndpointsStore((state) => state.status);
  const initRuntimeEndpoints = useRuntimeEndpointsStore((state) => state.init);
  const refreshRuntimeEndpoints = useRuntimeEndpointsStore((state) => state.refresh);
  const initGatewayEvents = useGatewayStore((state) => state.init);
  const refreshRuntimeHostStatusSnapshot = useGatewayStore((state) => state.refreshRuntimeHostStatus);
  const restartGateway = useGatewayStore((state) => state.restart);
  const refreshing = usePluginsStore((state) => state.refreshing);
  const refreshReason = usePluginsStore((state) => state.refreshReason);
  const mutating = usePluginsStore((state) => state.mutating);
  const mutatingAction = usePluginsStore((state) => state.mutatingAction);
  const refreshRuntime = usePluginsStore((state) => state.refreshRuntime);
  const restartHostAction = usePluginsStore((state) => state.restartHost);
  const [controlUiInfo, setControlUiInfo] = useState<ControlUiInfo | null>(null);
  const [openclawCliCommand, setOpenclawCliCommand] = useState('');
  const [openclawCliError, setOpenclawCliError] = useState<string | null>(null);
  const [proxyServerDraft, setProxyServerDraft] = useState('');
  const [proxyBypassRulesDraft, setProxyBypassRulesDraft] = useState('');
  const [proxyEnabledDraft, setProxyEnabledDraft] = useState(false);
  const [proxySettingsExpanded, setProxySettingsExpanded] = useState(false);
  const [savingProxy, setSavingProxy] = useState(false);
  const [savingBrowserMode, setSavingBrowserMode] = useState(false);
  const [showTelemetryViewer, setShowTelemetryViewer] = useState(false);
  const [telemetryEntries, setTelemetryEntries] = useState<UiTelemetryEntry[]>([]);
  const [telemetryWindowMinutes, setTelemetryWindowMinutes] = useState<number>(15);
  const [telemetryHistoryOnly, setTelemetryHistoryOnly] = useState(false);
  const [historyStrategySampleMinDraft, setHistoryStrategySampleMinDraft] = useState(
    String(HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN),
  );
  const [historyStrategySortKey, setHistoryStrategySortKey] = useState<HistoryStrategySortKey>('count');
  const [historyStrategySortDirection, setHistoryStrategySortDirection] = useState<HistoryStrategySortDirection>('desc');

  const isWindows = window.electron.platform === 'win32';
  const showCliTools = true;
  const [showOpenClawLogs, setShowOpenClawLogs] = useState(false);
  const [openClawLogContent, setOpenClawLogContent] = useState('');
  const [collectingDiagnostics, setCollectingDiagnostics] = useState(false);
  const [lastDiagnosticsArchiveId, setLastDiagnosticsArchiveId] = useState('');
  const [lastDiagnosticsEntries, setLastDiagnosticsEntries] = useState(0);
  const [lastDiagnosticsBytes, setLastDiagnosticsBytes] = useState(0);
  const [activeSection, setActiveSection] = useState<SettingsSectionKey>(
    () => parseSettingsSectionFromSearch(location.search) ?? DEFAULT_SETTINGS_SECTION
  );
  const [browserRelayInfo, setBrowserRelayInfo] = useState<BrowserRelayInfo | null>(null);
  const userAvatarInputRef = useRef<HTMLInputElement | null>(null);
  const [matchaAgentAppServerStatus, setMatchaAgentAppServerStatus] = useState<MatchaAgentAppServerStatus | null>(null);
  const [matchaAgentAppServerLoading, setMatchaAgentAppServerLoading] = useState(false);
  const [matchaAgentAppServerRestarting, setMatchaAgentAppServerRestarting] = useState(false);
  const [matchaAgentAppServerError, setMatchaAgentAppServerError] = useState('');
  const matchaAgentAppServerStatusRequestSequenceRef = useRef(0);

  useEffect(() => {
    void initGatewayEvents();
    const hadRuntime = usePluginsStore.getState().runtimeReady;
    void refreshRuntime({ reason: 'initial' }).catch(() => {
      if (!hadRuntime) {
        toast.error(t('plugins:errors.loadFailed'));
      }
    });
  }, [initGatewayEvents, refreshRuntime, t]);

  const handleShowOpenClawLogs = async () => {
    try {
      const logs = await hostApiFetch<{ content: string }>('/api/openclaw/logs?tailLines=100');
      setOpenClawLogContent(logs.content);
      setShowOpenClawLogs(true);
    } catch {
      setOpenClawLogContent('(Failed to load logs)');
      setShowOpenClawLogs(true);
    }
  };

  const handleOpenOpenClawLogDir = async () => {
    try {
      const { dir: logDir } = await hostApiFetch<{ dir: string | null }>('/api/openclaw/logs/dir');
      if (logDir) {
        await invokeIpc('shell:showItemInFolder', logDir);
      }
    } catch {
      // ignore
    }
  };

  const handleCollectDiagnosticsBundle = useCallback(async () => {
    setCollectingDiagnostics(true);
    try {
      const receipt = await collectDiagnosticsArchive();
      const exportResult = await exportDiagnosticsArchive(receipt.archiveId);
      if (exportResult.status === 'cancelled') {
        toast.info(t('diagnostics.toast.cancelled'));
        return;
      }
      if (exportResult.status === 'failed') {
        toast.error(t('diagnostics.toast.exportFailed'));
        return;
      }
      setLastDiagnosticsArchiveId(receipt.archiveId);
      setLastDiagnosticsEntries(receipt.entries);
      setLastDiagnosticsBytes(receipt.bytes);
      toast.success(t('diagnostics.toast.success', { count: receipt.entries }));
    } catch (error) {
      toast.error(t('diagnostics.toast.failed', { error: String(error) }));
    } finally {
      setCollectingDiagnostics(false);
    }
  }, [t]);

  const handleCopyBrowserRelayPath = useCallback(async () => {
    const target = browserRelayInfo?.extensionDir ?? browserRelayInfo?.relativeDir;
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target);
      toast.success(t('common:actions.copy'));
    } catch (error) {
      toast.error(`${t('common:status.error')}: ${String(error)}`);
    }
  }, [browserRelayInfo, t]);

  const handleCopyChromeExtensionsUrl = useCallback(async () => {
    const target = browserRelayInfo?.chromeExtensionsUrl ?? 'chrome://extensions/';
    try {
      await navigator.clipboard.writeText(target);
      toast.success(t('common:actions.copy'));
    } catch (error) {
      toast.error(`${t('common:status.error')}: ${String(error)}`);
    }
  }, [browserRelayInfo?.chromeExtensionsUrl, t]);

  const handleOpenChromeExtensionsUrl = useCallback(async () => {
    try {
      await invokeIpc('shell:openChromeExtensions');
    } catch (error) {
      toast.error(`${t('common:status.error')}: ${String(error)}`);
    }
  }, [t]);

  const handleRevealBrowserRelayDir = useCallback(async () => {
    const target = browserRelayInfo?.extensionDir;
    if (!target) return;
    try {
      await invokeIpc('shell:showItemInFolder', target);
    } catch (error) {
      toast.error(`${t('common:status.error')}: ${String(error)}`);
    }
  }, [browserRelayInfo?.extensionDir, t]);

  const handleAvatarFileSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    event.target.value = '';
    if (!selectedFile) {
      return;
    }
    if (!selectedFile.type.startsWith('image/')) {
      toast.error(t('appearance.avatarInvalidType'));
      return;
    }

    try {
      const sourceDataUrl = await readFileAsDataUrl(selectedFile);
      const squareAvatarDataUrl = await cropImageToSquareDataUrl(sourceDataUrl, 128);
      await setUserAvatarDataUrl(squareAvatarDataUrl);
      toast.success(t('appearance.avatarUpdated'));
    } catch (error) {
      toast.error(t('appearance.avatarUpdateFailed', { error: String(error) }));
    }
  };

  const handleClearAvatar = async () => {
    try {
      await clearUserAvatar();
      if (userAvatarInputRef.current) {
        userAvatarInputRef.current.value = '';
      }
      toast.success(t('appearance.avatarCleared'));
    } catch (error) {
      toast.error(t('appearance.avatarUpdateFailed', { error: String(error) }));
    }
  };

  // Open developer console
  const openDevConsole = async () => {
    try {
      const result = await hostApiFetch<{
        success: boolean;
        url?: string;
        port?: number;
        error?: string;
      }>('/api/gateway/control-ui');
      if (result.success && result.url && typeof result.port === 'number') {
        setControlUiInfo({ url: result.url, port: result.port });
        trackUiEvent('settings.open_dev_console');
        window.electron.openExternal(result.url);
      } else {
        console.error('Failed to get Dev Console URL:', result.error);
      }
    } catch (err) {
      console.error('Error opening Dev Console:', err);
    }
  };

  const refreshControlUiInfo = async () => {
    try {
      const result = await hostApiFetch<{
        success: boolean;
        url?: string;
        port?: number;
      }>('/api/gateway/control-ui');
      if (result.success && result.url && typeof result.port === 'number') {
        setControlUiInfo({ url: result.url, port: result.port });
      }
    } catch {
      // Ignore refresh errors
    }
  };

  const handleCopyGatewayToken = async () => {
    if (!controlUiInfo?.token) return;
    try {
      await navigator.clipboard.writeText(controlUiInfo.token);
      toast.success(t('developer.tokenCopied'));
    } catch (error) {
      toast.error(`Failed to copy token: ${String(error)}`);
    }
  };

  useEffect(() => {
    if (!showCliTools) return;
    let cancelled = false;

    (async () => {
      try {
        const result = await hostOpenClawGetCliCommand();
        if (cancelled) return;
        if (result.success && result.command) {
          setOpenclawCliCommand(result.command);
          setOpenclawCliError(null);
        } else {
          setOpenclawCliCommand('');
          setOpenclawCliError(result.error || 'OpenClaw CLI unavailable');
        }
      } catch (error) {
        if (cancelled) return;
        setOpenclawCliCommand('');
        setOpenclawCliError(String(error));
      }
    })();

    return () => { cancelled = true; };
  }, [devModeUnlocked, showCliTools]);

  const handleCopyCliCommand = async () => {
    if (!openclawCliCommand) return;
    try {
      await navigator.clipboard.writeText(openclawCliCommand);
      toast.success(t('developer.cmdCopied'));
    } catch (error) {
      toast.error(`Failed to copy command: ${String(error)}`);
    }
  };

  useEffect(() => {
    const unsubscribe = subscribeHostEvent<{ path?: string }>(
      'openclaw:cli-installed',
      (payload) => {
        const installedPath = typeof payload?.path === 'string' ? payload.path : '';
        toast.success(`openclaw CLI installed at ${installedPath}`);
      },
    );
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!devModeUnlocked) return;
    setTelemetryEntries(getUiTelemetrySnapshot(200));
    const unsubscribe = subscribeUiTelemetry((entry) => {
      setTelemetryEntries((prev) => {
        const next = [...prev, entry];
        if (next.length > 200) {
          next.splice(0, next.length - 200);
        }
        return next;
      });
    });
    return unsubscribe;
  }, [devModeUnlocked]);

  useEffect(() => {
    setProxyEnabledDraft(proxyEnabled);
  }, [proxyEnabled]);

  useEffect(() => {
    setProxyServerDraft(proxyServer);
  }, [proxyServer]);

  useEffect(() => {
    setProxyBypassRulesDraft(proxyBypassRules);
  }, [proxyBypassRules]);

  const proxySettingsDirty = useMemo(() => (
    proxyEnabledDraft !== proxyEnabled
    || proxyServerDraft.trim() !== proxyServer
    || proxyBypassRulesDraft.trim() !== proxyBypassRules
  ), [
    proxyBypassRules,
    proxyBypassRulesDraft,
    proxyEnabled,
    proxyEnabledDraft,
    proxyServer,
    proxyServerDraft,
  ]);
  const historyStrategySampleMin = useMemo(() => {
    const parsed = Number.parseInt(historyStrategySampleMinDraft, 10);
    if (!Number.isFinite(parsed) || parsed < HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN) {
      return HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN;
    }
    return Math.min(HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN_MAX, parsed);
  }, [historyStrategySampleMinDraft]);

  useEffect(() => {
    const sectionFromQuery = parseSettingsSectionFromSearch(location.search);
    if (!sectionFromQuery) {
      return;
    }
    setActiveSection((prev) => (prev === sectionFromQuery ? prev : sectionFromQuery));
  }, [location.search]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const result = await hostApiFetch<BrowserRelayInfo>('/api/app/browser-relay-info');
        if (!cancelled) {
          setBrowserRelayInfo(result);
        }
      } catch {
        if (!cancelled) {
          setBrowserRelayInfo(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaveProxySettings = async () => {
    setSavingProxy(true);
    try {
      const normalizedProxyServer = proxyServerDraft.trim();
      const normalizedBypassRules = proxyBypassRulesDraft.trim();
      await hostSettingsPutPatch({
        proxyEnabled: proxyEnabledDraft,
        proxyServer: normalizedProxyServer,
        proxyBypassRules: normalizedBypassRules,
      });

      useSettingsStore.setState({
        proxyEnabled: proxyEnabledDraft,
        proxyServer: normalizedProxyServer,
        proxyBypassRules: normalizedBypassRules,
      });

      toast.success(t('gateway.proxySaved'));
      trackUiEvent('settings.proxy_saved', { enabled: proxyEnabledDraft });
    } catch (error) {
      toast.error(`${t('gateway.proxySaveFailed')}: ${toUserMessage(error)}`);
    } finally {
      setSavingProxy(false);
    }
  };

  const handleSaveBrowserMode = useCallback(async (nextMode: BrowserMode) => {
    if (savingBrowserMode || nextMode === browserMode) {
      return;
    }
    setSavingBrowserMode(true);
    try {
      await hostSettingsPutPatch({
        browserMode: nextMode,
      });
      useSettingsStore.setState({ browserMode: nextMode });
      toast.success(t('gateway.browser.modeSaved'));
    } catch (error) {
      toast.error(`${t('gateway.browser.modeSaveFailed')}: ${toUserMessage(error)}`);
    } finally {
      setSavingBrowserMode(false);
    }
  }, [browserMode, savingBrowserMode, t]);

  const filteredTelemetryEntries = useMemo(() => {
    let entries = telemetryEntries;
    if (telemetryWindowMinutes > 0) {
      const cutoff = Date.now() - (telemetryWindowMinutes * 60 * 1000);
      entries = entries.filter((entry) => {
        const ts = Date.parse(entry.ts);
        return Number.isFinite(ts) && ts >= cutoff;
      });
    }
    if (telemetryHistoryOnly) {
      entries = entries.filter((entry) => entry.event.startsWith('chat.history_'));
    }
    return entries;
  }, [telemetryEntries, telemetryHistoryOnly, telemetryWindowMinutes]);

  const telemetryStats = useMemo(() => {
    let errorCount = 0;
    let slowCount = 0;
    for (const entry of filteredTelemetryEntries) {
      if (entry.event.endsWith('_error') || entry.event.includes('request_error')) {
        errorCount += 1;
      }
      const durationMs = typeof entry.payload.durationMs === 'number'
        ? entry.payload.durationMs
        : Number.NaN;
      if (Number.isFinite(durationMs) && durationMs >= 800) {
        slowCount += 1;
      }
    }
    return { total: filteredTelemetryEntries.length, errorCount, slowCount };
  }, [filteredTelemetryEntries]);

  const telemetryByEvent = useMemo(() => {
    const map = new Map<string, {
      event: string;
      count: number;
      errorCount: number;
      slowCount: number;
      totalDuration: number;
      timedCount: number;
      lastTs: string;
    }>();

    for (const entry of filteredTelemetryEntries) {
      const current = map.get(entry.event) ?? {
        event: entry.event,
        count: 0,
        errorCount: 0,
        slowCount: 0,
        totalDuration: 0,
        timedCount: 0,
        lastTs: entry.ts,
      };

      current.count += 1;
      current.lastTs = entry.ts;

      if (entry.event.endsWith('_error') || entry.event.includes('request_error')) {
        current.errorCount += 1;
      }

      const durationMs = typeof entry.payload.durationMs === 'number'
        ? entry.payload.durationMs
        : Number.NaN;
      if (Number.isFinite(durationMs)) {
        current.totalDuration += durationMs;
        current.timedCount += 1;
        if (durationMs >= 800) {
          current.slowCount += 1;
        }
      }

      map.set(entry.event, current);
    }

    return [...map.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }, [filteredTelemetryEntries]);

  const historyStrategyMetrics = useMemo(() => {
    const byStrategy = new Map<string, {
      strategy: string;
      mode: 'active' | 'quiet' | 'unknown';
      count: number;
      durations: number[];
      successCount: number;
      recoveredCount: number;
      failedCount: number;
    }>();

    for (const entry of filteredTelemetryEntries) {
      if (entry.event !== 'chat.history_load_total') {
        continue;
      }
      const rawStrategy = typeof entry.payload.strategy === 'string'
        ? entry.payload.strategy.trim()
        : '';
      const strategy = rawStrategy || 'default';
      const rawOutcome = typeof entry.payload.outcome === 'string'
        ? entry.payload.outcome.trim()
        : '';
      const outcome = rawOutcome || 'success';
      const mode = typeof entry.payload.quiet === 'boolean'
        ? (entry.payload.quiet ? 'quiet' : 'active')
        : 'unknown';
      const durationMs = typeof entry.payload.durationMs === 'number'
        ? entry.payload.durationMs
        : Number.NaN;

      const strategyKey = `${strategy}:${mode}`;
      const current = byStrategy.get(strategyKey) ?? {
        strategy,
        mode,
        count: 0,
        durations: [],
        successCount: 0,
        recoveredCount: 0,
        failedCount: 0,
      };
      current.count += 1;
      if (outcome === 'recovered') {
        current.recoveredCount += 1;
      } else if (outcome === 'failed' || outcome === 'aborted') {
        current.failedCount += 1;
      } else {
        current.successCount += 1;
      }
      if (Number.isFinite(durationMs) && durationMs >= 0) {
        current.durations.push(durationMs);
      }
      byStrategy.set(strategyKey, current);
    }

    return [...byStrategy.values()]
      .map((item) => {
        const totalDuration = item.durations.reduce((sum, value) => sum + value, 0);
        return {
          ...item,
          avgMs: item.durations.length > 0 ? Math.round(totalDuration / item.durations.length) : 0,
          p50Ms: computePercentile(item.durations, 50),
          p95Ms: computePercentile(item.durations, 95),
          p99Ms: computePercentile(item.durations, 99),
          lowSample: item.count < historyStrategySampleMin,
        };
      })
      .sort((a, b) => {
        const direction = historyStrategySortDirection === 'asc' ? 1 : -1;
        const metricDiff = (a[historyStrategySortKey] - b[historyStrategySortKey]) * direction;
        if (metricDiff !== 0) {
          return metricDiff;
        }
        const countDiff = (a.count - b.count) * direction;
        if (countDiff !== 0) {
          return countDiff;
        }
        return a.strategy.localeCompare(b.strategy);
      });
  }, [
    filteredTelemetryEntries,
    historyStrategySampleMin,
    historyStrategySortDirection,
    historyStrategySortKey,
  ]);

  const handleCopyTelemetry = async () => {
    try {
      const serialized = filteredTelemetryEntries.map((entry) => JSON.stringify(entry)).join('\n');
      await navigator.clipboard.writeText(serialized);
      toast.success(t('developer.telemetryCopied'));
    } catch (error) {
      toast.error(`${t('common:status.error')}: ${String(error)}`);
    }
  };

  const handleClearTelemetry = () => {
    clearUiTelemetry();
    setTelemetryEntries([]);
    toast.success(t('developer.telemetryCleared'));
  };

  const handleHistoryStrategySampleMinBlur = useCallback(() => {
    setHistoryStrategySampleMinDraft(String(historyStrategySampleMin));
  }, [historyStrategySampleMin]);

  const observedRuntimeHostStatus = runtimeHostEventState.lifecycle;
  const effectiveRuntimeHostStatus = observedRuntimeHostStatus;
  const runtimeEndpointCatalogLoading = runtimeEndpointsStatus === 'idle' || runtimeEndpointsStatus === 'loading';
  const openClawEndpoint = findRuntimeEndpointByAdapter(runtimeEndpoints, 'openclaw');
  const openClawEndpointStatus = runtimeEndpointCatalogLoading && !openClawEndpoint
    ? t('common:status.loading')
    : runtimeEndpointStatusLabel(openClawEndpoint);
  const matchaAgentAppServerStatusLabel = formatMatchaAgentAppServerStatusLabel(
    matchaAgentAppServerStatus,
    matchaAgentAppServerLoading,
    t('common:status.loading'),
  );
  const openClawEndpointBadgeVariant = openClawEndpoint
    ? runtimeEndpointBadgeVariant(openClawEndpoint)
    : runtimeEndpointCatalogLoading ? 'outline' : 'secondary';
  const matchaAgentAppServerBadgeVariant = matchaAgentAppServerBadgeVariantForStatus(
    matchaAgentAppServerStatus,
    matchaAgentAppServerLoading,
  );
  const showRuntimeHostError = effectiveRuntimeHostStatus === 'degraded'
    || effectiveRuntimeHostStatus === 'error'
    || effectiveRuntimeHostStatus === 'stopped';
  const runtimeHostRecoveredAt = runtimeHostEventState.lastRestartAt
    ? formatIsoTime(runtimeHostEventState.lastRestartAt)
    : '';
  const manualRuntimeRefreshing = refreshing && refreshReason === 'manual';

  const refreshRuntimeHostStatus = useCallback(async () => {
    try {
      await refreshRuntimeHostStatusSnapshot();
    } catch {
      toast.error(t('plugins:errors.loadFailed'));
    }
  }, [refreshRuntimeHostStatusSnapshot, t]);

  const applyMatchaAgentAppServerStatus = useCallback((status: MatchaAgentAppServerStatus) => {
    traceSettingsStartup('matcha-agent-status-apply', summarizeMatchaAgentAppServerTrace(status) ?? {});
    setMatchaAgentAppServerStatus(status);
    setMatchaAgentAppServerError('');
  }, []);

  const loadMatchaAgentAppServerStatus = useCallback(async () => {
    const ownedRequestSequence = matchaAgentAppServerStatusRequestSequenceRef.current + 1;
    const startedAtMs = Date.now();
    matchaAgentAppServerStatusRequestSequenceRef.current = ownedRequestSequence;
    const isOwnedStatusRequest = () => matchaAgentAppServerStatusRequestSequenceRef.current === ownedRequestSequence;

    traceSettingsStartup('matcha-agent-status-request-start', { sequence: ownedRequestSequence });
    setMatchaAgentAppServerLoading(true);
    setMatchaAgentAppServerError('');
    try {
      const status = await hostApiFetch<MatchaAgentAppServerStatus>('/api/matcha-agent/app-server/status');
      traceSettingsStartup('matcha-agent-status-request-success', {
        sequence: ownedRequestSequence,
        durationMs: Date.now() - startedAtMs,
        owned: isOwnedStatusRequest(),
        ...(summarizeMatchaAgentAppServerTrace(status) ?? {}),
      });
      if (isOwnedStatusRequest()) {
        applyMatchaAgentAppServerStatus(status);
      }
    } catch (error) {
      traceSettingsStartup('matcha-agent-status-request-error', {
        sequence: ownedRequestSequence,
        durationMs: Date.now() - startedAtMs,
        owned: isOwnedStatusRequest(),
        ...summarizeSettingsTraceError(error),
      });
      if (isOwnedStatusRequest()) {
        setMatchaAgentAppServerError(toUserMessage(error));
      }
    } finally {
      if (isOwnedStatusRequest()) {
        setMatchaAgentAppServerLoading(false);
      }
    }
  }, [applyMatchaAgentAppServerStatus]);

  const restartMatchaAgentAppServer = useCallback(async () => {
    setMatchaAgentAppServerRestarting(true);
    setMatchaAgentAppServerError('');
    try {
      await hostApiFetch<{ success: true }>('/api/matcha-agent/app-server/restart', { method: 'POST' });
      await loadMatchaAgentAppServerStatus();
    } catch (error) {
      const message = toUserMessage(error);
      setMatchaAgentAppServerError(message);
      toast.error(t('gateway.matchaAgentAppServerRestartFailed', { error: message }));
    } finally {
      setMatchaAgentAppServerRestarting(false);
    }
  }, [loadMatchaAgentAppServerStatus, t]);

  const matchaAgentAppServerStatusError = matchaAgentAppServerStatus?.lastError || matchaAgentAppServerError;

  useEffect(() => {
    if (activeSection !== 'gateway') {
      return;
    }
    initRuntimeEndpoints();
    void refreshRuntimeEndpoints();
    void loadMatchaAgentAppServerStatus();
    const unsubscribe = subscribeHostEvent<MatchaAgentAppServerStatus>('matcha-agent:status', (payload) => {
      if (payload && typeof payload === 'object' && typeof payload.processState === 'string') {
        traceSettingsStartup('matcha-agent-status-event', summarizeMatchaAgentAppServerTrace(payload) ?? {});
        applyMatchaAgentAppServerStatus(payload);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [activeSection, applyMatchaAgentAppServerStatus, initRuntimeEndpoints, loadMatchaAgentAppServerStatus, refreshRuntimeEndpoints]);

  const restartRuntimeHost = useCallback(async () => {
    try {
      await restartHostAction();
    } catch {
      toast.error(t('plugins:errors.restartFailed'));
    }
  }, [restartHostAction, t]);

  const openClawEndpointTone = runtimeStatusToneForVariant(openClawEndpointBadgeVariant);
  const runtimeHostTone = runtimeHostStatusTone(effectiveRuntimeHostStatus);
  const matchaAgentAppServerTone = runtimeStatusToneForVariant(matchaAgentAppServerBadgeVariant);
  const shouldShowRuntimeHostDetails = Boolean(
    showRuntimeHostError && runtimeHostEventState.error
    || runtimeHostEventState.restartCount > 0
    || runtimeHostRecoveredAt,
  );
  const runtimeHostDetails = shouldShowRuntimeHostDetails
    ? (
      <>
        {showRuntimeHostError && runtimeHostEventState.error && (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            {runtimeHostEventState.error}
          </p>
        )}
        {runtimeHostEventState.restartCount > 0 && (
          <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-700">
            {t('plugins:runtime.recoveredNotice', { count: runtimeHostEventState.restartCount })}
          </p>
        )}
        {runtimeHostRecoveredAt && (
          <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-700">
            {t('plugins:runtime.recoveredAt', { time: runtimeHostRecoveredAt })}
          </p>
        )}
      </>
    )
    : undefined;
  const runtimeStatusItems: RuntimeStatusItem[] = [
    {
      id: 'runtime-host',
      title: t('gateway.runtimeHostRuntimeLabel'),
      status: runtimeHostStatusLabel(effectiveRuntimeHostStatus, t),
      tone: runtimeHostTone,
      activity: refreshing && !manualRuntimeRefreshing ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('common:status.loading')}
        </span>
      ) : undefined,
      actions: [
        {
          id: 'restart',
          label: mutatingAction === 'restart' ? t('plugins:runtime.busy') : t('plugins:runtime.restart'),
          icon: 'refresh',
          onClick: () => void restartRuntimeHost(),
          disabled: manualRuntimeRefreshing || mutating,
        },
        {
          id: 'refresh',
          label: manualRuntimeRefreshing ? t('plugins:runtime.busy') : t('common:actions.refresh'),
          icon: 'refresh',
          onClick: () => void refreshRuntimeHostStatus(),
          disabled: manualRuntimeRefreshing || mutating,
          loading: manualRuntimeRefreshing,
        },
      ],
      details: runtimeHostDetails,
    },
    {
      id: 'openclaw',
      title: t('gateway.openclawRuntimeLabel'),
      status: openClawEndpointStatus,
      tone: openClawEndpointTone,
      actions: [
        {
          id: 'restart',
          label: t('common:actions.restart'),
          icon: 'refresh',
          onClick: restartGateway,
        },
        {
          id: 'logs',
          label: t('gateway.logs'),
          icon: 'logs',
          onClick: handleShowOpenClawLogs,
        },
      ],
      details: showOpenClawLogs ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-medium">{t('gateway.openclawLogs')}</p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleOpenOpenClawLogDir}>
                <ExternalLink className="h-3 w-3" />
                {t('gateway.openFolder')}
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowOpenClawLogs(false)}>
                {t('common:actions.close')}
              </Button>
            </div>
          </div>
          <StableScrollArea className="max-h-60 overflow-auto overscroll-contain rounded bg-background/60 [scrollbar-gutter:stable]">
            <pre className="whitespace-pre-wrap p-3 font-mono text-xs text-muted-foreground">
              {openClawLogContent || t('chat:noLogs')}
            </pre>
          </StableScrollArea>
        </div>
      ) : undefined,
    },
    {
      id: 'matcha-agent-app-server',
      title: t('gateway.localServiceRuntimeLabel'),
      status: matchaAgentAppServerStatusLabel,
      tone: matchaAgentAppServerTone,
      actions: [
        {
          id: 'restart',
          label: t('common:actions.restart'),
          icon: 'refresh',
          onClick: () => void restartMatchaAgentAppServer(),
          disabled: matchaAgentAppServerLoading || matchaAgentAppServerRestarting,
          loading: matchaAgentAppServerRestarting,
        },
        {
          id: 'refresh',
          label: t('common:actions.refresh'),
          icon: 'refresh',
          onClick: () => void loadMatchaAgentAppServerStatus(),
          disabled: matchaAgentAppServerLoading || matchaAgentAppServerRestarting,
          loading: matchaAgentAppServerLoading,
        },
      ],
      details: matchaAgentAppServerStatusError ? (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
          {matchaAgentAppServerStatusError}
        </p>
      ) : undefined,
    },
  ];
  const runtimeStatusSummaryTone = summarizeRuntimeStatusTone(runtimeStatusItems);
  const runtimeStatusSummary = runtimeStatusSummaryLabel(runtimeStatusSummaryTone, t);

  const sectionItems: Array<{ key: SettingsSectionKey; label: string }> = [
    { key: 'gateway', label: t('gateway.runtimeTitle') },
    { key: 'appearance', label: t('appearance.title') },
    { key: 'browser', label: t('gateway.browser.title') },
    { key: 'updates', label: t('updates.title') },
    { key: 'advanced', label: t('advanced.title') },
    { key: 'diagnostics', label: t('diagnostics.title') },
  ];

  const switchSection = useCallback((section: SettingsSectionKey) => {
    setActiveSection(section);
    const params = new URLSearchParams(location.search);
    params.set('section', section);
    const nextSearch = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: nextSearch ? `?${nextSearch}` : '',
      },
      { replace: true },
    );
  }, [location.pathname, location.search, navigate]);

  return (
    <div className="flex flex-col gap-6 p-6" data-testid="settings-page">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <Card className="h-fit border-border/60 bg-card/80">
          <CardContent className="p-2.5">
            <nav className="space-y-1" aria-label={t('title')}>
              {sectionItems.map((section) => (
                <Button
                  key={section.key}
                  type="button"
                  variant="ghost"
                  className={`w-full h-10 justify-start rounded-lg px-2.5 text-sm font-medium transition-colors border border-transparent ${
                    activeSection === section.key
                      ? 'bg-primary/12 text-primary hover:bg-primary/18'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/70'
                  }`}
                  onClick={() => switchSection(section.key)}
                >
                  <span
                    aria-hidden
                    className={`mr-2 h-1.5 w-1.5 rounded-full transition-colors ${
                      activeSection === section.key ? 'bg-primary' : 'bg-transparent'
                    }`}
                  />
                  <span className="truncate">{section.label}</span>
                </Button>
              ))}
            </nav>
          </CardContent>
        </Card>

        <div className="space-y-6">
          {/* Appearance */}
          {activeSection === 'appearance' && (
      <Card className="order-2">
        <CardHeader>
          <CardTitle>{t('appearance.title')}</CardTitle>
          <CardDescription>{t('appearance.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>{t('appearance.theme')}</Label>
            <div className="flex gap-2">
              <Button
                variant={theme === 'light' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  void setTheme('light').catch((error) => {
                    toast.error(`${t('common:status.error')}: ${toUserMessage(error)}`);
                  });
                }}
              >
                <Sun className="h-4 w-4 mr-2" />
                {t('appearance.light')}
              </Button>
              <Button
                variant={theme === 'dark' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  void setTheme('dark').catch((error) => {
                    toast.error(`${t('common:status.error')}: ${toUserMessage(error)}`);
                  });
                }}
              >
                <Moon className="h-4 w-4 mr-2" />
                {t('appearance.dark')}
              </Button>
              <Button
                variant={theme === 'system' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  void setTheme('system').catch((error) => {
                    toast.error(`${t('common:status.error')}: ${toUserMessage(error)}`);
                  });
                }}
              >
                <Monitor className="h-4 w-4 mr-2" />
                {t('appearance.system')}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t('appearance.language')}</Label>
            <div className="flex gap-2">
              {SUPPORTED_LANGUAGES.map((lang) => (
                <Button
                  key={lang.code}
                  variant={language === lang.code ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => { void setLanguage(lang.code).catch(() => {}); }}
                >
                  {lang.label}
                </Button>
              ))}
            </div>
          </div>
          <Separator />
          <div className="space-y-3">
            <div>
              <Label>{t('appearance.userAvatar')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('appearance.userAvatarDesc')}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted">
                {userAvatarDataUrl ? (
                  <img
                    src={userAvatarDataUrl}
                    alt={t('appearance.userAvatarPreviewAlt')}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <User className="h-6 w-6 text-muted-foreground" />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={userAvatarInputRef}
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  aria-label={t('appearance.uploadAvatarInputLabel')}
                  onChange={(event) => {
                    void handleAvatarFileSelect(event);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => userAvatarInputRef.current?.click()}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  {t('appearance.uploadAvatar')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!userAvatarDataUrl}
                  onClick={handleClearAvatar}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('appearance.clearAvatar')}
                </Button>
              </div>
                <div className="ml-auto flex w-auto max-w-full items-center gap-3">
                  <div className="max-w-[240px]">
                    <Label className="text-[15px] font-medium text-foreground/80">{t('appearance.launchAtStartup')}</Label>
                  </div>
                  <Switch
                    checked={launchAtStartup}
                    onCheckedChange={(value) => { void setLaunchAtStartup(value).catch(() => {}); }}
                  />
                </div>
              </div>
            </div>
        </CardContent>
      </Card>
          )}

          {activeSection === 'browser' && (
            <Card className="order-1">
              <CardHeader>
                <CardTitle>{t('gateway.browser.title')}</CardTitle>
                <CardDescription>{t('gateway.browser.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3 rounded-xl border border-border/60 p-5">
                  <div className="space-y-1">
                    <Label>{t('gateway.browser.modeLabel')}</Label>
                    <p className="text-sm text-muted-foreground">{t('gateway.browser.modeDescription')}</p>
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
                    {([
                      {
                        value: 'relay',
                        label: t('gateway.browser.modes.relay.title'),
                        description: t('gateway.browser.modes.relay.description'),
                      },
                      {
                        value: 'native',
                        label: t('gateway.browser.modes.native.title'),
                        description: t('gateway.browser.modes.native.description'),
                      },
                      {
                        value: 'off',
                        label: t('gateway.browser.modes.off.title'),
                        description: t('gateway.browser.modes.off.description'),
                      },
                    ] as const).map((option) => {
                      const active = browserMode === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => void handleSaveBrowserMode(option.value)}
                          disabled={savingBrowserMode}
                          className={`rounded-xl border p-4 text-left transition-colors ${
                            active
                              ? 'border-primary bg-primary/8'
                              : 'border-border/60 bg-background/40 hover:border-border'
                          } ${savingBrowserMode ? 'cursor-wait opacity-70' : ''}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="font-medium">{option.label}</div>
                            {active ? <Badge className="shrink-0" variant="secondary">{t('gateway.browser.currentMode')}</Badge> : null}
                          </div>
                          <p className="mt-2 text-sm text-muted-foreground">{option.description}</p>
                        </button>
                      );
                    })}
                  </div>
                  {savingBrowserMode ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>{t('gateway.browser.modeSaving')}</span>
                    </div>
                  ) : null}
                </div>

                {browserMode === 'relay' && (
                <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" onClick={handleOpenChromeExtensionsUrl}>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      {t('gateway.browser.openChromeExtensions')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleRevealBrowserRelayDir}
                      disabled={!browserRelayInfo?.exists}
                    >
                      <FolderOpen className="mr-2 h-4 w-4" />
                      {t('gateway.browser.revealExtensionDir')}
                    </Button>
                    <Button type="button" variant="outline" onClick={handleCopyBrowserRelayPath}>
                      <Copy className="mr-2 h-4 w-4" />
                      {t('gateway.browser.copyExtensionPath')}
                    </Button>
                    <Button type="button" variant="outline" onClick={handleCopyChromeExtensionsUrl}>
                      <Copy className="mr-2 h-4 w-4" />
                      {t('gateway.browser.copyChromeExtensions')}
                    </Button>
                  </div>
                </div>
                )}

                {browserMode === 'relay' && (
                <div className="space-y-3 rounded-xl border border-border/60 p-5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-semibold">1</div>
                    <div className="space-y-2">
                      <p className="text-lg font-semibold">{t('gateway.browser.steps.enableDevModeTitle')}</p>
                      <p className="text-sm text-muted-foreground">{t('gateway.browser.steps.enableDevModeBody')}</p>
                      <div className="rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-sm">
                        {browserRelayInfo?.chromeExtensionsUrl ?? 'chrome://extensions/'}
                      </div>
                    </div>
                  </div>
                </div>
                )}

                {browserMode === 'relay' && (
                <div className="space-y-3 rounded-xl border border-border/60 p-5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-semibold">2</div>
                    <div className="space-y-2">
                      <p className="text-lg font-semibold">{t('gateway.browser.steps.openFolderTitle')}</p>
                      <p className="text-sm text-muted-foreground">{t('gateway.browser.steps.openFolderBody')}</p>
                      <div className="rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-sm break-all">
                        {browserRelayInfo?.relativeDir ?? 'resources/tools/data/extension/chrome-extension/browser-relay'}
                      </div>
                      {browserRelayInfo?.extensionDir ? (
                        <p className="text-xs text-muted-foreground break-all">
                          {t('gateway.browser.absolutePathLabel')}: {browserRelayInfo.extensionDir}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
                )}

                {browserMode === 'relay' && (
                <div className="space-y-3 rounded-xl border border-border/60 p-5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-semibold">3</div>
                    <div className="space-y-2">
                      <p className="text-lg font-semibold">{t('gateway.browser.steps.installTitle')}</p>
                      <p className="text-sm text-muted-foreground">{t('gateway.browser.steps.installBody')}</p>
                      <p className="text-xs text-muted-foreground">{t('gateway.browser.steps.installHint')}</p>
                    </div>
                  </div>
                </div>
                )}

                {browserMode === 'native' && (
                <div className="rounded-xl border border-border/60 p-5">
                  <p className="text-lg font-semibold">{t('gateway.browser.nativeModeTitle')}</p>
                  <p className="mt-2 text-sm text-muted-foreground">{t('gateway.browser.nativeModeBody')}</p>
                </div>
                )}

                {browserMode === 'off' && (
                <div className="rounded-xl border border-border/60 p-5">
                  <p className="text-lg font-semibold">{t('gateway.browser.offModeTitle')}</p>
                  <p className="mt-2 text-sm text-muted-foreground">{t('gateway.browser.offModeBody')}</p>
                </div>
                )}
              </CardContent>
            </Card>
          )}

      {/* Gateway */}
      {activeSection === 'gateway' && (
      <Card className="order-1">
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle>{t('gateway.runtimeTitle')}</CardTitle>
          <div className="flex items-center gap-2 rounded-[var(--radius-pill)] border border-border/80 bg-background/60 px-3 py-1.5">
            <span className="text-xs font-medium text-muted-foreground">{runtimeStatusSummary}</span>
            <RuntimeStatusDot tone={runtimeStatusSummaryTone} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <RuntimeStatusList items={runtimeStatusItems} />


          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label>{t('gateway.autoStart')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('gateway.autoStartDesc')}
              </p>
            </div>
            <Switch
              checked={gatewayAutoStart}
              onCheckedChange={(value) => { void setGatewayAutoStart(value).catch(() => {}); }}
            />
          </div>

          <Separator />

          <div className="rounded-md border border-border/60 p-3">
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-start p-0 hover:bg-transparent"
              onClick={() => setProxySettingsExpanded((prev) => !prev)}
              data-testid="settings-proxy-expand"
            >
              <div className="flex items-center gap-2">
                {proxySettingsExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                <div className="text-left">
                  <Label>{t('gateway.proxyTitle')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('gateway.proxyDesc')}
                  </p>
                </div>
              </div>
            </Button>

            {proxySettingsExpanded && (
              <div className="mt-4 space-y-4" data-testid="settings-proxy-section">
                <div className="flex items-center justify-between">
                  <Label>{t('gateway.proxyTitle')}</Label>
                  <Switch
                    checked={proxyEnabledDraft}
                    onCheckedChange={setProxyEnabledDraft}
                    data-testid="settings-proxy-toggle"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="proxy-server">{t('gateway.proxyServer')}</Label>
                  <Input
                    id="proxy-server"
                    value={proxyServerDraft}
                    onChange={(event) => setProxyServerDraft(event.target.value)}
                    placeholder="http://127.0.0.1:7890"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('gateway.proxyServerHelp')}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="proxy-bypass">{t('gateway.proxyBypass')}</Label>
                  <Input
                    id="proxy-bypass"
                    value={proxyBypassRulesDraft}
                    onChange={(event) => setProxyBypassRulesDraft(event.target.value)}
                    placeholder="<local>;localhost;127.0.0.1;::1"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('gateway.proxyBypassHelp')}
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/40 p-3">
                  <p className="text-sm text-muted-foreground">
                    {t('gateway.proxyRestartNote')}
                  </p>
                  <Button
                    variant="outline"
                    onClick={handleSaveProxySettings}
                    disabled={savingProxy || !proxySettingsDirty}
                    data-testid="settings-proxy-save-button"
                  >
                    <RefreshCw className={`h-4 w-4 mr-2${savingProxy ? ' animate-spin' : ''}`} />
                    {savingProxy ? t('common:status.saving') : t('common:actions.save')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      )}
      {/* Updates */}
      {activeSection === 'updates' && (
      <Card className="order-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            {t('updates.title')}
          </CardTitle>
          <CardDescription>{t('updates.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <UpdateSettings />

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label>{t('updates.autoCheck')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('updates.autoCheckDesc')}
              </p>
            </div>
            <Switch
              checked={autoCheckUpdate}
              onCheckedChange={(value) => { void setAutoCheckUpdate(value).catch(() => {}); }}
            />
          </div>

        </CardContent>
      </Card>
      )}

      {/* Diagnostics */}
      {activeSection === 'diagnostics' && (
      <Card className="order-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {t('diagnostics.title')}
          </CardTitle>
          <CardDescription>{t('diagnostics.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => {
                void handleCollectDiagnosticsBundle();
              }}
              disabled={collectingDiagnostics}
            >
              {collectingDiagnostics ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {collectingDiagnostics ? t('diagnostics.collecting') : t('diagnostics.collect')}
            </Button>
          </div>

          {lastDiagnosticsArchiveId ? (
            <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3">
              <Label>{t('diagnostics.lastBundle')}</Label>
              <Input readOnly value={lastDiagnosticsArchiveId} className="font-mono" />
              <p className="text-xs text-muted-foreground">
                {t('diagnostics.lastMeta', {
                  count: lastDiagnosticsEntries,
                  bytes: lastDiagnosticsBytes,
                })}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>
      )}

      {/* Advanced */}
      {activeSection === 'advanced' && (
      <Card className="order-2">
        <CardHeader>
          <CardTitle>{t('advanced.title')}</CardTitle>
          <CardDescription>{t('advanced.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('advanced.devMode')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('advanced.devModeDesc')}
              </p>
            </div>
            <Switch
              checked={devModeUnlocked}
              onCheckedChange={(value) => { void setDevModeUnlocked(value).catch(() => {}); }}
            />
          </div>
        </CardContent>
      </Card>
      )}

      {/* Developer */}
      {activeSection === 'advanced' && devModeUnlocked && (
        <Card className="order-2">
          <CardHeader>
            <CardTitle>{t('developer.title')}</CardTitle>
            <CardDescription>{t('developer.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>{t('developer.console')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('developer.consoleDesc')}
              </p>
              <Button variant="outline" onClick={openDevConsole}>
                <Terminal className="h-4 w-4 mr-2" />
                {t('developer.openConsole')}
                <ExternalLink className="h-3 w-3 ml-2" />
              </Button>
              <p className="text-xs text-muted-foreground">
                {t('developer.consoleNote')}
              </p>
              <div className="space-y-2 pt-2">
                <Label>{t('developer.gatewayToken')}</Label>
                <p className="text-sm text-muted-foreground">
                  {t('developer.gatewayTokenDesc')}
                </p>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={controlUiInfo?.token || ''}
                    placeholder={t('developer.tokenUnavailable')}
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={refreshControlUiInfo}
                    disabled={!devModeUnlocked}
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    {t('common:actions.load')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCopyGatewayToken}
                    disabled={!controlUiInfo?.token}
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    {t('common:actions.copy')}
                  </Button>
                </div>
              </div>
            </div>
            {showCliTools && (
              <>
                <Separator />
                <div className="space-y-2">
                  <Label>{t('developer.cli')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('developer.cliDesc')}
                  </p>
                  {isWindows && (
                    <p className="text-xs text-muted-foreground">
                      {t('developer.cliPowershell')}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      value={openclawCliCommand}
                      placeholder={openclawCliError || t('developer.cmdUnavailable')}
                      className="font-mono"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCopyCliCommand}
                      disabled={!openclawCliCommand}
                    >
                      <Copy className="h-4 w-4 mr-2" />
                      {t('common:actions.copy')}
                    </Button>
                  </div>
                </div>
              </>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <Label>{t('developer.telemetryViewer')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('developer.telemetryViewerDesc')}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowTelemetryViewer((prev) => !prev)}
                >
                  {showTelemetryViewer
                    ? t('common:actions.hide')
                    : t('common:actions.show')}
                </Button>
              </div>

              {showTelemetryViewer && (
                <div className="space-y-3 rounded-lg border border-border/60 p-3">
                  <div className="grid gap-3 rounded-md border border-border/60 p-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="space-y-2">
                      <Label>{t('developer.telemetryWindow')}</Label>
                      <div className="flex flex-wrap gap-2">
                        {TELEMETRY_WINDOW_MINUTES_OPTIONS.map((minutes) => {
                          const active = telemetryWindowMinutes === minutes;
                          return (
                            <Button
                              key={minutes}
                              type="button"
                              size="sm"
                              variant={active ? 'default' : 'outline'}
                              onClick={() => setTelemetryWindowMinutes(minutes)}
                            >
                              {minutes === 0
                                ? t('developer.telemetryWindowAll')
                                : t('developer.telemetryWindowMinutes', { minutes })}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-center justify-between rounded-md border border-border/60 p-3">
                      <div>
                        <Label>{t('developer.telemetryHistoryOnly')}</Label>
                        <p className="text-xs text-muted-foreground">
                          {t('developer.telemetryHistoryOnlyDesc')}
                        </p>
                      </div>
                      <Switch
                        checked={telemetryHistoryOnly}
                        onCheckedChange={setTelemetryHistoryOnly}
                      />
                    </div>
                    <div className="space-y-2 rounded-md border border-border/60 p-3 sm:col-span-2 lg:col-span-1">
                      <Label>{t('developer.historyStrategyMetrics')}</Label>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">{t('developer.telemetryMinSample')}</span>
                          <Input
                            type="number"
                            min={HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN}
                            max={HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN_MAX}
                            step={1}
                            value={historyStrategySampleMinDraft}
                            onChange={(event) => setHistoryStrategySampleMinDraft(event.target.value)}
                            onBlur={handleHistoryStrategySampleMinBlur}
                            className="h-8 w-24 font-mono"
                          />
                          <Badge variant="outline">n&lt;{historyStrategySampleMin}</Badge>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <span className="self-center text-xs text-muted-foreground">{t('developer.telemetrySortBy')}</span>
                          {HISTORY_STRATEGY_SORT_KEYS.map((key) => (
                            <Button
                              key={key}
                              type="button"
                              size="sm"
                              variant={historyStrategySortKey === key ? 'default' : 'outline'}
                              onClick={() => setHistoryStrategySortKey(key)}
                            >
                              {t(HISTORY_STRATEGY_SORT_LABEL_KEY[key])}
                            </Button>
                          ))}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setHistoryStrategySortDirection((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
                          >
                            {historyStrategySortDirection === 'desc'
                              ? t('developer.telemetrySortDesc')
                              : t('developer.telemetrySortAsc')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{t('developer.telemetryTotal')}: {telemetryStats.total}</Badge>
                    {filteredTelemetryEntries.length !== telemetryEntries.length && (
                      <Badge variant="outline">
                        {t('developer.telemetryFiltered')}: {filteredTelemetryEntries.length}/{telemetryEntries.length}
                      </Badge>
                    )}
                    <Badge variant={telemetryStats.errorCount > 0 ? 'destructive' : 'secondary'}>
                      {t('developer.telemetryErrors')}: {telemetryStats.errorCount}
                    </Badge>
                    <Badge variant={telemetryStats.slowCount > 0 ? 'secondary' : 'outline'}>
                      {t('developer.telemetrySlow')}: {telemetryStats.slowCount}
                    </Badge>
                    <div className="ml-auto flex gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={handleCopyTelemetry}>
                        <Copy className="h-4 w-4 mr-2" />
                        {t('common:actions.copy')}
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={handleClearTelemetry}>
                        {t('common:actions.clear')}
                      </Button>
                    </div>
                  </div>

                  <StableScrollArea className="max-h-72 overflow-auto overscroll-contain rounded-md border border-border/50 bg-muted/20 [scrollbar-gutter:stable]">
                    {telemetryByEvent.length > 0 && (
                      <div className="border-b border-border/50 bg-background/70 p-2">
                        <p className="mb-2 text-[11px] font-semibold text-muted-foreground">
                          {t('developer.telemetryAggregated')}
                        </p>
                        <div className="space-y-1 text-[11px]">
                          {telemetryByEvent.map((item) => (
                            <div
                              key={item.event}
                              className="grid grid-cols-[minmax(0,1.6fr)_0.7fr_0.9fr_0.8fr_1fr] gap-2 rounded border border-border/40 px-2 py-1"
                            >
                              <span className="truncate font-medium" title={item.event}>{item.event}</span>
                              <span className="text-muted-foreground">n={item.count}</span>
                              <span className="text-muted-foreground">
                                avg={item.timedCount > 0 ? Math.round(item.totalDuration / item.timedCount) : 0}ms
                              </span>
                              <span className="text-muted-foreground">slow={item.slowCount}</span>
                              <span className="text-muted-foreground">err={item.errorCount}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {historyStrategyMetrics.length > 0 && (
                      <div className="border-b border-border/50 bg-background/70 p-2">
                        <p className="mb-2 text-[11px] font-semibold text-muted-foreground">
                          {t('developer.historyStrategyMetrics')}
                        </p>
                        <div className="space-y-1 text-[11px]">
                          {historyStrategyMetrics.map((item) => (
                            <div
                              key={`${item.strategy}:${item.mode}`}
                              className={`grid grid-cols-[minmax(0,0.95fr)_0.55fr_0.5fr_0.65fr_0.65fr_0.65fr_0.65fr_0.5fr_0.5fr_0.5fr_0.7fr] gap-2 rounded border border-border/40 px-2 py-1 ${
                                item.lowSample ? 'opacity-70' : ''
                              }`}
                            >
                              <span className="truncate font-medium font-mono" title={item.strategy}>{item.strategy}</span>
                              <span className="text-muted-foreground">{item.mode}</span>
                              <span className="text-muted-foreground">n={item.count}</span>
                              <span className="text-muted-foreground">avg={item.avgMs}ms</span>
                              <span className="text-muted-foreground">p50={item.p50Ms}ms</span>
                              <span className="text-muted-foreground">p95={item.p95Ms}ms</span>
                              <span className="text-muted-foreground">p99={item.p99Ms}ms</span>
                              <span className="text-muted-foreground">ok={item.successCount}</span>
                              <span className="text-muted-foreground">rec={item.recoveredCount}</span>
                              <span className="text-muted-foreground">fail={item.failedCount}</span>
                              <span className="text-muted-foreground">
                                {item.lowSample
                                  ? t('developer.telemetryLowSample', { min: historyStrategySampleMin })
                                  : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="space-y-1 p-2 font-mono text-xs">
                      {filteredTelemetryEntries.length === 0 ? (
                        <div className="text-muted-foreground">{t('developer.telemetryEmpty')}</div>
                      ) : (
                        filteredTelemetryEntries
                          .slice()
                          .reverse()
                          .map((entry) => (
                            <div key={entry.id} className="rounded border border-border/40 bg-background/60 p-2">
                              <div className="flex items-center justify-between gap-3">
                                <span className="font-semibold">{entry.event}</span>
                                <span className="text-muted-foreground">{entry.ts}</span>
                              </div>
                              <pre className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">
                                {JSON.stringify({ count: entry.count, ...entry.payload }, null, 2)}
                              </pre>
                            </div>
                          ))
                      )}
                    </div>
                  </StableScrollArea>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

        </div>
      </div>
    </div>
  );
}

export default Settings;
