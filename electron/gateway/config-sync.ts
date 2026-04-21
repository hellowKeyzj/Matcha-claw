import { app } from 'electron';
import path from 'path';
import { existsSync, rmSync } from 'fs';
import { homedir } from 'os';
import { getAllSettings } from '../services/settings/settings-store';
import { getOpenClawDir, getOpenClawEntryPath, isOpenClawPresent } from '../utils/paths';
import { getUvMirrorEnv } from '../utils/uv-env';
import { buildProxyEnv, resolveProxySettings } from '../utils/proxy';
import { logger } from '../utils/logger';
import { prependPathEntry } from '../utils/env-path';
import { fsPath } from '../utils/fs-path';
import { ensureBundledPluginsMirrorDir } from './bundled-plugins-mirror';
import { createDefaultRuntimeHostHttpClient } from '../main/runtime-host-client';
import { stripSystemdSupervisorEnv } from './config-sync-env';
import { syncGatewayConfigLocal as syncGatewayConfigLocalFallback } from '../../runtime-host/application/runtime-host/bootstrap';

function createGatewayConfigRuntimeHostClient() {
  return createDefaultRuntimeHostHttpClient({
    timeoutMs: 8_000,
  });
}

const BUILTIN_CHANNEL_EXTENSIONS = ['discord', 'telegram'];

function cleanupStaleBuiltInExtensions(): void {
  for (const extensionId of BUILTIN_CHANNEL_EXTENSIONS) {
    const extensionDir = path.join(homedir(), '.openclaw', 'extensions', extensionId);
    if (!existsSync(fsPath(extensionDir))) {
      continue;
    }
    try {
      rmSync(fsPath(extensionDir), { recursive: true, force: true });
      logger.info(`[plugin] Removed stale built-in extension copy: ${extensionId}`);
    } catch (error) {
      logger.warn(`[plugin] Failed to remove stale built-in extension ${extensionId}:`, error);
    }
  }
}

export interface GatewayLaunchContext {
  appSettings: Awaited<ReturnType<typeof getAllSettings>>;
  openclawDir: string;
  entryScript: string;
  gatewayArgs: string[];
  forkEnv: Record<string, string | undefined>;
  mode: 'dev' | 'packaged';
  binPathExists: boolean;
  loadedProviderKeyCount: number;
  proxySummary: string;
  channelStartupSummary: string;
  bundledPluginsDir?: string;
}

export async function syncGatewayConfigBeforeLaunch(
  appSettings: Awaited<ReturnType<typeof getAllSettings>>,
): Promise<void> {
  try {
    cleanupStaleBuiltInExtensions();
  } catch (error) {
    logger.warn('Failed to clean stale built-in extensions before gateway launch:', error);
  }

  const runtimeHostClient = createGatewayConfigRuntimeHostClient();
  try {
    await runtimeHostClient.request('POST', '/api/runtime-host/sync-gateway-config', {
      gatewayToken: appSettings.gatewayToken,
      proxyEnabled: appSettings.proxyEnabled,
      proxyServer: appSettings.proxyServer,
      proxyBypassRules: appSettings.proxyBypassRules,
    });
  } catch (err) {
    logger.warn('Failed to sync gateway bootstrap config through runtime-host:', err);
    try {
      await syncGatewayConfigLocalFallback({
        gatewayToken: appSettings.gatewayToken,
        proxyEnabled: appSettings.proxyEnabled,
        proxyServer: appSettings.proxyServer,
        proxyBypassRules: appSettings.proxyBypassRules,
      });
      logger.info('Applied gateway bootstrap config through local fallback sync');
    } catch (fallbackError) {
      logger.warn('Failed to sync gateway bootstrap config through local fallback:', fallbackError);
    }
  }
}

