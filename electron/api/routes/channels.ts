import type { IncomingMessage, ServerResponse } from 'http';
import { app } from 'electron';
import { existsSync, cpSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  deleteChannelConfig,
  getChannelFormValues,
  listConfiguredChannels,
  readOpenClawConfig,
  saveChannelConfig,
  setChannelEnabled,
  validateChannelConfig,
  validateChannelCredentials,
  writeOpenClawConfig,
} from '../../utils/channel-config';
import { upsertPluginInstallRecord } from '../../utils/plugin-install-record';
import { whatsAppLoginManager } from '../../utils/whatsapp-login';
import { weixinLoginManager } from '../../utils/weixin-login';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

function scheduleGatewayChannelRestart(ctx: HostApiContext, reason: string): void {
  if (ctx.gatewayManager.getStatus().state === 'stopped') {
    return;
  }
  ctx.gatewayManager.debouncedRestart();
  void reason;
}

type ManagedPluginInstallResult = {
  installed: boolean;
  warning?: string;
  installedPath?: string;
  sourcePath?: string;
  version?: string;
};

type PendingWeixinPersist = {
  config: Record<string, unknown>;
  installResult: ManagedPluginInstallResult;
  startedAt: number;
};

const pendingWeixinPersists = new Map<string, PendingWeixinPersist>();
let weixinPersistHooked = false;

function normalizeSessionKey(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

async function commitWeixinConfigAfterLoginSuccess(data: unknown): Promise<void> {
  const payload = (data && typeof data === 'object' ? data : {}) as {
    sessionKey?: unknown;
    requestedAccountId?: unknown;
    accountId?: unknown;
  };

  const bySession = normalizeSessionKey(payload.sessionKey);
  const byRequested = normalizeSessionKey(payload.requestedAccountId);
  const key = bySession ?? byRequested ?? (pendingWeixinPersists.size === 1 ? [...pendingWeixinPersists.keys()][0] : undefined);
  if (!key) {
    return;
  }

  const pending = pendingWeixinPersists.get(key);
  if (!pending) {
    return;
  }
  pendingWeixinPersists.delete(key);

  const resolvedAccountId = normalizeSessionKey(payload.accountId);
  const persistedConfig = {
    ...pending.config,
    enabled: true,
  };

  await recordChannelPluginInstall('openclaw-weixin', pending.installResult);
  await saveChannelConfig('openclaw-weixin', persistedConfig, resolvedAccountId);
}

function ensureWeixinPersistHooks(): void {
  if (weixinPersistHooked) {
    return;
  }
  weixinPersistHooked = true;

  weixinLoginManager.on('success', (data) => {
    void commitWeixinConfigAfterLoginSuccess(data).catch((error) => {
      console.error('[channels] Failed to persist weixin config after login success:', error);
    });
  });

  weixinLoginManager.on('error', () => {
    // Weixin login manager currently supports a single active login session.
    pendingWeixinPersists.clear();
  });
}

function getInstalledPluginVersion(pluginId: string): string | undefined {
  const pkgPath = join(homedir(), '.openclaw', 'extensions', pluginId, 'package.json');
  if (!existsSync(pkgPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

async function recordChannelPluginInstall(pluginId: string, installResult: ManagedPluginInstallResult): Promise<void> {
  if (!installResult.installed) {
    return;
  }
  const config = await readOpenClawConfig();
  const { nextConfig, changed } = upsertPluginInstallRecord(config as Record<string, unknown>, {
    pluginId,
    source: 'path',
    installPath: installResult.installedPath ?? join(homedir(), '.openclaw', 'extensions', pluginId),
    sourcePath: installResult.sourcePath,
    version: installResult.version,
  });
  if (changed) {
    await writeOpenClawConfig(nextConfig);
  }
}

async function ensureDingTalkPluginInstalled(): Promise<ManagedPluginInstallResult> {
  const targetDir = join(homedir(), '.openclaw', 'extensions', 'dingtalk');
  const targetManifest = join(targetDir, 'openclaw.plugin.json');

  if (existsSync(targetManifest)) {
    return {
      installed: true,
      installedPath: targetDir,
      version: getInstalledPluginVersion('dingtalk'),
    };
  }

  const candidateSources = app.isPackaged
    ? [
      join(process.resourcesPath, 'openclaw-plugins', 'dingtalk'),
      join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', 'dingtalk'),
      join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', 'dingtalk'),
    ]
    : [
      join(app.getAppPath(), 'build', 'openclaw-plugins', 'dingtalk'),
      join(process.cwd(), 'build', 'openclaw-plugins', 'dingtalk'),
      join(__dirname, '../../../build/openclaw-plugins/dingtalk'),
    ];

  const sourceDir = candidateSources.find((dir) => existsSync(join(dir, 'openclaw.plugin.json')));
  if (!sourceDir) {
    return {
      installed: false,
      warning: `Bundled DingTalk plugin mirror not found. Checked: ${candidateSources.join(' | ')}`,
    };
  }

  try {
    mkdirSync(join(homedir(), '.openclaw', 'extensions'), { recursive: true });
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true, dereference: true });
    if (!existsSync(targetManifest)) {
      return { installed: false, warning: 'Failed to install DingTalk plugin mirror (manifest missing).' };
    }
    return {
      installed: true,
      installedPath: targetDir,
      sourcePath: sourceDir,
      version: getInstalledPluginVersion('dingtalk'),
    };
  } catch {
    return { installed: false, warning: 'Failed to install bundled DingTalk plugin mirror' };
  }
}

async function ensureWeComPluginInstalled(): Promise<ManagedPluginInstallResult> {
  const targetDir = join(homedir(), '.openclaw', 'extensions', 'wecom');
  const targetManifest = join(targetDir, 'openclaw.plugin.json');

  if (existsSync(targetManifest)) {
    return {
      installed: true,
      installedPath: targetDir,
      version: getInstalledPluginVersion('wecom'),
    };
  }

  const candidateSources = app.isPackaged
    ? [
      join(process.resourcesPath, 'openclaw-plugins', 'wecom'),
      join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', 'wecom'),
      join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', 'wecom'),
    ]
    : [
      join(app.getAppPath(), 'build', 'openclaw-plugins', 'wecom'),
      join(process.cwd(), 'build', 'openclaw-plugins', 'wecom'),
      join(__dirname, '../../../build/openclaw-plugins/wecom'),
    ];

  const sourceDir = candidateSources.find((dir) => existsSync(join(dir, 'openclaw.plugin.json')));
  if (!sourceDir) {
    return {
      installed: false,
      warning: `Bundled WeCom plugin mirror not found. Checked: ${candidateSources.join(' | ')}`,
    };
  }

  try {
    mkdirSync(join(homedir(), '.openclaw', 'extensions'), { recursive: true });
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true, dereference: true });
    if (!existsSync(targetManifest)) {
      return { installed: false, warning: 'Failed to install WeCom plugin mirror (manifest missing).' };
    }
    return {
      installed: true,
      installedPath: targetDir,
      sourcePath: sourceDir,
      version: getInstalledPluginVersion('wecom'),
    };
  } catch {
    return { installed: false, warning: 'Failed to install bundled WeCom plugin mirror' };
  }
}

