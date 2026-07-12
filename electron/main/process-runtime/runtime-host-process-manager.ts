import { getPort } from '../../utils/config';
import { createLocalProcessRuntime } from './local-process-runtime';
import type { LocalProcessLifecycle } from './contracts';
import {
  RuntimeHostProcessAdapter,
  type RuntimeHostProcessHealth,
} from './adapters/runtime-host-process-adapter';

const DEFAULT_RUNTIME_HOST_START_TIMEOUT_MS = 15_000;
const DEFAULT_RUNTIME_HOST_STOP_TIMEOUT_MS = 1_200;
const DEFAULT_RUNTIME_HOST_AUTO_RESTART_BASE_DELAY_MS = 300;
const DEFAULT_RUNTIME_HOST_AUTO_RESTART_MAX_DELAY_MS = 5_000;
const DEFAULT_RUNTIME_HOST_AUTO_RESTART_WINDOW_MS = 60_000;
const DEFAULT_RUNTIME_HOST_AUTO_RESTART_MAX_ATTEMPTS = 6;

export type { RuntimeHostProcessHealth };

export interface RuntimeHostProcessState {
  readonly lifecycle: LocalProcessLifecycle;
  readonly port: number;
  readonly pid?: number;
  readonly lastError?: string;
}

export interface RuntimeHostProcessManager {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly forceTerminate: () => Promise<void>;
  readonly checkHealth: () => Promise<RuntimeHostProcessHealth>;
  readonly getState: () => RuntimeHostProcessState;
  readonly onStateChange: (handler: (state: RuntimeHostProcessState) => void) => () => void;
}

interface RuntimeHostProcessLogger {
  readonly info: (message: string) => void;
  readonly warn: (message: string, error?: unknown) => void;
  readonly error: (message: string, error?: unknown) => void;
}

export interface RuntimeHostProcessManagerOptions {
  readonly scriptPath?: string;
  readonly port?: number;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly autoRestartOnCrash?: boolean;
  readonly autoRestartBaseDelayMs?: number;
  readonly autoRestartMaxDelayMs?: number;
  readonly autoRestartWindowMs?: number;
  readonly autoRestartMaxAttempts?: number;
  readonly parentApiBaseUrl: string;
  readonly parentDispatchToken: string;
  readonly childEnv?: () => Record<string, string>;
  readonly logger?: RuntimeHostProcessLogger;
}

export function createRuntimeHostProcessManager(
  options: RuntimeHostProcessManagerOptions,
): RuntimeHostProcessManager {
  const adapter = new RuntimeHostProcessAdapter({
    scriptPath: options.scriptPath,
    port: Number.isFinite(options.port) && (options.port ?? 0) > 0
      ? Number(options.port)
      : getPort('MATCHACLAW_RUNTIME_HOST'),
    parentApiBaseUrl: options.parentApiBaseUrl,
    parentDispatchToken: options.parentDispatchToken,
    childEnv: options.childEnv,
    logger: options.logger,
  });

  const runtime = createLocalProcessRuntime({
    adapter,
    startTimeoutMs: options.startTimeoutMs ?? DEFAULT_RUNTIME_HOST_START_TIMEOUT_MS,
    stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_RUNTIME_HOST_STOP_TIMEOUT_MS,
    autoRestartOnCrash: options.autoRestartOnCrash,
    autoRestartBaseDelayMs:
      options.autoRestartBaseDelayMs ?? DEFAULT_RUNTIME_HOST_AUTO_RESTART_BASE_DELAY_MS,
    autoRestartMaxDelayMs:
      options.autoRestartMaxDelayMs ?? DEFAULT_RUNTIME_HOST_AUTO_RESTART_MAX_DELAY_MS,
    autoRestartWindowMs:
      options.autoRestartWindowMs ?? DEFAULT_RUNTIME_HOST_AUTO_RESTART_WINDOW_MS,
    autoRestartMaxAttempts:
      options.autoRestartMaxAttempts ?? DEFAULT_RUNTIME_HOST_AUTO_RESTART_MAX_ATTEMPTS,
    logger: options.logger,
  });

  function getState(): RuntimeHostProcessState {
    const state = runtime.getState();
    return {
      lifecycle: state.lifecycle,
      port: adapter.getPort(),
      ...(state.pid ? { pid: state.pid } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
    };
  }

  return {
    start: () => runtime.start(),
    stop: () => runtime.stop(),
    restart: () => runtime.restart(),
    forceTerminate: () => runtime.forceTerminate(),
    checkHealth: () => adapter.checkHealth(),
    getState,
    onStateChange(handler) {
      return runtime.onStateChange(() => handler(getState()));
    },
  };
}
