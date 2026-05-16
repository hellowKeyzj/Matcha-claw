import type { RuntimeHostLogger } from '../shared/logger';
import type { RuntimeClockPort, RuntimeScheduledTask, RuntimeSchedulerPort } from '../application/common/runtime-ports';
import type {
  RuntimeJobEnqueueOptions,
  RuntimeJobProgress,
  RuntimeJobQueueName,
  RuntimeJobQueueSnapshot,
  RuntimeJobSnapshot,
  RuntimeJobStatus,
} from '../application/common/runtime-contracts';

export interface RuntimeJobHandlerContext {
  readonly jobId: string;
  readonly logger: RuntimeHostLogger;
  readonly reportProgress: (progress: Omit<RuntimeJobProgress, 'updatedAt'>) => void;
}

export type RuntimeJobHandler = (
  payload: unknown,
  context: RuntimeJobHandlerContext,
) => Promise<unknown> | unknown;

export interface RuntimeJobDefinition {
  readonly type: string;
  readonly handler: RuntimeJobHandler;
}

interface RuntimeJobRecord extends RuntimeJobSnapshot {
  status: RuntimeJobStatus;
  queue: RuntimeJobQueueName;
  payload: unknown;
  dedupeKey?: string;
  retryDelayMs: number;
  attempts: number;
  maxAttempts: number;
  startedAt?: number;
  finishedAt?: number;
  progress?: RuntimeJobProgress;
  result?: unknown;
  error?: string;
}

export interface RuntimeJobQueueOptions {
  readonly concurrency?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly retentionSucceededMs?: number;
  readonly retentionFailedMs?: number;
  readonly maxRetainedJobs?: number;
}

const RUNTIME_JOB_QUEUE_ORDER: readonly RuntimeJobQueueName[] = ['critical', 'default', 'low'] as const;

export class RuntimeJobRegistry {
  private readonly handlers = new Map<string, RuntimeJobHandler>();

  register(type: string, handler: RuntimeJobHandler): void {
    if (this.handlers.has(type)) {
      throw new Error(`Runtime job handler already registered: ${type}`);
    }
    this.handlers.set(type, handler);
  }

  get(type: string): RuntimeJobHandler {
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new Error(`Runtime job handler not registered: ${type}`);
    }
    return handler;
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  listTypes(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }
}

export function registerRuntimeJobDefinitions(
  registry: RuntimeJobRegistry,
  definitions: readonly RuntimeJobDefinition[],
): void {
  for (const definition of definitions) {
    registry.register(definition.type, definition.handler);
  }
}

export class RuntimeJobQueue {
  private nextId = 1;
  private activeCount = 0;
  private stopped = false;
  private readonly pendingJobIds: Record<RuntimeJobQueueName, string[]> = {
    critical: [],
    default: [],
    low: [],
  };
  private readonly jobs = new Map<string, RuntimeJobRecord>();
  private readonly activeDedupeKeys = new Map<string, string>();
  private readonly recentDedupeJobIds = new Map<string, string>();
  private readonly retryTasks = new Map<string, RuntimeScheduledTask>();
  private readonly evictionTasks = new Map<string, RuntimeScheduledTask>();
  private readonly idleWaiters: Array<() => void> = [];
  private readonly concurrency: number;
  private readonly defaultMaxAttempts: number;
  private readonly defaultRetryDelayMs: number;
  private readonly retentionSucceededMs: number;
  private readonly retentionFailedMs: number;
  private readonly maxRetainedJobs: number;

