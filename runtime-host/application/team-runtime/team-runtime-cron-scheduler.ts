import { Cron } from 'croner';
import type { TeamArmedTriggerDescriptor } from './team-runtime-service';
import type { TeamRunRegistry } from './team-run-registry';
import type { TeamRuntimeOperationId } from './team-runtime-operation-id';
import type { TeamRuntimePort } from './team-runtime-port';

export interface TeamRuntimeCronSchedulerDeps {
  readonly runRegistry: TeamRunRegistry;
  readonly teamRuntimeService: TeamRuntimePort;
  readonly nowMs: () => number;
  readonly reconcileDelayMs?: number;
  readonly errorDelayMs?: number;
}

const DEFAULT_RECONCILE_DELAY_MS = 30_000;
const DEFAULT_ERROR_DELAY_MS = 60_000;
const TEAM_NODE_PROMPT_RETRY_DUE_OPERATION_ID = 'team.nodePromptRetryDue' as TeamRuntimeOperationId;

type ArmedCronJob = {
  readonly runId: string;
  readonly startNodeId: string;
  readonly cron: string;
  nextRunAtMs: number;
};

type NodePromptRetryScheduleRead = {
  readonly dueRunIds: string[];
  readonly nextRetryAtMs: number | null;
};

/**
 * Runtime-host-local driver for canvas StartNodes and retry wake-ups. It
 * discovers armed cron StartNodes across non-terminal runs via
 * `team.triggerList`, evaluates each expression with `croner`, and fires
 * `team.triggerFire` when a job's next-run time has elapsed.
 *
 * Node prompt retry wake-ups stay in the same TeamRun R3 path: this driver only
 * reads `team.runSnapshot` projections and invokes the R3 retry operation when
 * a scheduled retry is due. It never delivers prompts directly.
 *
 * This is deliberately NOT the OpenClaw scheduled-agent cron path: canvas cron is
 * owned by TeamRun (R3) and never reaches the OpenClaw gateway. Webhook triggers
 * are handled separately at the runtime-host HTTP boundary.
 */
