import type { RuntimeHostLogger } from '../shared/logger';
import type { RuntimeClockPort, RuntimeScheduledTask, RuntimeSchedulerPort } from '../application/common/runtime-ports';
import type {
  RuntimeJobEnqueueOptions,
  RuntimeJobProgress,
  RuntimeJobQueueName,
  RuntimeJobQueueSnapshot,
  RuntimeJobSnapshot,
  RuntimeJobStatus,
  type RuntimeJobResultEnvelope,
  type RuntimeJobResultRetention,
} from '../application/common/runtime-contracts';

export interface RuntimeJobHandlerContext {
  readonly jobId: string;
  readonly logger: RuntimeHostLogger;
  readonly reportProgress: (progress: Omit<RuntimeJobProgress, 'updatedAt'>) => void;
  readonly yieldIfNeeded: () => Promise<void>;
  readonly checkpoint: (message?: string) => Promise<void>;
}

export type RuntimeJobHandler = (
  payload: unknown,
  context: RuntimeJobHandlerContext,
) => Promise<unknown> | unknown;

export interface RuntimeJobDefinition {
  readonly type: string;
  readonly handler: RuntimeJobHandler;
}

export interface RuntimeJobRegistrationDescriptor {
  readonly type: string;
  readonly owner: string | null;
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
  resultRetention: RuntimeJobResultRetention;
  error?: string;
  yieldState?: RuntimeJobYieldState;
}

interface RuntimeJobYieldState {
  sliceStartedAt: number;
}

interface PendingRuntimeJobIdQueue {
  ids: string[];
  head: number;
}

export interface RuntimeJobEventSink {
  emitDone(snapshot: RuntimeJobSnapshot): void;
  emitProgress(snapshot: RuntimeJobSnapshot): void;
}

export interface RuntimeJobQueueOptions {
  readonly concurrency?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly retentionSucceededMs?: number;
  readonly retentionFailedMs?: number;
  readonly maxRetainedJobs?: number;
  readonly eventSink?: RuntimeJobEventSink;
}

const RUNTIME_JOB_QUEUE_ORDER: readonly RuntimeJobQueueName[] = ['critical', 'default', 'low'] as const;
const DEFAULT_JOB_SLICE_MS = 12;

function waitForNextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export class RuntimeJobRegistry {
  private readonly handlers = new Map<string, RuntimeJobHandler>();
  private readonly owners = new Map<string, string | null>();
  private activeRegistrationOwner: string | null = null;

  register(type: string, handler: RuntimeJobHandler): void {
    if (this.handlers.has(type)) {
      throw new Error(`Runtime job handler already registered: ${type}`);
    }
    this.handlers.set(type, handler);
    this.owners.set(type, this.activeRegistrationOwner);
  }

  withRegistrationOwner<T>(owner: string, register: () => T): T {
    const normalizedOwner = owner.trim();
    if (!normalizedOwner) {
      throw new Error('Runtime job registration owner is required');
    }
    const previousOwner = this.activeRegistrationOwner;
    this.activeRegistrationOwner = normalizedOwner;
    try {
      return register();
    } finally {
      this.activeRegistrationOwner = previousOwner;
    }
  }

  listRegistrations(): RuntimeJobRegistrationDescriptor[] {
    return Array.from(this.handlers.keys()).map((type) => ({
      type,
      owner: this.owners.get(type) ?? null,
    }));
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
  private readonly pendingJobIds: Record<RuntimeJobQueueName, PendingRuntimeJobIdQueue> = {
    critical: { ids: [], head: 0 },
    default: { ids: [], head: 0 },
    low: { ids: [], head: 0 },
  };
  private readonly jobs = new Map<string, RuntimeJobRecord>();
  private readonly jobIdsByType = new Map<string, Set<string>>();
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
  private eventSink: RuntimeJobEventSink | null;

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
    this.eventSink = options.eventSink ?? null;
  }

  setEventSink(sink: RuntimeJobEventSink): void {
    this.eventSink = sink;
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
      resultRetention: options.resultRetention ?? 'retain',
    };
    this.jobs.set(job.id, job);
    let typeBucket = this.jobIdsByType.get(job.type);
    if (!typeBucket) {
      typeBucket = new Set<string>();
      this.jobIdsByType.set(job.type, typeBucket);
    }
    typeBucket.add(job.id);
    if (options.dedupeKey) {
      this.activeDedupeKeys.set(options.dedupeKey, job.id);
    }

    this.enqueuePendingJobId(job.queue, job.id);
    this.drain();
    return this.snapshot(job);
  }

  get(jobId: string): RuntimeJobSnapshot | null {
    const job = this.jobs.get(jobId);
    return job ? this.snapshot(job) : null;
  }

  latestByType(type: string): RuntimeJobSnapshot | null {
    const bucket = this.jobIdsByType.get(type);
    if (!bucket || bucket.size === 0) {
      return null;
    }
    let latest: RuntimeJobRecord | null = null;
    for (const jobId of bucket) {
      const job = this.jobs.get(jobId);
      if (!job) {
        continue;
      }
      if (!latest || job.queuedAt > latest.queuedAt) {
        latest = job;
      }
    }
    return latest ? this.snapshot(latest) : null;
  }

  listByType(type: string): RuntimeJobSnapshot[] {
    const bucket = this.jobIdsByType.get(type);
    if (!bucket || bucket.size === 0) {
      return [];
    }
    const matches: RuntimeJobRecord[] = [];
    for (const jobId of bucket) {
      const job = this.jobs.get(jobId);
      if (job) {
        matches.push(job);
      }
    }
    matches.sort((left, right) => left.queuedAt - right.queuedAt);
    return matches.map((job) => this.snapshot(job));
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
          pendingCount: this.countPendingQueueJobs(this.pendingJobIds.critical),
        },
        default: {
          pendingCount: this.countPendingQueueJobs(this.pendingJobIds.default),
        },
        low: {
          pendingCount: this.countPendingQueueJobs(this.pendingJobIds.low),
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
      for (const jobId of this.drainPendingQueue(this.pendingJobIds[queue])) {
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
    job.yieldState = { sliceStartedAt: Date.now() };
    try {
      const result = await this.registry.get(job.type)(job.payload, this.createHandlerContext(job));
      this.applyJobResult(job, result);
      this.finish(job, 'succeeded');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.error = message;
      if (!this.stopped && job.attempts < job.maxAttempts) {
        job.status = 'queued';
        job.yieldState = undefined;
        this.logger.warn(`runtime job retrying: ${job.type}`, error);
        const retryTask = this.scheduler.schedule(job.retryDelayMs, () => {
          this.retryTasks.delete(job.id);
          if (this.stopped || job.status !== 'queued') {
            return;
          }
          this.enqueuePendingJobId(job.queue, job.id);
          this.drain();
        });
        this.retryTasks.set(job.id, retryTask);
        return;
      }
      this.finish(job, 'failed', message);
      this.logger.warn(`runtime job failed: ${job.type}`, error);
    } finally {
      job.yieldState = undefined;
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.drain();
      this.resolveIdleWaitersIfIdle();
    }
  }

  private isResultEnvelope(value: unknown): value is RuntimeJobResultEnvelope {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'value'));
  }

  private applyJobResult(job: RuntimeJobRecord, result: unknown): void {
    if (this.isResultEnvelope(result)) {
      job.resultRetention = result.retention ?? job.resultRetention;
      job.result = job.resultRetention === 'drop' ? undefined : result.value;
      return;
    }
    job.result = job.resultRetention === 'drop' ? undefined : result;
  }

  private createHandlerContext(job: RuntimeJobRecord): RuntimeJobHandlerContext {
    if (!job.yieldState) {
      throw new Error(`Runtime job missing execution context: ${job.id}`);
    }
    const yieldNow = async () => {
      await waitForNextTurn();
      if (job.yieldState) {
        job.yieldState.sliceStartedAt = Date.now();
      }
    };
    const reportProgress = (progress: Omit<RuntimeJobProgress, 'updatedAt'>) => {
      job.progress = {
        updatedAt: this.clock.nowMs(),
        ...(typeof progress.percent === 'number'
          ? { percent: Math.max(0, Math.min(100, progress.percent)) }
          : {}),
        ...(progress.message ? { message: progress.message } : {}),
      };
      this.eventSink?.emitProgress(this.snapshot(job));
    };
    return {
      jobId: job.id,
      logger: this.logger,
      reportProgress,
      yieldIfNeeded: async () => {
        const elapsedMs = Date.now() - (job.yieldState?.sliceStartedAt ?? Date.now());
        if (elapsedMs < DEFAULT_JOB_SLICE_MS) {
          return;
        }
        await yieldNow();
      },
      checkpoint: async (message) => {
        if (message) {
          reportProgress({ message });
        }
        await yieldNow();
      },
    };
  }

  private finish(job: RuntimeJobRecord, status: 'succeeded' | 'failed', error?: string): void {
    job.status = status;
    job.finishedAt = this.clock.nowMs();
    if (error) {
      job.error = error;
    } else {
      job.error = undefined;
    }
    if (job.dedupeKey) {
      if (this.activeDedupeKeys.get(job.dedupeKey) === job.id) {
        this.activeDedupeKeys.delete(job.dedupeKey);
      }
      this.recentDedupeJobIds.set(job.dedupeKey, job.id);
    }
    this.eventSink?.emitDone(this.snapshot(job));
    job.payload = null;
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

  private removePendingJobId(jobId: string): void {
    for (const queue of RUNTIME_JOB_QUEUE_ORDER) {
      const pendingQueue = this.pendingJobIds[queue];
      for (let index = pendingQueue.head; index < pendingQueue.ids.length; index += 1) {
        if (pendingQueue.ids[index] === jobId) {
          pendingQueue.ids.splice(index, 1);
          index -= 1;
        }
      }
      this.compactPendingQueue(pendingQueue);
    }
  }

  private evictJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }
    this.removePendingJobId(jobId);
    this.jobs.delete(jobId);
    const typeBucket = this.jobIdsByType.get(job.type);
    if (typeBucket) {
      typeBucket.delete(jobId);
      if (typeBucket.size === 0) {
        this.jobIdsByType.delete(job.type);
      }
    }
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

  private enqueuePendingJobId(queue: RuntimeJobQueueName, jobId: string): void {
    this.pendingJobIds[queue].ids.push(jobId);
  }

  private drainPendingQueue(queue: PendingRuntimeJobIdQueue): string[] {
    const pendingIds = queue.ids.slice(queue.head);
    queue.ids.length = 0;
    queue.head = 0;
    return pendingIds;
  }

  private compactPendingQueue(queue: PendingRuntimeJobIdQueue): void {
    if (queue.head <= 32 || queue.head * 2 < queue.ids.length) {
      return;
    }
    queue.ids.splice(0, queue.head);
    queue.head = 0;
  }

  private countPendingQueueJobs(queue: PendingRuntimeJobIdQueue): number {
    return queue.ids.length - queue.head;
  }

  private countPendingJobs(): number {
    return RUNTIME_JOB_QUEUE_ORDER.reduce(
      (total, queue) => total + this.countPendingQueueJobs(this.pendingJobIds[queue]),
      0,
    );
  }

  private shiftNextPendingJobId(): string | undefined {
    for (const queueName of RUNTIME_JOB_QUEUE_ORDER) {
      const queue = this.pendingJobIds[queueName];
      const jobId = queue.ids[queue.head];
      if (jobId) {
        queue.head += 1;
        this.compactPendingQueue(queue);
        return jobId;
      }
    }
    return undefined;
  }
}
