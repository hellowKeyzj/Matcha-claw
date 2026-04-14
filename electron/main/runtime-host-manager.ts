import {
  DEFAULT_PLUGIN_EXECUTION_ENABLED,
  type RuntimeHostCatalogPlugin,
  type RuntimeHostExecutionState,
  type RuntimeHostRouteResult,
} from './runtime-host-contract';
import type { GatewayManager } from '../gateway/manager';
import { logger } from '../utils/logger';
import { EventEmitter } from 'node:events';
import { getSetting, setSetting } from '../services/settings/settings-store';
import { createChannelRuntimeService } from '../services/channels/channel-runtime-service';
import { browserOAuthManager, type BrowserOAuthProviderType } from '../services/providers/oauth/browser-oauth-manager';
import { deviceOAuthManager, type OAuthProviderType } from '../services/providers/oauth/device-oauth-manager';
import {
  clearStoredLicenseData,
  forceRevalidateStoredLicense,
  getLicenseGateSnapshot,
  getStoredLicenseKey,
  validateLicenseKey,
  waitForLicenseGateBootstrap,
} from '../services/license/license-gate-service';
import { createRuntimeHostProcessManager } from './runtime-host-process-manager';
import {
  createRuntimeHostHttpClient,
} from './runtime-host-client';
import { getPort } from '../utils/config';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { shell } from 'electron';

type RuntimeHostLifecycle = 'idle' | 'starting' | 'running' | 'stopped' | 'error';
type RequestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
type RuntimeHealthLifecycle = 'idle' | 'booting' | 'running' | 'stopped' | 'error';
export type RuntimeHostShellAction =
  | 'shell_open_path'
  | 'provider_oauth_start'
  | 'provider_oauth_cancel'
  | 'provider_oauth_submit'
  | 'channel_whatsapp_start'
  | 'channel_whatsapp_cancel'
  | 'channel_openclaw_weixin_start'
  | 'channel_openclaw_weixin_cancel'
  | 'license_get_gate'
  | 'license_get_stored_key'
  | 'license_validate'
  | 'license_revalidate'
  | 'license_clear';

export type RuntimeHostGatewayForwardEventName =
  | 'gateway:notification'
  | 'gateway:conversation-event'
  | 'gateway:channel-status'
  | 'gateway:error'
  | 'gateway:connection';

export interface RuntimeHostManagerHealth {
  readonly ok: boolean;
  readonly lifecycle: RuntimeHealthLifecycle;
  readonly activePluginCount: number;
  readonly degradedPlugins: readonly string[];
  readonly error?: string;
}

export interface RuntimeHostManagerState {
  readonly lifecycle: RuntimeHostLifecycle;
  readonly runtimeLifecycle: RuntimeHealthLifecycle;
  readonly pid?: number;
  readonly activePluginCount: number;
  readonly pluginExecutionEnabled: boolean;
  readonly enabledPluginIds: readonly string[];
  readonly lastError?: string;
}

export interface RuntimeHostManager {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly syncSecurityPolicyToGatewayIfRunning: () => Promise<boolean>;
  readonly checkHealth: () => Promise<RuntimeHostManagerHealth>;
  readonly getState: () => RuntimeHostManagerState;
  readonly getExecutionState: () => RuntimeHostExecutionState;
  readonly refreshExecutionState: () => Promise<RuntimeHostExecutionState>;
  readonly setExecutionEnabled: (enabled: boolean) => Promise<RuntimeHostExecutionState>;
  readonly setEnabledPluginIds: (pluginIds: readonly string[]) => Promise<RuntimeHostExecutionState>;
  readonly listAvailablePlugins: () => Promise<readonly RuntimeHostCatalogPlugin[]>;
  readonly request: <TResponse>(
    method: RequestMethod,
    route: string,
    payload?: unknown,
  ) => Promise<RuntimeHostRouteResult<TResponse>>;
  readonly executeShellAction: (
    action: RuntimeHostShellAction,
    payload?: unknown,
  ) => Promise<RuntimeHostRouteResult>;
  readonly emitGatewayEvent: (
    eventName: RuntimeHostGatewayForwardEventName,
    payload: unknown,
  ) => void;
  readonly onGatewayEvent: (
    handler: (eventName: RuntimeHostGatewayForwardEventName, payload: unknown) => void,
  ) => () => void;
  readonly getInternalDispatchToken: () => string;
}