async function ensureFeishuPluginInstalled(): Promise<ManagedPluginInstallResult> {
  const targetDir = join(homedir(), '.openclaw', 'extensions', 'feishu-openclaw-plugin');
  const targetManifest = join(targetDir, 'openclaw.plugin.json');

  if (existsSync(targetManifest)) {
    return {
      installed: true,
      installedPath: targetDir,
      version: getInstalledPluginVersion('feishu-openclaw-plugin'),
    };
  }

  const candidateSources = app.isPackaged
    ? [
      join(process.resourcesPath, 'openclaw-plugins', 'feishu-openclaw-plugin'),
      join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', 'feishu-openclaw-plugin'),
      join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', 'feishu-openclaw-plugin'),
    ]
    : [
      join(app.getAppPath(), 'build', 'openclaw-plugins', 'feishu-openclaw-plugin'),
      join(process.cwd(), 'build', 'openclaw-plugins', 'feishu-openclaw-plugin'),
      join(__dirname, '../../../build/openclaw-plugins/feishu-openclaw-plugin'),
    ];

  const sourceDir = candidateSources.find((dir) => existsSync(join(dir, 'openclaw.plugin.json')));
  if (!sourceDir) {
    return {
      installed: false,
      warning: `Bundled Feishu plugin mirror not found. Checked: ${candidateSources.join(' | ')}`,
    };
  }

  try {
    mkdirSync(join(homedir(), '.openclaw', 'extensions'), { recursive: true });
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true, dereference: true });
    if (!existsSync(targetManifest)) {
      return { installed: false, warning: 'Failed to install Feishu plugin mirror (manifest missing).' };
    }
    return {
      installed: true,
      installedPath: targetDir,
      sourcePath: sourceDir,
      version: getInstalledPluginVersion('feishu-openclaw-plugin'),
    };
  } catch {
    return { installed: false, warning: 'Failed to install bundled Feishu plugin mirror' };
  }
}