export class TeamRuntimeCronScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private closed = false;
  private jobsByKey = new Map<string, ArmedCronJob>();

  constructor(private readonly deps: TeamRuntimeCronSchedulerDeps) {}

  refresh(): void {
    if (this.closed) return;
    if (!this.deps.runRegistry.hasNonTerminalRuns()) {
      this.jobsByKey.clear();
      this.clearTimer();
      return;
    }
    if (this.running || this.timer) return;
    this.schedule(0);
  }

  close(): void {
    this.closed = true;
    this.jobsByKey.clear();
    this.clearTimer();
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tickOnce();
    }, delayMs);
  }

  private async tickOnce(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      await this.reconcileJobs();
      const dueJobs = this.collectDueJobs();
      if (dueJobs.length > 0) {
        await Promise.all(dueJobs.map((job) => this.fireCronTrigger(job)));
      }
      const retrySchedule = await this.reconcileNodePromptRetries();
      this.schedule(this.nextDelayMs(retrySchedule.nextRetryAtMs));
    } catch {
      this.schedule(this.errorDelayMs);
    } finally {
      this.running = false;
    }
  }

  private async reconcileJobs(): Promise<void> {
    const response = await this.deps.teamRuntimeService.invoke('team.triggerList', {});
    const triggers = readArmedTriggers(response);
    const cronTriggers = triggers.filter((trigger) => trigger.trigger.mode === 'cron');
    const nextJobs = new Map<string, ArmedCronJob>();
    for (const trigger of cronTriggers) {
      if (trigger.trigger.mode !== 'cron') continue;
      const key = jobKey(trigger.runId, trigger.startNodeId);
      const existing = this.jobsByKey.get(key);
      if (existing && existing.cron === trigger.trigger.cron) {
        nextJobs.set(key, existing);
        continue;
      }
      const nextRunAtMs = computeNextRunMs(trigger.trigger.cron, this.deps.nowMs());
      if (nextRunAtMs === null) continue;
      nextJobs.set(key, { runId: trigger.runId, startNodeId: trigger.startNodeId, cron: trigger.trigger.cron, nextRunAtMs });
    }
    this.jobsByKey = nextJobs;
  }

  private collectDueJobs(): ArmedCronJob[] {
    const now = this.deps.nowMs();
    const due: ArmedCronJob[] = [];
    for (const job of this.jobsByKey.values()) {
      if (job.nextRunAtMs <= now) due.push(job);
    }
    return due;
  }

  private async fireCronTrigger(job: ArmedCronJob): Promise<void> {
    const firedAtMs = job.nextRunAtMs;
    // Advance the schedule first so a slow/failed fire never re-fires the same slot.
    const nextRunAtMs = computeNextRunMs(job.cron, this.deps.nowMs());
    if (nextRunAtMs === null) {
      this.jobsByKey.delete(jobKey(job.runId, job.startNodeId));
    } else {
      job.nextRunAtMs = nextRunAtMs;
    }
    await this.deps.teamRuntimeService.invoke('team.triggerFire', {
      runId: job.runId,
      startNodeId: job.startNodeId,
      triggerSource: 'cron',
      idempotencyKey: `team-cron:${job.runId}:${job.startNodeId}:${firedAtMs}`,
    });
  }

  private async reconcileNodePromptRetries(): Promise<NodePromptRetryScheduleRead> {
    const retrySchedule = await this.readNodePromptRetrySchedule();
    if (retrySchedule.dueRunIds.length === 0) return retrySchedule;

    for (const runId of retrySchedule.dueRunIds) {
      const response = await this.deps.teamRuntimeService.invoke(TEAM_NODE_PROMPT_RETRY_DUE_OPERATION_ID, { runId });
      if (!isSuccessfulApplicationResponse(response)) {
        throw new Error(`TeamRun node prompt retry wake-up failed for run ${runId}`);
      }
    }
    return await this.readNodePromptRetrySchedule();
  }

  private async readNodePromptRetrySchedule(): Promise<NodePromptRetryScheduleRead> {
    const now = this.deps.nowMs();
    const dueRunIds: string[] = [];
    let nextRetryAtMs: number | null = null;

    for (const runId of this.deps.runRegistry.listNonTerminalRunIds()) {
      const response = await this.deps.teamRuntimeService.invoke('team.runSnapshot', { runId });
      if (!isSuccessfulApplicationResponse(response)) {
        throw new Error(`TeamRun retry schedule snapshot failed for run ${runId}`);
      }
      const runNextRetryAtMs = readNextNodePromptRetryAtMs(response);
      if (runNextRetryAtMs === null) continue;
      if (runNextRetryAtMs <= now) {
        dueRunIds.push(runId);
        continue;
      }
      nextRetryAtMs = minNullableMs(nextRetryAtMs, runNextRetryAtMs);
    }

    return { dueRunIds, nextRetryAtMs };
  }

  private nextDelayMs(nextRetryAtMs: number | null): number {
    if (nextRetryAtMs === null) return this.reconcileDelayMs;
    return Math.max(0, Math.min(this.reconcileDelayMs, nextRetryAtMs - this.deps.nowMs()));
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private get reconcileDelayMs(): number {
    return this.deps.reconcileDelayMs ?? DEFAULT_RECONCILE_DELAY_MS;
  }

  private get errorDelayMs(): number {
    return this.deps.errorDelayMs ?? DEFAULT_ERROR_DELAY_MS;
  }
}

function jobKey(runId: string, startNodeId: string): string {
  return `${runId}::${startNodeId}`;
}

/**
 * Pure next-run evaluator over croner. Returns the absolute epoch-ms of the next
 * occurrence strictly after `fromMs`, or null when the expression is invalid or
 * has no future occurrence.
 */
export function computeNextRunMs(cronExpression: string, fromMs: number): number | null {
  try {
    const next = new Cron(cronExpression).nextRun(new Date(fromMs));
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

function readArmedTriggers(response: unknown): TeamArmedTriggerDescriptor[] {
  if (!response || typeof response !== 'object') return [];
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return [];
  const triggers = (data as { triggers?: unknown }).triggers;
  return Array.isArray(triggers) ? (triggers as TeamArmedTriggerDescriptor[]) : [];
}

function readNextNodePromptRetryAtMs(response: unknown): number | null {
  if (!response || typeof response !== 'object') return null;
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const deliveries = (data as { nodePromptDeliveries?: unknown }).nodePromptDeliveries;
  if (!Array.isArray(deliveries)) return null;

  let nextRetryAtMs: number | null = null;
  for (const delivery of deliveries) {
    if (!delivery || typeof delivery !== 'object') continue;
    const record = delivery as { status?: unknown; nextRetryAt?: unknown };
    if (record.status !== 'retry_scheduled') continue;
    if (typeof record.nextRetryAt !== 'number' || !Number.isFinite(record.nextRetryAt)) continue;
    nextRetryAtMs = minNullableMs(nextRetryAtMs, record.nextRetryAt);
  }
  return nextRetryAtMs;
}

function minNullableMs(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.min(current, candidate);
}

function isSuccessfulApplicationResponse(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const status = (response as { status?: unknown }).status;
  return typeof status === 'number' && status >= 200 && status < 300;
}
