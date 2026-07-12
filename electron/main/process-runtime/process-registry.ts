import type {
  LocalProcessId,
  LocalProcessReadiness,
  LocalProcessRunner,
  LocalProcessState,
} from './contracts';

export type LocalProcessRegistryEntry = {
  readonly id: LocalProcessId;
  readonly runner: LocalProcessRunner;
};

export type LocalProcessRunnerLikeState = Pick<LocalProcessState, 'lifecycle'>
  & Partial<Pick<LocalProcessState, 'pid' | 'port' | 'lastError'>>;

export type LocalProcessRunnerLike<TState extends LocalProcessRunnerLikeState> = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly forceTerminate: () => Promise<void>;
  readonly checkReadiness: () => Promise<LocalProcessReadiness>;
  readonly getState: () => TState;
  readonly onStateChange: (handler: (state: TState) => void) => () => void;
};

export type LocalProcessRunnerLikeRegistryEntry<TState extends LocalProcessRunnerLikeState> = {
  readonly id: LocalProcessId;
  readonly displayName: string;
  readonly runner: LocalProcessRunnerLike<TState>;
};

export class LocalProcessRegistry {
  private readonly runners = new Map<LocalProcessId, LocalProcessRunner>();

  register(entry: LocalProcessRegistryEntry): void {
    if (this.runners.has(entry.id)) {
      throw new Error(`Local process already registered: ${entry.id}`);
    }
    this.runners.set(entry.id, entry.runner);
  }

  registerRunnerLike<TState extends LocalProcessRunnerLikeState>(
    entry: LocalProcessRunnerLikeRegistryEntry<TState>,
  ): void {
    this.register({
      id: entry.id,
      runner: {
        start: () => entry.runner.start(),
        stop: () => entry.runner.stop(),
        restart: () => entry.runner.restart(),
        forceTerminate: () => entry.runner.forceTerminate(),
        checkReadiness: () => entry.runner.checkReadiness(),
        getState: () => toLocalProcessState(entry, entry.runner.getState()),
        onStateChange(handler) {
          return entry.runner.onStateChange((state) => {
            handler(toLocalProcessState(entry, state));
          });
        },
      },
    });
  }

  get(id: LocalProcessId): LocalProcessRunner | undefined {
    return this.runners.get(id);
  }

  require(id: LocalProcessId): LocalProcessRunner {
    const runner = this.runners.get(id);
    if (!runner) {
      throw new Error(`Local process is not registered: ${id}`);
    }
    return runner;
  }

  listStates(): LocalProcessState[] {
    return [...this.runners.values()].map((runner) => runner.getState());
  }

  async stopAll(): Promise<void> {
    await runForAllRegisteredProcesses(this.runners, 'stop', (runner) => runner.stop());
  }

  async forceTerminateAll(): Promise<void> {
    await runForAllRegisteredProcesses(
      this.runners,
      'force terminate',
      (runner) => runner.forceTerminate(),
    );
  }
}

async function runForAllRegisteredProcesses(
  runners: ReadonlyMap<LocalProcessId, LocalProcessRunner>,
  operation: string,
  run: (runner: LocalProcessRunner) => Promise<void>,
): Promise<void> {
  const entries = [...runners.entries()];
  const operations = entries.map(([, runner]) => {
    try {
      return run(runner);
    } catch (error) {
      return Promise.reject(error);
    }
  });
  const results = await Promise.allSettled(operations);
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [new Error(`Failed to ${operation} local process ${entries[index]![0]}`, { cause: result.reason })]
    : []);
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to ${operation} ${String(failures.length)} local process(es)`);
  }
}

function toLocalProcessState<TState extends LocalProcessRunnerLikeState>(
  entry: LocalProcessRunnerLikeRegistryEntry<TState>,
  state: TState,
): LocalProcessState {
  return {
    id: entry.id,
    displayName: entry.displayName,
    lifecycle: state.lifecycle,
    ...(state.pid ? { pid: state.pid } : {}),
    ...(state.port ? { port: state.port } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
  };
}