  constructor(
    private readonly registry: RuntimeJobRegistry,
    private readonly logger: RuntimeHostLogger,
    private readonly scheduler: RuntimeSchedulerPort,
    private readonly clock: RuntimeClockPort,
    options: RuntimeJobQueueOptions = {},
  ) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
    this.defaultMaxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 1));
    this.defaultRetryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 250));
    this.retentionSucceededMs = Math.max(0, Math.floor(options.retentionSucceededMs ?? 60_000));
    this.retentionFailedMs = Math.max(0, Math.floor(options.retentionFailedMs ?? 300_000));
    this.maxRetainedJobs = Math.max(1, Math.floor(options.maxRetainedJobs ?? 200));
  }

  enqueue(type: string, payload: unknown, options: RuntimeJobEnqueueOptions = {}): RuntimeJobSnapshot {
    if (this.stopped) {
      throw new Error('Runtime job queue is stopped');
    }
    if (!this.registry.has(type)) {
      throw new Error(`Runtime job handler not registered: ${type}`);
    }

    if (options.dedupeKey) {
      const activeJobId = this.activeDedupeKeys.get(options.dedupeKey);
      const activeJob = activeJobId ? this.jobs.get(activeJobId) : null;
      if (activeJob && (activeJob.status === 'queued' || activeJob.status === 'running')) {
        return this.snapshot(activeJob);
      }
      const cooldownMs = Math.max(0, Math.floor(options.dedupeCooldownMs ?? 0));
      if (cooldownMs > 0) {
        const recentJob = this.findRecentDedupeJob(options.dedupeKey);
        if (recentJob && typeof recentJob.finishedAt === 'number'
          && this.clock.nowMs() - recentJob.finishedAt < cooldownMs) {
          return this.snapshot(recentJob);
        }
      }
    }

    const job: RuntimeJobRecord = {
      id: `job-${this.nextId++}`,
      type,
      queue: options.queue ?? 'default',
      payload,
      dedupeKey: options.dedupeKey,
      status: 'queued',
      queuedAt: this.clock.nowMs(),
      attempts: 0,
      maxAttempts: Math.max(1, Math.floor(options.maxAttempts ?? this.defaultMaxAttempts)),
      retryDelayMs: Math.max(0, Math.floor(options.retryDelayMs ?? this.defaultRetryDelayMs)),
    };
    this.jobs.set(job.id, job);
    if (options.dedupeKey) {
      this.activeDedupeKeys.set(options.dedupeKey, job.id);
    }

    this.pendingJobIds[job.queue].push(job.id);
    this.drain();
    return this.snapshot(job);
  }

  get(jobId: string): RuntimeJobSnapshot | null {
    const job = this.jobs.get(jobId);
    return job ? this.snapshot(job) : null;
  }

  latestByType(type: string): RuntimeJobSnapshot | null {
    const matches = Array.from(this.jobs.values()).filter((job) => job.type === type);
    const latest = matches.sort((left, right) => right.queuedAt - left.queuedAt)[0];
    return latest ? this.snapshot(latest) : null;
  }

  listByType(type: string): RuntimeJobSnapshot[] {
    return this.list().filter((job) => job.type === type);
  }

  list(): RuntimeJobSnapshot[] {
    return Array.from(this.jobs.values())
      .sort((left, right) => left.queuedAt - right.queuedAt)
      .map((job) => this.snapshot(job));
  }

  snapshotQueue(): RuntimeJobQueueSnapshot {
    return {
      stopped: this.stopped,
      concurrency: this.concurrency,
      activeCount: this.activeCount,
      pendingCount: this.countPendingJobs(),
      totalCount: this.jobs.size,
      queues: {
        critical: {
          pendingCount: this.pendingJobIds.critical.length,
        },
        default: {
          pendingCount: this.pendingJobIds.default.length,
        },
        low: {
          pendingCount: this.pendingJobIds.low.length,
        },
      },
    };
  }

  listRegisteredTypes(): string[] {
    return this.registry.listTypes();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      await this.waitForIdle();
      return;
    }
    this.stopped = true;

    for (const task of this.retryTasks.values()) {
      task.cancel();
    }
    this.retryTasks.clear();

    for (const task of this.evictionTasks.values()) {
      task.cancel();
    }
    this.evictionTasks.clear();

    for (const queue of RUNTIME_JOB_QUEUE_ORDER) {
      for (const jobId of this.pendingJobIds[queue].splice(0)) {
        const job = this.jobs.get(jobId);
        if (job && job.status === 'queued') {
          this.finish(job, 'failed', 'Runtime job queue stopped');
        }
      }
    }

    for (const job of this.jobs.values()) {
      if (job.status === 'queued') {
        this.finish(job, 'failed', 'Runtime job queue stopped');
      }
    }

    await this.waitForIdle();
  }

  private drain(): void {
    if (this.stopped) {
      return;
    }
    while (this.activeCount < this.concurrency && this.countPendingJobs() > 0) {
      const jobId = this.shiftNextPendingJobId();
      const job = jobId ? this.jobs.get(jobId) : null;
      if (!job || job.status !== 'queued') {
        continue;
      }
      this.activeCount += 1;
      void this.run(job);
    }
  }

  private async run(job: RuntimeJobRecord): Promise<void> {
    job.status = 'running';
    job.attempts += 1;
    job.startedAt = this.clock.nowMs();
    job.finishedAt = undefined;
    try {
      job.result = await this.registry.get(job.type)(job.payload, {
        jobId: job.id,
        logger: this.logger,
        reportProgress: (progress) => {
          job.progress = {
            updatedAt: this.clock.nowMs(),
            ...(typeof progress.percent === 'number'
              ? { percent: Math.max(0, Math.min(100, progress.percent)) }
              : {}),
            ...(progress.message ? { message: progress.message } : {}),
          };
        },
      });
      this.finish(job, 'succeeded');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.error = message;
      if (!this.stopped && job.attempts < job.maxAttempts) {
        job.status = 'queued';
        this.logger.warn(`runtime job retrying: ${job.type}`, error);
        const retryTask = this.scheduler.schedule(job.retryDelayMs, () => {
          this.retryTasks.delete(job.id);
          if (this.stopped || job.status !== 'queued') {
            return;
          }
          this.pendingJobIds[job.queue].push(job.id);
          this.drain();
        });
        this.retryTasks.set(job.id, retryTask);
        return;
      }
      this.finish(job, 'failed', message);
      this.logger.warn(`runtime job failed: ${job.type}`, error);
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.drain();
      this.resolveIdleWaitersIfIdle();
    }
  }

  private finish(job: RuntimeJobRecord, status: 'succeeded' | 'failed', error?: string): void {
    job.status = status;
    job.finishedAt = this.clock.nowMs();
    if (error) {
      job.error = error;
    } else {
      job.error = undefined;
    }
    job.payload = null;
    if (job.dedupeKey) {
      if (this.activeDedupeKeys.get(job.dedupeKey) === job.id) {
        this.activeDedupeKeys.delete(job.dedupeKey);
      }
      this.recentDedupeJobIds.set(job.dedupeKey, job.id);
    }
    this.scheduleEviction(job);
    this.enforceMaxRetention();
  }

  private scheduleEviction(job: RuntimeJobRecord): void {
    const retentionMs = job.status === 'failed' ? this.retentionFailedMs : this.retentionSucceededMs;
    if (retentionMs <= 0) {
      this.evictJob(job.id);
      return;
    }
    const previousTask = this.evictionTasks.get(job.id);
    if (previousTask) {
      previousTask.cancel();
    }
    const task = this.scheduler.schedule(retentionMs, () => {
      this.evictionTasks.delete(job.id);
      this.evictJob(job.id);
    });
    this.evictionTasks.set(job.id, task);
  }

  private enforceMaxRetention(): void {
    const finishedJobs = Array.from(this.jobs.values()).filter(
      (job) => job.status === 'succeeded' || job.status === 'failed',
    );
    if (finishedJobs.length <= this.maxRetainedJobs) {
      return;
    }
    finishedJobs.sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0));
    const overflow = finishedJobs.length - this.maxRetainedJobs;
    for (let index = 0; index < overflow; index += 1) {
      this.evictJob(finishedJobs[index].id);
    }
  }

  private evictJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }
    this.jobs.delete(jobId);
    const evictionTask = this.evictionTasks.get(jobId);
    if (evictionTask) {
      evictionTask.cancel();
      this.evictionTasks.delete(jobId);
    }
    if (job.dedupeKey && this.recentDedupeJobIds.get(job.dedupeKey) === jobId) {
      this.recentDedupeJobIds.delete(job.dedupeKey);
    }
  }

  private findRecentDedupeJob(dedupeKey: string): RuntimeJobRecord | null {
    const recentJobId = this.recentDedupeJobIds.get(dedupeKey);
    if (!recentJobId) {
      return null;
    }
    const recentJob = this.jobs.get(recentJobId);
    if (!recentJob || (recentJob.status !== 'succeeded' && recentJob.status !== 'failed')) {
      return null;
    }
    return recentJob;
  }

  private snapshot(job: RuntimeJobRecord): RuntimeJobSnapshot {
    return {
      id: job.id,
      type: job.type,
      queue: job.queue,
      status: job.status,
      queuedAt: job.queuedAt,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      ...(job.startedAt ? { startedAt: job.startedAt } : {}),
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
      ...(job.progress ? { progress: job.progress } : {}),
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  private waitForIdle(): Promise<void> {
    if (this.activeCount === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private resolveIdleWaitersIfIdle(): void {
    if (this.activeCount !== 0 || this.idleWaiters.length === 0) {
      return;
    }
    for (const resolve of this.idleWaiters.splice(0)) {
      resolve();
    }
  }

  private countPendingJobs(): number {
    return RUNTIME_JOB_QUEUE_ORDER.reduce(
      (total, queue) => total + this.pendingJobIds[queue].length,
      0,
    );
  }

  private shiftNextPendingJobId(): string | undefined {
    for (const queue of RUNTIME_JOB_QUEUE_ORDER) {
      const jobId = this.pendingJobIds[queue].shift();
      if (jobId) {
        return jobId;
      }
    }
    return undefined;
  }
}
