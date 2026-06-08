import type { RuntimeHostRouteResult } from './runtime-host-contract';
import type { GatewayManager } from '../gateway/manager';
import { logger } from '../utils/logger';
import { EventEmitter } from 'node:events';
import { browserOAuthManager, type BrowserOAuthProviderType } from '../services/providers/oauth/browser-oauth-manager';
import { deviceOAuthManager, type OAuthProviderType } from '../services/providers/oauth/device-oauth-manager';
import { createRuntimeHostProcessManager } from './runtime-host-process-manager';
import {
  createRuntimeHostHttpClient,
} from './runtime-host-client';
import { getPort } from '../utils/config';
import { app, shell } from 'electron';
import { join } from 'node:path';
import { getOpenClawDir } from '../utils/paths';
import { prependPathEntry } from '../utils/env-path';
import type { GatewayTransportIssue } from '../../runtime-host/shared/gateway-error';

type RuntimeHostLifecycle = 'idle' | 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'error';
type RequestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
type RuntimeHealthLifecycle = 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'error';
export type RuntimeHostShellAction =
  | 'shell_open_path'
  | 'gateway_restart'
  | 'host_diagnostics_snapshot'
  | 'provider_oauth_start'
  | 'provider_oauth_cancel'
  | 'provider_oauth_submit';

export type RuntimeHostGatewayForwardEventName =
  | 'gateway:lifecycle'
  | 'gateway:notification'
  | 'session:update'
  | 'task:snapshot'
  | 'gateway:channel-status'
  | 'gateway:error'
  | 'license:gate-changed'
  | 'team:event';

export type RuntimeHostRuntimeJobForwardEventName =
  | 'runtime-job:done'
  | 'runtime-job:progress';

export interface RuntimeHostGatewayStatusSnapshot {
  readonly state: 'connected' | 'reconnecting' | 'disconnected';
  readonly portReachable: boolean;
  readonly gatewayReady: boolean;
  readonly healthSummary: 'healthy' | 'degraded' | 'unresponsive';
  readonly diagnostics: {
    readonly lastAliveAt?: number;
    readonly lastRpcSuccessAt?: number;
    readonly lastRpcFailureAt?: number;
    readonly lastRpcFailureMethod?: string;
    readonly lastHeartbeatTimeoutAt?: number;
    readonly consecutiveHeartbeatMisses: number;
    readonly lastSocketCloseAt?: number;
    readonly lastSocketCloseCode?: number;
    readonly consecutiveRpcFailures: number;
  };
  readonly lastError?: string;
  readonly lastIssue?: GatewayTransportIssue;
  readonly updatedAt: number;
}

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
  readonly lastError?: string;
}

export interface RuntimeHostManager {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly checkHealth: () => Promise<RuntimeHostManagerHealth>;
  readonly readGatewayStatus: () => Promise<RuntimeHostGatewayStatusSnapshot | null>;
  readonly getState: () => RuntimeHostManagerState;
  readonly request: <TResponse>(
    method: RequestMethod,
    route: string,
    payload?: unknown,
    options?: {
      timeoutMs?: number;
    },
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
  readonly emitRuntimeJobEvent: (
    eventName: RuntimeHostRuntimeJobForwardEventName,
    payload: unknown,
  ) => void;
  readonly onRuntimeJobEvent: (
    handler: (eventName: RuntimeHostRuntimeJobForwardEventName, payload: unknown) => void,
  ) => () => void;
  readonly onStateChange: (handler: (state: RuntimeHostManagerState) => void) => () => void;
  readonly getInternalDispatchToken: () => string;
}

export interface RuntimeHostManagerDeps {
  readonly gatewayManager: GatewayManager;
}

type RuntimeHostProviderOAuthInput = {
  provider: string;
  region?: 'global' | 'cn';
  flowId: string;
  accountId: string;
  label?: string;
};

type RuntimeHostOAuthFlowBinding = {
  flowId: string;
  accountId: string;
  vendorId: string;
};

type RuntimeHostOAuthSubmitInput = RuntimeHostOAuthFlowBinding & {
  code: string;
};

type RuntimeHostMainProcessCapabilities = {
  readonly providerOAuth: {
    readonly startOAuthFlow: (input: RuntimeHostProviderOAuthInput) => Promise<void>;
    readonly cancelOAuthFlow: (input: RuntimeHostOAuthFlowBinding) => Promise<void>;
    readonly submitManualOAuthCode: (input: RuntimeHostOAuthSubmitInput) => boolean;
  };
};

type RuntimeHostChildEnv = Record<string, string>;

function getBundledBinDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin');
  }
  return join(process.cwd(), 'resources', 'bin', `${process.platform}-${process.arch}`);
}

function buildRuntimeHostChildEnv(baseEnv: RuntimeHostChildEnv): RuntimeHostChildEnv {
  return {
    ...prependPathEntry(process.env, getBundledBinDir()).env,
    ...baseEnv,
  } as RuntimeHostChildEnv;
}

