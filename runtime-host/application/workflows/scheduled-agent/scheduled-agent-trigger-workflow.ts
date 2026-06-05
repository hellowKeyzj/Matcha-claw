import type { RuntimeClockPort, RuntimeTimerPort } from '../../common/runtime-ports';
import type { GatewayCronPort } from '../../gateway/gateway-runtime-port';

type CronPayload = {
  kind?: string;
  message?: string;
  text?: string;
};

type CronDelivery = {
  mode?: string;
  channel?: string;
  to?: string;
};

type CronState = {
  lastRunAtMs?: number;
  runningAtMs?: number;
};

export interface GatewayCronJobForTrigger {
  id: string;
  name: string;
  sessionTarget?: string;
  wakeMode?: string;
  agentId?: string;
  payload?: CronPayload;
  delivery?: CronDelivery;
  state?: CronState;
}

type CronTriggerLogger = {
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

type CronRunResult = {
  ran?: boolean;
  reason?: string;
  enqueued?: boolean;
  runId?: string;
};

const MANUAL_RESTORE_POLL_MS = 1000;
const MANUAL_RESTORE_MAX_WAIT_MS = 15 * 60 * 1000;

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function parseCronJobs(value: unknown): GatewayCronJobForTrigger[] {
  const record = toRecord(value);
  const rawJobs = record?.jobs;
  if (!Array.isArray(rawJobs)) return [];
  return rawJobs.filter((entry): entry is GatewayCronJobForTrigger => {
    return Boolean(entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string');
  });
}

async function findCronJobById(
  gateway: Pick<GatewayCronPort, 'listCronJobs'>,
  id: string,
): Promise<GatewayCronJobForTrigger | null> {
  const result = await gateway.listCronJobs(true);
  const jobs = parseCronJobs(result);
  return jobs.find((job) => job.id === id) ?? null;
}

function resolvePromptText(job: GatewayCronJobForTrigger): string {
  const payload = job.payload ?? {};
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (message) return message;
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (text) return text;
  return '';
}

export function shouldUseManualRunProfileSwitch(job: GatewayCronJobForTrigger): boolean {
  const sessionTarget = typeof job.sessionTarget === 'string' ? job.sessionTarget : 'isolated';
  const payloadKind = typeof job.payload?.kind === 'string' ? job.payload.kind : 'agentTurn';
  return sessionTarget === 'isolated' && payloadKind === 'agentTurn';
}

export function buildManualRunPatches(job: GatewayCronJobForTrigger): {
  manualPatch: Record<string, unknown>;
  restorePatch: Record<string, unknown>;
} {
  const originalSessionTarget = job.sessionTarget === 'main' ? 'main' : 'isolated';
  const originalWakeMode = job.wakeMode === 'now' ? 'now' : 'next-heartbeat';
  const originalPrompt = resolvePromptText(job);
  const manualPrompt = originalPrompt || `手动执行任务：${job.name}`;
  const originalPayloadKind = typeof job.payload?.kind === 'string' ? job.payload.kind : 'agentTurn';

  const restorePayload = originalPayloadKind === 'systemEvent'
    ? { kind: 'systemEvent', text: originalPrompt || job.name }
    : { kind: 'agentTurn', message: originalPrompt || job.name };

  const restorePatch: Record<string, unknown> = {
    sessionTarget: originalSessionTarget,
    wakeMode: originalWakeMode,
    payload: restorePayload,
  };

  if (originalSessionTarget === 'isolated') {
    restorePatch.delivery = job.delivery?.mode
      ? { ...job.delivery }
      : { mode: 'none' };
  }

  return {
    manualPatch: {
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: manualPrompt },
    },
    restorePatch,
  };
}

function isSkippedRun(result: unknown): boolean {
  const record = toRecord(result);
  if (!record) return false;
  if (record.ran === false) return true;
  const reason = typeof record.reason === 'string' ? record.reason : '';
  return reason === 'already-running' || reason === 'not-due';
}

async function waitForRunCompletion(params: {
  gateway: Pick<GatewayCronPort, 'listCronJobs'>;
  id: string;
  baselineLastRunAtMs: number;
  clock: RuntimeClockPort;
  timer: RuntimeTimerPort;
}): Promise<void> {
  const deadline = params.clock.nowMs() + MANUAL_RESTORE_MAX_WAIT_MS;

  while (params.clock.nowMs() < deadline) {
    await params.timer.sleep(MANUAL_RESTORE_POLL_MS);
    const job = await findCronJobById(params.gateway, params.id);
    if (!job) return;

    const state = job.state ?? {};
    const currentLastRunAtMs = typeof state.lastRunAtMs === 'number' ? state.lastRunAtMs : 0;
    const isRunning = typeof state.runningAtMs === 'number';

    if (currentLastRunAtMs > params.baselineLastRunAtMs && !isRunning) {
      return;
    }
  }
}

async function restoreCronJobConfig(params: {
  gateway: Pick<GatewayCronPort, 'updateCronJob'>;
  id: string;
  restorePatch: Record<string, unknown>;
  logger?: CronTriggerLogger;
}): Promise<void> {
  try {
    await params.gateway.updateCronJob(params.id, params.restorePatch);
  } catch (error) {
    params.logger?.warn?.(`[cron] 手动执行后恢复任务配置失败: ${params.id}`, error);
  }
}

export interface ScheduledAgentTriggerWorkflowDeps {
  readonly gateway: Pick<GatewayCronPort, 'listCronJobs' | 'updateCronJob' | 'runCronJob'>;
  readonly clock: RuntimeClockPort;
  readonly timer: RuntimeTimerPort;
  readonly logger?: CronTriggerLogger;
}

export class ScheduledAgentTriggerWorkflow {
  constructor(private readonly deps: ScheduledAgentTriggerWorkflowDeps) {}

  async execute(input: { readonly id: string }): Promise<unknown> {
    const job = await findCronJobById(this.deps.gateway, input.id);
    if (!job) {
      throw new Error(`Cron job not found: ${input.id}`);
    }

    if (!shouldUseManualRunProfileSwitch(job)) {
      return await this.deps.gateway.runCronJob(input.id, 'force');
    }

    const { manualPatch, restorePatch } = buildManualRunPatches(job);
    const baselineLastRunAtMs = typeof job.state?.lastRunAtMs === 'number' ? job.state.lastRunAtMs : 0;

    try {
      await this.deps.gateway.updateCronJob(input.id, manualPatch);
    } catch (error) {
      this.deps.logger?.warn?.(`[cron] 手动执行配置切换失败，回退为原生 cron.run: ${input.id}`, error);
      return await this.deps.gateway.runCronJob(input.id, 'force');
    }

    let runResult: unknown;
    try {
      runResult = await this.deps.gateway.runCronJob(input.id, 'force') as CronRunResult;
    } catch (error) {
      await restoreCronJobConfig({
        gateway: this.deps.gateway,
        id: input.id,
        restorePatch,
        logger: this.deps.logger,
      });
      throw error;
    }

    if (isSkippedRun(runResult)) {
      await restoreCronJobConfig({
        gateway: this.deps.gateway,
        id: input.id,
        restorePatch,
        logger: this.deps.logger,
      });
      return runResult;
    }

    try {
      await waitForRunCompletion({
        gateway: this.deps.gateway,
        id: input.id,
        baselineLastRunAtMs,
        clock: this.deps.clock,
        timer: this.deps.timer,
      });
    } catch (error) {
      this.deps.logger?.warn?.(`[cron] 等待手动执行完成时出错: ${input.id}`, error);
    } finally {
      await restoreCronJobConfig({
        gateway: this.deps.gateway,
        id: input.id,
        restorePatch,
        logger: this.deps.logger,
      });
    }

    return runResult;
  }
}
