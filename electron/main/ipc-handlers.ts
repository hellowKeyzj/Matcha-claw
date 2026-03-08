/**
 * IPC Handlers
 * Registers all IPC handlers for main-renderer communication
 */
import { ipcMain, BrowserWindow, shell, dialog, app, nativeImage } from 'electron';
import { existsSync, cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, basename, dirname, resolve, relative, isAbsolute } from 'node:path';
import crypto from 'node:crypto';
import { GatewayManager } from '../gateway/manager';
import { MatchaClawHubService, MatchaClawHubSearchParams, MatchaClawHubInstallParams, MatchaClawHubUninstallParams } from '../gateway/clawhub';
import {
  storeApiKey,
  getApiKey,
  deleteApiKey,
  hasApiKey,
  saveProvider,
  getProvider,
  getAllProviders,
  deleteProvider,
  setDefaultProvider,
  getDefaultProvider,
  getAllProvidersWithKeyInfo,
  type ProviderConfig,
} from '../utils/secure-storage';
import { getOpenClawStatus, getOpenClawDir, getOpenClawConfigDir, getOpenClawSkillsDir, ensureDir } from '../utils/paths';
import { getOpenClawCliCommand } from '../utils/openclaw-cli';
import { getAllSettings, getSetting, resetSettings, setSetting, type AppSettings } from '../utils/store';
import { expandPath } from '../utils/paths';
import {
  saveProviderKeyToOpenClaw,
  removeProviderFromOpenClaw,
  setOpenClawDefaultModel,
  setOpenClawDefaultModelWithOverride,
  syncProviderConfigToOpenClaw,
  updateAgentModelProvider,
} from '../utils/openclaw-auth';
import { logger } from '../utils/logger';
import {
  saveChannelConfig,
  getChannelConfig,
  getChannelFormValues,
  deleteChannelConfig,
  listConfiguredChannels,
  setChannelEnabled,
  validateChannelConfig,
  validateChannelCredentials,
} from '../utils/channel-config';
import { checkUvInstalled, installUv, setupManagedPython } from '../utils/uv-setup';
import { updateSkillConfig, getSkillConfig, getAllSkillConfigs } from '../utils/skill-config';
import { whatsAppLoginManager } from '../utils/whatsapp-login';
import { getProviderConfig } from '../utils/provider-registry';
import { getProviderDefaultModel } from '../utils/provider-registry';
import { deviceOAuthManager, OAuthProviderType } from '../utils/device-oauth';
import { applyProxySettings } from './proxy';
import { proxyAwareFetch } from '../utils/proxy-fetch';
import { getRecentTokenUsageHistory } from '../utils/token-usage';
import { registerTeamFsHandlers } from './team-fs-handlers';
import { upsertPluginInstallRecord, type InstallSource } from '../utils/plugin-install-record';
import { validateLicenseKey } from '../utils/license';

/**
 * For custom/ollama providers, derive a unique key for OpenClaw config files
 * so that multiple instances of the same type don't overwrite each other.
 * For all other providers the key is simply the provider type.
 *
 * @param type - Provider type (e.g. 'custom', 'ollama', 'openrouter')
 * @param providerId - Unique provider ID from secure-storage (UUID-like)
 * @returns A string like 'custom-a1b2c3d4' or 'openrouter'
 */
export function getOpenClawProviderKey(type: string, providerId: string): string {
  if (type === 'custom' || type === 'ollama') {
    const suffix = providerId.replace(/-/g, '').slice(0, 8);
    return `${type}-${suffix}`;
  }
  if (type === 'minimax-portal-cn') {
    return 'minimax-portal';
  }
  return type;
}

function getProviderModelRef(config: ProviderConfig): string | undefined {
  const providerKey = getOpenClawProviderKey(config.type, config.id);

  if (config.model) {
    return config.model.startsWith(`${providerKey}/`)
      ? config.model
      : `${providerKey}/${config.model}`;
  }

  return getProviderDefaultModel(config.type);
}

async function getProviderFallbackModelRefs(config: ProviderConfig): Promise<string[]> {
  const allProviders = await getAllProviders();
  const providerMap = new Map(allProviders.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  const results: string[] = [];
  const providerKey = getOpenClawProviderKey(config.type, config.id);

  for (const fallbackModel of config.fallbackModels ?? []) {
    const normalizedModel = fallbackModel.trim();
    if (!normalizedModel) continue;

    const modelRef = normalizedModel.startsWith(`${providerKey}/`)
      ? normalizedModel
      : `${providerKey}/${normalizedModel}`;

    if (seen.has(modelRef)) continue;
    seen.add(modelRef);
    results.push(modelRef);
  }

  for (const fallbackId of config.fallbackProviderIds ?? []) {
    if (!fallbackId || fallbackId === config.id) continue;

    const fallbackProvider = providerMap.get(fallbackId);
    if (!fallbackProvider) continue;

    const modelRef = getProviderModelRef(fallbackProvider);
    if (!modelRef || seen.has(modelRef)) continue;

    seen.add(modelRef);
    results.push(modelRef);
  }

  return results;
}

/**
 * Register all IPC handlers
 */
export function registerIpcHandlers(
  gatewayManager: GatewayManager,
  matchaclawHubService: MatchaClawHubService,
  mainWindow: BrowserWindow
): void {
  // Gateway handlers
  registerGatewayHandlers(gatewayManager, mainWindow);

  // MatchaClawHub handlers
  registerMatchaClawHubHandlers(matchaclawHubService);

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

  // License handlers
  registerLicenseHandlers();

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
  registerWhatsAppHandlers(mainWindow);

  // Device OAuth handlers (Code Plan)
  registerDeviceOAuthHandlers(mainWindow);

  // File staging handlers (upload/send separation)
  registerFileHandlers();
  registerRolesMetadataHandlers(gatewayManager);
  registerTeamFsHandlers();

}

function isPathInside(basePath: string, targetPath: string): boolean {
  const relPath = relative(basePath, targetPath);
  return relPath === '' || (!relPath.startsWith('..') && !isAbsolute(relPath));
}

function registerRolesMetadataHandlers(gatewayManager: GatewayManager): void {
  const resolveRolesMetadataPath = (rootDir?: string): string => {
    const configDir = resolve(expandPath(gatewayManager.getRuntimePaths().configDir || getOpenClawConfigDir()));
    const workspaceDirRaw = gatewayManager.getRuntimePaths().workspaceDir;
    const workspaceDir = workspaceDirRaw ? resolve(expandPath(workspaceDirRaw)) : null;
    const fallbackRoot = workspaceDir ? join(configDir, 'workspace-subagents') : join(configDir, 'workspace-subagents');
    const requestedRoot = (typeof rootDir === 'string' && rootDir.trim())
      ? resolve(expandPath(rootDir.trim()))
      : fallbackRoot;

    // Keep write scope under OpenClaw config/workspace tree.
    const underConfigDir = isPathInside(configDir, requestedRoot);
    const underWorkspaceDir = workspaceDir ? isPathInside(workspaceDir, requestedRoot) : false;
    if (!underConfigDir && !underWorkspaceDir) {
      throw new Error(`roles metadata path is outside allowed roots: ${requestedRoot}`);
    }

    return join(requestedRoot, 'ROLES_METADATA.md');
  };

  ipcMain.handle('roles:readMetadata', async (_, rootDir?: string) => {
    const filePath = resolveRolesMetadataPath(rootDir);
    try {
      const content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
      return { path: filePath, content };
    } catch (error) {
      logger.error('roles:readMetadata failed', error);
      throw error;
    }
  });

  ipcMain.handle('roles:writeMetadata', async (_, input: { rootDir?: string; content: string }) => {
    if (!input || typeof input.content !== 'string') {
      throw new Error('Invalid roles metadata payload');
    }
    const filePath = resolveRolesMetadataPath(input.rootDir);
    try {
      ensureDir(dirname(filePath));
      writeFileSync(filePath, input.content, 'utf8');
      return { path: filePath };
    } catch (error) {
      logger.error('roles:writeMetadata failed', error);
      throw error;
    }
  });
}

/**
 * Skill config IPC handlers
 * Direct read/write to ~/.openclaw/openclaw.json (bypasses Gateway RPC)
 */
function registerSkillConfigHandlers(): void {
  // Update skill config (apiKey and env)
  ipcMain.handle('skill:updateConfig', async (_, params: {
    skillKey: string;
    apiKey?: string;
    env?: Record<string, string>;
  }) => {
    return await updateSkillConfig(params.skillKey, {
      apiKey: params.apiKey,
      env: params.env,
    });
  });

  // Get skill config
  ipcMain.handle('skill:getConfig', async (_, skillKey: string) => {
    return await getSkillConfig(skillKey);
  });

  // Get all skill configs
  ipcMain.handle('skill:getAllConfigs', async () => {
    return await getAllSkillConfigs();
  });
}

/**
 * Gateway CronJob type (as returned by cron.list RPC)
 */
interface GatewayCronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: { kind: string; expr?: string; everyMs?: number; at?: string; tz?: string };
  payload: { kind: string; message?: string; text?: string };
  delivery?: { mode: string; channel?: string; to?: string };
  sessionTarget?: string;
  state: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: string;
    lastError?: string;
    lastDurationMs?: number;
  };
}

