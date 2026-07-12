import { createLocalProcessRuntime } from './local-process-runtime';
import type {
  LocalProcessLifecycle,
  LocalProcessReadiness,
} from './contracts';
import { OpenClawGatewayProcessAdapter } from './adapters/openclaw-gateway-process-adapter';
import type { GatewayManager } from './openclaw-gateway/manager';

const DEFAULT_GATEWAY_START_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_GATEWAY_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_GATEWAY_AUTO_RESTART_BASE_DELAY_MS = 1_000;
const DEFAULT_GATEWAY_AUTO_RESTART_MAX_DELAY_MS = 30_000;
const DEFAULT_GATEWAY_AUTO_RESTART_WINDOW_MS = Number.MAX_SAFE_INTEGER;
const DEFAULT_GATEWAY_AUTO_RESTART_MAX_ATTEMPTS = 10;

export type OpenClawGatewayProcessLifecycle = LocalProcessLifecycle;

export interface OpenClawGatewayProcessState {
  readonly lifecycle: OpenClawGatewayProcessLifecycle;
  readonly port?: number;
  readonly pid?: number;
  readonly lastError?: string;
}

interface OpenClawGatewayProcessLogger {
  readonly debug?: (message: string) => void;
  readonly info?: (message: string) => void;
  readonly warn?: (message: string, error?: unknown) => void;
  readonly error?: (message: string, error?: unknown) => void;
}

export interface OpenClawGatewayProcessManagerOptions {
  readonly gatewayManager: GatewayManager;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly autoRestartOnCrash?: boolean;
  readonly autoRestartBaseDelayMs?: number;
  readonly autoRestartMaxDelayMs?: number;
  readonly autoRestartWindowMs?: number;
  readonly autoRestartMaxAttempts?: number;
  readonly logger?: OpenClawGatewayProcessLogger;
}

export interface OpenClawGatewayProcessManager {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly forceTerminate: () => Promise<void>;
  readonly checkReadiness: () => Promise<LocalProcessReadiness>;
  readonly getState: () => OpenClawGatewayProcessState;
  readonly onStateChange: (handler: (state: OpenClawGatewayProcessState) => void) => () => void;
}

export function createOpenClawGatewayProcessManager(
  options: OpenClawGatewayProcessManagerOptions,
): OpenClawGatewayProcessManager {
  const runtime = createLocalProcessRuntime({
    adapter: new OpenClawGatewayProcessAdapter({
      gatewayManager: options.gatewayManager,
    }),
    startTimeoutMs: options.startTimeoutMs ?? DEFAULT_GATEWAY_START_TIMEOUT_MS,
    stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_GATEWAY_STOP_TIMEOUT_MS,
    autoRestartOnCrash: options.autoRestartOnCrash,
    autoRestartBaseDelayMs:
      options.autoRestartBaseDelayMs ?? DEFAULT_GATEWAY_AUTO_RESTART_BASE_DELAY_MS,
    autoRestartMaxDelayMs:
      options.autoRestartMaxDelayMs ?? DEFAULT_GATEWAY_AUTO_RESTART_MAX_DELAY_MS,
    autoRestartWindowMs:
      options.autoRestartWindowMs ?? DEFAULT_GATEWAY_AUTO_RESTART_WINDOW_MS,
    autoRestartMaxAttempts:
      options.autoRestartMaxAttempts ?? DEFAULT_GATEWAY_AUTO_RESTART_MAX_ATTEMPTS,
    logger: options.logger,
  });

  function getState(): OpenClawGatewayProcessState {
    const state = runtime.getState();
    return {
      lifecycle: state.lifecycle,
      ...(state.port ? { port: state.port } : {}),
      ...(state.pid ? { pid: state.pid } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
    };
  }

  const manager: OpenClawGatewayProcessManager = {
    start: () => runtime.start(),
    stop: () => runtime.stop(),
    restart: () => runtime.restart(),
    forceTerminate: () => runtime.forceTerminate(),
    checkReadiness: () => runtime.checkReadiness(),
    getState,
    onStateChange(handler) {
      return runtime.onStateChange(() => handler(getState()));
    },
  };

  options.gatewayManager.setProcessController(manager);
  return manager;
}
