import type { RuntimeHostLogger } from '../../../../shared/logger';
import type { OpenClawConfigRepositoryPort } from '../infrastructure/openclaw-config-repository';
import type { PluginFileSystemPort } from '../../../../plugin-engine/plugin-file-system';
import {
  applyEnabledPluginIdsToOpenClawConfig,
  readManuallyEnabledPluginIdsFromOpenClawConfig,
  readManuallyManagedPluginIdsFromConfig,
} from './openclaw-plugin-config-service';
import { normalizeBrowserMode } from '../../../../shared/browser-mode';

const PACKAGED_CONTROL_UI_ALLOWED_ORIGINS = ['file://', 'null'] as const;

function ensurePackagedControlUiAllowedOrigins(
  controlUi: Record<string, unknown>,
): Record<string, unknown> {
  const allowedOrigins = Array.isArray(controlUi.allowedOrigins)
    ? (controlUi.allowedOrigins as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
  const nextAllowedOrigins = [...allowedOrigins];

  for (const origin of PACKAGED_CONTROL_UI_ALLOWED_ORIGINS) {
    if (!nextAllowedOrigins.includes(origin)) {
      nextAllowedOrigins.push(origin);
    }
  }

  return {
    ...controlUi,
    allowedOrigins: nextAllowedOrigins,
  };
}

function applyDefaultBrowserSsrfPolicy(browser: Record<string, unknown>): boolean {
  if (browser.ssrfPolicy == null) {
    browser.ssrfPolicy = { dangerouslyAllowPrivateNetwork: true };
    return true;
  }
  if (
    typeof browser.ssrfPolicy === 'object'
    && !Array.isArray(browser.ssrfPolicy)
    && (browser.ssrfPolicy as Record<string, unknown>).dangerouslyAllowPrivateNetwork === undefined
  ) {
    (browser.ssrfPolicy as Record<string, unknown>).dangerouslyAllowPrivateNetwork = true;
    return true;
  }
  return false;
}

function markRestartCommand(config: Record<string, unknown>): void {
  const commands = (
    config.commands && typeof config.commands === 'object'
      ? { ...(config.commands as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  commands.restart = true;
  config.commands = commands;
}

function replaceConfigContents(target: Record<string, unknown>, source: Record<string, unknown>): void {
  if (target === source) {
    return;
  }
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
}

function syncOfficialBrowserDenylist(config: Record<string, unknown>, shouldDeny: boolean): void {
  const plugins = (
    config.plugins && typeof config.plugins === 'object'
      ? { ...(config.plugins as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  const deny = Array.isArray(plugins.deny)
    ? (plugins.deny as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
  const nextDeny = deny.filter((pluginId) => pluginId !== 'browser');

  if (shouldDeny) {
    nextDeny.push('browser');
  }

  if (nextDeny.length > 0) {
    plugins.deny = nextDeny;
  } else {
    delete plugins.deny;
  }

  if (Object.keys(plugins).length > 0) {
    config.plugins = plugins;
  } else {
    delete config.plugins;
  }
}

export async function syncGatewayTokenToConfig(
  configRepository: OpenClawConfigRepositoryPort,
  token: string,
  logger: RuntimeHostLogger,
): Promise<void> {
  let synced = false;
  await configRepository.patchSection('gateway', (gatewayValue, config) => {
    let changed = false;
    const gateway = (
      gatewayValue && typeof gatewayValue === 'object'
        ? { ...(gatewayValue as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;

    const auth = (
      gateway.auth && typeof gateway.auth === 'object'
        ? { ...(gateway.auth as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;

    if (auth.mode !== 'token') {
      auth.mode = 'token';
      changed = true;
    }
    if (auth.token !== token) {
      auth.token = token;
      changed = true;
    }
    gateway.auth = auth;

    const controlUi = (
      gateway.controlUi && typeof gateway.controlUi === 'object'
        ? { ...(gateway.controlUi as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    const nextControlUi = ensurePackagedControlUiAllowedOrigins(controlUi);
    const previousAllowedOrigins = Array.isArray(controlUi.allowedOrigins) ? controlUi.allowedOrigins : [];
    const nextAllowedOrigins = Array.isArray(nextControlUi.allowedOrigins) ? nextControlUi.allowedOrigins : [];
    if (nextAllowedOrigins.length !== previousAllowedOrigins.length) {
      changed = true;
    }
    gateway.controlUi = nextControlUi;

    if (!gateway.mode) {
      gateway.mode = 'local';
      changed = true;
    }
    if (changed) {
      markRestartCommand(config);
      synced = true;
    }
    return { result: undefined, value: gateway, changed };
  });
  if (synced) {
    logger.info('Synced gateway token to openclaw.json');
  }
}

export async function syncBrowserConfigToOpenClaw(
  configRepository: OpenClawConfigRepositoryPort,
  logger: RuntimeHostLogger,
): Promise<void> {
  let synced = false;
  await configRepository.patchSection('browser', (browserValue, config) => {
    const browser = (
      browserValue && typeof browserValue === 'object'
        ? { ...(browserValue as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;

    let changed = false;

    if (browser.enabled === undefined) {
      browser.enabled = true;
      changed = true;
    }

    if (browser.defaultProfile === undefined) {
      browser.defaultProfile = 'openclaw';
      changed = true;
    }

    if (applyDefaultBrowserSsrfPolicy(browser)) {
      changed = true;
    }

    if (changed) {
      markRestartCommand(config);
      synced = true;
    }
    return { result: undefined, value: browser, changed };
  });
  if (synced) {
    logger.info('Synced browser config to openclaw.json');
  }
}

export async function syncBrowserModeToOpenClaw(
  configRepository: OpenClawConfigRepositoryPort,
  pluginFileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'listDirectoryEntries'>,
  modeInput: unknown,
  logger: RuntimeHostLogger,
): Promise<void> {
  const browserMode = normalizeBrowserMode(modeInput);
  let synced = false;

  await configRepository.updateDirty(async (config) => {
    const browser = (
      config.browser && typeof config.browser === 'object'
        ? { ...(config.browser as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;

    browser.enabled = browserMode === 'native';
    if (browserMode === 'native') {
      browser.defaultProfile = 'openclaw';
    } else {
      delete browser.defaultProfile;
    }
    applyDefaultBrowserSsrfPolicy(browser);
    syncOfficialBrowserDenylist(config, browserMode !== 'native');

    const currentEnabledPluginIds = await readManuallyEnabledPluginIdsFromOpenClawConfig(configRepository, pluginFileSystem, config);
    const currentManagedPluginIds = await readManuallyManagedPluginIdsFromConfig(configRepository, pluginFileSystem, config);
    const nextEnabledPluginIds = currentEnabledPluginIds.filter(
      (pluginId) => pluginId !== 'browser' && pluginId !== 'browser-relay',
    );
    for (const pluginId of currentManagedPluginIds) {
      if (
        pluginId !== 'browser'
        && pluginId !== 'browser-relay'
        && !nextEnabledPluginIds.includes(pluginId)
      ) {
        nextEnabledPluginIds.push(pluginId);
      }
    }
    if (browserMode === 'native') {
      nextEnabledPluginIds.push('browser');
    }
    if (browserMode === 'relay') {
      nextEnabledPluginIds.push('browser-relay');
    }

    const nextConfig = await applyEnabledPluginIdsToOpenClawConfig(configRepository, pluginFileSystem, config, nextEnabledPluginIds);
    nextConfig.browser = browser;
    replaceConfigContents(config, nextConfig);
    markRestartCommand(config);
    synced = true;
    return { result: undefined, changed: true };
  });
  if (synced) {
    logger.info(`Synced browser mode "${browserMode}" to openclaw.json`);
  }
}

export async function syncSessionIdleMinutesToOpenClaw(
  configRepository: OpenClawConfigRepositoryPort,
  logger: RuntimeHostLogger,
): Promise<void> {
  const DEFAULT_IDLE_MINUTES = 10_080;
  let synced = false;
  await configRepository.patchSection('session', (sessionValue, config) => {
    const session = (
      sessionValue && typeof sessionValue === 'object'
        ? { ...(sessionValue as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;

    if (session.idleMinutes !== undefined) {
      return { result: undefined, value: sessionValue, changed: false };
    }
    if (
      session.reset !== undefined
      || session.resetByType !== undefined
      || session.resetByChannel !== undefined
    ) {
      return { result: undefined, value: sessionValue, changed: false };
    }

    session.idleMinutes = DEFAULT_IDLE_MINUTES;
    markRestartCommand(config);
    synced = true;
    return { result: undefined, value: session, changed: true };
  });
  if (synced) {
    logger.info(`Synced session.idleMinutes=${DEFAULT_IDLE_MINUTES} to openclaw.json`);
  }
}