/**
 * Transform a Gateway CronJob to the frontend CronJob format
 */
function transformCronJob(job: GatewayCronJob) {
  // Extract message from payload
  const message = job.payload?.message || job.payload?.text || '';

  // Build target from delivery info — only if a delivery channel is specified
  const channelType = job.delivery?.channel;
  const target = channelType
    ? { channelType, channelId: channelType, channelName: channelType }
    : undefined;

  // Build lastRun from state
  const lastRun = job.state?.lastRunAtMs
    ? {
      time: new Date(job.state.lastRunAtMs).toISOString(),
      success: job.state.lastStatus === 'ok',
      error: job.state.lastError,
      duration: job.state.lastDurationMs,
    }
    : undefined;

  // Build nextRun from state
  const nextRun = job.state?.nextRunAtMs
    ? new Date(job.state.nextRunAtMs).toISOString()
    : undefined;

  return {
    id: job.id,
    name: job.name,
    message,
    schedule: job.schedule, // Pass the object through; frontend parseCronSchedule handles it
    target,
    enabled: job.enabled,
    createdAt: new Date(job.createdAtMs).toISOString(),
    updatedAt: new Date(job.updatedAtMs).toISOString(),
    lastRun,
    nextRun,
  };
}

/**
 * Cron task IPC handlers
 * Proxies cron operations to the Gateway RPC service.
 * The frontend works with plain cron expression strings, but the Gateway
 * expects CronSchedule objects ({ kind: "cron", expr: "..." }).
 * These handlers bridge the two formats.
 */