async function ensureQQBotPluginInstalled(): Promise<ManagedPluginInstallResult> {
  const targetDir = join(homedir(), '.openclaw', 'extensions', 'qqbot');
  const targetManifest = join(targetDir, 'openclaw.plugin.json');

  if (existsSync(targetManifest)) {
    return {
      installed: true,
      installedPath: targetDir,
      version: getInstalledPluginVersion('qqbot'),
    };
  }

  const candidateSources = app.isPackaged
    ? [
      join(process.resourcesPath, 'openclaw-plugins', 'qqbot'),
      join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', 'qqbot'),
      join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', 'qqbot'),
    ]
    : [
      join(app.getAppPath(), 'build', 'openclaw-plugins', 'qqbot'),
      join(process.cwd(), 'build', 'openclaw-plugins', 'qqbot'),
      join(__dirname, '../../../build/openclaw-plugins/qqbot'),
    ];

  const sourceDir = candidateSources.find((dir) => existsSync(join(dir, 'openclaw.plugin.json')));
  if (!sourceDir) {
    return {
      installed: false,
      warning: `Bundled QQ Bot plugin mirror not found. Checked: ${candidateSources.join(' | ')}`,
    };
  }

  try {
    mkdirSync(join(homedir(), '.openclaw', 'extensions'), { recursive: true });
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true, dereference: true });
    if (!existsSync(targetManifest)) {
      return { installed: false, warning: 'Failed to install QQ Bot plugin mirror (manifest missing).' };
    }
    return {
      installed: true,
      installedPath: targetDir,
      sourcePath: sourceDir,
      version: getInstalledPluginVersion('qqbot'),
    };
  } catch {
    return { installed: false, warning: 'Failed to install bundled QQ Bot plugin mirror' };
  }
}

async function ensureWeixinPluginInstalled(): Promise<ManagedPluginInstallResult> {
  const pluginId = 'openclaw-weixin';
  const targetDir = join(homedir(), '.openclaw', 'extensions', pluginId);
  const targetManifest = join(targetDir, 'openclaw.plugin.json');

  if (existsSync(targetManifest)) {
    return {
      installed: true,
      installedPath: targetDir,
      version: getInstalledPluginVersion(pluginId),
    };
  }

  const candidateSources = app.isPackaged
    ? [
      join(process.resourcesPath, 'openclaw-plugins', pluginId),
      join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', pluginId),
      join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', pluginId),
    ]
    : [
      join(app.getAppPath(), 'build', 'openclaw-plugins', pluginId),
      join(process.cwd(), 'build', 'openclaw-plugins', pluginId),
      join(__dirname, `../../../build/openclaw-plugins/${pluginId}`),
    ];

  const sourceDir = candidateSources.find((dir) => existsSync(join(dir, 'openclaw.plugin.json')));
  if (!sourceDir) {
    return {
      installed: false,
      warning: `Bundled Weixin plugin mirror not found. Checked: ${candidateSources.join(' | ')}`,
    };
  }

  try {
    mkdirSync(join(homedir(), '.openclaw', 'extensions'), { recursive: true });
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true, dereference: true });
    if (!existsSync(targetManifest)) {
      return { installed: false, warning: 'Failed to install Weixin plugin mirror (manifest missing).' };
    }
    return {
      installed: true,
      installedPath: targetDir,
      sourcePath: sourceDir,
      version: getInstalledPluginVersion(pluginId),
    };
  } catch {
    return { installed: false, warning: 'Failed to install bundled Weixin plugin mirror' };
  }
}