export function createRuntimeHostManager(
  deps: RuntimeHostManagerDeps,
): RuntimeHostManager {
  function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  function asOAuthStartInput(value: unknown): RuntimeHostProviderOAuthInput | null {
    const record = asRecord(value);
    const provider = typeof record?.provider === 'string' ? record.provider.trim() : '';
    const flowId = typeof record?.flowId === 'string' ? record.flowId.trim() : '';
    const accountId = typeof record?.accountId === 'string' ? record.accountId.trim() : '';
    if (!provider || !flowId || !accountId) {
      return null;
    }
    const region = record?.region;
    return {
      provider,
      flowId,
      accountId,
      ...(region === 'global' || region === 'cn' ? { region } : {}),
      ...(typeof record?.label === 'string' ? { label: record.label } : {}),
    };
  }

  function asOAuthFlowBinding(value: unknown): RuntimeHostOAuthFlowBinding | null {
    const record = asRecord(value);
    const flowId = typeof record?.flowId === 'string' ? record.flowId.trim() : '';
    const accountId = typeof record?.accountId === 'string' ? record.accountId.trim() : '';
    const vendorId = typeof record?.vendorId === 'string' ? record.vendorId.trim() : '';
    return flowId && accountId && vendorId ? { flowId, accountId, vendorId } : null;
  }

  function asOAuthSubmitInput(value: unknown): RuntimeHostOAuthSubmitInput | null {
    const binding = asOAuthFlowBinding(value);
    const record = asRecord(value);
    const code = typeof record?.code === 'string' ? record.code.trim() : '';
    return binding && code ? { ...binding, code } : null;
  }

  let lifecycle: RuntimeHostLifecycle = 'idle';
  let lastError: string | undefined;
  let activePluginCount = 0;
  let childGatewayBridgeSnapshot: { port: number; token: string } = {
    port: getPort('OPENCLAW_GATEWAY'),
    token: '',
  };
  const internalDispatchToken = `runtime-host-dispatch-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const gatewayEventBus = new EventEmitter();
  const runtimeJobEventBus = new EventEmitter();
  const stateChangeBus = new EventEmitter();
  const hostApiPort = getPort('MATCHACLAW_HOST_API');
  const openClawDir = getOpenClawDir();
  const runtimeHostProcess = createRuntimeHostProcessManager({
    parentApiBaseUrl: `http://127.0.0.1:${hostApiPort}`,
    parentDispatchToken: internalDispatchToken,
    childEnv: () => buildRuntimeHostChildEnv({
      MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(childGatewayBridgeSnapshot.port),
      MATCHACLAW_OPENCLAW_DIR: openClawDir,
      MATCHACLAW_APP_PACKAGED: app.isPackaged ? '1' : '0',
      MATCHACLAW_APP_VERSION: app.getVersion(),
      MATCHACLAW_APP_USER_DATA_DIR: app.getPath('userData'),
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
  } as const;

  async function hydrateExecutionStateFromSources(): Promise<void> {
    const gatewayStatusPort = infrastructure.gatewayManager.getStatus().port;
    if (!Number.isFinite(gatewayStatusPort) || gatewayStatusPort <= 0) {
      throw new Error(`Invalid gateway port from gateway manager: ${String(gatewayStatusPort)}`);
    }
    childGatewayBridgeSnapshot = {
      port: gatewayStatusPort,
      token: '',
    };
  }

  // 主进程保留能力：只有主进程才能执行，因此通过 shell action 暴露给子进程调用。
  const mainProcessCapabilities: RuntimeHostMainProcessCapabilities = {
    providerOAuth: {
      startOAuthFlow: async (input) => {
        if (input.provider === 'openai') {
          await browserOAuthManager.startFlow(input.provider as BrowserOAuthProviderType, {
            flowId: input.flowId,
            accountId: input.accountId,
            label: input.label,
          });
          return;
        }
        await deviceOAuthManager.startFlow(
          input.provider as OAuthProviderType,
          input.region,
          {
            flowId: input.flowId,
            accountId: input.accountId,
            label: input.label,
          },
        );
      },
      cancelOAuthFlow: async (input) => {
        await deviceOAuthManager.stopFlow(input);
        await browserOAuthManager.stopFlow(input);
      },
      submitManualOAuthCode: (input) => browserOAuthManager.submitManualCode(input),
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
        const input = asOAuthFlowBinding(payload);
        if (!input) {
          return { status: 400, data: { success: false, error: 'provider-accounts/oauth/cancel 参数无效' } };
        }
        await mainProcessCapabilities.providerOAuth.cancelOAuthFlow(input);
        return { status: 200, data: { success: true } };
      }

      if (action === 'provider_oauth_submit') {
        const input = asOAuthSubmitInput(payload);
        if (!input) {
          return { status: 400, data: { success: false, error: 'provider-accounts/oauth/submit 参数无效' } };
        }
        const accepted = mainProcessCapabilities.providerOAuth.submitManualOAuthCode(input);
        if (!accepted) {
          return { status: 400, data: { success: false, error: 'No active manual OAuth input pending' } };
        }
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

      if (action === 'gateway_restart') {
        if (infrastructure.gatewayManager.getStatus().processState !== 'stopped') {
          infrastructure.gatewayManager.debouncedRestart();
        }
        return { status: 200, data: { success: true } };
      }

      if (action === 'host_diagnostics_snapshot') {
        return {
          status: 200,
          data: {
            success: true,
            snapshot: {
              userDataDir: app.getPath('userData'),
              appInfo: {
                name: app.getName(),
                version: app.getVersion(),
                isPackaged: app.isPackaged,
                platform: process.platform,
                arch: process.arch,
                electron: process.versions.electron,
                node: process.versions.node,
              },
              gatewayStatus: infrastructure.gatewayManager.getStatus(),
            },
          },
        };
      }

      return { status: 400, data: { success: false, error: `Unsupported shell action: ${action}` } };
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
    if (lifecycle === 'restarting') {
      return 'restarting';
    }
    switch (processLifecycle) {
      case 'starting':
        return 'starting';
      case 'running':
        return 'running';
      case 'stopped':
        return 'stopped';
      case 'error':
        return 'error';
      case 'idle':
      default:
        return 'stopped';
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

  function emitRuntimeJobEventInternal(
    eventName: RuntimeHostRuntimeJobForwardEventName,
    payload: unknown,
  ): void {
    runtimeJobEventBus.emit('runtime-job:event', eventName, payload);
  }

  function onRuntimeJobEventInternal(
    handler: (eventName: RuntimeHostRuntimeJobForwardEventName, payload: unknown) => void,
  ): () => void {
    runtimeJobEventBus.on('runtime-job:event', handler);
    return () => {
      runtimeJobEventBus.off('runtime-job:event', handler);
    };
  }

  function emitStateChangeInternal(): void {
    stateChangeBus.emit('state:change', getStateInternal());
  }

  function getStateInternal(): RuntimeHostManagerState {
    const processState = infrastructure.processManager.getState();
    const runtimeLifecycle = mapProcessLifecycleToRuntimeLifecycle(processState.lifecycle);
    return {
      lifecycle,
      runtimeLifecycle,
      ...(processState.pid ? { pid: processState.pid } : {}),
      activePluginCount,
      ...((lastError || processState.lastError) ? { lastError: processState.lastError ?? lastError } : {}),
    };
  }

  function onStateChangeInternal(
    handler: (state: RuntimeHostManagerState) => void,
  ): () => void {
    stateChangeBus.on('state:change', handler);
    return () => {
      stateChangeBus.off('state:change', handler);
    };
  }

  // 子进程的 lifecycle 变化（启动完成、自动重启、退出）由 processManager 推送，
  // 这里桥接到 RuntimeHostManager 自己的 stateChangeBus。
  infrastructure.processManager.onStateChange(() => {
    emitStateChangeInternal();
  });

  return {
    async start() {
      if (lifecycle === 'starting' || lifecycle === 'running') {
        return;
      }
      lifecycle = 'starting';
      lastError = undefined;
      emitStateChangeInternal();
      try {
        await hydrateExecutionStateFromSources();
        await infrastructure.processManager.start();
        lifecycle = 'running';
        logger.info('Runtime Host started');
      } catch (error) {
        lifecycle = 'error';
        lastError = error instanceof Error ? error.message : String(error);
        logger.error('Runtime Host start failed:', error);
        throw error;
      } finally {
        emitStateChangeInternal();
      }
    },

    async stop() {
      if (lifecycle === 'stopped' || lifecycle === 'idle') {
        return;
      }
      lifecycle = 'stopping';
      emitStateChangeInternal();
      await infrastructure.processManager.stop();
      lifecycle = 'stopped';
      logger.info('Runtime Host stopped');
      emitStateChangeInternal();
    },

    async restart() {
      lifecycle = 'restarting';
      lastError = undefined;
      emitStateChangeInternal();
      try {
        await hydrateExecutionStateFromSources();
        await infrastructure.processManager.restart();
        lifecycle = 'running';
        logger.info('Runtime Host restarted');
      } catch (error) {
        lifecycle = 'error';
        lastError = error instanceof Error ? error.message : String(error);
        logger.error('Runtime Host restart failed:', error);
        throw error;
      } finally {
        emitStateChangeInternal();
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

    async readGatewayStatus() {
      try {
        const result = await infrastructure.httpClient.request<{
          success?: boolean;
          status?: RuntimeHostGatewayStatusSnapshot;
        }>('GET', '/api/gateway/status');
        if (result.data?.success !== true || !result.data.status) {
          return null;
        }
        return result.data.status;
      } catch {
        return null;
      }
    },

    getState() {
      return getStateInternal();
    },

    async request<TResponse>(
      method: RequestMethod,
      route: string,
      payload?: unknown,
      options?: {
        timeoutMs?: number;
      },
    ) {
      return await infrastructure.httpClient.request<TResponse>(method, route, payload, options);
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

    emitRuntimeJobEvent(eventName, payload) {
      emitRuntimeJobEventInternal(eventName, payload);
    },

    onRuntimeJobEvent(handler) {
      return onRuntimeJobEventInternal(handler);
    },

    onStateChange(handler) {
      return onStateChangeInternal(handler);
    },

    getInternalDispatchToken() {
      return internalDispatchToken;
    },
  };
}
