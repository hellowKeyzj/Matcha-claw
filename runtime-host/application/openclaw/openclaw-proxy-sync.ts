import type { RuntimeHostLogger } from '../../shared/logger';
import type { OpenClawConfigRepositoryPort } from './openclaw-config-repository';

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
  configRepository: OpenClawConfigRepositoryPort,
  settings: ProxySettings,
  logger: RuntimeHostLogger,
  options: SyncProxyOptions = {},
): Promise<void> {
  let syncedProxy = '';
  let skipped = false;
  await configRepository.update((config) => {
    const channels = isRecord(config.channels) ? config.channels : {};
    const telegramSection = channels.telegram;

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
      skipped = true;
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
    syncedProxy = nextProxy || 'disabled';
  });
  if (skipped) {
    logger.info('Skipped Telegram proxy sync because proxy is disabled and preserve mode is enabled');
  }
  if (syncedProxy) {
    logger.info(`Synced Telegram proxy to OpenClaw config (${syncedProxy})`);
  }
}
