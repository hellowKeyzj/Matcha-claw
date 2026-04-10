import { readOpenClawConfigJson, writeOpenClawConfigJson } from '../../api/storage/paths';
import { createRuntimeLogger } from '../../shared/logger';
import { withOpenClawConfigLock } from './openclaw-config-mutex';

const logger = createRuntimeLogger('openclaw-proxy-sync');

export interface ProxySettings {
  proxyEnabled: boolean;
  proxyServer: string;
  proxyBypassRules: string;
}

export interface SyncProxyOptions {
  preserveExistingWhenDisabled?: boolean;
}

function trimValue(value: string | undefined | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProxyServer(proxyServer: string): string {
  const value = trimValue(proxyServer);
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `http://${value}`;
}

function resolveProxySettings(settings: ProxySettings): { allProxy: string } {
  return {
    allProxy: normalizeProxyServer(settings.proxyServer),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function syncProxyConfigToOpenClaw(
  settings: ProxySettings,
  options: SyncProxyOptions = {},
): Promise<void> {
  await withOpenClawConfigLock(async () => {
    const config = readOpenClawConfigJson() as Record<string, unknown>;
    const telegramSection = config.channels?.telegram;

    if (!isRecord(telegramSection)) {
      return;
    }

    if (!isRecord(telegramSection.accounts)) {
      telegramSection.accounts = {};
    }
    const defaultAccountId = typeof telegramSection.defaultAccount === 'string' && telegramSection.defaultAccount.trim()
      ? telegramSection.defaultAccount
      : 'default';
    telegramSection.defaultAccount = defaultAccountId;
    const accounts = telegramSection.accounts as Record<string, Record<string, unknown>>;
    const currentDefault = isRecord(accounts[defaultAccountId]) ? accounts[defaultAccountId] : {};

    const resolved = resolveProxySettings(settings);
    const preserveExistingWhenDisabled = options.preserveExistingWhenDisabled !== false;
    const nextProxy = settings.proxyEnabled
      ? resolved.allProxy
      : '';
    const currentProxy = typeof currentDefault.proxy === 'string' ? currentDefault.proxy : '';

    if (!settings.proxyEnabled && preserveExistingWhenDisabled && currentProxy) {
      logger.info('Skipped Telegram proxy sync because proxy is disabled and preserve mode is enabled');
      return;
    }

    if (!nextProxy && !currentProxy) {
      return;
    }

    accounts[defaultAccountId] = { ...currentDefault };

    if (nextProxy) {
      accounts[defaultAccountId].proxy = nextProxy;
    } else {
      delete accounts[defaultAccountId].proxy;
    }
    if ('proxy' in telegramSection) {
      delete telegramSection.proxy;
    }

    await writeOpenClawConfigJson(config);
    logger.info(`Synced Telegram proxy to OpenClaw config (${nextProxy || 'disabled'})`);
  });
}
