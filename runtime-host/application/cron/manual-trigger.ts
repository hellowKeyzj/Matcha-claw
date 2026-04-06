import type { OpenClawBridge } from '../../openclaw-bridge';

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

type CronTriggerBridge = Pick<OpenClawBridge, 'listCronJobs' | 'updateCronJob' | 'runCronJob'>;

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
  openclawBridge: CronTriggerBridge,
  id: string,
): Promise<GatewayCronJobForTrigger | null> {
  const result = await openclawBridge.listCronJobs(true);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForRunCompletion(params: {
  openclawBridge: CronTriggerBridge;
  id: string;
  baselineLastRunAtMs: number;
}): Promise<void> {
  const deadline = Date.now() + MANUAL_RESTORE_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await sleep(MANUAL_RESTORE_POLL_MS);
    const job = await findCronJobById(params.openclawBridge, params.id);
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
  openclawBridge: CronTriggerBridge;
  id: string;
  restorePatch: Record<string, unknown>;
  logger?: CronTriggerLogger;
}): Promise<void> {
  try {
    await params.openclawBridge.updateCronJob(params.id, params.restorePatch);
  } catch (error) {
    params.logger?.warn?.(`[cron] 手动执行后恢复任务配置失败: ${params.id}`, error);
  }
}

function scheduleRestoreAfterRun(params: {
  openclawBridge: CronTriggerBridge;
  id: string;
  baselineLastRunAtMs: number;
  restorePatch: Record<string, unknown>;
  logger?: CronTriggerLogger;
}): void {
  void (async () => {
    try {
      await waitForRunCompletion({
        openclawBridge: params.openclawBridge,
        id: params.id,
        baselineLastRunAtMs: params.baselineLastRunAtMs,
      });
    } catch (error) {
      params.logger?.warn?.(`[cron] 等待手动执行完成时出错: ${params.id}`, error);
    } finally {
      await restoreCronJobConfig({
        openclawBridge: params.openclawBridge,
        id: params.id,
        restorePatch: params.restorePatch,
        logger: params.logger,
      });
    }
  })();
}

export async function triggerCronJobWithSplitProfiles(params: {
  openclawBridge: CronTriggerBridge;
  id: string;
  logger?: CronTriggerLogger;
}): Promise<unknown> {
  const job = await findCronJobById(params.openclawBridge, params.id);
  if (!job) {
    throw new Error(`Cron job not found: ${params.id}`);
  }

  if (!shouldUseManualRunProfileSwitch(job)) {
    return await params.openclawBridge.runCronJob(params.id, 'force');
  }

  const { manualPatch, restorePatch } = buildManualRunPatches(job);
  const baselineLastRunAtMs = typeof job.state?.lastRunAtMs === 'number' ? job.state.lastRunAtMs : 0;

  try {
    await params.openclawBridge.updateCronJob(params.id, manualPatch);
  } catch (error) {
    params.logger?.warn?.(`[cron] 手动执行配置切换失败，回退为原生 cron.run: ${params.id}`, error);
    return await params.openclawBridge.runCronJob(params.id, 'force');
  }

  let runResult: unknown;
  try {
    runResult = await params.openclawBridge.runCronJob(params.id, 'force') as CronRunResult;
  } catch (error) {
    await restoreCronJobConfig({
      openclawBridge: params.openclawBridge,
      id: params.id,
      restorePatch,
      logger: params.logger,
    });
    throw error;
  }

  if (isSkippedRun(runResult)) {
    await restoreCronJobConfig({
      openclawBridge: params.openclawBridge,
      id: params.id,
      restorePatch,
      logger: params.logger,
    });
    return runResult;
  }

  scheduleRestoreAfterRun({
    openclawBridge: params.openclawBridge,
    id: params.id,
    baselineLastRunAtMs,
    restorePatch,
    logger: params.logger,
  });

  return runResult;
}