async function loadProviderEnv(): Promise<{ providerEnv: Record<string, string>; loadedProviderKeyCount: number }> {
  const runtimeHostClient = createGatewayConfigRuntimeHostClient();
  const providerEnv: Record<string, string> = {};
  let providerTypes: string[] = [];
  let envVarByProviderType: Record<string, string> = {};
  try {
    const result = await runtimeHostClient.request<{
      success?: boolean;
      keyableProviderTypes?: unknown;
      envVarByProviderType?: unknown;
    }>('GET', '/api/runtime-host/provider-env-map');
    const data = result.data;
    providerTypes = Array.isArray(data?.keyableProviderTypes)
      ? data.keyableProviderTypes.filter((item): item is string => typeof item === 'string')
      : [];
    envVarByProviderType = (
      data?.envVarByProviderType
      && typeof data.envVarByProviderType === 'object'
      && !Array.isArray(data.envVarByProviderType)
    )
      ? Object.fromEntries(
        Object.entries(data.envVarByProviderType)
          .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'),
      )
      : {};
  } catch (error) {
    logger.warn('Failed to fetch provider env map through runtime-host:', error);
    providerTypes = [];
    envVarByProviderType = {};
  }
  let loadedProviderKeyCount = 0;

  const accountTypeById = new Map<string, string>();
  let defaultAccountId: string | null = null;
  try {
    const result = await runtimeHostClient.request<{
      defaultAccountId?: unknown;
      accounts?: unknown;
    }>('GET', '/api/provider-accounts');
    if (typeof result.data?.defaultAccountId === 'string' && result.data.defaultAccountId.trim()) {
      defaultAccountId = result.data.defaultAccountId.trim();
    }
    if (Array.isArray(result.data?.accounts)) {
      for (const item of result.data.accounts) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          continue;
        }
        const record = item as Record<string, unknown>;
        const accountId = typeof record.id === 'string' ? record.id.trim() : '';
        const accountType = typeof record.vendorId === 'string'
          ? record.vendorId.trim()
          : (typeof record.type === 'string' ? record.type.trim() : '');
        if (accountId && accountType) {
          accountTypeById.set(accountId, accountType);
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to load provider account snapshot through runtime-host:', err);
  }

  const fetchAccountApiKey = async (accountId: string): Promise<string | null> => {
    const response = await runtimeHostClient.request<{ apiKey?: unknown }>(
      'GET',
      `/api/provider-accounts/${encodeURIComponent(accountId)}/api-key`,
    );
    return typeof response.data?.apiKey === 'string' && response.data.apiKey.trim()
      ? response.data.apiKey
      : null;
  };

  try {
    if (defaultAccountId) {
      const defaultProviderType = accountTypeById.get(defaultAccountId) ?? null;
      const defaultProviderKey = await fetchAccountApiKey(defaultAccountId);
      if (defaultProviderType && defaultProviderKey) {
        const envVar = envVarByProviderType[defaultProviderType];
        if (envVar) {
          providerEnv[envVar] = defaultProviderKey;
          loadedProviderKeyCount++;
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to load default provider key for environment injection:', err);
  }

  for (const providerType of providerTypes) {
    try {
      const key = await fetchAccountApiKey(providerType);
      if (key) {
        const envVar = envVarByProviderType[providerType];
        if (envVar) {
          providerEnv[envVar] = key;
          loadedProviderKeyCount++;
        }
      }
    } catch (err) {
      logger.warn(`Failed to load API key for ${providerType}:`, err);
    }
  }

  return { providerEnv, loadedProviderKeyCount };
}

async function resolveChannelStartupPolicy(): Promise<{
  skipChannels: boolean;
  channelStartupSummary: string;
}> {
  const runtimeHostClient = createGatewayConfigRuntimeHostClient();
  try {
    const response = await runtimeHostClient.request<{ channels?: unknown }>('GET', '/api/channels/configured');
    const configuredChannels = Array.isArray(response.data?.channels)
      ? response.data.channels.filter((channel): channel is string => typeof channel === 'string')
      : [];
    if (configuredChannels.length === 0) {
      return {
        skipChannels: true,
        channelStartupSummary: 'skipped(no configured channels)',
      };
    }

    return {
      skipChannels: false,
      channelStartupSummary: `enabled(${configuredChannels.join(',')})`,
    };
  } catch (error) {
    logger.warn('Failed to determine configured channels for gateway launch:', error);
    return {
      skipChannels: false,
      channelStartupSummary: 'enabled(unknown)',
    };
  }
}

export async function prepareGatewayLaunchContext(port: number): Promise<GatewayLaunchContext> {
  const openclawDir = getOpenClawDir();
  const entryScript = getOpenClawEntryPath();

  if (!isOpenClawPresent()) {
    throw new Error(`OpenClaw package not found at: ${openclawDir}`);
  }

  const appSettings = await getAllSettings();
  await syncGatewayConfigBeforeLaunch(appSettings);

  const bundledPluginsDir = await ensureBundledPluginsMirrorDir({
    openclawDir,
    mirrorRootDir: path.join(app.getPath('userData'), 'openclaw-bundled-plugins'),
    packaged: app.isPackaged,
    logger,
  });

  if (!existsSync(entryScript)) {
    throw new Error(`OpenClaw entry script not found at: ${entryScript}`);
  }

  const gatewayArgs = ['gateway', '--port', String(port), '--token', appSettings.gatewayToken, '--allow-unconfigured'];
  const mode = app.isPackaged ? 'packaged' : 'dev';

  const platform = process.platform;
  const arch = process.arch;
  const target = `${platform}-${arch}`;
  const binPath = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(process.cwd(), 'resources', 'bin', target);
  const binPathExists = existsSync(binPath);

  const { providerEnv, loadedProviderKeyCount } = await loadProviderEnv();
  const { skipChannels, channelStartupSummary } = await resolveChannelStartupPolicy();
  const uvEnv = await getUvMirrorEnv();
  const proxyEnv = buildProxyEnv(appSettings);
  const resolvedProxy = resolveProxySettings(appSettings);
  const proxySummary = appSettings.proxyEnabled
    ? `http=${resolvedProxy.httpProxy || '-'}, https=${resolvedProxy.httpsProxy || '-'}, all=${resolvedProxy.allProxy || '-'}`
    : 'disabled';

  const { NODE_OPTIONS: _nodeOptions, ...baseEnv } = process.env;
  const baseEnvRecord = baseEnv as Record<string, string | undefined>;
  const baseEnvPatched = binPathExists
    ? prependPathEntry(baseEnvRecord, binPath).env
    : baseEnvRecord;
  const forkEnv: Record<string, string | undefined> = {
    ...stripSystemdSupervisorEnv(baseEnvPatched),
    ...providerEnv,
    ...uvEnv,
    ...proxyEnv,
    OPENCLAW_GATEWAY_TOKEN: appSettings.gatewayToken,
    OPENCLAW_SKIP_CHANNELS: skipChannels ? '1' : '',
    CLAWDBOT_SKIP_CHANNELS: skipChannels ? '1' : '',
    OPENCLAW_NO_RESPAWN: '1',
  };
  if (bundledPluginsDir) {
    forkEnv.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
  }

  return {
    appSettings,
    openclawDir,
    entryScript,
    gatewayArgs,
    forkEnv,
    mode,
    binPathExists,
    loadedProviderKeyCount,
    proxySummary,
    channelStartupSummary,
    bundledPluginsDir,
  };
}
