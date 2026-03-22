/**
 * IPC Handlers
 * Registers all IPC handlers for main-renderer communication
 */
import { ipcMain, BrowserWindow, shell, dialog, app, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, basename, isAbsolute, resolve as resolvePath } from 'node:path';
import crypto from 'node:crypto';
import { GatewayManager } from '../gateway/manager';
import { ClawHubService, ClawHubSearchParams, ClawHubInstallParams, ClawHubUninstallParams } from '../gateway/clawhub';
import { getOpenClawConfigDir, expandPath } from '../utils/paths';
import { getAllSettings, getSetting, resetSettings, setSetting, type AppSettings } from '../utils/store';
import { logger } from '../utils/logger';
import { checkUvInstalled, installUv, setupManagedPython } from '../utils/uv-setup';
import { whatsAppLoginManager } from '../utils/whatsapp-login';
import { weixinLoginManager } from '../utils/weixin-login';
import { deviceOAuthManager } from '../utils/device-oauth';
import { browserOAuthManager } from '../utils/browser-oauth';
import { applyProxySettings } from './proxy';
import { syncLaunchAtStartupSettingFromStore } from './launch-at-startup';
import { proxyAwareFetch } from '../utils/proxy-fetch';
import { getRecentTokenUsageHistory } from '../utils/token-usage';
import { getProviderService } from '../services/providers/provider-service';
import { appUpdater } from './updater';
import { registerTeamIpcHandlers } from './team-ipc-handlers';
import { getPort } from '../utils/config';
import type { PlatformRuntimeFacade } from './platform-ipc-facade';
import type { RegistryQuery, ToolSource } from '../core/contracts';
import { registerSkillConfigHandlers } from '../adapters/platform/ipc/skill-config-ipc';
import { registerCronHandlers, transformCronJob, type GatewayCronJob } from '../adapters/platform/ipc/cron-ipc';
import { registerGatewayHandlers } from '../adapters/platform/ipc/gateway-ipc';
import { registerOpenClawHandlers } from '../adapters/platform/ipc/openclaw-ipc';
import { registerProviderHandlers } from '../adapters/platform/ipc/provider-ipc';

type AppRequest = {
  id?: string;
  module: string;
  action: string;
  payload?: unknown;
};

type AppErrorCode = 'VALIDATION' | 'PERMISSION' | 'TIMEOUT' | 'GATEWAY' | 'INTERNAL' | 'UNSUPPORTED';

type AppResponse = {
  id?: string;
  ok: boolean;
  data?: unknown;
  error?: {
    code: AppErrorCode;
    message: string;
    details?: unknown;
  };
};

/**
 * Register all IPC handlers
 */
export function registerIpcHandlers(
  gatewayManager: GatewayManager,
  clawHubService: ClawHubService,
  mainWindow: BrowserWindow,
  platformFacade?: PlatformRuntimeFacade,
): void {
  // Unified request protocol
  registerUnifiedRequestHandlers(gatewayManager, platformFacade);

  // Host API proxy handlers
  registerHostApiProxyHandlers();

  // Gateway handlers
  registerGatewayHandlers(gatewayManager, mainWindow, platformFacade);

  // ClawHub handlers
  registerClawHubHandlers(clawHubService);

  // OpenClaw handlers
  registerOpenClawHandlers(gatewayManager);

  // Provider handlers
  registerProviderHandlers(gatewayManager);

  // Shell handlers
  registerShellHandlers();

  // Dialog handlers
  registerDialogHandlers();

  // Session handlers
  registerSessionHandlers();

  // App handlers
  registerAppHandlers();

  // Settings handlers
  registerSettingsHandlers(gatewayManager);

  // UV handlers
  registerUvHandlers();

  // Log handlers (for UI to read gateway/app logs)
  registerLogHandlers();

  // Usage handlers
  registerUsageHandlers();

  // Skill config handlers (direct file access, no Gateway RPC)
  registerSkillConfigHandlers();

  // Cron task handlers (proxy to Gateway RPC)
  registerCronHandlers(gatewayManager);

  // Window control handlers (for custom title bar on Windows/Linux)
  registerWindowHandlers(mainWindow);

  // WhatsApp handlers
  registerChannelQrHandlers(mainWindow);

  // Device OAuth handlers (Code Plan)
  registerDeviceOAuthHandlers(mainWindow);

  // File staging handlers (upload/send separation)
  registerFileHandlers();

  // Team runtime handlers (pull-claim + mailbox)
  registerTeamIpcHandlers();
}

