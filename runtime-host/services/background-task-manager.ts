import type { RuntimeJobSnapshot } from '../application/common/runtime-contracts';
import type { RuntimeTimerPort } from '../application/common/runtime-ports';
import type { RuntimeJobQueryPort } from '../application/runtime-host/runtime-task-ports';

export type BackgroundTaskKind = 'agent' | 'shell';
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundTaskSnapshot {
  id: string;
  sessionKey?: string;
  kind: BackgroundTaskKind;
  status: BackgroundTaskStatus;
  stdout?: string;
  stderr?: string;
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BackgroundTaskRegistration {
  id: string;
  sessionKey?: string;
  kind: BackgroundTaskKind;
  stdout?: () => string;
  stderr?: () => string;
  result?: () => unknown;
  error?: () => string | undefined;
  status?: () => BackgroundTaskStatus;
  cancel?: () => Promise<void> | void;
}

function mapJobStatus(job: RuntimeJobSnapshot): BackgroundTaskStatus {
  if (job.status === 'succeeded') return 'completed';
  if (job.status === 'failed') return 'failed';
  return 'running';
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readJobText(job: RuntimeJobSnapshot, key: 'stdout' | 'stderr'): string | undefined {
  const result = job.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return undefined;
  }
  return readText((result as Record<string, unknown>)[key]);
}

export class BackgroundTaskManager {
  private readonly registered = new Map<string, BackgroundTaskRegistration & {
    createdAt: number;
    updatedAt: number;
    cancelled: boolean;
  }>();

  constructor(private readonly deps: {
    jobQueries: RuntimeJobQueryPort;
    timer: RuntimeTimerPort;
    nowMs: () => number;
  }) {}

  registerTask(registration: BackgroundTaskRegistration): BackgroundTaskSnapshot {
    const now = this.deps.nowMs();
    const record = {
      ...registration,
      createdAt: now,
      updatedAt: now,
      cancelled: false,
    };
    this.registered.set(registration.id, record);
    return this.snapshotRegistered(record);
  }

  getTask(taskId: string): BackgroundTaskSnapshot | null {
    const registered = this.registered.get(taskId);
    if (registered) {
      return this.snapshotRegistered(registered);
    }
    const job = this.deps.jobQueries.get(taskId);
    return job ? this.snapshotJob(job) : null;
  }

  getTasksBySession(sessionKey: string): BackgroundTaskSnapshot[] {
    const registered = Array.from(this.registered.values())
      .filter((task) => task.sessionKey === sessionKey)
      .map((task) => this.snapshotRegistered(task));
    return [
      ...registered,
      ...this.deps.jobQueries.list()
        .filter((job) => {
          const payload = job.result && typeof job.result === 'object' && !Array.isArray(job.result)
            ? job.result as Record<string, unknown>
            : null;
          return payload?.sessionKey === sessionKey;
        })
        .map((job) => this.snapshotJob(job)),
    ];
  }

  async waitFor(taskId: string, timeoutMs = 60_000): Promise<BackgroundTaskSnapshot | null> {
    const deadline = this.deps.nowMs() + Math.max(0, timeoutMs);
    for (;;) {
      const task = this.getTask(taskId);
      if (!task || task.status !== 'running' || this.deps.nowMs() >= deadline) {
        return task;
      }
      await this.deps.timer.sleep(250);
    }
  }

  async cancel(taskId: string): Promise<boolean> {
    const registered = this.registered.get(taskId);
    if (!registered) {
      return false;
    }
    registered.cancelled = true;
    registered.updatedAt = this.deps.nowMs();
    await registered.cancel?.();
    return true;
  }

  clearBySession(sessionKey: string): void {
    for (const [taskId, task] of this.registered.entries()) {
      if (task.sessionKey === sessionKey) {
        this.registered.delete(taskId);
      }
    }
  }

  async output(taskId: string, options: { wait?: boolean; timeoutMs?: number } = {}): Promise<BackgroundTaskSnapshot | null> {
    return options.wait
      ? await this.waitFor(taskId, options.timeoutMs)
      : this.getTask(taskId);
  }

  async stop(taskId: string): Promise<{ success: boolean; task: BackgroundTaskSnapshot | null }> {
    const success = await this.cancel(taskId);
    return {
      success,
      task: this.getTask(taskId),
    };
  }

  private snapshotRegistered(task: BackgroundTaskRegistration & {
    createdAt: number;
    updatedAt: number;
    cancelled: boolean;
  }): BackgroundTaskSnapshot {
    const status = task.cancelled ? 'cancelled' : (task.status?.() ?? 'running');
    return {
      id: task.id,
      ...(task.sessionKey ? { sessionKey: task.sessionKey } : {}),
      kind: task.kind,
      status,
      ...(readText(task.stdout?.()) ? { stdout: readText(task.stdout?.()) } : {}),
      ...(readText(task.stderr?.()) ? { stderr: readText(task.stderr?.()) } : {}),
      ...(task.result?.() !== undefined ? { result: task.result?.() } : {}),
      ...(readText(task.error?.()) ? { error: readText(task.error?.()) } : {}),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  private snapshotJob(job: RuntimeJobSnapshot): BackgroundTaskSnapshot {
    return {
      id: job.id,
      kind: 'agent',
      status: mapJobStatus(job),
      ...(readJobText(job, 'stdout') ? { stdout: readJobText(job, 'stdout') } : {}),
      ...(readJobText(job, 'stderr') ? { stderr: readJobText(job, 'stderr') } : {}),
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
      createdAt: job.queuedAt,
      updatedAt: job.finishedAt ?? job.startedAt ?? job.queuedAt,
    };
  }
}