export async function handleChannelRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  ensureWeixinPersistHooks();

  if (url.pathname === '/api/channels/configured' && req.method === 'GET') {
    sendJson(res, 200, { success: true, channels: await listConfiguredChannels() });
    return true;
  }

  if (url.pathname === '/api/channels/config/validate' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ channelType: string }>(req);
      sendJson(res, 200, { success: true, ...(await validateChannelConfig(body.channelType)) });
    } catch (error) {
      sendJson(res, 500, { success: false, valid: false, errors: [String(error)], warnings: [] });
    }
    return true;
  }

  if (url.pathname === '/api/channels/credentials/validate' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ channelType: string; config: Record<string, string> }>(req);
      sendJson(res, 200, { success: true, ...(await validateChannelCredentials(body.channelType, body.config)) });
    } catch (error) {
      sendJson(res, 500, { success: false, valid: false, errors: [String(error)], warnings: [] });
    }
    return true;
  }

  if (url.pathname === '/api/channels/whatsapp/start' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ accountId: string }>(req);
      await whatsAppLoginManager.start(body.accountId);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/whatsapp/cancel' && req.method === 'POST') {
    try {
      await whatsAppLoginManager.stop();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/openclaw-weixin/start' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ accountId?: string; config?: Record<string, unknown> }>(req);
      const installResult = await ensureWeixinPluginInstalled();
      if (!installResult.installed) {
        sendJson(res, 500, { success: false, error: installResult.warning || 'Weixin plugin install failed' });
        return true;
      }
      const sessionKey = normalizeSessionKey(body.accountId) ?? 'default';
      const config = {
        ...(body.config && typeof body.config === 'object' ? body.config : {}),
        enabled: true,
      };
      pendingWeixinPersists.set(sessionKey, {
        config,
        installResult,
        startedAt: Date.now(),
      });

      const routeTag = typeof config.routeTag === 'string' ? config.routeTag : undefined;
      const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : undefined;
      weixinLoginManager.startInBackground({
        accountId: sessionKey,
        baseUrl,
        routeTag,
      });
      sendJson(res, 200, { success: true, queued: true, sessionKey });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/openclaw-weixin/cancel' && req.method === 'POST') {
    try {
      await weixinLoginManager.stop();
      pendingWeixinPersists.clear();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/config' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ channelType: string; config: Record<string, unknown>; accountId?: string }>(req);
      if (body.channelType === 'dingtalk') {
        const installResult = await ensureDingTalkPluginInstalled();
        if (!installResult.installed) {
          sendJson(res, 500, { success: false, error: installResult.warning || 'DingTalk plugin install failed' });
          return true;
        }
        await recordChannelPluginInstall('dingtalk', installResult);
      }
      if (body.channelType === 'wecom') {
        const installResult = await ensureWeComPluginInstalled();
        if (!installResult.installed) {
          sendJson(res, 500, { success: false, error: installResult.warning || 'WeCom plugin install failed' });
          return true;
        }
        await recordChannelPluginInstall('wecom', installResult);
      }
      if (body.channelType === 'qqbot') {
        const installResult = await ensureQQBotPluginInstalled();
        if (!installResult.installed) {
          sendJson(res, 500, { success: false, error: installResult.warning || 'QQ Bot plugin install failed' });
          return true;
        }
        await recordChannelPluginInstall('qqbot', installResult);
      }
      if (body.channelType === 'feishu') {
        const installResult = await ensureFeishuPluginInstalled();
        if (!installResult.installed) {
          sendJson(res, 500, { success: false, error: installResult.warning || 'Feishu plugin install failed' });
          return true;
        }
        await recordChannelPluginInstall('feishu-openclaw-plugin', installResult);
      }
      if (body.channelType === 'openclaw-weixin') {
        const installResult = await ensureWeixinPluginInstalled();
        if (!installResult.installed) {
          sendJson(res, 500, { success: false, error: installResult.warning || 'Weixin plugin install failed' });
          return true;
        }
        await recordChannelPluginInstall('openclaw-weixin', installResult);
      }
      await saveChannelConfig(body.channelType, body.config, body.accountId);
      scheduleGatewayChannelRestart(ctx, `channel:saveConfig:${body.channelType}`);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/channels/config/enabled' && req.method === 'PUT') {
    try {
      const body = await parseJsonBody<{ channelType: string; enabled: boolean }>(req);
      await setChannelEnabled(body.channelType, body.enabled);
      scheduleGatewayChannelRestart(ctx, `channel:setEnabled:${body.channelType}`);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/channels/config/') && req.method === 'GET') {
    try {
      const channelType = decodeURIComponent(url.pathname.slice('/api/channels/config/'.length));
      const accountId = url.searchParams.get('accountId') || undefined;
      sendJson(res, 200, {
        success: true,
        values: await getChannelFormValues(channelType, accountId),
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/channels/config/') && req.method === 'DELETE') {
    try {
      const channelType = decodeURIComponent(url.pathname.slice('/api/channels/config/'.length));
      await deleteChannelConfig(channelType);
      scheduleGatewayChannelRestart(ctx, `channel:deleteConfig:${channelType}`);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  void ctx;
  return false;
}