function registerHostApiProxyHandlers(): void {
  type HostApiFetchRequest = {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  };

  ipcMain.handle('hostapi:fetch', async (_, request: HostApiFetchRequest) => {
    try {
      const port = getPort('MATCHACLAW_HOST_API');
      const normalizedPath = request?.path
        ? (request.path.startsWith('/') ? request.path : `/${request.path}`)
        : '/';
      const method = (request?.method || 'GET').toUpperCase();
      const timeoutMs =
        typeof request?.timeoutMs === 'number' && request.timeoutMs > 0
          ? request.timeoutMs
          : 15000;

      const headers: Record<string, string> = { ...(request?.headers ?? {}) };
      let body: string | undefined;
      if (request?.body !== undefined && request.body !== null && method !== 'GET' && method !== 'HEAD') {
        body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Awaited<ReturnType<typeof proxyAwareFetch>>;
      try {
        response = await proxyAwareFetch(`http://127.0.0.1:${port}${normalizedPath}`, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json')) {
        const json = await response.json();
        return {
          ok: true,
          data: {
            status: response.status,
            ok: response.ok,
            json,
          },
        };
      }

      const text = await response.text();
      return {
        ok: true,
        data: {
          status: response.status,
          ok: response.ok,
          text,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: { message: String(error) },
      };
    }
  });
}

function mapAppErrorCode(error: unknown): AppErrorCode {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (msg.includes('timeout')) return 'TIMEOUT';
  if (msg.includes('permission') || msg.includes('denied') || msg.includes('forbidden')) return 'PERMISSION';
  if (msg.includes('gateway')) return 'GATEWAY';
  if (msg.includes('invalid') || msg.includes('required')) return 'VALIDATION';
  return 'INTERNAL';
}

function isProxyKey(key: keyof AppSettings): boolean {
  return (
    key === 'proxyEnabled' ||
    key === 'proxyServer' ||
    key === 'proxyBypassRules'
  );
}

function isLaunchAtStartupKey(key: keyof AppSettings): boolean {
  return key === 'launchAtStartup';
}

function registerUnifiedRequestHandlers(
  gatewayManager: GatewayManager,
  platformFacade?: PlatformRuntimeFacade,
): void {
  const providerService = getProviderService();
  const handleProxySettingsChange = async () => {
    const settings = await getAllSettings();
    await applyProxySettings(settings);
    if (gatewayManager.getStatus().state === 'running') {
      await gatewayManager.restart();
    }
  };

  ipcMain.handle('app:request', async (_, request: AppRequest): Promise<AppResponse> => {
    if (!request || typeof request.module !== 'string' || typeof request.action !== 'string') {
      return {
        id: request?.id,
        ok: false,
        error: { code: 'VALIDATION', message: 'Invalid app request format' },
      };
    }

    try {
      let data: unknown;
      switch (request.module) {
        case 'app': {
          if (request.action === 'version') data = app.getVersion();
          else if (request.action === 'name') data = app.getName();
          else if (request.action === 'platform') data = process.platform;
          else {
            return {
              id: request.id,
              ok: false,
              error: {
                code: 'UNSUPPORTED',
                message: `APP_REQUEST_UNSUPPORTED:${request.module}.${request.action}`,
              },
            };
          }
          break;
        }
        case 'provider': {
          if (request.action === 'listAccounts') {
            data = await providerService.listAccounts();
            break;
          }
          if (request.action === 'listVendors') {
            data = await providerService.listVendors();
            break;
          }
          if (request.action === 'listAccountStatuses') {
            data = await providerService.listAccountStatuses();
            break;
          }
          if (request.action === 'getAccount') {
            const payload = request.payload as { accountId?: string } | string | undefined;
            const accountId = typeof payload === 'string' ? payload : payload?.accountId;
            if (!accountId) throw new Error('Invalid provider.getAccount payload');
            data = await providerService.getAccount(accountId);
            break;
          }
          if (request.action === 'getDefaultAccountId') {
            data = await providerService.getDefaultAccountId();
            break;
          }
          if (request.action === 'hasAccountApiKey') {
            const payload = request.payload as { accountId?: string } | string | undefined;
            const accountId = typeof payload === 'string' ? payload : payload?.accountId;
            if (!accountId) throw new Error('Invalid provider.hasAccountApiKey payload');
            data = await providerService.hasAccountApiKey(accountId);
            break;
          }
          if (request.action === 'getAccountApiKey') {
            const payload = request.payload as { accountId?: string } | string | undefined;
            const accountId = typeof payload === 'string' ? payload : payload?.accountId;
            if (!accountId) throw new Error('Invalid provider.getAccountApiKey payload');
            data = await providerService.getAccountApiKey(accountId);
            break;
          }
          if (request.action === 'setDefaultAccount') {
            const payload = request.payload as { accountId?: string } | string | undefined;
            const accountId = typeof payload === 'string' ? payload : payload?.accountId;
            if (!accountId) throw new Error('Invalid provider.setDefaultAccount payload');
            await providerService.setDefaultAccount(accountId);
            data = { success: true };
            break;
          }
          return {
            id: request.id,
            ok: false,
            error: {
              code: 'UNSUPPORTED',
              message: `APP_REQUEST_UNSUPPORTED:${request.module}.${request.action}`,
            },
          };
        }
        case 'update': {
          if (request.action === 'status') {
            data = appUpdater.getStatus();
            break;
          }
          if (request.action === 'version') {
            data = appUpdater.getCurrentVersion();
            break;
          }
          if (request.action === 'check') {
            try {
              await appUpdater.checkForUpdates();
              data = { success: true, status: appUpdater.getStatus() };
            } catch (error) {
              data = { success: false, error: String(error), status: appUpdater.getStatus() };
            }
            break;
          }
          if (request.action === 'download') {
            try {
              await appUpdater.downloadUpdate();
              data = { success: true };
            } catch (error) {
              data = { success: false, error: String(error) };
            }
            break;
          }
          if (request.action === 'install') {
            appUpdater.quitAndInstall();
            data = { success: true };
            break;
          }
          if (request.action === 'setChannel') {
            const payload = request.payload as { channel?: 'stable' | 'beta' | 'dev' } | 'stable' | 'beta' | 'dev' | undefined;
            const channel = typeof payload === 'string' ? payload : payload?.channel;
            if (!channel) throw new Error('Invalid update.setChannel payload');
            appUpdater.setChannel(channel);
            data = { success: true };
            break;
          }
          if (request.action === 'setAutoDownload') {
            const payload = request.payload as { enable?: boolean } | boolean | undefined;
            const enable = typeof payload === 'boolean' ? payload : payload?.enable;
            if (typeof enable !== 'boolean') throw new Error('Invalid update.setAutoDownload payload');
            appUpdater.setAutoDownload(enable);
            data = { success: true };
            break;
          }
          if (request.action === 'cancelAutoInstall') {
            appUpdater.cancelAutoInstall();
            data = { success: true };
            break;
          }
          return {
            id: request.id,
            ok: false,
            error: {
              code: 'UNSUPPORTED',
              message: `APP_REQUEST_UNSUPPORTED:${request.module}.${request.action}`,
            },
          };
        }
        case 'platform': {
          if (!platformFacade) {
            return {
              id: request.id,
              ok: false,
              error: {
                code: 'UNSUPPORTED',
                message: 'APP_REQUEST_UNSUPPORTED:platform.facade_missing',
              },
            };
          }

          if (request.action === 'runtimeHealth') {
            data = await platformFacade.runtimeHealth();
            break;
          }
          if (request.action === 'installNativeTool') {
            const payload = request.payload as { source?: ToolSource } | undefined;
            if (!payload?.source) throw new Error('Invalid platform.installNativeTool payload');
            data = await platformFacade.installNativeTool(payload.source);
            break;
          }
          if (request.action === 'reconcileNativeTools') {
            data = await platformFacade.reconcileNativeTools();
            break;
          }
          if (request.action === 'listEffectiveTools') {
            const payload = request.payload as RegistryQuery | undefined;
            data = await platformFacade.listEffectiveTools(payload);
            break;
          }
          return {
            id: request.id,
            ok: false,
            error: {
              code: 'UNSUPPORTED',
              message: `APP_REQUEST_UNSUPPORTED:${request.module}.${request.action}`,
            },
          };
        }
        case 'cron': {
          if (request.action === 'list') {
            const result = await gatewayManager.rpc('cron.list', { includeDisabled: true });
            const jobs = (result as { jobs?: GatewayCronJob[] })?.jobs ?? [];
            data = jobs.map(transformCronJob);
            break;
          }
          if (request.action === 'create') {
            type CronCreateInput = { name: string; message: string; schedule: string; enabled?: boolean };
            const payload = request.payload as
              | { input?: CronCreateInput }
              | [CronCreateInput]
              | CronCreateInput
              | undefined;
            let input: CronCreateInput | undefined;
            if (Array.isArray(payload)) {
              input = payload[0];
            } else if (payload && typeof payload === 'object' && 'input' in payload) {
              input = payload.input;
            } else {
              input = payload as CronCreateInput | undefined;
            }
            if (!input) throw new Error('Invalid cron.create payload');
            const gatewayInput = {
              name: input.name,
              schedule: { kind: 'cron', expr: input.schedule },
              payload: { kind: 'agentTurn', message: input.message },
              enabled: input.enabled ?? true,
              wakeMode: 'next-heartbeat',
              sessionTarget: 'isolated',
              delivery: { mode: 'none' },
            };
            const created = await gatewayManager.rpc('cron.add', gatewayInput);
            data = created && typeof created === 'object' ? transformCronJob(created as GatewayCronJob) : created;
            break;
          }
          if (request.action === 'update') {
            const payload = request.payload as
              | { id?: string; input?: Record<string, unknown> }
              | [string, Record<string, unknown>]
              | undefined;
            const id = Array.isArray(payload) ? payload[0] : payload?.id;
            const input = Array.isArray(payload) ? payload[1] : payload?.input;
            if (!id || !input) throw new Error('Invalid cron.update payload');
            const patch = { ...input };
            if (typeof patch.schedule === 'string') patch.schedule = { kind: 'cron', expr: patch.schedule };
            if (typeof patch.message === 'string') {
              patch.payload = { kind: 'agentTurn', message: patch.message };
              delete patch.message;
            }
            data = await gatewayManager.rpc('cron.update', { id, patch });
            break;
          }
          if (request.action === 'delete') {
            const payload = request.payload as { id?: string } | string | undefined;
            const id = typeof payload === 'string' ? payload : payload?.id;
            if (!id) throw new Error('Invalid cron.delete payload');
            data = await gatewayManager.rpc('cron.remove', { id });
            break;
          }
          if (request.action === 'toggle') {
            const payload = request.payload as { id?: string; enabled?: boolean } | [string, boolean] | undefined;
            const id = Array.isArray(payload) ? payload[0] : payload?.id;
            const enabled = Array.isArray(payload) ? payload[1] : payload?.enabled;
            if (!id || typeof enabled !== 'boolean') throw new Error('Invalid cron.toggle payload');
            data = await gatewayManager.rpc('cron.update', { id, patch: { enabled } });
            break;
          }
          if (request.action === 'trigger') {
            const payload = request.payload as { id?: string } | string | undefined;
            const id = typeof payload === 'string' ? payload : payload?.id;
            if (!id) throw new Error('Invalid cron.trigger payload');
            data = await gatewayManager.rpc('cron.run', { id, mode: 'force' });
            break;
          }
          return {
            id: request.id,
            ok: false,
            error: {
              code: 'UNSUPPORTED',
              message: `APP_REQUEST_UNSUPPORTED:${request.module}.${request.action}`,
            },
          };
        }
        case 'usage': {
          if (request.action === 'recentTokenHistory') {
            const payload = request.payload as { limit?: number } | number | undefined;
            const limit = typeof payload === 'number' ? payload : payload?.limit;
            const safeLimit = typeof limit === 'number' && Number.isFinite(limit)
              ? Math.max(Math.floor(limit), 1)
              : undefined;
            data = await getRecentTokenUsageHistory(safeLimit);
            break;
          }
          return {
            id: request.id,
            ok: false,
            error: {
              code: 'UNSUPPORTED',
              message: `APP_REQUEST_UNSUPPORTED:${request.module}.${request.action}`,
            },
          };
        }
        case 'settings': {
          if (request.action === 'getAll') {
            data = await getAllSettings();
            break;
          }
          if (request.action === 'get') {
            const payload = request.payload as { key?: keyof AppSettings } | [keyof AppSettings] | undefined;
            const key = Array.isArray(payload) ? payload[0] : payload?.key;
            if (!key) throw new Error('Invalid settings.get payload');
            data = await getSetting(key);
            break;
          }
          if (request.action === 'set') {
            const payload = request.payload as
              | { key?: keyof AppSettings; value?: AppSettings[keyof AppSettings] }
              | [keyof AppSettings, AppSettings[keyof AppSettings]]
              | undefined;
            const key = Array.isArray(payload) ? payload[0] : payload?.key;
            const value = Array.isArray(payload) ? payload[1] : payload?.value;
            if (!key) throw new Error('Invalid settings.set payload');
            await setSetting(key, value as never);
            if (isProxyKey(key)) {
              await handleProxySettingsChange();
            }
            if (isLaunchAtStartupKey(key)) {
              await syncLaunchAtStartupSettingFromStore();
            }
            data = { success: true };
            break;
          }
          if (request.action === 'setMany') {
            const patch = (request.payload ?? {}) as Partial<AppSettings>;
            const entries = Object.entries(patch) as Array<[keyof AppSettings, AppSettings[keyof AppSettings]]>;
            for (const [key, value] of entries) {
              await setSetting(key, value as never);
            }
            if (entries.some(([key]) => isProxyKey(key))) {
              await handleProxySettingsChange();
            }
            if (entries.some(([key]) => isLaunchAtStartupKey(key))) {
              await syncLaunchAtStartupSettingFromStore();
            }
            data = { success: true };
            break;
          }
          if (request.action === 'reset') {
            await resetSettings();
            const settings = await getAllSettings();
            await handleProxySettingsChange();
            await syncLaunchAtStartupSettingFromStore();
            data = { success: true, settings };
            break;
          }
          return {
            id: request.id,
            ok: false,
            error: {
              code: 'UNSUPPORTED',
              message: `APP_REQUEST_UNSUPPORTED:${request.module}.${request.action}`,
            },
          };
        }
        default:
          return {
            id: request.id,
            ok: false,
            error: {
              code: 'UNSUPPORTED',
              message: `APP_REQUEST_UNSUPPORTED:${request.module}.${request.action}`,
            },
          };
      }

      return { id: request.id, ok: true, data };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: {
          code: mapAppErrorCode(error),
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}


/**
 * UV-related IPC handlers
 */
function registerUvHandlers(): void {
  // Check if uv is installed
  ipcMain.handle('uv:check', async () => {
    return await checkUvInstalled();
  });

  // Install uv and setup managed Python
  ipcMain.handle('uv:install-all', async () => {
    try {
      const isInstalled = await checkUvInstalled();
      if (!isInstalled) {
        await installUv();
      }
      // Always run python setup to ensure it exists in uv's cache
      await setupManagedPython();
      return { success: true };
    } catch (error) {
      console.error('Failed to setup uv/python:', error);
      return { success: false, error: String(error) };
    }
  });
}

/**
 * Log-related IPC handlers
 * Allows the renderer to read application logs for diagnostics
 */
function registerLogHandlers(): void {
  // Get recent logs from memory ring buffer
  ipcMain.handle('log:getRecent', async (_, count?: number) => {
    return logger.getRecentLogs(count);
  });

  // Read log file content (last N lines)
  ipcMain.handle('log:readFile', async (_, tailLines?: number) => {
    return await logger.readLogFile(tailLines);
  });

  // Get log file path (so user can open in file explorer)
  ipcMain.handle('log:getFilePath', async () => {
    return logger.getLogFilePath();
  });

  // Get log directory path
  ipcMain.handle('log:getDir', async () => {
    return logger.getLogDir();
  });

  // List all log files
  ipcMain.handle('log:listFiles', async () => {
    return await logger.listLogFiles();
  });
}


/**
 * Channel QR Login Handlers
 */
function registerChannelQrHandlers(mainWindow: BrowserWindow): void {
  // Request WhatsApp QR code
  ipcMain.handle('channel:requestWhatsAppQr', async (_, accountId: string) => {
    try {
      logger.info('channel:requestWhatsAppQr', { accountId });
      await whatsAppLoginManager.start(accountId);
      return { success: true };
    } catch (error) {
      logger.error('channel:requestWhatsAppQr failed', error);
      return { success: false, error: String(error) };
    }
  });

  // Cancel WhatsApp login
  ipcMain.handle('channel:cancelWhatsAppQr', async () => {
    try {
      await whatsAppLoginManager.stop();
      return { success: true };
    } catch (error) {
      logger.error('channel:cancelWhatsAppQr failed', error);
      return { success: false, error: String(error) };
    }
  });

  // Check WhatsApp status (is it active?)
  // ipcMain.handle('channel:checkWhatsAppStatus', ...)

  // Request Weixin QR code
  ipcMain.handle('channel:requestWeixinQr', async (_, payload: { accountId?: string; baseUrl?: string; routeTag?: string }) => {
    try {
      logger.info('channel:requestWeixinQr', payload);
      weixinLoginManager.startInBackground(payload ?? {});
      return { success: true, queued: true };
    } catch (error) {
      logger.error('channel:requestWeixinQr failed', error);
      return { success: false, error: String(error) };
    }
  });

  // Cancel Weixin login
  ipcMain.handle('channel:cancelWeixinQr', async () => {
    try {
      await weixinLoginManager.stop();
      return { success: true };
    } catch (error) {
      logger.error('channel:cancelWeixinQr failed', error);
      return { success: false, error: String(error) };
    }
  });

  // Forward events to renderer
  whatsAppLoginManager.on('qr', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('channel:whatsapp-qr', data);
    }
  });

  whatsAppLoginManager.on('success', (data) => {
    if (!mainWindow.isDestroyed()) {
      logger.info('whatsapp:login-success', data);
      mainWindow.webContents.send('channel:whatsapp-success', data);
    }
  });

  whatsAppLoginManager.on('error', (error) => {
    if (!mainWindow.isDestroyed()) {
      logger.error('whatsapp:login-error', error);
      mainWindow.webContents.send('channel:whatsapp-error', error);
    }
  });

  weixinLoginManager.on('qr', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('channel:weixin-qr', data);
    }
  });

  weixinLoginManager.on('success', (data) => {
    if (!mainWindow.isDestroyed()) {
      logger.info('weixin:login-success', data);
      mainWindow.webContents.send('channel:weixin-success', data);
    }
  });

  weixinLoginManager.on('error', (error) => {
    if (!mainWindow.isDestroyed()) {
      logger.error('weixin:login-error', error);
      mainWindow.webContents.send('channel:weixin-error', error);
    }
  });
}

/**
 * Device OAuth Handlers (Code Plan)
 */
function registerDeviceOAuthHandlers(mainWindow: BrowserWindow): void {
  deviceOAuthManager.setWindow(mainWindow);
  browserOAuthManager.setWindow(mainWindow);
}


/**
 * Shell-related IPC handlers
 */
function registerShellHandlers(): void {
  // Open external URL
  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    await shell.openExternal(url);
  });

  // Open path in file explorer
  ipcMain.handle('shell:showItemInFolder', async (_, path: string) => {
    const rawPath = typeof path === 'string' ? path.trim() : '';
    if (!rawPath) {
      return { success: false, error: 'empty_path' };
    }

    const decodedPath = (() => {
      try {
        return decodeURIComponent(rawPath);
      } catch {
        return rawPath;
      }
    })();
    const expandedPath = expandPath(decodedPath);
    if (!isAbsolute(expandedPath)) {
      logger.warn(`[shell:showItemInFolder] relative path rejected: "${rawPath}"`);
      return { success: false, error: 'relative_path_not_supported', rawPath };
    }
    const resolvedPath = resolvePath(expandedPath);
    if (!existsSync(resolvedPath)) {
      logger.warn(`[shell:showItemInFolder] target not found: raw="${rawPath}" resolved="${resolvedPath}"`);
      return { success: false, error: 'not_found', rawPath, resolvedPath };
    }
    shell.showItemInFolder(resolvedPath);
    return { success: true, resolvedPath, source: 'absolute' };
  });

  // Open path
  ipcMain.handle('shell:openPath', async (_, path: string) => {
    return await shell.openPath(path);
  });
}

/**
 * ClawHub-related IPC handlers
 */
function registerClawHubHandlers(clawHubService: ClawHubService): void {
  // Search skills
  ipcMain.handle('clawhub:search', async (_, params: ClawHubSearchParams) => {
    try {
      const results = await clawHubService.search(params);
      return { success: true, results };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Install skill
  ipcMain.handle('clawhub:install', async (_, params: ClawHubInstallParams) => {
    try {
      await clawHubService.install(params);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Uninstall skill
  ipcMain.handle('clawhub:uninstall', async (_, params: ClawHubUninstallParams) => {
    try {
      await clawHubService.uninstall(params);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // List installed skills
  ipcMain.handle('clawhub:list', async () => {
    try {
      const results = await clawHubService.listInstalled();
      return { success: true, results };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Open skill readme
  ipcMain.handle('clawhub:openSkillReadme', async (_, slug: string) => {
    try {
      await clawHubService.openSkillReadme(slug);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}

/**
 * Dialog-related IPC handlers
 */
function registerDialogHandlers(): void {
  // Show open dialog
  ipcMain.handle('dialog:open', async (_, options: Electron.OpenDialogOptions) => {
    const result = await dialog.showOpenDialog(options);
    return result;
  });

  // Show save dialog
  ipcMain.handle('dialog:save', async (_, options: Electron.SaveDialogOptions) => {
    const result = await dialog.showSaveDialog(options);
    return result;
  });

  // Show message box
  ipcMain.handle('dialog:message', async (_, options: Electron.MessageBoxOptions) => {
    const result = await dialog.showMessageBox(options);
    return result;
  });
}

/**
 * App-related IPC handlers
 */
function registerAppHandlers(): void {
  // Get app version
  ipcMain.handle('app:version', () => {
    return app.getVersion();
  });

  // Get app name
  ipcMain.handle('app:name', () => {
    return app.getName();
  });

  // Get app path
  ipcMain.handle('app:getPath', (_, name: Parameters<typeof app.getPath>[0]) => {
    return app.getPath(name);
  });

  // Get platform
  ipcMain.handle('app:platform', () => {
    return process.platform;
  });

  // Quit app
  ipcMain.handle('app:quit', () => {
    app.quit();
  });

  // Relaunch app
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.quit();
  });
}

function registerSettingsHandlers(gatewayManager: GatewayManager): void {
  const handleProxySettingsChange = async () => {
    const settings = await getAllSettings();
    await applyProxySettings(settings);
    if (gatewayManager.getStatus().state === 'running') {
      await gatewayManager.restart();
    }
  };

  ipcMain.handle('settings:get', async (_, key: keyof AppSettings) => {
    return await getSetting(key);
  });

  ipcMain.handle('settings:getAll', async () => {
    return await getAllSettings();
  });

  ipcMain.handle('settings:set', async (_, key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => {
    await setSetting(key, value as never);

    if (
      key === 'proxyEnabled' ||
      key === 'proxyServer' ||
      key === 'proxyBypassRules'
    ) {
      await handleProxySettingsChange();
    }
    if (key === 'launchAtStartup') {
      await syncLaunchAtStartupSettingFromStore();
    }

    return { success: true };
  });

  ipcMain.handle('settings:setMany', async (_, patch: Partial<AppSettings>) => {
    const entries = Object.entries(patch) as Array<[keyof AppSettings, AppSettings[keyof AppSettings]]>;
    for (const [key, value] of entries) {
      await setSetting(key, value as never);
    }

    if (entries.some(([key]) =>
      key === 'proxyEnabled' ||
      key === 'proxyServer' ||
      key === 'proxyBypassRules'
    )) {
      await handleProxySettingsChange();
    }
    if (entries.some(([key]) => key === 'launchAtStartup')) {
      await syncLaunchAtStartupSettingFromStore();
    }

    return { success: true };
  });

  ipcMain.handle('settings:reset', async () => {
    await resetSettings();
    const settings = await getAllSettings();
    await handleProxySettingsChange();
    await syncLaunchAtStartupSettingFromStore();
    return { success: true, settings };
  });
}
function registerUsageHandlers(): void {
  ipcMain.handle('usage:recentTokenHistory', async (_, limit?: number) => {
    const safeLimit = typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(Math.floor(limit), 1)
      : undefined;
    return await getRecentTokenUsageHistory(safeLimit);
  });
}
/**
 * Window control handlers (for custom title bar on Windows/Linux)
 */
function registerWindowHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('window:minimize', () => {
    mainWindow.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.handle('window:close', () => {
    mainWindow.close();
  });

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow.isMaximized();
  });
}

// ── Mime type helpers ────────────────────────────────────────────

const EXT_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function getMimeType(ext: string): string {
  return EXT_MIME_MAP[ext.toLowerCase()] || 'application/octet-stream';
}

function mimeToExt(mimeType: string): string {
  for (const [ext, mime] of Object.entries(EXT_MIME_MAP)) {
    if (mime === mimeType) return ext;
  }
  return '';
}

const OUTBOUND_DIR = join(homedir(), '.openclaw', 'media', 'outbound');

/**
 * Generate a preview data URL for image files.
 * Resizes large images while preserving aspect ratio (only constrain the
 * longer side so the image is never squished). The frontend handles
 * square cropping via CSS object-fit: cover.
 */
async function generateImagePreview(filePath: string, mimeType: string): Promise<string | null> {
  try {
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) return null;
    const size = img.getSize();
    const maxDim = 512; // keep enough resolution for crisp display on Retina
    // Only resize if larger than threshold — specify ONE dimension to keep ratio
    if (size.width > maxDim || size.height > maxDim) {
      const resized = size.width >= size.height
        ? img.resize({ width: maxDim })   // landscape / square → constrain width
        : img.resize({ height: maxDim }); // portrait → constrain height
      return `data:image/png;base64,${resized.toPNG().toString('base64')}`;
    }
    // Small image — use original (async read to avoid blocking)
    const { readFile: readFileAsync } = await import('fs/promises');
    const buf = await readFileAsync(filePath);
    return `data:${mimeType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * File staging IPC handlers
 * Stage files to ~/.openclaw/media/outbound/ for gateway access
 */
function registerFileHandlers(): void {
  // Stage files from real disk paths (used with dialog:open)
  ipcMain.handle('file:stage', async (_, filePaths: string[]) => {
    const fsP = await import('fs/promises');
    await fsP.mkdir(OUTBOUND_DIR, { recursive: true });

    const results = [];
    for (const filePath of filePaths) {
      const id = crypto.randomUUID();
      const ext = extname(filePath);
      const stagedPath = join(OUTBOUND_DIR, `${id}${ext}`);
      await fsP.copyFile(filePath, stagedPath);

      const s = await fsP.stat(stagedPath);
      const mimeType = getMimeType(ext);
      const fileName = basename(filePath);

      // Generate preview for images
      let preview: string | null = null;
      if (mimeType.startsWith('image/')) {
        preview = await generateImagePreview(stagedPath, mimeType);
      }

      results.push({ id, fileName, mimeType, fileSize: s.size, stagedPath, preview });
    }
    return results;
  });

  // Stage file from buffer (used for clipboard paste / drag-drop)
  ipcMain.handle('file:stageBuffer', async (_, payload: {
    base64: string;
    fileName: string;
    mimeType: string;
  }) => {
    const fsP = await import('fs/promises');
    await fsP.mkdir(OUTBOUND_DIR, { recursive: true });

    const id = crypto.randomUUID();
    const ext = extname(payload.fileName) || mimeToExt(payload.mimeType);
    const stagedPath = join(OUTBOUND_DIR, `${id}${ext}`);
    const buffer = Buffer.from(payload.base64, 'base64');
    await fsP.writeFile(stagedPath, buffer);

    const mimeType = payload.mimeType || getMimeType(ext);
    const fileSize = buffer.length;

    // Generate preview for images
    let preview: string | null = null;
    if (mimeType.startsWith('image/')) {
      preview = await generateImagePreview(stagedPath, mimeType);
    }

    return { id, fileName: payload.fileName, mimeType, fileSize, stagedPath, preview };
  });

  // Load thumbnails for file paths on disk (used to restore previews in history)
  // Save an image to a user-chosen location (base64 data URI or existing file path)
  ipcMain.handle('media:saveImage', async (_, params: {
    base64?: string;
    mimeType?: string;
    filePath?: string;
    defaultFileName: string;
  }) => {
    try {
      const ext = params.defaultFileName.includes('.')
        ? params.defaultFileName.split('.').pop()!
        : (params.mimeType?.split('/')[1] || 'png');
      const result = await dialog.showSaveDialog({
        defaultPath: join(homedir(), 'Downloads', params.defaultFileName),
        filters: [
          { name: 'Images', extensions: [ext, 'png', 'jpg', 'jpeg', 'webp', 'gif'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) return { success: false };

      const fsP = await import('fs/promises');
      if (params.filePath) {
        try {
          await fsP.access(params.filePath);
          await fsP.copyFile(params.filePath, result.filePath);
        } catch {
          return { success: false, error: 'Source file not found' };
        }
      } else if (params.base64) {
        const buffer = Buffer.from(params.base64, 'base64');
        await fsP.writeFile(result.filePath, buffer);
      } else {
        return { success: false, error: 'No image data provided' };
      }
      return { success: true, savedPath: result.filePath };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('media:getThumbnails', async (_, paths: Array<{ filePath: string; mimeType: string }>) => {
    const fsP = await import('fs/promises');
    const results: Record<string, { preview: string | null; fileSize: number }> = {};
    for (const { filePath, mimeType } of paths) {
      try {
        const s = await fsP.stat(filePath);
        let preview: string | null = null;
        if (mimeType.startsWith('image/')) {
          preview = await generateImagePreview(filePath, mimeType);
        }
        results[filePath] = { preview, fileSize: s.size };
      } catch {
        results[filePath] = { preview: null, fileSize: 0 };
      }
    }
    return results;
  });
}

/**
 * Session IPC handlers
 *
 * Performs a soft-delete of a session's JSONL transcript on disk.
 * sessionKey format: "agent:<agentId>:<suffix>" — e.g. "agent:main:session-1234567890".
 * The JSONL file lives at: ~/.openclaw/agents/<agentId>/sessions/<suffix>.jsonl
 * Renaming to <suffix>.deleted.jsonl hides it from sessions.list and token-usage
 * (both already filter out filenames containing ".deleted.").
 */
function registerSessionHandlers(): void {
  ipcMain.handle('session:delete', async (_, sessionKey: string) => {
    try {
      if (!sessionKey || !sessionKey.startsWith('agent:')) {
        return { success: false, error: `Invalid sessionKey: ${sessionKey}` };
      }

      const parts = sessionKey.split(':');
      if (parts.length < 3) {
        return { success: false, error: `sessionKey has too few parts: ${sessionKey}` };
      }

      const agentId = parts[1];
      const openclawConfigDir = getOpenClawConfigDir();
      const sessionsDir = join(openclawConfigDir, 'agents', agentId, 'sessions');
      const sessionsJsonPath = join(sessionsDir, 'sessions.json');

      logger.info(`[session:delete] key=${sessionKey} agentId=${agentId}`);
      logger.info(`[session:delete] sessionsJson=${sessionsJsonPath}`);

      const fsP = await import('fs/promises');

      // ── Step 1: read sessions.json to find the UUID file for this sessionKey ──
      let sessionsJson: Record<string, unknown> = {};
      try {
        const raw = await fsP.readFile(sessionsJsonPath, 'utf8');
        sessionsJson = JSON.parse(raw) as Record<string, unknown>;
      } catch (e) {
        logger.warn(`[session:delete] Could not read sessions.json: ${String(e)}`);
        return { success: false, error: `Could not read sessions.json: ${String(e)}` };
      }

      // sessions.json structure: try common shapes used by OpenClaw Gateway:
      //   Shape A (array):  { sessions: [{ key, file, ... }] }
      //   Shape B (object): { [sessionKey]: { file, ... } }
      //   Shape C (array):  { sessions: [{ key, id, ... }] }  — id is the UUID
      let uuidFileName: string | undefined;

      // Shape A / C — array under "sessions" key
      if (Array.isArray(sessionsJson.sessions)) {
        const entry = (sessionsJson.sessions as Array<Record<string, unknown>>)
          .find((s) => s.key === sessionKey || s.sessionKey === sessionKey);
        if (entry) {
          // Could be "file", "fileName", "id" + ".jsonl", or "path"
          uuidFileName = (entry.file ?? entry.fileName ?? entry.path) as string | undefined;
          if (!uuidFileName && typeof entry.id === 'string') {
            uuidFileName = `${entry.id}.jsonl`;
          }
        }
      }

      // Shape B — flat object keyed by sessionKey; value may be a string or an object.
      // Actual Gateway format: { sessionFile: "/abs/path/uuid.jsonl", sessionId: "uuid", ... }
      let resolvedSrcPath: string | undefined;

      if (!uuidFileName && sessionsJson[sessionKey] != null) {
        const val = sessionsJson[sessionKey];
        if (typeof val === 'string') {
          uuidFileName = val;
        } else if (typeof val === 'object' && val !== null) {
          const entry = val as Record<string, unknown>;
          // Priority: absolute sessionFile path > relative file/fileName/path > id/sessionId as UUID
          const absFile = (entry.sessionFile ?? entry.file ?? entry.fileName ?? entry.path) as string | undefined;
          if (absFile) {
            if (absFile.startsWith('/') || absFile.match(/^[A-Za-z]:\\/)) {
              // Absolute path — use directly
              resolvedSrcPath = absFile;
            } else {
              uuidFileName = absFile;
            }
          } else {
            // Fall back to UUID fields
            const uuidVal = (entry.id ?? entry.sessionId) as string | undefined;
            if (uuidVal) uuidFileName = uuidVal.endsWith('.jsonl') ? uuidVal : `${uuidVal}.jsonl`;
          }
        }
      }

      if (!uuidFileName && !resolvedSrcPath) {
        const rawVal = sessionsJson[sessionKey];
        logger.warn(`[session:delete] Cannot resolve file for "${sessionKey}". Raw value: ${JSON.stringify(rawVal)}`);
        return { success: false, error: `Cannot resolve file for session: ${sessionKey}` };
      }

      // Normalise: if we got a relative filename, resolve it against sessionsDir
      if (!resolvedSrcPath) {
        if (!uuidFileName!.endsWith('.jsonl')) uuidFileName = `${uuidFileName}.jsonl`;
        resolvedSrcPath = join(sessionsDir, uuidFileName!);
      }

      const dstPath = resolvedSrcPath.replace(/\.jsonl$/, '.deleted.jsonl');
      logger.info(`[session:delete] file: ${resolvedSrcPath}`);

      // ── Step 2: rename the JSONL file ──
      try {
        await fsP.access(resolvedSrcPath);
        await fsP.rename(resolvedSrcPath, dstPath);
        logger.info(`[session:delete] Renamed ${resolvedSrcPath} → ${dstPath}`);
      } catch (e) {
        logger.warn(`[session:delete] Could not rename file: ${String(e)}`);
      }

      // ── Step 3: remove the entry from sessions.json ──
      try {
        // Re-read to avoid race conditions
        const raw2 = await fsP.readFile(sessionsJsonPath, 'utf8');
        const json2 = JSON.parse(raw2) as Record<string, unknown>;

        if (Array.isArray(json2.sessions)) {
          json2.sessions = (json2.sessions as Array<Record<string, unknown>>)
            .filter((s) => s.key !== sessionKey && s.sessionKey !== sessionKey);
        } else if (json2[sessionKey]) {
          delete json2[sessionKey];
        }

        await fsP.writeFile(sessionsJsonPath, JSON.stringify(json2, null, 2), 'utf8');
        logger.info(`[session:delete] Removed "${sessionKey}" from sessions.json`);
      } catch (e) {
        logger.warn(`[session:delete] Could not update sessions.json: ${String(e)}`);
        // Non-fatal — JSONL rename already done
      }

      return { success: true };
    } catch (err) {
      logger.error(`[session:delete] Unexpected error for ${sessionKey}:`, err);
      return { success: false, error: String(err) };
    }
  });
}
