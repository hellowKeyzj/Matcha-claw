import { createLocalProcessRuntime } from './local-process-runtime';
import type {
  LocalProcessLifecycle,
  LocalProcessLogger,
  LocalProcessReadiness,
} from './contracts';
import {
  MatchaAgentAppServerProcessAdapter,
  type MatchaAgentAppServerEndpointSnapshot,
} from './adapters/matcha-agent-app-server-process-adapter';

export type MatchaAgentAppServerProcessLifecycle = LocalProcessLifecycle;

export interface MatchaAgentAppServerProcessState {
  readonly lifecycle: MatchaAgentAppServerProcessLifecycle;
  readonly port?: number;
  readonly pid?: number;
  readonly lastError?: string;
}

interface MatchaAgentAppServerProcessLogger {
  readonly debug?: (message: string) => void;
  readonly info?: (message: string) => void;
  readonly warn?: (message: string, error?: unknown) => void;
  readonly error?: (message: string, error?: unknown) => void;
}

export interface MatchaAgentAppServerProcessManagerOptions {
  readonly port?: number;
  readonly token?: string;
  readonly startTimeoutMs?: number;
  readonly autoRestartOnCrash?: boolean;
  readonly autoRestartBaseDelayMs?: number;
  readonly autoRestartMaxDelayMs?: number;
  readonly autoRestartWindowMs?: number;
  readonly autoRestartMaxAttempts?: number;
  readonly logger?: MatchaAgentAppServerProcessLogger;
}

export interface MatchaAgentAppServerProcessManager {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly forceTerminate: () => Promise<void>;
  readonly checkReadiness: () => Promise<LocalProcessReadiness>;
  readonly getState: () => MatchaAgentAppServerProcessState;
  readonly getEndpointSnapshot: () => MatchaAgentAppServerEndpointSnapshot | undefined;
  readonly onStateChange: (handler: (state: MatchaAgentAppServerProcessState) => void) => () => void;
}

export function createMatchaAgentAppServerProcessManager(
  options: MatchaAgentAppServerProcessManagerOptions = {},
): MatchaAgentAppServerProcessManager {
  const adapter = new MatchaAgentAppServerProcessAdapter({
    port: options.port,
    token: options.token,
  });
  const runtime = createLocalProcessRuntime({
    adapter,
    startTimeoutMs: options.startTimeoutMs,
    autoRestartOnCrash: options.autoRestartOnCrash,
    autoRestartBaseDelayMs: options.autoRestartBaseDelayMs,
    autoRestartMaxDelayMs: options.autoRestartMaxDelayMs,
    autoRestartWindowMs: options.autoRestartWindowMs,
    autoRestartMaxAttempts: options.autoRestartMaxAttempts,
    logger: options.logger as LocalProcessLogger | undefined,
  });

  function getState(): MatchaAgentAppServerProcessState {
    const state = runtime.getState();
    return {
      lifecycle: state.lifecycle,
      ...(state.port ? { port: state.port } : {}),
      ...(state.pid ? { pid: state.pid } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
    };
  }

  return {
    start: () => runtime.start(),
    stop: () => runtime.stop(),
    restart: () => runtime.restart(),
    forceTerminate: () => runtime.forceTerminate(),
    checkReadiness: () => runtime.checkReadiness(),
    getState,
    getEndpointSnapshot: () => runtime.getState().lifecycle === 'running'
      ? adapter.getEndpointSnapshot()
      : undefined,
    onStateChange(handler) {
      return runtime.onStateChange(() => handler(getState()));
    },
  };
}
