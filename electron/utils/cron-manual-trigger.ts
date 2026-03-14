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

type CronRpc = <T = unknown>(method: string, params?: unknown) => Promise<T>;

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

async function findCronJobById(rpc: CronRpc, id: string): Promise<GatewayCronJobForTrigger | null> {
  const result = await rpc('cron.list', { includeDisabled: true });
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

  const manualPatch: Record<string, unknown> = {
    sessionTarget: 'main',
    wakeMode: 'now',
    payload: { kind: 'systemEvent', text: manualPrompt },
  };

  return { manualPatch, restorePatch };
}

function isSkippedRun(result: unknown): boolean {
  const record = toRecord(result);
  if (!record) return false;
  if (record.ran === false) return true;
  const reason = typeof record.reason === 'string' ? record.reason : '';
  return reason === 'already-running' || reason === 'not-due';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunCompletion(params: {
  rpc: CronRpc;
  id: string;
  baselineLastRunAtMs: number;
}): Promise<void> {
  const deadline = Date.now() + MANUAL_RESTORE_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await sleep(MANUAL_RESTORE_POLL_MS);
    const job = await findCronJobById(params.rpc, params.id);
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
  rpc: CronRpc;
  id: string;
  restorePatch: Record<string, unknown>;
  logger?: CronTriggerLogger;
}): Promise<void> {
  try {
    await params.rpc('cron.update', { id: params.id, patch: params.restorePatch });
  } catch (error) {
    params.logger?.warn?.(`[cron] 手动执行后恢复任务配置失败: ${params.id}`, error);
  }
}

function scheduleRestoreAfterRun(params: {
  rpc: CronRpc;
  id: string;
  baselineLastRunAtMs: number;
  restorePatch: Record<string, unknown>;
  logger?: CronTriggerLogger;
}): void {
  void (async () => {
    try {
      await waitForRunCompletion({
        rpc: params.rpc,
        id: params.id,
        baselineLastRunAtMs: params.baselineLastRunAtMs,
      });
    } catch (error) {
      params.logger?.warn?.(`[cron] 等待手动执行完成时出错: ${params.id}`, error);
    } finally {
      await restoreCronJobConfig({
        rpc: params.rpc,
        id: params.id,
        restorePatch: params.restorePatch,
        logger: params.logger,
      });
    }
  })();
}

export async function triggerCronJobWithSplitProfiles(params: {
  rpc: CronRpc;
  id: string;
  logger?: CronTriggerLogger;
}): Promise<unknown> {
  const job = await findCronJobById(params.rpc, params.id);
  if (!job) {
    throw new Error(`Cron job not found: ${params.id}`);
  }

  if (!shouldUseManualRunProfileSwitch(job)) {
    return await params.rpc('cron.run', { id: params.id, mode: 'force' });
  }

  const { manualPatch, restorePatch } = buildManualRunPatches(job);
  const baselineLastRunAtMs = typeof job.state?.lastRunAtMs === 'number' ? job.state.lastRunAtMs : 0;

  try {
    await params.rpc('cron.update', { id: params.id, patch: manualPatch });
  } catch (error) {
    params.logger?.warn?.(`[cron] 手动执行配置切换失败，回退为原生 cron.run: ${params.id}`, error);
    return await params.rpc('cron.run', { id: params.id, mode: 'force' });
  }

  let runResult: unknown;
  try {
    runResult = await params.rpc<CronRunResult>('cron.run', { id: params.id, mode: 'force' });
  } catch (error) {
    await restoreCronJobConfig({
      rpc: params.rpc,
      id: params.id,
      restorePatch,
      logger: params.logger,
    });
    throw error;
  }

  if (isSkippedRun(runResult)) {
    await restoreCronJobConfig({
      rpc: params.rpc,
      id: params.id,
      restorePatch,
      logger: params.logger,
    });
    return runResult;
  }

  scheduleRestoreAfterRun({
    rpc: params.rpc,
    id: params.id,
    baselineLastRunAtMs,
    restorePatch,
    logger: params.logger,
  });

  return runResult;
}

