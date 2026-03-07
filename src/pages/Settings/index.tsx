/**
 * Settings Page
 * Application configuration
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Sun,
  Moon,
  Monitor,
  RefreshCw,
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
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '@/i18n';
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
  const currentVersion = useUpdateStore((state) => state.currentVersion);
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
  const [savingProxy, setSavingProxy] = useState(false);

  const isWindows = window.electron.platform === 'win32';
  const showCliTools = true;
  const [showLogs, setShowLogs] = useState(false);
  const [logContent, setLogContent] = useState('');
  const [activeSection, setActiveSection] = useState<SettingsSectionKey>(
    () => parseSettingsSectionFromSearch(location.search) ?? DEFAULT_SETTINGS_SECTION
  );
  const userAvatarInputRef = useRef<HTMLInputElement | null>(null);
  const [taskPluginInfo, setTaskPluginInfo] = useState<TaskPluginInfo | null>(null);
  const [taskPluginBusy, setTaskPluginBusy] = useState(false);

  const handleShowLogs = async () => {
    try {
      const logs = await window.electron.ipcRenderer.invoke('log:readFile', 100) as string;
      setLogContent(logs);
      setShowLogs(true);
    } catch {
      setLogContent('(Failed to load logs)');
      setShowLogs(true);
    }
  };

  const handleOpenLogDir = async () => {
    try {
      const logDir = await window.electron.ipcRenderer.invoke('log:getDir') as string;
      if (logDir) {
        await window.electron.ipcRenderer.invoke('shell:showItemInFolder', logDir);
      }
    } catch {
      // ignore
    }
  };
  const loadTaskPluginStatus = async (silent = true) => {
    try {
      const status = await getTaskPluginStatus();
      setTaskPluginInfo(status);
    } catch (error) {
      if (!silent) {
        toast.error(t('taskPlugin.toastStatusFailed', { error: String(error) }));
      }
    }
  };

  const handleInstallTaskPlugin = async () => {
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
  };

  // Open developer console
  const openDevConsole = async () => {
    try {
      const result = await window.electron.ipcRenderer.invoke('gateway:getControlUiUrl') as {
        success: boolean;
        url?: string;
        token?: string;
        port?: number;
        error?: string;
      };
      if (result.success && result.url && result.token && typeof result.port === 'number') {
        setControlUiInfo({ url: result.url, token: result.token, port: result.port });
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
      const result = await window.electron.ipcRenderer.invoke('gateway:getControlUiUrl') as {
        success: boolean;
        url?: string;
        token?: string;
        port?: number;
      };
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
        const result = await window.electron.ipcRenderer.invoke('openclaw:getCliCommand') as {
          success: boolean;
          command?: string;
          error?: string;
        };
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

  const handleAvatarFileSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    // 允许重复选择同一文件
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

  const handleSaveProxySettings = async () => {
    setSavingProxy(true);
    try {
      const normalizedProxyServer = proxyServerDraft.trim();
      const normalizedHttpServer = proxyHttpServerDraft.trim();
      const normalizedHttpsServer = proxyHttpsServerDraft.trim();
      const normalizedAllServer = proxyAllServerDraft.trim();
      const normalizedBypassRules = proxyBypassRulesDraft.trim();
      await window.electron.ipcRenderer.invoke('settings:setMany', {
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
    } catch (error) {
      toast.error(`${t('gateway.proxySaveFailed')}: ${String(error)}`);
    } finally {
      setSavingProxy(false);
    }
  };

  useEffect(() => {
    void loadTaskPluginStatus(true);
  }, []);

  useEffect(() => {
    const sectionFromQuery = parseSettingsSectionFromSearch(location.search);
    if (!sectionFromQuery) {
      return;
    }
    setActiveSection((prev) => (prev === sectionFromQuery ? prev : sectionFromQuery));
  }, [location.search]);

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
    { key: 'about', label: t('about.title') },
  ];

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <Card className="h-fit border-border/60 bg-card/80">
          <CardContent className="p-2.5">
            <p className="px-2.5 pb-2 text-xs font-medium tracking-wide text-muted-foreground">
              {t('title')}
            </p>
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

        <div>

      {/* Appearance */}
      {activeSection === 'appearance' && (
      <Card>
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
      <Card>
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
      <Card>
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

          <div className="space-y-4">
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

            {devModeUnlocked && (
              <>
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
              </>
            )}

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
        </CardContent>
      </Card>
      )}

      {/* Task Plugin */}
      {activeSection === 'taskPlugin' && (
      <Card>
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
              <Button onClick={handleInstallTaskPlugin} disabled={taskPluginBusy}>
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
      <Card>
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

      {/* Advanced */}
      {activeSection === 'advanced' && (
      <Card>
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
          {devModeUnlocked && (
            <>
              <Separator />
              <div className="space-y-1">
                <h3 className="text-base font-semibold">{t('developer.title')}</h3>
                <p className="text-sm text-muted-foreground">{t('developer.description')}</p>
              </div>

              <div className="space-y-4">
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
              </div>
            </>
          )}
        </CardContent>
      </Card>
      )}

      {/* About */}
      {activeSection === 'about' && (
      <Card>
        <CardHeader>
          <CardTitle>{t('about.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong>{t('about.appName')}</strong> - {t('about.tagline')}
          </p>
          <p>{t('about.basedOn')}</p>
          <p>{t('about.version', { version: currentVersion })}</p>
          <div className="flex gap-4 pt-2">
            <Button
              variant="link"
              className="h-auto p-0"
              onClick={() => window.electron.openExternal('https://claw-x.com')}
            >
              {t('about.docs')}
            </Button>
            <Button
              variant="link"
              className="h-auto p-0"
              onClick={() => window.electron.openExternal('https://github.com/ValueCell-ai/ClawX')}
            >
              {t('about.github')}
            </Button>
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