export interface RuntimeHostManagerDeps {
  readonly gatewayManager: GatewayManager;
  readonly enabledPluginIds?: readonly string[];
}

type RuntimeHostProviderOAuthInput = {
  provider: string;
  region?: 'global' | 'cn';
  accountId?: string;
  label?: string;
};

type RuntimeHostMainProcessCapabilities = {
  readonly channel: ReturnType<typeof createChannelRuntimeService>;
  readonly providerOAuth: {
    readonly startOAuthFlow: (input: RuntimeHostProviderOAuthInput) => Promise<void>;
    readonly cancelOAuthFlow: () => Promise<void>;
    readonly submitManualOAuthCode: (code: string) => boolean;
  };
  readonly license: {
    readonly waitForBootstrap: () => Promise<void>;
    readonly getGateSnapshot: () => ReturnType<typeof getLicenseGateSnapshot>;
    readonly getStoredKey: () => Promise<string | null>;
    readonly validateKey: (key: string) => Promise<Awaited<ReturnType<typeof validateLicenseKey>>>;
    readonly revalidateStored: () => Promise<Awaited<ReturnType<typeof forceRevalidateStoredLicense>>>;
    readonly clearStored: () => Promise<void>;
  };
};

export function createRuntimeHostManager(
  deps: RuntimeHostManagerDeps,
): RuntimeHostManager {
  function resolvePackagedResourcePath(...segments: string[]): string | null {
    const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath.trim() : '';
    if (!resourcesPath) {
      return null;
    }
    const appAsarPath = join(resourcesPath, 'app.asar');
    if (!existsSync(appAsarPath)) {
      return null;
    }
    return join(resourcesPath, ...segments);
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  function asOAuthStartInput(value: unknown): {
    provider: string;
    region?: 'global' | 'cn';
    accountId?: string;
    label?: string;
  } | null {
    const record = asRecord(value);
    if (!record || typeof record.provider !== 'string') {
      return null;
    }
    const region = record.region;
    return {
      provider: record.provider,
      ...(region === 'global' || region === 'cn' ? { region } : {}),
      ...(typeof record.accountId === 'string' ? { accountId: record.accountId } : {}),
      ...(typeof record.label === 'string' ? { label: record.label } : {}),
    };
  }

  let executionState: RuntimeHostExecutionState = {
    pluginExecutionEnabled: DEFAULT_PLUGIN_EXECUTION_ENABLED,
    enabledPluginIds: deps.enabledPluginIds?.length
      ? Array.from(new Set(deps.enabledPluginIds))
      : [],
  };

  let lifecycle: RuntimeHostLifecycle = 'idle';
  let lastError: string | undefined;
  let childPluginCatalogSnapshot: readonly RuntimeHostCatalogPlugin[] = [];
  let activePluginCount = 0;
  let childGatewayBridgeSnapshot: { port: number; token: string } = {
    port: getPort('OPENCLAW_GATEWAY'),
    token: '',
  };
  try {
    const rawCatalog = process.env.MATCHACLAW_RUNTIME_HOST_PLUGIN_CATALOG;
    if (rawCatalog) {
      const parsed = JSON.parse(rawCatalog) as unknown;
      if (Array.isArray(parsed)) {
        childPluginCatalogSnapshot = parsed.filter((item): item is RuntimeHostCatalogPlugin => {
          if (!item || typeof item !== 'object') return false;
          const candidate = item as Record<string, unknown>;
          return typeof candidate.id === 'string'
            && typeof candidate.name === 'string'
            && typeof candidate.version === 'string'
            && (candidate.kind === 'builtin' || candidate.kind === 'third-party')
            && (candidate.platform === undefined || candidate.platform === 'openclaw' || candidate.platform === 'matchaclaw')
            && typeof candidate.category === 'string';
        }).map((item) => ({
          ...item,
          platform: item.platform === 'matchaclaw' ? 'matchaclaw' : 'openclaw',
        }));
      }
    }
  } catch {
    childPluginCatalogSnapshot = [];
  }
  const internalDispatchToken = `runtime-host-dispatch-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const gatewayEventBus = new EventEmitter();
  const hostApiPort = getPort('MATCHACLAW_HOST_API');
  const packagedOpenClawDir = resolvePackagedResourcePath('openclaw');
  const packagedTaskManagerPluginSourceDir = resolvePackagedResourcePath('openclaw-plugins', 'task-manager');
  const runtimeHostProcess = createRuntimeHostProcessManager({
    parentApiBaseUrl: `http://127.0.0.1:${hostApiPort}`,
    parentDispatchToken: internalDispatchToken,
    childEnv: () => ({
      MATCHACLAW_RUNTIME_HOST_PLUGIN_EXECUTION_ENABLED: executionState.pluginExecutionEnabled ? '1' : '0',
      MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS: JSON.stringify(executionState.enabledPluginIds),
      MATCHACLAW_RUNTIME_HOST_PLUGIN_CATALOG: JSON.stringify(childPluginCatalogSnapshot),
      MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(childGatewayBridgeSnapshot.port),
      MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: childGatewayBridgeSnapshot.token,
      ...(packagedOpenClawDir ? { MATCHACLAW_OPENCLAW_DIR: packagedOpenClawDir } : {}),
      ...(packagedTaskManagerPluginSourceDir
        ? { MATCHACLAW_RUNTIME_HOST_TASK_PLUGIN_SOURCE_DIR: packagedTaskManagerPluginSourceDir }
        : {}),
    }),
    logger,
  });
  const runtimeHostHttpClient = createRuntimeHostHttpClient({
    baseUrl: `http://127.0.0.1:${runtimeHostProcess.getState().port}`,
  });
  // 主进程基础设施：runtime-host-manager 自己做进程编排和配置同步时依赖的能力。
  const infrastructure = {
    gatewayManager: deps.gatewayManager,
    processManager: runtimeHostProcess,
    httpClient: runtimeHostHttpClient,
    settingsStore: {
      get: getSetting,
      set: setSetting,
    },
  } as const;

  async function hydrateExecutionStateFromSources(): Promise<void> {
    const [pluginExecutionEnabled, runtimeHostEnabledPluginIds, gatewayToken] = await Promise.all([
      infrastructure.settingsStore.get('pluginExecutionEnabled').catch(() => DEFAULT_PLUGIN_EXECUTION_ENABLED),
      infrastructure.settingsStore.get('runtimeHostEnabledPluginIds').catch(() => [] as string[]),
      infrastructure.settingsStore.get('gatewayToken').catch(() => ''),
    ]);
    executionState = {
      pluginExecutionEnabled: typeof pluginExecutionEnabled === 'boolean'
        ? pluginExecutionEnabled
        : DEFAULT_PLUGIN_EXECUTION_ENABLED,
      enabledPluginIds: Array.isArray(runtimeHostEnabledPluginIds)
        ? Array.from(new Set(runtimeHostEnabledPluginIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)))
        : [],
    };
    const gatewayStatusPort = infrastructure.gatewayManager.getStatus().port;
    if (!Number.isFinite(gatewayStatusPort) || gatewayStatusPort <= 0) {
      throw new Error(`Invalid gateway port from gateway manager: ${String(gatewayStatusPort)}`);
    }
    childGatewayBridgeSnapshot = {
      port: gatewayStatusPort,
      token: typeof gatewayToken === 'string' ? gatewayToken : '',
    };
  }

  async function setExecutionEnabledInternal(enabled: boolean): Promise<RuntimeHostExecutionState> {
    if (executionState.pluginExecutionEnabled === enabled) {
      return executionState;
    }
    executionState = {
      ...executionState,
      pluginExecutionEnabled: enabled,
    };
    await infrastructure.settingsStore.set('pluginExecutionEnabled', enabled);
    if (lifecycle === 'running' || lifecycle === 'starting') {
      await infrastructure.processManager.restart();
    }
    return executionState;
  }

  async function setEnabledPluginIdsInternal(pluginIds: readonly string[]): Promise<RuntimeHostExecutionState> {
    const normalizedPluginIds = Array.from(new Set(
      pluginIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ));
    const hasSameLength = normalizedPluginIds.length === executionState.enabledPluginIds.length;
    const isSame = hasSameLength
      && normalizedPluginIds.every((pluginId, index) => pluginId === executionState.enabledPluginIds[index]);
    if (isSame) {
      return executionState;
    }
    executionState = {
      ...executionState,
      enabledPluginIds: normalizedPluginIds,
    };
    await infrastructure.settingsStore.set('runtimeHostEnabledPluginIds', normalizedPluginIds);
    if (lifecycle === 'running' || lifecycle === 'starting') {
      await infrastructure.processManager.restart();
    }
    return executionState;
  }

  // 主进程保留能力：只有主进程才能执行，因此通过 shell action 暴露给子进程调用。
  const mainProcessCapabilities: RuntimeHostMainProcessCapabilities = {
    channel: createChannelRuntimeService({
      scheduleGatewayRestart: () => {
        if (infrastructure.gatewayManager.getStatus().state === 'stopped') {
          return;
        }
        infrastructure.gatewayManager.debouncedRestart();
      },
    }),
    providerOAuth: {
      startOAuthFlow: async (input) => {
        if (input.provider === 'google' || input.provider === 'openai') {
          await browserOAuthManager.startFlow(input.provider as BrowserOAuthProviderType, {
            accountId: input.accountId,
            label: input.label,
          });
          return;
        }
        await deviceOAuthManager.startFlow(
          input.provider as OAuthProviderType,
          input.region,
          {
            accountId: input.accountId,
            label: input.label,
          },
        );
      },
      cancelOAuthFlow: async () => {
        await deviceOAuthManager.stopFlow();
        await browserOAuthManager.stopFlow();
      },
      submitManualOAuthCode: (code) => browserOAuthManager.submitManualCode(code || ''),
    },
    license: {
      waitForBootstrap: async () => await waitForLicenseGateBootstrap(),
      getGateSnapshot: () => getLicenseGateSnapshot(),
      getStoredKey: async () => await getStoredLicenseKey(),
      validateKey: async (key) => await validateLicenseKey(key),
      revalidateStored: async () => await forceRevalidateStoredLicense('manual'),
      clearStored: async () => await clearStoredLicenseData(),
    },
  };

  async function executeShellActionInternal(
    action: RuntimeHostShellAction,
    payload?: unknown,
  ): Promise<RuntimeHostRouteResult> {
    try {
      if (action === 'provider_oauth_start') {
        const input = asOAuthStartInput(payload);
        if (!input) {
          return { status: 400, data: { success: false, error: 'provider-accounts/oauth/start 参数无效' } };
        }
        await mainProcessCapabilities.providerOAuth.startOAuthFlow(input);
        return { status: 200, data: { success: true } };
      }

      if (action === 'provider_oauth_cancel') {
        await mainProcessCapabilities.providerOAuth.cancelOAuthFlow();
        return { status: 200, data: { success: true } };
      }

      if (action === 'provider_oauth_submit') {
        const body = asRecord(payload);
        const code = typeof body?.code === 'string' ? body.code : '';
        const accepted = mainProcessCapabilities.providerOAuth.submitManualOAuthCode(code);
        if (!accepted) {
          return { status: 400, data: { success: false, error: 'No active manual OAuth input pending' } };
        }
        return { status: 200, data: { success: true } };
      }

      if (action === 'channel_whatsapp_start') {
        const body = asRecord(payload);
        const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
        await mainProcessCapabilities.channel.startWhatsApp(accountId);
        return { status: 200, data: { success: true } };
      }

      if (action === 'channel_whatsapp_cancel') {
        await mainProcessCapabilities.channel.cancelWhatsApp();
        return { status: 200, data: { success: true } };
      }

      if (action === 'channel_openclaw_weixin_start') {
        const body = asRecord(payload);
        const result = await mainProcessCapabilities.channel.startOpenClawWeixin({
          accountId: typeof body?.accountId === 'string' ? body.accountId : undefined,
          config: asRecord(body?.config) ?? undefined,
        });
        return { status: 200, data: { success: true, ...result } };
      }

      if (action === 'channel_openclaw_weixin_cancel') {
        await mainProcessCapabilities.channel.cancelOpenClawWeixin();
        return { status: 200, data: { success: true } };
      }

      if (action === 'shell_open_path') {
        const body = asRecord(payload);
        const targetPath = typeof body?.path === 'string' ? body.path.trim() : '';
        if (!targetPath) {
          return { status: 400, data: { success: false, error: 'path is required' } };
        }
        const openError = await shell.openPath(targetPath);
        if (openError) {
          return { status: 500, data: { success: false, error: openError } };
        }
        return { status: 200, data: { success: true } };
      }

      if (action === 'license_get_gate') {
        await mainProcessCapabilities.license.waitForBootstrap();
        return { status: 200, data: mainProcessCapabilities.license.getGateSnapshot() };
      }

      if (action === 'license_get_stored_key') {
        await mainProcessCapabilities.license.waitForBootstrap();
        return { status: 200, data: { key: await mainProcessCapabilities.license.getStoredKey() } };
      }

      if (action === 'license_validate') {
        const body = asRecord(payload);
        const key = typeof body?.key === 'string' ? body.key : '';
        return { status: 200, data: await mainProcessCapabilities.license.validateKey(key) };
      }

      if (action === 'license_revalidate') {
        return { status: 200, data: await mainProcessCapabilities.license.revalidateStored() };
      }

      await mainProcessCapabilities.license.clearStored();
      return { status: 200, data: { success: true } };
    } catch (error) {
      return {
        status: 500,
        data: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  function mapProcessLifecycleToRuntimeLifecycle(
    processLifecycle: 'idle' | 'starting' | 'running' | 'stopped' | 'error',
  ): RuntimeHealthLifecycle {
    switch (processLifecycle) {
      case 'starting':
        return 'booting';
      case 'running':
        return 'running';
      case 'stopped':
        return 'stopped';
      case 'error':
        return 'error';
      case 'idle':
      default:
        return 'idle';
    }
  }

  function isRuntimeHostManagerHealth(value: unknown): value is RuntimeHostManagerHealth {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as Partial<RuntimeHostManagerHealth>;
    return typeof candidate.ok === 'boolean'
      && typeof candidate.lifecycle === 'string'
      && typeof candidate.activePluginCount === 'number'
      && Array.isArray(candidate.degradedPlugins);
  }

  function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  function normalizeCatalogPluginsFromPayload(payload: unknown): readonly RuntimeHostCatalogPlugin[] {
    if (!payload || typeof payload !== 'object') {
      return [];
    }
    const record = payload as Record<string, unknown>;
    const plugins = record.plugins;
    if (!Array.isArray(plugins)) {
      return [];
    }
    return plugins
      .map((item): RuntimeHostCatalogPlugin | null => {
        if (!item || typeof item !== 'object') {
          return null;
        }
        const plugin = item as Record<string, unknown>;
        if (
          typeof plugin.id !== 'string'
          || typeof plugin.name !== 'string'
          || typeof plugin.version !== 'string'
          || (plugin.kind !== 'builtin' && plugin.kind !== 'third-party')
          || (plugin.platform !== undefined && plugin.platform !== 'openclaw' && plugin.platform !== 'matchaclaw')
          || typeof plugin.category !== 'string'
        ) {
          return null;
        }
        return {
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          kind: plugin.kind,
          platform: plugin.platform === 'matchaclaw' ? 'matchaclaw' : 'openclaw',
          category: plugin.category,
          ...(typeof plugin.description === 'string' ? { description: plugin.description } : {}),
        };
      })
      .filter((item): item is RuntimeHostCatalogPlugin => Boolean(item));
  }

  function emitGatewayEventInternal(
    eventName: RuntimeHostGatewayForwardEventName,
    payload: unknown,
  ): void {
    gatewayEventBus.emit('gateway:event', eventName, payload);
  }

  function onGatewayEventInternal(
    handler: (eventName: RuntimeHostGatewayForwardEventName, payload: unknown) => void,
  ): () => void {
    gatewayEventBus.on('gateway:event', handler);
    return () => {
      gatewayEventBus.off('gateway:event', handler);
    };
  }

  return {
    async start() {
      if (lifecycle === 'starting' || lifecycle === 'running') {
        return;
      }
      lifecycle = 'starting';
      lastError = undefined;
      try {
        await hydrateExecutionStateFromSources();
        await infrastructure.processManager.start();
        lifecycle = 'running';
        logger.info(
          `Runtime Host started (execution=${executionState.pluginExecutionEnabled ? 'enabled' : 'disabled'}, plugins=${executionState.enabledPluginIds.join(', ') || 'none'})`,
        );
      } catch (error) {
        lifecycle = 'error';
        lastError = error instanceof Error ? error.message : String(error);
        logger.error('Runtime Host start failed:', error);
        throw error;
      }
    },

    async stop() {
      if (lifecycle === 'stopped' || lifecycle === 'idle') {
        return;
      }
      await infrastructure.processManager.stop();
      lifecycle = 'stopped';
      logger.info('Runtime Host stopped');
    },

    async restart() {
      await hydrateExecutionStateFromSources();
      await infrastructure.processManager.restart();
      lifecycle = 'running';
    },

    async syncSecurityPolicyToGatewayIfRunning() {
      try {
        const result = await infrastructure.httpClient.request<{
          readonly synced?: boolean;
        }>('POST', '/api/security/sync-current-policy');
        return result.data?.synced === true;
      } catch (error) {
        logger.warn(`Failed to sync security policy through runtime-host child: ${toErrorMessage(error)}`);
        return false;
      }
    },

    async checkHealth() {
      try {
        const result = await infrastructure.httpClient.request<{
          readonly health?: RuntimeHostManagerHealth;
        }>('GET', '/api/runtime-host/health');
        const payload = result.data;
        if (payload && typeof payload === 'object' && 'health' in payload) {
          const health = (payload as { readonly health?: unknown }).health;
          if (isRuntimeHostManagerHealth(health)) {
            activePluginCount = health.activePluginCount;
            return health;
          }
        }
        return {
          ok: false,
          lifecycle: 'error',
          activePluginCount: 0,
          degradedPlugins: [],
          error: 'Invalid runtime-host transport health payload',
        };
      } catch (error) {
        return {
          ok: false,
          lifecycle: 'error',
          activePluginCount: 0,
          degradedPlugins: [],
          error: `Runtime-host transport health failed: ${toErrorMessage(error)}`,
        };
      }
    },

    getState() {
      const processState = infrastructure.processManager.getState();
      const runtimeLifecycle = mapProcessLifecycleToRuntimeLifecycle(processState.lifecycle);
      return {
        lifecycle,
        runtimeLifecycle,
        ...(processState.pid ? { pid: processState.pid } : {}),
        pluginExecutionEnabled: executionState.pluginExecutionEnabled,
        activePluginCount,
        enabledPluginIds: executionState.enabledPluginIds,
        ...((lastError || processState.lastError) ? { lastError: processState.lastError ?? lastError } : {}),
      };
    },

    getExecutionState() {
      return executionState;
    },

    async refreshExecutionState() {
      await hydrateExecutionStateFromSources();
      return executionState;
    },

    async setExecutionEnabled(enabled) {
      return await setExecutionEnabledInternal(enabled);
    },

    async setEnabledPluginIds(pluginIds) {
      return await setEnabledPluginIdsInternal(pluginIds);
    },

    async listAvailablePlugins() {
      const result = await infrastructure.httpClient.request<{
        readonly plugins?: unknown;
      }>('GET', '/api/plugins/catalog');
      const plugins = normalizeCatalogPluginsFromPayload(result.data);
      childPluginCatalogSnapshot = plugins;
      return plugins;
    },

    async request<TResponse>(method, route, payload) {
      return await infrastructure.httpClient.request<TResponse>(method, route, payload);
    },

    async executeShellAction(action, payload) {
      return await executeShellActionInternal(action, payload);
    },

    emitGatewayEvent(eventName, payload) {
      emitGatewayEventInternal(eventName, payload);
    },

    onGatewayEvent(handler) {
      return onGatewayEventInternal(handler);
    },

    getInternalDispatchToken() {
      return internalDispatchToken;
    },
  };
}
