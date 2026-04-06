import { app } from 'electron';
import { existsSync, cpSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDefaultRuntimeHostHttpClient } from '../../main/runtime-host-client';
import { whatsAppLoginManager } from './whatsapp-login-manager';
import { weixinLoginManager } from './weixin-login-manager';

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
};

export interface ChannelRuntimeService {
  readonly startWhatsApp: (accountId: string) => Promise<void>;
  readonly cancelWhatsApp: () => Promise<void>;
  readonly startOpenClawWeixin: (input: {
    accountId?: string;
    config?: Record<string, unknown>;
  }) => Promise<{ queued: true; sessionKey: string }>;
  readonly cancelOpenClawWeixin: () => Promise<void>;
}

function normalizeSessionKey(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
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

function resolveBundledPluginSources(pluginId: string): string[] {
  if (app.isPackaged) {
    return [
      join(process.resourcesPath, 'openclaw-plugins', pluginId),
      join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', pluginId),
      join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', pluginId),
    ];
  }
  return [
    join(app.getAppPath(), 'build', 'openclaw-plugins', pluginId),
    join(process.cwd(), 'build', 'openclaw-plugins', pluginId),
    join(__dirname, `../../../build/openclaw-plugins/${pluginId}`),
  ];
}

async function ensureBundledPluginInstalled(
  pluginId: string,
  displayName: string,
): Promise<ManagedPluginInstallResult> {
  const targetDir = join(homedir(), '.openclaw', 'extensions', pluginId);
  const targetManifest = join(targetDir, 'openclaw.plugin.json');

  if (existsSync(targetManifest)) {
    return {
      installed: true,
      installedPath: targetDir,
      version: getInstalledPluginVersion(pluginId),
    };
  }

  const candidateSources = resolveBundledPluginSources(pluginId);
  const sourceDir = candidateSources.find((dir) => existsSync(join(dir, 'openclaw.plugin.json')));
  if (!sourceDir) {
    return {
      installed: false,
      warning: `Bundled ${displayName} plugin mirror not found. Checked: ${candidateSources.join(' | ')}`,
    };
  }

  try {
    mkdirSync(join(homedir(), '.openclaw', 'extensions'), { recursive: true });
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true, dereference: true });
    if (!existsSync(targetManifest)) {
      return { installed: false, warning: `Failed to install ${displayName} plugin mirror (manifest missing).` };
    }
    return {
      installed: true,
      installedPath: targetDir,
      sourcePath: sourceDir,
      version: getInstalledPluginVersion(pluginId),
    };
  } catch {
    return { installed: false, warning: `Failed to install bundled ${displayName} plugin mirror` };
  }
}

export function createChannelRuntimeService(
  deps: { scheduleGatewayRestart: (reason: string) => void },
): ChannelRuntimeService {
  const runtimeHostClient = createDefaultRuntimeHostHttpClient({
    timeoutMs: 8000,
  });
  const pendingWeixinPersists = new Map<string, PendingWeixinPersist>();
  const pendingWhatsAppAccounts = new Set<string>();
  let weixinPersistHooked = false;
  let whatsAppPersistHooked = false;

  function scheduleGatewayChannelRestart(reason: string): void {
    deps.scheduleGatewayRestart(reason);
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

    if (!pending.installResult.installed) {
      throw new Error('openclaw-weixin plugin is not installed');
    }
    await runtimeHostClient.request('POST', '/api/channels/config', {
      channelType: 'openclaw-weixin',
      ...(resolvedAccountId ? { accountId: resolvedAccountId } : {}),
      config: persistedConfig,
      enabled: true,
    });
    scheduleGatewayChannelRestart('channel:openclaw-weixin:loginSuccess');
  }

  async function commitWhatsAppConfigAfterLoginSuccess(data: unknown): Promise<void> {
    const payload = (data && typeof data === 'object' ? data : {}) as { accountId?: unknown };
    const accountId = normalizeSessionKey(payload.accountId)
      ?? (pendingWhatsAppAccounts.size === 1 ? [...pendingWhatsAppAccounts][0] : undefined);
    if (!accountId || !pendingWhatsAppAccounts.has(accountId)) {
      return;
    }
    pendingWhatsAppAccounts.delete(accountId);
    await runtimeHostClient.request('POST', '/api/channels/config', {
      channelType: 'whatsapp',
      accountId,
      config: { enabled: true },
      enabled: true,
    });
    scheduleGatewayChannelRestart('channel:whatsapp:loginSuccess');
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
      pendingWeixinPersists.clear();
    });
  }

  function ensureWhatsAppPersistHooks(): void {
    if (whatsAppPersistHooked) {
      return;
    }
    whatsAppPersistHooked = true;

    whatsAppLoginManager.on('success', (data) => {
      void commitWhatsAppConfigAfterLoginSuccess(data).catch((error) => {
        console.error('[channels] Failed to persist whatsapp config after login success:', error);
      });
    });

    whatsAppLoginManager.on('error', (data) => {
      const payload = (data && typeof data === 'object' ? data : {}) as { accountId?: unknown };
      const accountId = normalizeSessionKey(payload.accountId);
      if (accountId) {
        pendingWhatsAppAccounts.delete(accountId);
      } else {
        pendingWhatsAppAccounts.clear();
      }
    });
  }

  ensureWeixinPersistHooks();
  ensureWhatsAppPersistHooks();

  return {
    async startWhatsApp(accountId: string) {
      pendingWhatsAppAccounts.add(accountId);
      await whatsAppLoginManager.start(accountId);
    },
    async cancelWhatsApp() {
      pendingWhatsAppAccounts.clear();
      await whatsAppLoginManager.stop();
    },
    async startOpenClawWeixin(input: { accountId?: string; config?: Record<string, unknown> }) {
      const pluginId = 'openclaw-weixin';
      const installResult = await ensureBundledPluginInstalled(pluginId, 'Weixin');
      if (!installResult.installed) {
        throw new Error(installResult.warning || 'Weixin plugin install failed');
      }
      const sessionKey = normalizeSessionKey(input.accountId) ?? 'default';
      const config = {
        ...(input.config && typeof input.config === 'object' ? input.config : {}),
        enabled: true,
      };
      pendingWeixinPersists.set(sessionKey, {
        config,
        installResult,
      });

      const routeTag = typeof config.routeTag === 'string' ? config.routeTag : undefined;
      const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : undefined;
      weixinLoginManager.startInBackground({
        accountId: sessionKey,
        baseUrl,
        routeTag,
      });
      return { queued: true as const, sessionKey };
    },
    async cancelOpenClawWeixin() {
      await weixinLoginManager.stop();
      pendingWeixinPersists.clear();
    },
  };
}
