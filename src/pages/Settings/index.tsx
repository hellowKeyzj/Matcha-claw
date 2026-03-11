/**
 * Settings Page
 * Application configuration
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Sun,
  Moon,
  Monitor,
  RefreshCw,
  Loader2,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
  Terminal,
  ExternalLink,
  Key,
  Download,
  Copy,
  FileText,
  Wrench,
  Upload,
  Trash2,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { useSettingsStore } from '@/stores/settings';
import { useGatewayStore } from '@/stores/gateway';
import { useUpdateStore } from '@/stores/update';
import { ProvidersSettings } from '@/components/settings/ProvidersSettings';
import { UpdateSettings } from '@/components/settings/UpdateSettings';
import {
  getGatewayWsDiagnosticEnabled,
  invokeIpc,
  setGatewayWsDiagnosticEnabled,
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
import { hostApiFetch } from '@/lib/host-api';
import { getTaskPluginStatus, installTaskPlugin } from '@/lib/openclaw/task-manager-client';
import {
  DEFAULT_SETTINGS_SECTION,
  parseSettingsSectionFromSearch,
  type SettingsSectionKey,
} from '@/lib/settings/sections';
type ControlUiInfo = {
  url: string;
  token: string;
  port: number;
};

type TaskPluginInfo = {
  installed: boolean;
  enabled: boolean;
  skillEnabled: boolean;
  version?: string;
  pluginDir: string;
};

type LicenseValidationCode =
  | 'valid'
  | 'empty'
  | 'format_invalid'
  | 'service_unconfigured'
  | 'network_error'
  | 'server_rejected'
  | 'cache_grace_valid'
  | 'expired'
  | 'device_mismatch'
  | 'not_allowed'
  | 'checksum_invalid';

type LicenseValidationCodeWithUnknown = LicenseValidationCode | 'unknown';

interface LicenseValidationResponse {
  valid: boolean;
  code: LicenseValidationCode;
  normalizedKey?: string;
  message?: string;
}

interface LicenseGateSnapshot {
  state: 'checking' | 'granted' | 'blocked';
  reason: string;
  checkedAtMs: number;
  hasStoredKey: boolean;
  hasUsableCache: boolean;
  nextRevalidateAtMs: number | null;
  lastValidation?: LicenseValidationResponse | null;
  renewalAlert?: 'near_expiry_renew_failed' | null;
}

interface DiagnosticsBundleResponse {
  zipPath: string;
  generatedAt: string;
  fileCount: number;
}

function maskLicenseKeyForDisplay(raw: string): string {
  const text = raw.trim();
  if (!text) {
    return '';
  }
  const visiblePrefix = 4;
  const visibleSuffix = 4;
  const plainChars = text.replace(/-/g, '').length;
  let shownPlainChars = 0;
  return text.split('').map((char) => {
    if (char === '-') {
      return '-';
    }
    shownPlainChars += 1;
    if (plainChars <= visiblePrefix + visibleSuffix) {
      return '*';
    }
    if (shownPlainChars <= visiblePrefix || shownPlainChars > plainChars - visibleSuffix) {
      return char;
    }
    return '*';
  }).join('');
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
  const { t } = useTranslation('settings');
  const location = useLocation();
  const navigate = useNavigate();
  const {
    theme,
    setTheme,
    language,
    setLanguage,
    userAvatarDataUrl,
    setUserAvatarDataUrl,
    clearUserAvatar,
    launchAtStartup,
    setLaunchAtStartup,
    gatewayAutoStart,
    setGatewayAutoStart,
    proxyEnabled,
    proxyServer,
    proxyHttpServer,
    proxyHttpsServer,
    proxyAllServer,
    proxyBypassRules,
    setProxyEnabled,
    setProxyServer,
    setProxyHttpServer,
    setProxyHttpsServer,
    setProxyAllServer,
    setProxyBypassRules,
    autoCheckUpdate,
    setAutoCheckUpdate,
    autoDownloadUpdate,
    setAutoDownloadUpdate,
    devModeUnlocked,
    setDevModeUnlocked,
  } = useSettingsStore();

  const { status: gatewayStatus, restart: restartGateway } = useGatewayStore();
  const updateSetAutoDownload = useUpdateStore((state) => state.setAutoDownload);
  const [controlUiInfo, setControlUiInfo] = useState<ControlUiInfo | null>(null);
  const [openclawCliCommand, setOpenclawCliCommand] = useState('');
  const [openclawCliError, setOpenclawCliError] = useState<string | null>(null);
  const [proxyServerDraft, setProxyServerDraft] = useState('');
  const [proxyHttpServerDraft, setProxyHttpServerDraft] = useState('');
  const [proxyHttpsServerDraft, setProxyHttpsServerDraft] = useState('');
  const [proxyAllServerDraft, setProxyAllServerDraft] = useState('');
  const [proxyBypassRulesDraft, setProxyBypassRulesDraft] = useState('');
  const [proxyEnabledDraft, setProxyEnabledDraft] = useState(false);
  const [showAdvancedProxy, setShowAdvancedProxy] = useState(false);
  const [savingProxy, setSavingProxy] = useState(false);
  const [wsDiagnosticEnabled, setWsDiagnosticEnabled] = useState(false);
  const [showTelemetryViewer, setShowTelemetryViewer] = useState(false);
  const [telemetryEntries, setTelemetryEntries] = useState<UiTelemetryEntry[]>([]);

  const isWindows = window.electron.platform === 'win32';
  const showCliTools = true;
  const [showLogs, setShowLogs] = useState(false);
  const [logContent, setLogContent] = useState('');
  const [collectingDiagnostics, setCollectingDiagnostics] = useState(false);
  const [lastDiagnosticsZipPath, setLastDiagnosticsZipPath] = useState('');
  const [lastDiagnosticsGeneratedAt, setLastDiagnosticsGeneratedAt] = useState('');
  const [lastDiagnosticsFileCount, setLastDiagnosticsFileCount] = useState(0);
  const [activeSection, setActiveSection] = useState<SettingsSectionKey>(
    () => parseSettingsSectionFromSearch(location.search) ?? DEFAULT_SETTINGS_SECTION
  );
  const userAvatarInputRef = useRef<HTMLInputElement | null>(null);
  const [taskPluginInfo, setTaskPluginInfo] = useState<TaskPluginInfo | null>(null);
  const [taskPluginBusy, setTaskPluginBusy] = useState(false);
  const [licenseKeyInput, setLicenseKeyInput] = useState('');
  const [licenseValidationCode, setLicenseValidationCode] = useState<LicenseValidationCodeWithUnknown | null>(null);
  const [licenseValidationMessage, setLicenseValidationMessage] = useState('');
  const [licenseBusy, setLicenseBusy] = useState(false);
  const [showLicenseKeyPlain, setShowLicenseKeyPlain] = useState(false);
  const [licenseGateSnapshot, setLicenseGateSnapshot] = useState<LicenseGateSnapshot>({
    state: 'checking',
    reason: 'init',
    checkedAtMs: 0,
    hasStoredKey: false,
    hasUsableCache: false,
    nextRevalidateAtMs: null,
    lastValidation: null,
    renewalAlert: null,
  });

  const handleShowLogs = async () => {
    try {
      const logs = await hostApiFetch<{ content: string }>('/api/logs?tailLines=100');
      setLogContent(logs.content);
      setShowLogs(true);
    } catch {
      setLogContent('(Failed to load logs)');
      setShowLogs(true);
    }
  };

  const handleOpenLogDir = async () => {
    try {
      const { dir: logDir } = await hostApiFetch<{ dir: string | null }>('/api/logs/dir');
      if (logDir) {
        await invokeIpc('shell:showItemInFolder', logDir);
      }
    } catch {
      // ignore
    }
  };

  const refreshLicenseGateSnapshot = useCallback(async () => {
    try {
      const snapshot = await hostApiFetch<LicenseGateSnapshot>('/api/license/gate');
      if (snapshot && typeof snapshot === 'object' && typeof snapshot.state === 'string') {
        setLicenseGateSnapshot(snapshot);
      }
    } catch {
      // ignore
    }
  }, []);

  const loadStoredLicenseKey = useCallback(async () => {
    try {
      const payload = await hostApiFetch<{ key: string | null }>('/api/license/stored-key');
      const storedKey = typeof payload.key === 'string' ? payload.key.trim() : '';
      if (storedKey) {
        setLicenseKeyInput(storedKey);
      }
    } catch {
      // ignore
    }
  }, []);

  const resolveLicenseMessage = useCallback((code: LicenseValidationCodeWithUnknown | null, fallbackMessage?: string) => {
    if (!code) {
      return '';
    }
    const localized = t(`license.messages.${code}`, { defaultValue: '' });
    if (localized) {
      return fallbackMessage ? `${localized}: ${fallbackMessage}` : localized;
    }
    if (fallbackMessage) {
      return fallbackMessage;
    }
    return t('license.messages.unknown');
  }, [t]);

  const applyLicenseResult = useCallback((result: LicenseValidationResponse | null) => {
    if (!result) {
      setLicenseValidationCode('unknown');
      setLicenseValidationMessage(t('license.messages.unknown'));
      return;
    }

    const nextCode: LicenseValidationCodeWithUnknown = result.code ?? 'unknown';
    setLicenseValidationCode(nextCode);
    const message = resolveLicenseMessage(nextCode, result.message);
    setLicenseValidationMessage(message);
    if (result.normalizedKey) {
      setLicenseKeyInput(result.normalizedKey);
    }
    if (result.valid) {
      if (result.code === 'cache_grace_valid') {
        toast.success(t('license.messages.cache_grace_valid'));
      } else {
        toast.success(t('license.messages.valid'));
      }
    } else {
      toast.error(message || t('license.messages.unknown'));
    }
  }, [resolveLicenseMessage, t]);

  const runValidateLicense = useCallback(async () => {
    setLicenseBusy(true);
    try {
      const result = await hostApiFetch<LicenseValidationResponse>('/api/license/validate', {
        method: 'POST',
        body: JSON.stringify({ key: licenseKeyInput }),
      });
      applyLicenseResult(result);
      await refreshLicenseGateSnapshot();
    } catch (error) {
      setLicenseValidationCode('unknown');
      setLicenseValidationMessage(resolveLicenseMessage('unknown', String(error)));
      toast.error(resolveLicenseMessage('unknown', String(error)));
    } finally {
      setLicenseBusy(false);
    }
  }, [applyLicenseResult, licenseKeyInput, refreshLicenseGateSnapshot, resolveLicenseMessage]);

  const handleValidateLicense = useCallback(() => {
    if (!licenseKeyInput.trim()) {
      setLicenseValidationCode('empty');
      setLicenseValidationMessage(resolveLicenseMessage('empty'));
      toast.error(resolveLicenseMessage('empty'));
      return;
    }
    void runValidateLicense();
  }, [licenseKeyInput, resolveLicenseMessage, runValidateLicense]);

  const handleForceRevalidate = useCallback(async () => {
    setLicenseBusy(true);
    try {
      const result = await hostApiFetch<LicenseValidationResponse>('/api/license/revalidate', {
        method: 'POST',
      });
      applyLicenseResult(result);
      await refreshLicenseGateSnapshot();
    } catch (error) {
      setLicenseValidationCode('unknown');
      setLicenseValidationMessage(resolveLicenseMessage('unknown', String(error)));
      toast.error(resolveLicenseMessage('unknown', String(error)));
    } finally {
      setLicenseBusy(false);
    }
  }, [applyLicenseResult, refreshLicenseGateSnapshot, resolveLicenseMessage]);

  const handleClearStoredLicense = useCallback(async () => {
    setLicenseBusy(true);
    try {
      await hostApiFetch('/api/license/clear', { method: 'POST' });
      setLicenseKeyInput('');
      setLicenseValidationCode(null);
      setLicenseValidationMessage('');
      setShowLicenseKeyPlain(false);
      await refreshLicenseGateSnapshot();
      toast.success(t('license.toast.cleared'));
    } catch (error) {
      toast.error(t('license.toast.clearFailed', { error: String(error) }));
    } finally {
      setLicenseBusy(false);
    }
  }, [refreshLicenseGateSnapshot, t]);

  const handleCollectDiagnosticsBundle = useCallback(async () => {
    setCollectingDiagnostics(true);
    try {
      const result = await hostApiFetch<DiagnosticsBundleResponse>('/api/diagnostics/collect', {
        method: 'POST',
      });
      if (!result || typeof result.zipPath !== 'string' || !result.zipPath.trim()) {
        throw new Error('invalid diagnostics bundle result');
      }
      setLastDiagnosticsZipPath(result.zipPath);
      setLastDiagnosticsGeneratedAt(result.generatedAt);
      setLastDiagnosticsFileCount(result.fileCount);
      toast.success(t('diagnostics.toast.success', { count: result.fileCount }));
    } catch (error) {
      toast.error(t('diagnostics.toast.failed', { error: String(error) }));
    } finally {
      setCollectingDiagnostics(false);
    }
  }, [t]);

  const handleOpenDiagnosticsBundleFolder = useCallback(async () => {
    if (!lastDiagnosticsZipPath) {
      return;
    }
    try {
      await invokeIpc('shell:showItemInFolder', lastDiagnosticsZipPath);
    } catch (error) {
      toast.error(t('diagnostics.toast.openFailed', { error: String(error) }));
    }
  }, [lastDiagnosticsZipPath, t]);

  const loadTaskPluginStatus = useCallback(async (silent = true) => {
    try {
      const status = await getTaskPluginStatus();
      setTaskPluginInfo(status);
    } catch (error) {
      if (!silent) {
        toast.error(t('taskPlugin.toastStatusFailed', { error: String(error) }));
      }
    }
  }, [t]);

  const handleInstallTaskPlugin = useCallback(async () => {
    setTaskPluginBusy(true);
    try {
      const result = await installTaskPlugin();
      if (!result.success) {
        toast.error(t('taskPlugin.toastInstallFailed', { error: result.error || 'unknown error' }));
        return;
      }
      toast.success(t('taskPlugin.toastInstallSuccess'));
      await loadTaskPluginStatus(true);
    } catch (error) {
      toast.error(t('taskPlugin.toastInstallFailed', { error: String(error) }));
    } finally {
      setTaskPluginBusy(false);
    }
  }, [loadTaskPluginStatus, t]);

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
      setUserAvatarDataUrl(squareAvatarDataUrl);
      toast.success(t('appearance.avatarUpdated'));
    } catch (error) {
      toast.error(t('appearance.avatarUpdateFailed', { error: String(error) }));
    }
  };

  const handleClearAvatar = () => {
    clearUserAvatar();
    if (userAvatarInputRef.current) {
      userAvatarInputRef.current.value = '';
    }
    toast.success(t('appearance.avatarCleared'));
  };

  // Open developer console
  const openDevConsole = async () => {
    try {
      const result = await hostApiFetch<{
        success: boolean;
        url?: string;
        token?: string;
        port?: number;
        error?: string;
      }>('/api/gateway/control-ui');
      if (result.success && result.url && result.token && typeof result.port === 'number') {
        setControlUiInfo({ url: result.url, token: result.token, port: result.port });
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
        token?: string;
        port?: number;
      }>('/api/gateway/control-ui');
      if (result.success && result.url && result.token && typeof result.port === 'number') {
        setControlUiInfo({ url: result.url, token: result.token, port: result.port });
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
        const result = await invokeIpc<{
          success: boolean;
          command?: string;
          error?: string;
        }>('openclaw:getCliCommand');
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
    const unsubscribe = window.electron.ipcRenderer.on(
      'openclaw:cli-installed',
      (...args: unknown[]) => {
        const installedPath = typeof args[0] === 'string' ? args[0] : '';
        toast.success(`openclaw CLI installed at ${installedPath}`);
      },
    );
    return () => { unsubscribe?.(); };
  }, []);

  useEffect(() => {
    setWsDiagnosticEnabled(getGatewayWsDiagnosticEnabled());
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
    setProxyHttpServerDraft(proxyHttpServer);
  }, [proxyHttpServer]);

  useEffect(() => {
    setProxyHttpsServerDraft(proxyHttpsServer);
  }, [proxyHttpsServer]);

  useEffect(() => {
    setProxyAllServerDraft(proxyAllServer);
  }, [proxyAllServer]);

  useEffect(() => {
    setProxyBypassRulesDraft(proxyBypassRules);
  }, [proxyBypassRules]);

  useEffect(() => {
    void loadTaskPluginStatus(true);
  }, [loadTaskPluginStatus]);

  useEffect(() => {
    void refreshLicenseGateSnapshot();
    void loadStoredLicenseKey();
  }, [refreshLicenseGateSnapshot, loadStoredLicenseKey]);

  useEffect(() => {
    if (activeSection !== 'license') {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshLicenseGateSnapshot();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [activeSection, refreshLicenseGateSnapshot]);

  useEffect(() => {
    const sectionFromQuery = parseSettingsSectionFromSearch(location.search);
    if (!sectionFromQuery) {
      return;
    }
    setActiveSection((prev) => (prev === sectionFromQuery ? prev : sectionFromQuery));
  }, [location.search]);

  const handleSaveProxySettings = async () => {
    setSavingProxy(true);
    try {
      const normalizedProxyServer = proxyServerDraft.trim();
      const normalizedHttpServer = proxyHttpServerDraft.trim();
      const normalizedHttpsServer = proxyHttpsServerDraft.trim();
      const normalizedAllServer = proxyAllServerDraft.trim();
      const normalizedBypassRules = proxyBypassRulesDraft.trim();
      await invokeIpc('settings:setMany', {
        proxyEnabled: proxyEnabledDraft,
        proxyServer: normalizedProxyServer,
        proxyHttpServer: normalizedHttpServer,
        proxyHttpsServer: normalizedHttpsServer,
        proxyAllServer: normalizedAllServer,
        proxyBypassRules: normalizedBypassRules,
      });

      setProxyServer(normalizedProxyServer);
      setProxyHttpServer(normalizedHttpServer);
      setProxyHttpsServer(normalizedHttpsServer);
      setProxyAllServer(normalizedAllServer);
      setProxyBypassRules(normalizedBypassRules);
      setProxyEnabled(proxyEnabledDraft);

      toast.success(t('gateway.proxySaved'));
      trackUiEvent('settings.proxy_saved', { enabled: proxyEnabledDraft });
    } catch (error) {
      toast.error(`${t('gateway.proxySaveFailed')}: ${toUserMessage(error)}`);
    } finally {
      setSavingProxy(false);
    }
  };

  const telemetryStats = useMemo(() => {
    let errorCount = 0;
    let slowCount = 0;
    for (const entry of telemetryEntries) {
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
    return { total: telemetryEntries.length, errorCount, slowCount };
  }, [telemetryEntries]);

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

    for (const entry of telemetryEntries) {
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
  }, [telemetryEntries]);

  const handleCopyTelemetry = async () => {
    try {
      const serialized = telemetryEntries.map((entry) => JSON.stringify(entry)).join('\n');
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

  const handleWsDiagnosticToggle = (enabled: boolean) => {
    setGatewayWsDiagnosticEnabled(enabled);
    setWsDiagnosticEnabled(enabled);
    toast.success(
      enabled
        ? t('developer.wsDiagnosticEnabled')
        : t('developer.wsDiagnosticDisabled'),
    );
  };

  const taskPluginReady = Boolean(taskPluginInfo?.installed && taskPluginInfo?.enabled && taskPluginInfo?.skillEnabled);

  const taskPluginBadgeVariant = !taskPluginInfo?.installed
    ? 'secondary'
    : taskPluginReady
      ? 'success'
      : 'destructive';

  const taskPluginStatusLabel = !taskPluginInfo?.installed
    ? t('taskPlugin.notInstalled')
    : taskPluginReady
      ? t('taskPlugin.installedEnabled')
      : t('taskPlugin.installedDisabled');

  const sectionItems: Array<{ key: SettingsSectionKey; label: string }> = [
    { key: 'gateway', label: t('gateway.title') },
    { key: 'appearance', label: t('appearance.title') },
    { key: 'aiProviders', label: t('aiProviders.title') },
    { key: 'taskPlugin', label: t('taskPlugin.title') },
    { key: 'updates', label: t('updates.title') },
    { key: 'advanced', label: t('advanced.title') },
    { key: 'license', label: t('license.title') },
    { key: 'diagnostics', label: t('diagnostics.title') },
  ];

  return (
    <div className="flex flex-col gap-6 p-6">
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
                  onClick={() => {
                    setActiveSection(section.key);
                    const params = new URLSearchParams(location.search);
                    params.set('section', section.key);
                    const nextSearch = params.toString();
                    navigate(
                      {
                        pathname: location.pathname,
                        search: nextSearch ? `?${nextSearch}` : '',
                      },
                      { replace: true },
                    );
                  }}
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
          {activeSection === 'license' && (
            <Card className="order-2">
              <CardHeader>
                <CardTitle>{t('license.title')}</CardTitle>
                <CardDescription>{t('license.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 p-3">
                  <div>
                    <Label>{t('license.gateStatus')}</Label>
                    {licenseGateSnapshot.renewalAlert ? (
                      <p className="mt-1 text-xs text-amber-600">
                        {t(`license.renewAlert.${licenseGateSnapshot.renewalAlert}`)}
                      </p>
                    ) : null}
                  </div>
                  <Badge
                    variant={
                      licenseGateSnapshot.state === 'granted'
                        ? 'success'
                        : licenseGateSnapshot.state === 'blocked'
                          ? 'destructive'
                          : 'secondary'
                    }
                  >
                    {t(`license.gateState.${licenseGateSnapshot.state}`)}
                  </Badge>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="settings-license-key">{t('license.inputLabel')}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="settings-license-key"
                      value={showLicenseKeyPlain ? licenseKeyInput : maskLicenseKeyForDisplay(licenseKeyInput)}
                      placeholder={t('license.placeholder')}
                      readOnly={!showLicenseKeyPlain && licenseGateSnapshot.hasStoredKey && Boolean(licenseKeyInput)}
                      onChange={(event) => {
                        setLicenseKeyInput(event.target.value);
                        setLicenseValidationCode(null);
                        setLicenseValidationMessage('');
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          handleValidateLicense();
                        }
                      }}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowLicenseKeyPlain((prev) => !prev)}
                      title={showLicenseKeyPlain ? t('license.hideKey') : t('license.showKey')}
                      aria-label={showLicenseKeyPlain ? t('license.hideKey') : t('license.showKey')}
                    >
                      {showLicenseKeyPlain ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  {(licenseValidationMessage || licenseValidationCode) ? (
                    <p
                      className={
                        licenseValidationCode === 'valid' || licenseValidationCode === 'cache_grace_valid'
                          ? 'text-xs text-green-500'
                          : licenseValidationCode
                            ? 'text-xs text-destructive'
                            : 'text-xs text-muted-foreground'
                      }
                    >
                      {licenseValidationMessage || resolveLicenseMessage(licenseValidationCode)}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={handleValidateLicense} disabled={licenseBusy}>
                    {licenseBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {t('license.validate')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      void handleForceRevalidate();
                    }}
                    disabled={licenseBusy || !licenseGateSnapshot.hasStoredKey}
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {t('license.revalidate')}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => {
                      void handleClearStoredLicense();
                    }}
                    disabled={licenseBusy || (!licenseGateSnapshot.hasStoredKey && !licenseGateSnapshot.hasUsableCache)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t('license.clear')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

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
                onClick={() => setTheme('light')}
              >
                <Sun className="h-4 w-4 mr-2" />
                {t('appearance.light')}
              </Button>
              <Button
                variant={theme === 'dark' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTheme('dark')}
              >
                <Moon className="h-4 w-4 mr-2" />
                {t('appearance.dark')}
              </Button>
              <Button
                variant={theme === 'system' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTheme('system')}
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
                  onClick={() => setLanguage(lang.code)}
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
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-[15px] font-medium text-foreground/80">{t('appearance.launchAtStartup')}</Label>
                  <p className="text-[13px] text-muted-foreground mt-1">
                    {t('appearance.launchAtStartupDesc')}
                  </p>
                </div>
                <Switch
                  checked={launchAtStartup}
                  onCheckedChange={setLaunchAtStartup}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('appearance.userAvatarHint')}
            </p>
          </div>
        </CardContent>
      </Card>
          )}

      {/* AI Providers */}
      {activeSection === 'aiProviders' && (
      <Card className="order-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            {t('aiProviders.title')}
          </CardTitle>
          <CardDescription>{t('aiProviders.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ProvidersSettings />
        </CardContent>
      </Card>
      )}

      {/* Gateway */}
      {activeSection === 'gateway' && (
      <Card className="order-1">
        <CardHeader>
          <CardTitle>{t('gateway.title')}</CardTitle>
          <CardDescription>{t('gateway.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('gateway.status')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('gateway.port')}: {gatewayStatus.port}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  gatewayStatus.state === 'running'
                    ? 'success'
                    : gatewayStatus.state === 'error'
                      ? 'destructive'
                      : 'secondary'
                }
              >
                {gatewayStatus.state}
              </Badge>
              <Button variant="outline" size="sm" onClick={restartGateway}>
                <RefreshCw className="h-4 w-4 mr-2" />
                {t('common:actions.restart')}
              </Button>
              <Button variant="outline" size="sm" onClick={handleShowLogs}>
                <FileText className="h-4 w-4 mr-2" />
                {t('gateway.logs')}
              </Button>
            </div>
          </div>

          {showLogs && (
            <div className="mt-4 p-4 rounded-lg bg-black/10 dark:bg-black/40 border border-border">
              <div className="flex items-center justify-between mb-2">
                <p className="font-medium text-sm">{t('gateway.appLogs')}</p>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleOpenLogDir}>
                    <ExternalLink className="h-3 w-3 mr-1" />
                    {t('gateway.openFolder')}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowLogs(false)}>
                    {t('common:actions.close')}
                  </Button>
                </div>
              </div>
              <pre className="text-xs text-muted-foreground bg-background/50 p-3 rounded max-h-60 overflow-auto whitespace-pre-wrap font-mono">
                {logContent || t('chat:noLogs')}
              </pre>
            </div>
          )}

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
              onCheckedChange={setGatewayAutoStart}
            />
          </div>

          <Separator />

          {devModeUnlocked ? (
            <div className="space-y-4">
              <div className="rounded-md border border-border/60 p-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => setShowAdvancedProxy((prev) => !prev)}
                >
                  {showAdvancedProxy ? (
                    <ChevronDown className="h-4 w-4 mr-2" />
                  ) : (
                    <ChevronRight className="h-4 w-4 mr-2" />
                  )}
                  {showAdvancedProxy ? t('gateway.hideAdvancedProxy') : t('gateway.showAdvancedProxy')}
                </Button>
                {showAdvancedProxy && (
                  <div className="mt-3 space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <Label>{t('gateway.proxyTitle')}</Label>
                        <p className="text-sm text-muted-foreground">
                          {t('gateway.proxyDesc')}
                        </p>
                      </div>
                      <Switch
                        checked={proxyEnabledDraft}
                        onCheckedChange={setProxyEnabledDraft}
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
                      <Label htmlFor="proxy-http-server">{t('gateway.proxyHttpServer')}</Label>
                      <Input
                        id="proxy-http-server"
                        value={proxyHttpServerDraft}
                        onChange={(event) => setProxyHttpServerDraft(event.target.value)}
                        placeholder={proxyServerDraft || 'http://127.0.0.1:7890'}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('gateway.proxyHttpServerHelp')}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="proxy-https-server">{t('gateway.proxyHttpsServer')}</Label>
                      <Input
                        id="proxy-https-server"
                        value={proxyHttpsServerDraft}
                        onChange={(event) => setProxyHttpsServerDraft(event.target.value)}
                        placeholder={proxyServerDraft || 'http://127.0.0.1:7890'}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('gateway.proxyHttpsServerHelp')}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="proxy-all-server">{t('gateway.proxyAllServer')}</Label>
                      <Input
                        id="proxy-all-server"
                        value={proxyAllServerDraft}
                        onChange={(event) => setProxyAllServerDraft(event.target.value)}
                        placeholder={proxyServerDraft || 'socks5://127.0.0.1:7891'}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('gateway.proxyAllServerHelp')}
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

                    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/40 p-3">
                      <p className="text-sm text-muted-foreground">
                        {t('gateway.proxyRestartNote')}
                      </p>
                      <Button
                        variant="outline"
                        onClick={handleSaveProxySettings}
                        disabled={savingProxy}
                      >
                        <RefreshCw className={`h-4 w-4 mr-2${savingProxy ? ' animate-spin' : ''}`} />
                        {savingProxy ? t('common:status.saving') : t('common:actions.save')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground">
              {t('advanced.devModeDesc')}
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* Task Plugin */}
      {activeSection === 'taskPlugin' && (
      <Card className="order-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wrench className="h-5 w-5" />
            {t('taskPlugin.title')}
          </CardTitle>
          <CardDescription>{t('taskPlugin.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <Label>{t('taskPlugin.status')}</Label>
              <div className="flex items-center gap-2">
                <Badge variant={taskPluginBadgeVariant}>{taskPluginStatusLabel}</Badge>
                {taskPluginInfo?.version ? (
                  <span className="text-xs text-muted-foreground">
                    {t('taskPlugin.version')}: {taskPluginInfo.version}
                  </span>
                ) : null}
              </div>
              {taskPluginInfo?.installed ? (
                <p className="text-xs text-muted-foreground">
                  Skill `task-manager`: {taskPluginInfo.skillEnabled ? 'enabled' : 'disabled'}
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => void loadTaskPluginStatus(false)}
                disabled={taskPluginBusy}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('taskPlugin.refresh')}
              </Button>
              <Button onClick={() => void handleInstallTaskPlugin()} disabled={taskPluginBusy}>
                <Wrench className="mr-2 h-4 w-4" />
                {taskPluginInfo?.installed ? t('taskPlugin.reinstall') : t('taskPlugin.install')}
              </Button>
            </div>
          </div>

          {taskPluginInfo?.pluginDir ? (
            <div className="space-y-1">
              <Label>{t('taskPlugin.path')}</Label>
              <Input readOnly value={taskPluginInfo.pluginDir} className="font-mono" />
            </div>
          ) : null}
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
              onCheckedChange={setAutoCheckUpdate}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>{t('updates.autoDownload')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('updates.autoDownloadDesc')}
              </p>
            </div>
            <Switch
              checked={autoDownloadUpdate}
              onCheckedChange={(value) => {
                setAutoDownloadUpdate(value);
                updateSetAutoDownload(value);
              }}
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
            <Button
              variant="outline"
              onClick={() => {
                void handleOpenDiagnosticsBundleFolder();
              }}
              disabled={!lastDiagnosticsZipPath}
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              {t('diagnostics.openFolder')}
            </Button>
          </div>

          {lastDiagnosticsZipPath ? (
            <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3">
              <Label>{t('diagnostics.lastBundle')}</Label>
              <Input readOnly value={lastDiagnosticsZipPath} className="font-mono" />
              <p className="text-xs text-muted-foreground">
                {t('diagnostics.lastMeta', {
                  generatedAt: lastDiagnosticsGeneratedAt || '-',
                  count: lastDiagnosticsFileCount,
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
              onCheckedChange={setDevModeUnlocked}
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

            <Separator />
            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-md border border-border/60 p-3">
                <div>
                  <Label>{t('developer.wsDiagnostic')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('developer.wsDiagnosticDesc')}
                  </p>
                </div>
                <Switch
                  checked={wsDiagnosticEnabled}
                  onCheckedChange={handleWsDiagnosticToggle}
                />
              </div>

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
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{t('developer.telemetryTotal')}: {telemetryStats.total}</Badge>
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

                  <div className="max-h-72 overflow-auto rounded-md border border-border/50 bg-muted/20">
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
                    <div className="space-y-1 p-2 font-mono text-xs">
                      {telemetryEntries.length === 0 ? (
                        <div className="text-muted-foreground">{t('developer.telemetryEmpty')}</div>
                      ) : (
                        telemetryEntries
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
                  </div>
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
