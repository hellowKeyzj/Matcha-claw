import type { ChildProcess } from 'node:child_process';

export type LocalProcessId = string;

export type LocalProcessLifecycle =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'restarting'
  | 'error';

export type LocalProcessLaunchKind = 'node-child' | 'spawn' | 'utility' | 'external';

export type LocalProcessLogStream = 'stdout' | 'stderr';

export type LocalProcessLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'drop';

export type LocalProcessLogEvent = {
  readonly level: LocalProcessLogLevel;
  readonly message: string;
};

export type LocalProcessReadiness =
  | { readonly status: 'ready'; readonly detail?: string }
  | { readonly status: 'not-ready'; readonly detail?: string }
  | { readonly status: 'error'; readonly error: string };

export type LocalProcessLaunchMetadata = Record<string, unknown>;

export type LocalProcessLaunchPlan = {
  readonly kind: LocalProcessLaunchKind;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: 'ignore' | 'pipe' | 'inherit';
  readonly serviceName?: string;
  readonly ipc?: boolean;
  readonly gracefulShutdownMessage?: unknown;
  readonly terminateProcessTree?: boolean;
  readonly port?: number;
  readonly pid?: number;
  readonly metadata?: LocalProcessLaunchMetadata;
};

export type LocalProcessState = {
  readonly id: LocalProcessId;
  readonly displayName: string;
  readonly lifecycle: LocalProcessLifecycle;
  readonly pid?: number;
  readonly port?: number;
  readonly lastError?: string;
};

export type LocalProcessCrashEvent = {
  readonly id: LocalProcessId;
  readonly displayName: string;
  readonly pid?: number;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly message: string;
};

export type LocalProcessAutoRestartScheduledEvent = {
  readonly reason: string;
  readonly attempt: number;
  readonly delayMs: number;
};

export type LocalProcessAutoRestartHaltedEvent = {
  readonly reason: string;
  readonly maxAttempts: number;
  readonly windowMs: number;
};

export type LocalProcessStartContext = {
  readonly nowMs: () => number;
  readonly attempt: number;
  readonly signal: AbortSignal;
  readonly assertActive?: () => void;
};

export type LocalProcessStartFailureCleanup = 'stop-current' | 'keep-current';

export type LocalProcessStartFailureRecovery =
  | { readonly action: 'retry'; readonly cleanup?: LocalProcessStartFailureCleanup }
  | { readonly action: 'fail'; readonly cleanup?: LocalProcessStartFailureCleanup };

export type LocalProcessStartFailureContext = {
  readonly error: Error;
  readonly attempt: number;
  readonly plan?: LocalProcessLaunchPlan;
  readonly nowMs: () => number;
  readonly signal: AbortSignal;
};

export type LocalProcessReadinessContext = {
  readonly nowMs: () => number;
  readonly signal: AbortSignal;
};

export type LocalProcessExternalController = {
  readonly start?: () => Promise<void>;
  readonly stop?: () => Promise<void>;
  readonly restart?: () => Promise<void>;
};

export type LocalProcessUtilityForkOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: 'ignore' | 'pipe' | 'inherit';
  readonly serviceName?: string;
};

export type LocalProcessUtilityProcess = {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly kill: () => boolean;
  readonly once: {
    (event: 'exit', listener: (code: number) => void): LocalProcessUtilityProcess;
    (
      event: 'error',
      listener: (type: string, location: string, report: string) => void,
    ): LocalProcessUtilityProcess;
  };
};

export type LocalProcessUtilityLauncher = {
  readonly fork: (
    modulePath: string,
    args: string[],
    options: LocalProcessUtilityForkOptions,
  ) => LocalProcessUtilityProcess | Promise<LocalProcessUtilityProcess>;
};

export type LocalProcessAdapter = {
  readonly id: LocalProcessId;
  readonly displayName: string;
  readonly prepareLaunch: (context: LocalProcessStartContext) => Promise<LocalProcessLaunchPlan>;
  readonly probeReadiness: (
    plan: LocalProcessLaunchPlan,
    context: LocalProcessReadinessContext,
  ) => Promise<LocalProcessReadiness>;
  readonly recoverStartFailure?: (
    context: LocalProcessStartFailureContext,
  ) => Promise<LocalProcessStartFailureRecovery> | LocalProcessStartFailureRecovery;
  readonly externalController?: LocalProcessExternalController;
  readonly onLaunched?: (state: LocalProcessState) => Promise<void>;
  readonly onStarted?: (state: LocalProcessState) => Promise<void>;
  readonly onStopped?: (state: LocalProcessState) => Promise<void>;
  readonly onCrashed?: (event: LocalProcessCrashEvent) => Promise<void>;
  readonly onAutoRestartScheduled?: (event: LocalProcessAutoRestartScheduledEvent) => Promise<void>;
  readonly onAutoRestartHalted?: (event: LocalProcessAutoRestartHaltedEvent) => Promise<void>;
  readonly classifyLog?: (
    line: string,
    stream: LocalProcessLogStream,
  ) => LocalProcessLogEvent;
};

export type LocalProcessRunner = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly forceTerminate: () => Promise<void>;
  readonly checkReadiness: () => Promise<LocalProcessReadiness>;
  readonly getState: () => LocalProcessState;
  readonly onStateChange: (handler: (state: LocalProcessState) => void) => () => void;
};

export type LocalProcessLogger = {
  readonly debug?: (message: string) => void;
  readonly info?: (message: string) => void;
  readonly warn?: (message: string, error?: unknown) => void;
  readonly error?: (message: string, error?: unknown) => void;
};

export type LocalProcessRuntimeOptions = {
  readonly adapter: LocalProcessAdapter;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly autoRestartOnCrash?: boolean;
  readonly autoRestartBaseDelayMs?: number;
  readonly autoRestartMaxDelayMs?: number;
  readonly autoRestartWindowMs?: number;
  readonly autoRestartMaxAttempts?: number;
  readonly logger?: LocalProcessLogger;
  readonly utilityLauncher?: LocalProcessUtilityLauncher;
};

export type LocalProcessSpawnResult = {
  readonly child: ChildProcess;
};