function registerCronHandlers(gatewayManager: GatewayManager): void {
  // List all cron jobs — transforms Gateway CronJob format to frontend CronJob format
  ipcMain.handle('cron:list', async () => {
    try {
      const result = await gatewayManager.rpc('cron.list', { includeDisabled: true });
      const data = result as { jobs?: GatewayCronJob[] };
      const jobs = data?.jobs ?? [];

      // Auto-repair legacy UI-created jobs that were saved without
      // delivery: { mode: 'none' }.  The Gateway auto-normalizes them
      // to delivery: { mode: 'announce' } which then fails with
      // "Channel is required" when no external channels are configured.
      const repairTasks: Promise<unknown>[] = [];
      for (const job of jobs) {
        const isIsolatedAgent =
          (job.sessionTarget === 'isolated' || !job.sessionTarget) &&
          job.payload?.kind === 'agentTurn';
        const needsRepair =
          isIsolatedAgent &&
          job.delivery?.mode === 'announce' &&
          !job.delivery?.channel;

        if (needsRepair) {
          // 先就地修正返回给前端的视图，避免阻塞读取流程。
          job.delivery = { mode: 'none' };
          if (job.state?.lastError?.includes('Channel is required')) {
            job.state.lastError = undefined;
            job.state.lastStatus = 'ok';
          }

          const task = gatewayManager.rpc('cron.update', {
              id: job.id,
              patch: { delivery: { mode: 'none' } },
            })
            .catch((e) => {
              console.warn(`Failed to auto-repair cron job ${job.id}:`, e);
            });
          repairTasks.push(task);
        }
      }

      // Transform Gateway format to frontend format
      const transformed = jobs.map(transformCronJob);
      if (repairTasks.length > 0) {
        void Promise.allSettled(repairTasks);
      }
      return transformed;
    } catch (error) {
      console.error('Failed to list cron jobs:', error);
      throw error;
    }
  });

  // Create a new cron job
  // UI-created tasks have no delivery target — results go to the MatchaClaw chat page.
  // Tasks created via external channels (Feishu, Discord, etc.) are handled
  // directly by the OpenClaw Gateway and do not pass through this IPC handler.
  ipcMain.handle('cron:create', async (_, input: {
    name: string;
    message: string;
    schedule: string;
    enabled?: boolean;
  }) => {
    try {
      const gatewayInput = {
        name: input.name,
        schedule: { kind: 'cron', expr: input.schedule },
        payload: { kind: 'agentTurn', message: input.message },
        enabled: input.enabled ?? true,
        wakeMode: 'next-heartbeat',
        sessionTarget: 'isolated',
        // UI-created jobs deliver results via MatchaClaw WebSocket chat events,
        // not external messaging channels.  Setting mode='none' prevents
        // the Gateway from attempting channel delivery (which would fail
        // with "Channel is required" when no channels are configured).
        delivery: { mode: 'none' },
      };
      const result = await gatewayManager.rpc('cron.add', gatewayInput);
      // Transform the returned job to frontend format
      if (result && typeof result === 'object') {
        return transformCronJob(result as GatewayCronJob);
      }
      return result;
    } catch (error) {
      console.error('Failed to create cron job:', error);
      throw error;
    }
  });

  // Update an existing cron job
  ipcMain.handle('cron:update', async (_, id: string, input: Record<string, unknown>) => {
    try {
      // Transform schedule string to CronSchedule object if present
      const patch = { ...input };
      if (typeof patch.schedule === 'string') {
        patch.schedule = { kind: 'cron', expr: patch.schedule };
      }
      // Transform message to payload format if present
      if (typeof patch.message === 'string') {
        patch.payload = { kind: 'agentTurn', message: patch.message };
        delete patch.message;
      }
      const result = await gatewayManager.rpc('cron.update', { id, patch });
      return result;
    } catch (error) {
      console.error('Failed to update cron job:', error);
      throw error;
    }
  });

  // Delete a cron job
  ipcMain.handle('cron:delete', async (_, id: string) => {
    try {
      const result = await gatewayManager.rpc('cron.remove', { id });
      return result;
    } catch (error) {
      console.error('Failed to delete cron job:', error);
      throw error;
    }
  });

  // Toggle a cron job enabled/disabled
  ipcMain.handle('cron:toggle', async (_, id: string, enabled: boolean) => {
    try {
      const result = await gatewayManager.rpc('cron.update', { id, patch: { enabled } });
      return result;
    } catch (error) {
      console.error('Failed to toggle cron job:', error);
      throw error;
    }
  });

  // Trigger a cron job manually
  ipcMain.handle('cron:trigger', async (_, id: string) => {
    try {
      const result = await gatewayManager.rpc('cron.run', { id, mode: 'force' });
      return result;
    } catch (error) {
      console.error('Failed to trigger cron job:', error);
      throw error;
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
 * Gateway-related IPC handlers
 */
function registerGatewayHandlers(
  gatewayManager: GatewayManager,
  mainWindow: BrowserWindow
): void {
  // Get Gateway status
  ipcMain.handle('gateway:status', () => {
    return gatewayManager.getStatus();
  });

  // Check if Gateway is connected
  ipcMain.handle('gateway:isConnected', () => {
    return gatewayManager.isConnected();
  });

  // Start Gateway
  ipcMain.handle('gateway:start', async () => {
    try {
      await gatewayManager.start();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Stop Gateway
  ipcMain.handle('gateway:stop', async () => {
    try {
      await gatewayManager.stop();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Restart Gateway
  ipcMain.handle('gateway:restart', async () => {
    try {
      await gatewayManager.restart();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Gateway RPC call
  ipcMain.handle('gateway:rpc', async (_, method: string, params?: unknown, timeoutMs?: number) => {
    try {
      const result = await gatewayManager.rpc(method, params, timeoutMs);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Chat send with media — reads staged files from disk and builds attachments.
  // Raster images (png/jpg/gif/webp) are inlined as base64 vision attachments.
  // All other files are referenced by path in the message text so the model
  // can access them via tools (the same format channels use).
  const VISION_MIME_TYPES = new Set([
    'image/png', 'image/jpeg', 'image/bmp', 'image/webp',
  ]);

  ipcMain.handle('chat:sendWithMedia', async (_, params: {
    sessionKey: string;
    message: string;
    deliver?: boolean;
    idempotencyKey: string;
    media?: Array<{ filePath: string; mimeType: string; fileName: string }>;
  }) => {
    try {
      let message = params.message;
      // The Gateway processes image attachments through TWO parallel paths:
      // Path A: `attachments` param → parsed via `parseMessageWithAttachments` →
      //   injected as inline vision content when the model supports images.
      //   Format: { content: base64, mimeType: string, fileName?: string }
      // Path B: `[media attached: ...]` in message text → Gateway's native image
      //   detection (`detectAndLoadPromptImages`) reads the file from disk and
      //   injects it as inline vision content. Also works for history messages.
      // We use BOTH paths for maximum reliability.
      const imageAttachments: Array<Record<string, unknown>> = [];
      const fileReferences: string[] = [];

      if (params.media && params.media.length > 0) {
        const fsP = await import('fs/promises');
        for (const m of params.media) {
          const exists = await fsP.access(m.filePath).then(() => true, () => false);
          logger.info(`[chat:sendWithMedia] Processing file: ${m.fileName} (${m.mimeType}), path: ${m.filePath}, exists: ${exists}, isVision: ${VISION_MIME_TYPES.has(m.mimeType)}`);

          // Always add file path reference so the model can access it via tools
          fileReferences.push(
            `[media attached: ${m.filePath} (${m.mimeType}) | ${m.filePath}]`,
          );

          if (VISION_MIME_TYPES.has(m.mimeType)) {
            // Send as base64 attachment in the format the Gateway expects:
            // { content: base64String, mimeType: string, fileName?: string }
            // The Gateway normalizer looks for `a.content` (NOT `a.source.data`).
            const fileBuffer = await fsP.readFile(m.filePath);
            const base64Data = fileBuffer.toString('base64');
            logger.info(`[chat:sendWithMedia] Read ${fileBuffer.length} bytes, base64 length: ${base64Data.length}`);
            imageAttachments.push({
              content: base64Data,
              mimeType: m.mimeType,
              fileName: m.fileName,
            });
          }
        }
      }

      // Append file references to message text so the model knows about them
      if (fileReferences.length > 0) {
        const refs = fileReferences.join('\n');
        message = message ? `${message}\n\n${refs}` : refs;
      }

      const rpcParams: Record<string, unknown> = {
        sessionKey: params.sessionKey,
        message,
        deliver: params.deliver ?? false,
        idempotencyKey: params.idempotencyKey,
      };

      if (imageAttachments.length > 0) {
        rpcParams.attachments = imageAttachments;
      }

      logger.info(`[chat:sendWithMedia] Sending: message="${message.substring(0, 100)}", attachments=${imageAttachments.length}, fileRefs=${fileReferences.length}`);

      // Longer timeout for chat sends to tolerate high-latency networks (avoids connect error)
      const timeoutMs = 120000;
      const result = await gatewayManager.rpc('chat.send', rpcParams, timeoutMs);
      logger.info(`[chat:sendWithMedia] RPC result: ${JSON.stringify(result)}`);
      return { success: true, result };
    } catch (error) {
      logger.error(`[chat:sendWithMedia] Error: ${String(error)}`);
      return { success: false, error: String(error) };
    }
  });

  // Get the Control UI URL with token for embedding
  ipcMain.handle('gateway:getControlUiUrl', async () => {
    try {
      const status = gatewayManager.getStatus();
      const token = await getSetting('gatewayToken');
      const port = status.port || 18789;
      // Pass token as query param - Control UI will store it in localStorage
      const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
      return { success: true, url, port, token };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Health check
  ipcMain.handle('gateway:health', async () => {
    try {
      const health = await gatewayManager.checkHealth();
      return { success: true, ...health };
    } catch (error) {
      return { success: false, ok: false, error: String(error) };
    }
  });

  // Forward Gateway events to renderer
  gatewayManager.on('status', (status) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:status-changed', status);
    }
  });

  gatewayManager.on('message', (message) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:message', message);
    }
  });

  gatewayManager.on('notification', (notification) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:notification', notification);
    }
  });

  gatewayManager.on('channel:status', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:channel-status', data);
    }
  });

  gatewayManager.on('chat:message', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:chat-message', data);
    }
  });

  gatewayManager.on('exit', (code) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:exit', code);
    }
  });

  gatewayManager.on('error', (error) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:error', error.message);
    }
  });
}

/**
 * OpenClaw-related IPC handlers
 * For checking package status and channel configuration
 */
function registerOpenClawHandlers(gatewayManager: GatewayManager): void {
  type PluginInstallResult = {
    installed: boolean;
    warning?: string;
    installedPath?: string;
    sourcePath?: string;
    version?: string;
  };

  type OpenClawJson = {
    plugins?: {
      enabled?: boolean;
      allow?: string[];
      entries?: Record<string, Record<string, unknown> & { enabled?: boolean }>;
      installs?: Record<string, Record<string, unknown>>;
      [key: string]: unknown;
    };
    skills?: {
      entries?: Record<string, Record<string, unknown> & { enabled?: boolean }>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };

  const openclawConfigPath = join(homedir(), '.openclaw', 'openclaw.json');

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function readOpenClawConfigJson(): OpenClawJson {
    try {
      if (!existsSync(openclawConfigPath)) {
        return {};
      }
      const parsed = JSON.parse(readFileSync(openclawConfigPath, 'utf-8')) as OpenClawJson;
      return isRecord(parsed) ? parsed : {};
    } catch (error) {
      logger.warn('Failed to read openclaw.json while handling plugin config:', error);
      return {};
    }
  }

  function writeOpenClawConfigJson(config: OpenClawJson): void {
    mkdirSync(dirname(openclawConfigPath), { recursive: true });
    writeFileSync(openclawConfigPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  function getInstalledPluginVersion(pluginId: string): string | undefined {
    const pluginPkgPath = join(homedir(), '.openclaw', 'extensions', pluginId, 'package.json');
    try {
      if (!existsSync(pluginPkgPath)) {
        return undefined;
      }
      const parsed = JSON.parse(readFileSync(pluginPkgPath, 'utf-8')) as { version?: unknown };
      return typeof parsed.version === 'string' ? parsed.version : undefined;
    } catch {
      return undefined;
    }
  }

  function isPluginEnabled(pluginId: string): boolean {
    const config = readOpenClawConfigJson();
    const plugins = isRecord(config.plugins) ? config.plugins : undefined;
    const entries = isRecord(plugins?.entries) ? plugins?.entries : undefined;
    const entry = entries && isRecord(entries[pluginId]) ? entries[pluginId] : undefined;
    const enabledByEntry = typeof entry?.enabled === 'boolean' ? entry.enabled : false;
    const allowList = Array.isArray(plugins?.allow) ? plugins.allow.filter((item): item is string => typeof item === 'string') : [];
    const allowed = allowList.length === 0 ? false : allowList.includes(pluginId);
    const pluginsEnabled = typeof plugins?.enabled === 'boolean' ? plugins.enabled : true;
    return pluginsEnabled && (enabledByEntry || allowed);
  }

  function ensurePluginEnabledInConfig(pluginId: string): boolean {
    const config = readOpenClawConfigJson();
    const plugins = isRecord(config.plugins) ? config.plugins : {};
    const entries = isRecord(plugins.entries) ? plugins.entries as Record<string, Record<string, unknown>> : {};
    const entry = isRecord(entries[pluginId]) ? entries[pluginId] : {};
    const allow = Array.isArray(plugins.allow) ? plugins.allow.filter((item): item is string => typeof item === 'string') : [];

    plugins.enabled = true;
    if (!allow.includes(pluginId)) {
      allow.push(pluginId);
    }
    plugins.allow = allow;
    entries[pluginId] = {
      ...entry,
      enabled: true,
    };
    plugins.entries = entries;
    config.plugins = plugins;

    writeOpenClawConfigJson(config);
    return true;
  }

  function ensurePluginInstallRecordInConfig(
    pluginId: string,
    params: {
      source: InstallSource;
      installPath?: string;
      sourcePath?: string;
      spec?: string;
      version?: string;
    },
  ): boolean {
    const config = readOpenClawConfigJson() as Record<string, unknown>;
    const { nextConfig, changed } = upsertPluginInstallRecord(config, {
      pluginId,
      source: params.source,
      installPath: params.installPath,
      sourcePath: params.sourcePath,
      spec: params.spec,
      version: params.version,
    });
    if (!changed) return false;
    writeOpenClawConfigJson(nextConfig as OpenClawJson);
    return true;
  }

  function backfillManagedPluginInstallRecord(pluginId: string): void {
    const installedPath = join(homedir(), '.openclaw', 'extensions', pluginId);
    const manifestPath = join(installedPath, 'openclaw.plugin.json');
    if (!existsSync(manifestPath)) return;
    const changed = ensurePluginInstallRecordInConfig(pluginId, {
      source: 'path',
      installPath: installedPath,
      version: getInstalledPluginVersion(pluginId),
    });
    if (changed) {
      logger.info(`Backfilled plugins.installs record for ${pluginId}`);
    }
  }

  function isSkillEnabled(skillId: string): boolean {
    const config = readOpenClawConfigJson();
    const skills = isRecord(config.skills) ? config.skills : undefined;
    const entries = isRecord(skills?.entries) ? skills.entries as Record<string, Record<string, unknown>> : undefined;
    const entry = entries && isRecord(entries[skillId]) ? entries[skillId] : undefined;
    return typeof entry?.enabled === 'boolean' ? entry.enabled : false;
  }

  function ensureSkillEnabledInConfig(skillId: string): boolean {
    const config = readOpenClawConfigJson();
    const skills = isRecord(config.skills) ? config.skills : {};
    const entries = isRecord(skills.entries) ? skills.entries as Record<string, Record<string, unknown>> : {};
    const entry = isRecord(entries[skillId]) ? entries[skillId] : {};

    entries[skillId] = {
      ...entry,
      enabled: true,
    };
    skills.entries = entries;
    config.skills = skills;

    writeOpenClawConfigJson(config);
    return true;
  }

  interface EnsureBundledPluginOptions {
    extraDevSources?: string[];
    forceReinstall?: boolean;
    preferExtraDevSourcesInDev?: boolean;
  }

  async function ensureBundledPluginInstalled(
    pluginId: string,
    options: EnsureBundledPluginOptions = {},
  ): Promise<PluginInstallResult> {
    const extraDevSources = options.extraDevSources ?? [];
    const forceReinstall = options.forceReinstall === true;
    const preferExtraDevSourcesInDev = options.preferExtraDevSourcesInDev === true;
    const targetDir = join(homedir(), '.openclaw', 'extensions', pluginId);
    const targetManifest = join(targetDir, 'openclaw.plugin.json');

    if (!forceReinstall && existsSync(targetManifest)) {
      logger.info(`${pluginId} plugin already installed from local mirror`);
      return {
        installed: true,
        installedPath: targetDir,
        version: getInstalledPluginVersion(pluginId),
      };
    }

    const packagedCandidates = [
      join(process.resourcesPath, 'openclaw-plugins', pluginId),
      join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', pluginId),
      join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', pluginId)
    ];
    const baseDevCandidates = [
      join(app.getAppPath(), 'build', 'openclaw-plugins', pluginId),
      join(process.cwd(), 'build', 'openclaw-plugins', pluginId),
      join(__dirname, `../../build/openclaw-plugins/${pluginId}`),
    ];
    const devCandidates = preferExtraDevSourcesInDev
      ? [...extraDevSources, ...baseDevCandidates]
      : [...baseDevCandidates, ...extraDevSources];

    const candidateSources = app.isPackaged
      ? [
        ...packagedCandidates,
      ]
      : [
        ...devCandidates,
      ];

    const sourceDir = candidateSources.find((dir) => existsSync(join(dir, 'openclaw.plugin.json')));
    if (!sourceDir) {
      logger.warn(`Bundled ${pluginId} plugin mirror not found in candidate paths`, { candidateSources });
      return {
        installed: false,
        warning: `Bundled ${pluginId} plugin mirror not found. Checked: ${candidateSources.join(' | ')}`,
      };
    }

    try {
      mkdirSync(join(homedir(), '.openclaw', 'extensions'), { recursive: true });
      try {
        rmSync(targetDir, {
          recursive: true,
          force: true,
          maxRetries: 8,
          retryDelay: 120,
        });
      } catch (removeError) {
        // Windows 上扩展目录偶发被占用，删除失败时降级为原地覆盖复制。
        logger.warn(`Failed to remove existing ${pluginId} plugin directory, fallback to in-place overwrite:`, removeError);
      }
      cpSync(sourceDir, targetDir, { recursive: true, dereference: true });

      if (!existsSync(targetManifest)) {
        return { installed: false, warning: `Failed to install ${pluginId} plugin mirror (manifest missing).` };
      }

      logger.info(`Installed ${pluginId} plugin from bundled mirror: ${sourceDir}`);
      return {
        installed: true,
        installedPath: targetDir,
        sourcePath: sourceDir,
        version: getInstalledPluginVersion(pluginId),
      };
    } catch (error) {
      logger.warn(`Failed to install ${pluginId} plugin from bundled mirror:`, error);
      return {
        installed: false,
        warning: `Failed to install bundled ${pluginId} plugin mirror`,
      };
    }
  }

  async function ensureDingTalkPluginInstalled(): Promise<PluginInstallResult> {
    return ensureBundledPluginInstalled('dingtalk');
  }

  async function ensureTaskManagerPluginInstalled(): Promise<PluginInstallResult> {
    return ensureBundledPluginInstalled('task-manager', {
      extraDevSources: [
        join(process.cwd(), 'packages', 'openclaw-task-manager-plugin'),
        join(app.getAppPath(), 'packages', 'openclaw-task-manager-plugin'),
        join(__dirname, '../../packages/openclaw-task-manager-plugin'),
      ],
      forceReinstall: true,
      // dev 环境优先使用 build/openclaw-plugins 镜像，packages 仅作为兜底来源，
      // 避免重装时误装回陈旧 package 副本。
      preferExtraDevSourcesInDev: false,
    });
  }

  for (const pluginId of ['task-manager', 'dingtalk']) {
    backfillManagedPluginInstallRecord(pluginId);
  }

  // Get OpenClaw package status
  ipcMain.handle('openclaw:status', () => {
    const status = getOpenClawStatus();
    logger.info('openclaw:status IPC called', status);
    return status;
  });

  // Check if OpenClaw is ready (package present)
  ipcMain.handle('openclaw:isReady', () => {
    const status = getOpenClawStatus();
    return status.packageExists;
  });

  // Get the resolved OpenClaw directory path (for diagnostics)
  ipcMain.handle('openclaw:getDir', () => {
    return getOpenClawDir();
  });

  // Get the OpenClaw config directory (~/.openclaw)
  ipcMain.handle('openclaw:getConfigDir', () => {
    return getOpenClawConfigDir();
  });

  // Read the raw OpenClaw JSON config from disk without going through gateway config RPC.
  ipcMain.handle('openclaw:getConfigJson', () => {
    return {
      config: readOpenClawConfigJson(),
      path: openclawConfigPath,
    };
  });

  // Get OpenClaw workspace directory currently used by the Gateway.
  ipcMain.handle('openclaw:getWorkspaceDir', () => {
    return gatewayManager.getRuntimePaths().workspaceDir || null;
  });

  // Get all task-relevant workspace directories (main + agent-specific workspaces).
  ipcMain.handle('openclaw:getTaskWorkspaceDirs', () => {
    const dirs = new Set<string>();
    const runtimeWorkspace = gatewayManager.getRuntimePaths().workspaceDir;
    if (typeof runtimeWorkspace === 'string' && runtimeWorkspace.trim()) {
      const resolved = resolve(expandPath(runtimeWorkspace.trim()));
      if (existsSync(resolved)) {
        dirs.add(resolved);
      }
    }

    const config = readOpenClawConfigJson();
    const agents = isRecord(config.agents) ? config.agents : undefined;
    const agentList = Array.isArray(agents?.list) ? agents.list : [];
    for (const entry of agentList) {
      if (!isRecord(entry)) {
        continue;
      }
      const workspace = typeof entry.workspace === 'string' ? entry.workspace.trim() : '';
      if (!workspace) {
        continue;
      }
      const resolved = resolve(expandPath(workspace));
      if (existsSync(resolved)) {
        dirs.add(resolved);
      }
    }

    return Array.from(dirs);
  });

  // Get runtime path details for diagnostics.
  ipcMain.handle('openclaw:getRuntimeInfo', () => {
    return gatewayManager.getRuntimePaths();
  });

  // Get the OpenClaw skills directory (~/.openclaw/skills)
  ipcMain.handle('openclaw:getSkillsDir', () => {
    const dir = getOpenClawSkillsDir();
    ensureDir(dir);
    return dir;
  });

  // Get a shell command to run OpenClaw CLI without modifying PATH
  ipcMain.handle('openclaw:getCliCommand', () => {
    try {
      const status = getOpenClawStatus();
      if (!status.packageExists) {
        return { success: false, error: `OpenClaw package not found at: ${status.dir}` };
      }
      if (!existsSync(status.entryPath)) {
        return { success: false, error: `OpenClaw entry script not found at: ${status.entryPath}` };
      }
      return { success: true, command: getOpenClawCliCommand() };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Task manager plugin status
  ipcMain.handle('task:pluginStatus', async () => {
    const pluginId = 'task-manager';
    const pluginDir = join(homedir(), '.openclaw', 'extensions', pluginId);
    const manifestPath = join(pluginDir, 'openclaw.plugin.json');
    return {
      installed: existsSync(manifestPath),
      enabled: isPluginEnabled(pluginId),
      skillEnabled: isSkillEnabled('task-manager'),
      version: getInstalledPluginVersion(pluginId),
      pluginDir,
    };
  });

  // Install task manager plugin from bundled mirror/local source and restart Gateway
  ipcMain.handle('task:pluginInstall', async () => {
    try {
      const result = await ensureTaskManagerPluginInstalled();
      if (!result.installed) {
        return {
          success: false,
          error: result.warning || 'Task manager plugin install failed',
        };
      }
      ensurePluginEnabledInConfig('task-manager');
      ensurePluginInstallRecordInConfig('task-manager', {
        source: 'path',
        installPath: result.installedPath,
        sourcePath: result.sourcePath,
        version: result.version,
      });
      ensureSkillEnabledInConfig('task-manager');
      gatewayManager.debouncedRestart();
      return {
        success: true,
        installed: true,
        enabled: true,
        skillEnabled: true,
        installedPath: result.installedPath,
        sourcePath: result.sourcePath,
        version: result.version,
      };
    } catch (error) {
      logger.error('Failed to install task-manager plugin:', error);
      return {
        success: false,
        error: String(error),
      };
    }
  });


  // ==================== Channel Configuration Handlers ====================

  // Save channel configuration
  ipcMain.handle('channel:saveConfig', async (_, channelType: string, config: Record<string, unknown>) => {
    try {
      logger.info('channel:saveConfig', { channelType, keys: Object.keys(config || {}) });
      if (channelType === 'dingtalk') {
        const installResult = await ensureDingTalkPluginInstalled();
        if (!installResult.installed) {
          return {
            success: false,
            error: installResult.warning || 'DingTalk plugin install failed',
          };
        }
        ensurePluginInstallRecordInConfig('dingtalk', {
          source: 'path',
          installPath: installResult.installedPath,
          sourcePath: installResult.sourcePath,
          version: installResult.version,
        });
        await saveChannelConfig(channelType, config);
        logger.info(
          `Skipping app-forced Gateway restart after channel:saveConfig (${channelType}); Gateway handles channel config reload/restart internally`
        );
        return {
          success: true,
          pluginInstalled: installResult.installed,
          warning: installResult.warning,
        };
      }
      await saveChannelConfig(channelType, config);
      // Do not force stop/start here. Recent Gateway builds detect channel config
      // changes and perform an internal service restart; forcing another restart
      // from Electron can race with reconnect and kill the newly spawned process.
      logger.info(
        `Skipping app-forced Gateway restart after channel:saveConfig (${channelType}); waiting for Gateway internal channel reload`
      );
      return { success: true };
    } catch (error) {
      console.error('Failed to save channel config:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get channel configuration
  ipcMain.handle('channel:getConfig', async (_, channelType: string) => {
    try {
      const config = await getChannelConfig(channelType);
      return { success: true, config };
    } catch (error) {
      console.error('Failed to get channel config:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get channel form values (reverse-transformed for UI pre-fill)
  ipcMain.handle('channel:getFormValues', async (_, channelType: string) => {
    try {
      const values = await getChannelFormValues(channelType);
      return { success: true, values };
    } catch (error) {
      console.error('Failed to get channel form values:', error);
      return { success: false, error: String(error) };
    }
  });

  // Delete channel configuration
  ipcMain.handle('channel:deleteConfig', async (_, channelType: string) => {
    try {
      await deleteChannelConfig(channelType);
      return { success: true };
    } catch (error) {
      console.error('Failed to delete channel config:', error);
      return { success: false, error: String(error) };
    }
  });

  // List configured channels
  ipcMain.handle('channel:listConfigured', async () => {
    try {
      const channels = await listConfiguredChannels();
      return { success: true, channels };
    } catch (error) {
      console.error('Failed to list channels:', error);
      return { success: false, error: String(error) };
    }
  });

  // Enable or disable a channel
  ipcMain.handle('channel:setEnabled', async (_, channelType: string, enabled: boolean) => {
    try {
      await setChannelEnabled(channelType, enabled);
      return { success: true };
    } catch (error) {
      console.error('Failed to set channel enabled:', error);
      return { success: false, error: String(error) };
    }
  });

  // Validate channel configuration
  ipcMain.handle('channel:validate', async (_, channelType: string) => {
    try {
      const result = await validateChannelConfig(channelType);
      return { success: true, ...result };
    } catch (error) {
      console.error('Failed to validate channel:', error);
      return { success: false, valid: false, errors: [String(error)], warnings: [] };
    }
  });

  // Validate channel credentials by calling actual service APIs (before saving)
  ipcMain.handle('channel:validateCredentials', async (_, channelType: string, config: Record<string, string>) => {
    try {
      const result = await validateChannelCredentials(channelType, config);
      return { success: true, ...result };
    } catch (error) {
      console.error('Failed to validate channel credentials:', error);
      return { success: false, valid: false, errors: [String(error)], warnings: [] };
    }
  });
}

/**
 * WhatsApp Login Handlers
 */
function registerWhatsAppHandlers(mainWindow: BrowserWindow): void {
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
}

/**
 * Device OAuth Handlers (Code Plan)
 */
function registerDeviceOAuthHandlers(mainWindow: BrowserWindow): void {
  deviceOAuthManager.setWindow(mainWindow);

  // Request Provider OAuth initialization
  ipcMain.handle('provider:requestOAuth', async (_, provider: OAuthProviderType, region?: 'global' | 'cn') => {
    try {
      logger.info(`provider:requestOAuth for ${provider}`);
      await deviceOAuthManager.startFlow(provider, region);
      return { success: true };
    } catch (error) {
      logger.error('provider:requestOAuth failed', error);
      return { success: false, error: String(error) };
    }
  });

  // Cancel Provider OAuth
  ipcMain.handle('provider:cancelOAuth', async () => {
    try {
      await deviceOAuthManager.stopFlow();
      return { success: true };
    } catch (error) {
      logger.error('provider:cancelOAuth failed', error);
      return { success: false, error: String(error) };
    }
  });
}

/**
 * Provider-related IPC handlers
 */
function registerProviderHandlers(gatewayManager: GatewayManager): void {
  const openclawConfigPath = join(homedir(), '.openclaw', 'openclaw.json');

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function getOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  function normalizeModelIdWithProviderHint(
    rawModelId: string | undefined,
    providerHint?: string,
  ): string | undefined {
    const normalizedRawModelId = getOptionalString(rawModelId);
    if (!normalizedRawModelId) {
      return undefined;
    }
    const normalizedProviderHint = getOptionalString(providerHint);
    if (!normalizedProviderHint) {
      return normalizedRawModelId;
    }
    if (normalizedRawModelId.includes('/')) {
      return normalizedRawModelId;
    }
    return `${normalizedProviderHint}/${normalizedRawModelId}`;
  }

  function pushUniqueModelId(
    modelId: string | undefined,
    ordered: string[],
    seen: Set<string>,
  ): void {
    if (!modelId || seen.has(modelId)) {
      return;
    }
    seen.add(modelId);
    ordered.push(modelId);
  }

  function extractModelId(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return getOptionalString(value);
    }
    if (!isRecord(value)) {
      return undefined;
    }
    return getOptionalString(value.primary);
  }

  function extractFallbackModelIds(value: unknown): string[] {
    if (!isRecord(value) || !Array.isArray(value.fallbacks)) {
      return [];
    }
    return value.fallbacks
      .map((entry) => getOptionalString(entry))
      .filter((entry): entry is string => Boolean(entry));
  }

  function buildPatchedModelValue(
    currentModelValue: unknown,
    replacementModel: string | null,
  ): Record<string, unknown> | string | null {
    if (replacementModel == null) {
      return null;
    }
    if (isRecord(currentModelValue)) {
      return {
        ...currentModelValue,
        primary: replacementModel,
      };
    }
    return replacementModel;
  }

  function readOpenClawConfigForProviderSync(): Record<string, unknown> {
    try {
      if (!existsSync(openclawConfigPath)) {
        return {};
      }
      const parsed = JSON.parse(readFileSync(openclawConfigPath, 'utf-8')) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch (error) {
      logger.warn('Failed to read openclaw.json for provider sync', error);
      return {};
    }
  }

  function writeOpenClawConfigForProviderSync(config: Record<string, unknown>): void {
    mkdirSync(dirname(openclawConfigPath), { recursive: true });
    writeFileSync(openclawConfigPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  function collectConfiguredModelIdsFromOpenClawConfig(
    config: Record<string, unknown>,
  ): { modelIds: string[]; unsafeShape: boolean } {
    const ordered: string[] = [];
    const seen = new Set<string>();
    let unsafeShape = false;

    const models = isRecord(config.models) ? config.models : undefined;
    const providers = isRecord(models?.providers)
      ? models.providers as Record<string, unknown>
      : undefined;

    if (providers) {
      for (const [providerId, providerEntry] of Object.entries(providers)) {
        const providerHint = getOptionalString(providerId);
        if (!isRecord(providerEntry)) {
          unsafeShape = true;
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(providerEntry, 'models')) {
          unsafeShape = true;
          continue;
        }
        const providerModels = providerEntry.models;
        if (!Array.isArray(providerModels)) {
          unsafeShape = true;
          continue;
        }
        for (const modelEntry of providerModels) {
          if (typeof modelEntry === 'string') {
            pushUniqueModelId(
              normalizeModelIdWithProviderHint(modelEntry, providerHint),
              ordered,
              seen,
            );
            continue;
          }
          if (!isRecord(modelEntry)) {
            continue;
          }
          const rawModelId = getOptionalString(modelEntry.id);
          pushUniqueModelId(
            normalizeModelIdWithProviderHint(rawModelId, providerHint),
            ordered,
            seen,
          );
        }
      }
    }

    const agents = isRecord(config.agents) ? config.agents : undefined;
    const defaults = isRecord(agents?.defaults) ? agents.defaults : undefined;
    const defaultsModels = isRecord(defaults?.models) ? defaults.models : undefined;
    if (defaultsModels) {
      for (const [rawModelId] of Object.entries(defaultsModels)) {
        pushUniqueModelId(getOptionalString(rawModelId), ordered, seen);
      }
    }

    return {
      modelIds: ordered,
      unsafeShape,
    };
  }

  function collectAutoFillModelCandidatesFromOpenClawConfig(config: Record<string, unknown>): string[] {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const push = (modelId: string | undefined) => {
      pushUniqueModelId(modelId, ordered, seen);
    };

    const agents = isRecord(config.agents) ? config.agents : undefined;
    const defaults = isRecord(agents?.defaults) ? agents.defaults : undefined;
    const defaultsModel = defaults?.model;
    push(extractModelId(defaultsModel));
    for (const fallbackId of extractFallbackModelIds(defaultsModel)) {
      push(fallbackId);
    }

    const list = Array.isArray(agents?.list) ? agents.list : [];
    for (const entry of list) {
      if (!isRecord(entry)) {
        continue;
      }
      push(extractModelId(entry.model));
      for (const fallbackId of extractFallbackModelIds(entry.model)) {
        push(fallbackId);
      }
    }

    return ordered;
  }

  function resolveReplacementModel(
    config: Record<string, unknown>,
    configuredModelIds: string[],
  ): string | null {
    const configuredModelIdSet = new Set(configuredModelIds);
    const candidates = collectAutoFillModelCandidatesFromOpenClawConfig(config);
    for (const candidate of candidates) {
      if (configuredModelIdSet.has(candidate)) {
        return candidate;
      }
    }
    return configuredModelIds[0] ?? null;
  }

  function reconcileAgentModelsAfterProviderMutation(): {
    changed: boolean;
    skippedByUnknownShape: boolean;
  } {
    const config = readOpenClawConfigForProviderSync();
    const { modelIds, unsafeShape } = collectConfiguredModelIdsFromOpenClawConfig(config);
    if (unsafeShape) {
      return {
        changed: false,
        skippedByUnknownShape: true,
      };
    }

    const configuredModelIdSet = new Set(modelIds);
    const replacementModel = resolveReplacementModel(config, modelIds);
    const agents = isRecord(config.agents) ? config.agents : undefined;
    if (!agents) {
      return {
        changed: false,
        skippedByUnknownShape: false,
      };
    }

    let changed = false;

    const defaults = isRecord(agents.defaults) ? agents.defaults : undefined;
    if (defaults) {
      const defaultsModelId = extractModelId(defaults.model);
      if (defaultsModelId && !configuredModelIdSet.has(defaultsModelId)) {
        defaults.model = buildPatchedModelValue(defaults.model, replacementModel);
        agents.defaults = defaults;
        changed = true;
      }
    }

    const list = Array.isArray(agents.list) ? agents.list : [];
    for (const entry of list) {
      if (!isRecord(entry)) {
        continue;
      }
      const modelId = extractModelId(entry.model);
      if (!modelId || configuredModelIdSet.has(modelId)) {
        continue;
      }
      entry.model = buildPatchedModelValue(entry.model, replacementModel);
      changed = true;
    }

    if (changed) {
      config.agents = agents;
      writeOpenClawConfigForProviderSync(config);
    }

    return {
      changed,
      skippedByUnknownShape: false,
    };
  }

  function runProviderMutationReconcileIfNeeded(): void {
    const result = reconcileAgentModelsAfterProviderMutation();
    if (result.skippedByUnknownShape) {
      logger.warn(
        'Skip provider model reconciliation: detected unknown models.providers[*].models shape in openclaw.json'
      );
      return;
    }
    if (result.changed) {
      logger.info('Reconciled invalid agent model references after provider mutation');
    }
  }

  // Listen for OAuth success to automatically restart the Gateway with new tokens/configs.
  // Use a longer debounce (8s) so that provider:setDefault — which writes the full config
  // and then calls debouncedRestart(2s) — has time to fire and coalesce into a single
  // restart.  Without this, the OAuth restart fires first with stale config, and the
  // subsequent provider:setDefault restart is deferred and dropped.
  deviceOAuthManager.on('oauth:success', (providerType) => {
    logger.info(`[IPC] Scheduling Gateway restart after ${providerType} OAuth success...`);
    gatewayManager.debouncedRestart(8000);
  });

  // Get all providers with key info
  ipcMain.handle('provider:list', async () => {
    return await getAllProvidersWithKeyInfo();
  });

  // Get a specific provider
  ipcMain.handle('provider:get', async (_, providerId: string) => {
    return await getProvider(providerId);
  });

  // Save a provider configuration
  ipcMain.handle('provider:save', async (_, config: ProviderConfig, apiKey?: string) => {
    try {
      // Save the provider config
      await saveProvider(config);

      // Derive the unique OpenClaw key for this provider instance
      const ock = getOpenClawProviderKey(config.type, config.id);

      // Store the API key if provided
      if (apiKey !== undefined) {
        const trimmedKey = apiKey.trim();
        if (trimmedKey) {
          await storeApiKey(config.id, trimmedKey);

          // Also write to OpenClaw auth-profiles.json so the gateway can use it
          try {
            await saveProviderKeyToOpenClaw(ock, trimmedKey);
          } catch (err) {
            console.warn('Failed to save key to OpenClaw auth-profiles:', err);
          }
        }
      }

      // Sync the provider configuration to openclaw.json so Gateway knows about it
      try {
        const meta = getProviderConfig(config.type);
        const api = config.type === 'custom' || config.type === 'ollama' ? 'openai-completions' : meta?.api;

        if (api) {
          await syncProviderConfigToOpenClaw(ock, config.model, {
            baseUrl: config.baseUrl || meta?.baseUrl,
            api,
            apiKeyEnv: meta?.apiKeyEnv,
            headers: meta?.headers,
          });

          if (config.type === 'custom' || config.type === 'ollama') {
            const resolvedKey = apiKey !== undefined
              ? (apiKey.trim() || null)
              : await getApiKey(config.id);
            if (resolvedKey && config.baseUrl) {
              const modelId = config.model;
              await updateAgentModelProvider(ock, {
                baseUrl: config.baseUrl,
                api: 'openai-completions',
                models: modelId ? [{ id: modelId, name: modelId }] : [],
                apiKey: resolvedKey,
              });
            }
          }

          runProviderMutationReconcileIfNeeded();

          // Debounced restart so the gateway picks up new config/env vars.
          // Multiple rapid provider saves (e.g. during setup) are coalesced.
          logger.info(`Scheduling Gateway restart after saving provider "${ock}" config`);
          gatewayManager.debouncedRestart();
        }
      } catch (err) {
        console.warn('Failed to sync openclaw provider config:', err);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Delete a provider
  ipcMain.handle('provider:delete', async (_, providerId: string) => {
    try {
      const existing = await getProvider(providerId);
      await deleteProvider(providerId);

      // Best-effort cleanup in OpenClaw auth profiles & openclaw.json config
      if (existing?.type) {
        try {
          const ock = getOpenClawProviderKey(existing.type, providerId);
          await removeProviderFromOpenClaw(ock);
          runProviderMutationReconcileIfNeeded();

          // Debounced restart so the gateway stops loading the deleted provider.
          logger.info(`Scheduling Gateway restart after deleting provider "${ock}"`);
          gatewayManager.debouncedRestart();
        } catch (err) {
          console.warn('Failed to completely remove provider from OpenClaw:', err);
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Update API key for a provider
  ipcMain.handle('provider:setApiKey', async (_, providerId: string, apiKey: string) => {
    try {
      await storeApiKey(providerId, apiKey);

      // Also write to OpenClaw auth-profiles.json
      const provider = await getProvider(providerId);
      const providerType = provider?.type || providerId;
      const ock = getOpenClawProviderKey(providerType, providerId);
      try {
        await saveProviderKeyToOpenClaw(ock, apiKey);
      } catch (err) {
        console.warn('Failed to save key to OpenClaw auth-profiles:', err);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Atomically update provider config and API key
  ipcMain.handle(
    'provider:updateWithKey',
    async (
      _,
      providerId: string,
      updates: Partial<ProviderConfig>,
      apiKey?: string
    ) => {
      const existing = await getProvider(providerId);
      if (!existing) {
        return { success: false, error: 'Provider not found' };
      }

      const previousKey = await getApiKey(providerId);
      const previousOck = getOpenClawProviderKey(existing.type, providerId);

      try {
        const nextConfig: ProviderConfig = {
          ...existing,
          ...updates,
          updatedAt: new Date().toISOString(),
        };

        const ock = getOpenClawProviderKey(nextConfig.type, providerId);

        await saveProvider(nextConfig);

        if (apiKey !== undefined) {
          const trimmedKey = apiKey.trim();
          if (trimmedKey) {
            await storeApiKey(providerId, trimmedKey);
            await saveProviderKeyToOpenClaw(ock, trimmedKey);
          } else {
            await deleteApiKey(providerId);
            await removeProviderFromOpenClaw(ock);
          }
        }

        // Sync the provider configuration to openclaw.json so Gateway knows about it
        try {
          const fallbackModels = await getProviderFallbackModelRefs(nextConfig);
          const meta = getProviderConfig(nextConfig.type);
          const api = nextConfig.type === 'custom' || nextConfig.type === 'ollama' ? 'openai-completions' : meta?.api;

          if (api) {
            await syncProviderConfigToOpenClaw(ock, nextConfig.model, {
              baseUrl: nextConfig.baseUrl || meta?.baseUrl,
              api,
              apiKeyEnv: meta?.apiKeyEnv,
              headers: meta?.headers,
            });

            if (nextConfig.type === 'custom' || nextConfig.type === 'ollama') {
              const resolvedKey = apiKey !== undefined
                ? (apiKey.trim() || null)
                : await getApiKey(providerId);
              if (resolvedKey && nextConfig.baseUrl) {
                const modelId = nextConfig.model;
                await updateAgentModelProvider(ock, {
                  baseUrl: nextConfig.baseUrl,
                  api: 'openai-completions',
                  models: modelId ? [{ id: modelId, name: modelId }] : [],
                  apiKey: resolvedKey,
                });
              }
            }
          }

          // If this provider is the current default, update the primary model
          const defaultProviderId = await getDefaultProvider();
          if (defaultProviderId === providerId) {
            const modelOverride = nextConfig.model
              ? `${ock}/${nextConfig.model}`
              : undefined;
            if (nextConfig.type !== 'custom' && nextConfig.type !== 'ollama') {
              await setOpenClawDefaultModel(ock, modelOverride, fallbackModels);
            } else {
              await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
                baseUrl: nextConfig.baseUrl,
                api: 'openai-completions',
              }, fallbackModels);
            }
          }

          runProviderMutationReconcileIfNeeded();

          // Debounced restart so the gateway picks up updated config/env vars.
          logger.info(`Scheduling Gateway restart after updating provider "${ock}" config`);
          gatewayManager.debouncedRestart();
        } catch (err) {
          console.warn('Failed to sync openclaw config after provider update:', err);
        }

        return { success: true };
      } catch (error) {
        // Best-effort rollback to keep config/key consistent.
        try {
          await saveProvider(existing);
          if (previousKey) {
            await storeApiKey(providerId, previousKey);
            await saveProviderKeyToOpenClaw(previousOck, previousKey);
          } else {
            await deleteApiKey(providerId);
            await removeProviderFromOpenClaw(previousOck);
          }
        } catch (rollbackError) {
          console.warn('Failed to rollback provider updateWithKey:', rollbackError);
        }

        return { success: false, error: String(error) };
      }
    }
  );

  // Delete API key for a provider
  ipcMain.handle('provider:deleteApiKey', async (_, providerId: string) => {
    try {
      await deleteApiKey(providerId);

      // Keep OpenClaw auth-profiles.json in sync with local key storage
      const provider = await getProvider(providerId);
      const providerType = provider?.type || providerId;
      const ock = getOpenClawProviderKey(providerType, providerId);
      try {
        if (ock) {
          await removeProviderFromOpenClaw(ock);
        }
      } catch (err) {
        console.warn('Failed to completely remove provider from OpenClaw:', err);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Check if a provider has an API key
  ipcMain.handle('provider:hasApiKey', async (_, providerId: string) => {
    return await hasApiKey(providerId);
  });

  // Get the actual API key (for internal use only - be careful!)
  ipcMain.handle('provider:getApiKey', async (_, providerId: string) => {
    return await getApiKey(providerId);
  });

  // Set default provider and update OpenClaw default model
  ipcMain.handle('provider:setDefault', async (_, providerId: string) => {
    try {
      await setDefaultProvider(providerId);

      // Update OpenClaw config to use this provider's default model
      const provider = await getProvider(providerId);
      if (provider) {
        try {
          const ock = getOpenClawProviderKey(provider.type, providerId);
          const providerKey = await getApiKey(providerId);
          const fallbackModels = await getProviderFallbackModelRefs(provider);

          // OAuth providers (qwen-portal, minimax-portal, minimax-portal-cn) might use OAuth OR a direct API key.
          // Treat them as OAuth only if they don't have a local API key configured.
          const OAUTH_PROVIDER_TYPES = ['qwen-portal', 'minimax-portal', 'minimax-portal-cn'];
          const isOAuthProvider = OAUTH_PROVIDER_TYPES.includes(provider.type) && !providerKey;

          if (!isOAuthProvider) {
            // Build the full model string: "openclawKey/modelId"
            const modelOverride = provider.model
              ? (provider.model.startsWith(`${ock}/`)
                ? provider.model
                : `${ock}/${provider.model}`)
              : undefined;

            if (provider.type === 'custom' || provider.type === 'ollama') {
              await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
                baseUrl: provider.baseUrl,
                api: 'openai-completions',
              }, fallbackModels);
            } else {
              await setOpenClawDefaultModel(ock, modelOverride, fallbackModels);
            }

            // Keep auth-profiles in sync with the default provider instance.
            if (providerKey) {
              await saveProviderKeyToOpenClaw(ock, providerKey);
            }
          } else {
            // OAuth providers (minimax-portal, minimax-portal-cn, qwen-portal)
            const defaultBaseUrl = provider.type === 'minimax-portal'
              ? 'https://api.minimax.io/anthropic'
              : (provider.type === 'minimax-portal-cn' ? 'https://api.minimaxi.com/anthropic' : 'https://portal.qwen.ai/v1');
            const api: 'anthropic-messages' | 'openai-completions' =
              (provider.type === 'minimax-portal' || provider.type === 'minimax-portal-cn')
                ? 'anthropic-messages'
                : 'openai-completions';

            let baseUrl = provider.baseUrl || defaultBaseUrl;
            if ((provider.type === 'minimax-portal' || provider.type === 'minimax-portal-cn') && baseUrl) {
              baseUrl = baseUrl.replace(/\/v1$/, '').replace(/\/anthropic$/, '').replace(/\/$/, '') + '/anthropic';
            }

            // To ensure the OpenClaw Gateway's internal token refresher works,
            // we must save the CN provider under the "minimax-portal" key in openclaw.json
            const targetProviderKey = (provider.type === 'minimax-portal' || provider.type === 'minimax-portal-cn')
              ? 'minimax-portal'
              : provider.type;

            await setOpenClawDefaultModelWithOverride(targetProviderKey, getProviderModelRef(provider), {
              baseUrl,
              api,
              authHeader: targetProviderKey === 'minimax-portal' ? true : undefined,
              // Relies on OpenClaw Gateway native auth-profiles syncing
              apiKeyEnv: targetProviderKey === 'minimax-portal' ? 'minimax-oauth' : 'qwen-oauth',
            }, fallbackModels);

            logger.info(`Configured openclaw.json for OAuth provider "${provider.type}"`);

            // Also write models.json directly so pi-ai picks up the correct baseUrl and
            // authHeader immediately, without waiting for Gateway to sync openclaw.json.
            try {
              const defaultModelId = provider.model?.split('/').pop();
              await updateAgentModelProvider(targetProviderKey, {
                baseUrl,
                api,
                authHeader: targetProviderKey === 'minimax-portal' ? true : undefined,
                apiKey: targetProviderKey === 'minimax-portal' ? 'minimax-oauth' : 'qwen-oauth',
                models: defaultModelId ? [{ id: defaultModelId, name: defaultModelId }] : [],
              });
            } catch (err) {
              logger.warn(`Failed to update models.json for OAuth provider "${targetProviderKey}":`, err);
            }
          }

          // For custom/ollama providers, also update the per-agent models.json
          if (
            (provider.type === 'custom' || provider.type === 'ollama') &&
            providerKey &&
            provider.baseUrl
          ) {
            const modelId = provider.model;
            await updateAgentModelProvider(ock, {
              baseUrl: provider.baseUrl,
              api: 'openai-completions',
              models: modelId ? [{ id: modelId, name: modelId }] : [],
              apiKey: providerKey,
            });
          }

          runProviderMutationReconcileIfNeeded();

          // Debounced restart so the gateway picks up the new default provider.
          // Because OAuth success triggers a debounced restart, the gateway might not be
          // currently connected ('starting' or 'reconnecting'). Checking if it is simply
          // not 'stopped' ensures the restart request is correctly queued or coalesced.
          if (gatewayManager.getStatus().state !== 'stopped') {
            logger.info(`Scheduling Gateway restart after provider switch to "${ock}"`);
            gatewayManager.debouncedRestart();
          }
        } catch (err) {
          console.warn('Failed to set OpenClaw default model:', err);
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });



  // Get default provider
  ipcMain.handle('provider:getDefault', async () => {
    return await getDefaultProvider();
  });

  // Validate API key by making a real test request to the provider.
  // providerId can be either a stored provider ID or a provider type.
  ipcMain.handle(
    'provider:validateKey',
    async (
      _,
      providerId: string,
      apiKey: string,
      options?: { baseUrl?: string }
    ) => {
      try {
        // First try to get existing provider
        const provider = await getProvider(providerId);

        // Use provider.type if provider exists, otherwise use providerId as the type
        // This allows validation during setup when provider hasn't been saved yet
        const providerType = provider?.type || providerId;
        const registryBaseUrl = getProviderConfig(providerType)?.baseUrl;
        // Prefer caller-supplied baseUrl (live form value) over persisted config.
        // This ensures Setup/Settings validation reflects unsaved edits immediately.
        const resolvedBaseUrl = options?.baseUrl || provider?.baseUrl || registryBaseUrl;

        console.log(`[matchaclaw-validate] validating provider type: ${providerType}`);
        return await validateApiKeyWithProvider(providerType, apiKey, { baseUrl: resolvedBaseUrl });
      } catch (error) {
        console.error('Validation error:', error);
        return { valid: false, error: String(error) };
      }
    }
  );
}

type ValidationProfile = 'openai-compatible' | 'google-query-key' | 'anthropic-header' | 'openrouter' | 'none';

/**
 * Validate API key using lightweight model-listing endpoints (zero token cost).
 * Providers are grouped into 3 auth styles:
 * - openai-compatible: Bearer auth + /models
 * - google-query-key: ?key=... + /models
 * - anthropic-header: x-api-key + anthropic-version + /models
 */
async function validateApiKeyWithProvider(
  providerType: string,
  apiKey: string,
  options?: { baseUrl?: string }
): Promise<{ valid: boolean; error?: string }> {
  const profile = getValidationProfile(providerType);
  if (profile === 'none') {
    return { valid: true };
  }

  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    return { valid: false, error: 'API key is required' };
  }

  try {
    switch (profile) {
      case 'openai-compatible':
        return await validateOpenAiCompatibleKey(providerType, trimmedKey, options?.baseUrl);
      case 'google-query-key':
        return await validateGoogleQueryKey(providerType, trimmedKey, options?.baseUrl);
      case 'anthropic-header':
        return await validateAnthropicHeaderKey(providerType, trimmedKey, options?.baseUrl);
      case 'openrouter':
        return await validateOpenRouterKey(providerType, trimmedKey);
      default:
        return { valid: false, error: `Unsupported validation profile for provider: ${providerType}` };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { valid: false, error: errorMessage };
  }
}

function logValidationStatus(provider: string, status: number): void {
  console.log(`[matchaclaw-validate] ${provider} HTTP ${status}`);
}

function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 8) return `${secret.slice(0, 2)}***`;
  return `${secret.slice(0, 4)}***${secret.slice(-4)}`;
}

function sanitizeValidationUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const key = url.searchParams.get('key');
    if (key) url.searchParams.set('key', maskSecret(key));
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const next = { ...headers };
  if (next.Authorization?.startsWith('Bearer ')) {
    const token = next.Authorization.slice('Bearer '.length);
    next.Authorization = `Bearer ${maskSecret(token)}`;
  }
  if (next['x-api-key']) {
    next['x-api-key'] = maskSecret(next['x-api-key']);
  }
  return next;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function buildOpenAiModelsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/models?limit=1`;
}

function logValidationRequest(
  provider: string,
  method: string,
  url: string,
  headers: Record<string, string>
): void {
  console.log(
    `[matchaclaw-validate] ${provider} request ${method} ${sanitizeValidationUrl(url)} headers=${JSON.stringify(sanitizeHeaders(headers))}`
  );
}

function getValidationProfile(providerType: string): ValidationProfile {
  switch (providerType) {
    case 'anthropic':
      return 'anthropic-header';
    case 'google':
      return 'google-query-key';
    case 'openrouter':
      return 'openrouter';
    case 'ollama':
      return 'none';
    default:
      return 'openai-compatible';
  }
}

async function performProviderValidationRequest(
  providerLabel: string,
  url: string,
  headers: Record<string, string>
): Promise<{ valid: boolean; error?: string }> {
  try {
    logValidationRequest(providerLabel, 'GET', url, headers);
    const response = await proxyAwareFetch(url, { headers });
    logValidationStatus(providerLabel, response.status);
    const data = await response.json().catch(() => ({}));
    return classifyAuthResponse(response.status, data);
  } catch (error) {
    return {
      valid: false,
      error: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Helper: classify an HTTP response as valid / invalid / error.
 * 200 / 429 → valid (key works, possibly rate-limited).
 * 401 / 403 → invalid.
 * Everything else → return the API error message.
 */
function classifyAuthResponse(
  status: number,
  data: unknown
): { valid: boolean; error?: string } {
  if (status >= 200 && status < 300) return { valid: true };
  if (status === 429) return { valid: true }; // rate-limited but key is valid
  if (status === 401 || status === 403) return { valid: false, error: 'Invalid API key' };

  // Try to extract an error message
  const obj = data as { error?: { message?: string }; message?: string } | null;
  const msg = obj?.error?.message || obj?.message || `API error: ${status}`;
  return { valid: false, error: msg };
}

async function validateOpenAiCompatibleKey(
  providerType: string,
  apiKey: string,
  baseUrl?: string
): Promise<{ valid: boolean; error?: string }> {
  const trimmedBaseUrl = baseUrl?.trim();
  if (!trimmedBaseUrl) {
    return { valid: false, error: `Base URL is required for provider "${providerType}" validation` };
  }

  const headers = { Authorization: `Bearer ${apiKey}` };

  // Try /models first (standard OpenAI-compatible endpoint)
  const modelsUrl = buildOpenAiModelsUrl(trimmedBaseUrl);
  const modelsResult = await performProviderValidationRequest(providerType, modelsUrl, headers);

  // If /models returned 404, the provider likely doesn't implement it (e.g. MiniMax).
  // Fall back to a minimal /chat/completions POST which almost all providers support.
  if (modelsResult.error?.includes('API error: 404')) {
    console.log(
      `[matchaclaw-validate] ${providerType} /models returned 404, falling back to /chat/completions probe`
    );
    const base = normalizeBaseUrl(trimmedBaseUrl);
    const chatUrl = `${base}/chat/completions`;
    return await performChatCompletionsProbe(providerType, chatUrl, headers);
  }

  return modelsResult;
}

/**
 * Fallback validation: send a minimal /chat/completions request.
 * We intentionally use max_tokens=1 to minimise cost. The goal is only to
 * distinguish auth errors (401/403) from a working key (200/400/429).
 * A 400 "invalid model" still proves the key itself is accepted.
 */
async function performChatCompletionsProbe(
  providerLabel: string,
  url: string,
  headers: Record<string, string>
): Promise<{ valid: boolean; error?: string }> {
  try {
    logValidationRequest(providerLabel, 'POST', url, headers);
    const response = await proxyAwareFetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'validation-probe',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    });
    logValidationStatus(providerLabel, response.status);
    const data = await response.json().catch(() => ({}));

    // 401/403 → invalid key
    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: 'Invalid API key' };
    }
    // 200, 400 (bad model but key accepted), 429 → key is valid
    if (
      (response.status >= 200 && response.status < 300) ||
      response.status === 400 ||
      response.status === 429
    ) {
      return { valid: true };
    }
    return classifyAuthResponse(response.status, data);
  } catch (error) {
    return {
      valid: false,
      error: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function validateGoogleQueryKey(
  providerType: string,
  apiKey: string,
  baseUrl?: string
): Promise<{ valid: boolean; error?: string }> {
  // Default to the official Google Gemini API base URL if none is provided
  const base = normalizeBaseUrl(baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
  const url = `${base}/models?pageSize=1&key=${encodeURIComponent(apiKey)}`;
  return await performProviderValidationRequest(providerType, url, {});
}

async function validateAnthropicHeaderKey(
  providerType: string,
  apiKey: string,
  baseUrl?: string
): Promise<{ valid: boolean; error?: string }> {
  const base = normalizeBaseUrl(baseUrl || 'https://api.anthropic.com/v1');
  const url = `${base}/models?limit=1`;
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  return await performProviderValidationRequest(providerType, url, headers);
}

async function validateOpenRouterKey(
  providerType: string,
  apiKey: string
): Promise<{ valid: boolean; error?: string }> {
  // Use OpenRouter's auth check endpoint instead of public /models
  const url = 'https://openrouter.ai/api/v1/auth/key';
  const headers = { Authorization: `Bearer ${apiKey}` };
  return await performProviderValidationRequest(providerType, url, headers);
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
    shell.showItemInFolder(path);
  });

  // Open path
  ipcMain.handle('shell:openPath', async (_, path: string) => {
    return await shell.openPath(path);
  });

  // Check local path exists before opening (avoid native explorer error dialog)
  ipcMain.handle('shell:pathExists', async (_, path: string) => {
    try {
      const target = String(path ?? '').trim();
      if (!target) {
        return false;
      }
      return existsSync(target);
    } catch {
      return false;
    }
  });
}

/**
 * MatchaClawHub-related IPC handlers
 */
function registerMatchaClawHubHandlers(matchaclawHubService: MatchaClawHubService): void {
  // Search skills
  ipcMain.handle('matchaclawhub:search', async (_, params: MatchaClawHubSearchParams) => {
    try {
      const results = await matchaclawHubService.search(params);
      return { success: true, results };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Install skill
  ipcMain.handle('matchaclawhub:install', async (_, params: MatchaClawHubInstallParams) => {
    try {
      await matchaclawHubService.install(params);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Uninstall skill
  ipcMain.handle('matchaclawhub:uninstall', async (_, params: MatchaClawHubUninstallParams) => {
    try {
      await matchaclawHubService.uninstall(params);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // List installed skills
  ipcMain.handle('matchaclawhub:list', async () => {
    try {
      const results = await matchaclawHubService.listInstalled();
      return { success: true, results };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Open skill readme
  ipcMain.handle('matchaclawhub:openSkillReadme', async (_, slug: string) => {
    try {
      await matchaclawHubService.openSkillReadme(slug);
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
      key === 'proxyHttpServer' ||
      key === 'proxyHttpsServer' ||
      key === 'proxyAllServer' ||
      key === 'proxyBypassRules'
    ) {
      await handleProxySettingsChange();
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
      key === 'proxyHttpServer' ||
      key === 'proxyHttpsServer' ||
      key === 'proxyAllServer' ||
      key === 'proxyBypassRules'
    )) {
      await handleProxySettingsChange();
    }

    return { success: true };
  });

  ipcMain.handle('settings:reset', async () => {
    await resetSettings();
    const settings = await getAllSettings();
    await handleProxySettingsChange();
    return { success: true, settings };
  });
}

function registerLicenseHandlers(): void {
  ipcMain.handle('license:validate', async (_, rawKey: string) => {
    return validateLicenseKey(typeof rawKey === 'string' ? rawKey : '');
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
