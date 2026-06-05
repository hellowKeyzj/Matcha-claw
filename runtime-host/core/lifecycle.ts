import type { RuntimeHostLogger } from '../shared/logger';
import type { RuntimeLifecycleState } from '../application/common/runtime-contracts';

export type RuntimeHostLifecycleState = RuntimeLifecycleState;

export interface RuntimeHostBackgroundService {
  readonly name: string;
  readonly start: () => Promise<void> | void;
  readonly stop?: () => Promise<void> | void;
}

export interface RuntimeHostCleanupTask {
  readonly name: string;
  readonly run: () => Promise<void> | void;
}

export interface RuntimeHostLifecycleRegistrationDescriptor {
  readonly kind: 'background-service' | 'cleanup-task';
  readonly name: string;
  readonly owner: string | null;
}

export interface RuntimeHostLifecycleDefinitions {
  readonly backgroundServices?: readonly RuntimeHostBackgroundService[];
  readonly cleanupTasks?: readonly RuntimeHostCleanupTask[];
}

export function registerRuntimeLifecycleDefinitions(
  lifecycle: RuntimeHostLifecycle,
  definitions: RuntimeHostLifecycleDefinitions,
): void {
  for (const service of definitions.backgroundServices ?? []) {
    lifecycle.registerBackgroundService(service);
  }
  for (const task of definitions.cleanupTasks ?? []) {
    lifecycle.registerCleanup(task);
  }
}

export class RuntimeHostLifecycle {
  private state: RuntimeHostLifecycleState = 'starting';
  private readonly backgroundServices: RuntimeHostBackgroundService[] = [];
  private readonly backgroundServiceNames = new Set<string>();
  private readonly backgroundServiceOwners = new Map<string, string | null>();
  private readonly startedBackgroundServiceNames = new Set<string>();
  private readonly cleanupTasks: RuntimeHostCleanupTask[] = [];
  private readonly cleanupTaskNames = new Set<string>();
  private readonly cleanupTaskOwners = new Map<string, string | null>();
  private activeRegistrationOwner: string | null = null;

  constructor(private readonly logger: RuntimeHostLogger) {}

  getState(): RuntimeHostLifecycleState {
    return this.state;
  }

  markRunning(): void {
    this.state = 'running';
  }

  markStopping(): void {
    if (this.state !== 'stopped') {
      this.state = 'stopping';
    }
  }

  markError(error: unknown): void {
    this.state = 'error';
    this.logger.error('runtime-host lifecycle entered error state', error);
  }

  registerBackgroundService(service: RuntimeHostBackgroundService): void {
    if (this.backgroundServiceNames.has(service.name)) {
      throw new Error(`Runtime host background service already registered: ${service.name}`);
    }
    this.backgroundServiceNames.add(service.name);
    this.backgroundServiceOwners.set(service.name, this.activeRegistrationOwner);
    this.backgroundServices.push(service);
  }

  registerCleanup(task: RuntimeHostCleanupTask): void {
    if (this.cleanupTaskNames.has(task.name)) {
      throw new Error(`Runtime host cleanup task already registered: ${task.name}`);
    }
    this.cleanupTaskNames.add(task.name);
    this.cleanupTaskOwners.set(task.name, this.activeRegistrationOwner);
    this.cleanupTasks.push(task);
  }

  withRegistrationOwner<T>(owner: string, register: () => T): T {
    const normalizedOwner = owner.trim();
    if (!normalizedOwner) {
      throw new Error('Runtime lifecycle registration owner is required');
    }
    const previousOwner = this.activeRegistrationOwner;
    this.activeRegistrationOwner = normalizedOwner;
    try {
      return register();
    } finally {
      this.activeRegistrationOwner = previousOwner;
    }
  }

  listRegistrations(): RuntimeHostLifecycleRegistrationDescriptor[] {
    return [
      ...this.backgroundServices.map((service) => ({
        kind: 'background-service' as const,
        name: service.name,
        owner: this.backgroundServiceOwners.get(service.name) ?? null,
      })),
      ...this.cleanupTasks.map((task) => ({
        kind: 'cleanup-task' as const,
        name: task.name,
        owner: this.cleanupTaskOwners.get(task.name) ?? null,
      })),
    ];
  }

  startBackgroundServices(): void {
    if (process.env.MATCHACLAW_RUNTIME_HOST_DISABLE_BACKGROUND_SERVICES === '1') {
      return;
    }
    setImmediate(() => {
      for (const service of this.backgroundServices) {
        if (this.state === 'stopped') {
          return;
        }
        if (this.startedBackgroundServiceNames.has(service.name)) {
          continue;
        }
        this.startedBackgroundServiceNames.add(service.name);
        Promise.resolve(service.start()).catch((error) => {
          this.logger.warn(`background service failed: ${service.name}`, error);
        });
      }
    });
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') {
      return;
    }
    this.state = 'stopped';

    for (const service of [...this.backgroundServices].reverse()) {
      if (!service.stop || !this.startedBackgroundServiceNames.has(service.name)) {
        continue;
      }
      try {
        await service.stop();
      } catch (error) {
        this.logger.warn(`background service stop failed: ${service.name}`, error);
      }
    }
    this.startedBackgroundServiceNames.clear();

    for (const task of [...this.cleanupTasks].reverse()) {
      try {
        await task.run();
      } catch (error) {
        this.logger.warn(`runtime-host cleanup task failed: ${task.name}`, error);
      }
    }
  }
}
