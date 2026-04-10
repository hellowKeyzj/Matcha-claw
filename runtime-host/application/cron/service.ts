import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { triggerCronJobWithSplitProfiles } from './manual-trigger';
import type { OpenClawBridge } from '../../openclaw-bridge';
import { getRecentTokenUsageHistory } from '../usage/token-usage-history';

type CronRouteBridge = Pick<
  OpenClawBridge,
  'listCronJobs' | 'addCronJob' | 'updateCronJob' | 'removeCronJob' | 'runCronJob'
>;

type CronDeliveryMode = 'none' | 'announce';
type GatewayCronDelivery = {
  mode: CronDeliveryMode;
  channel?: string;
  to?: string;
  accountId?: string;
};

const WECHAT_CHANNEL_ALIAS = new Set(['wechat', 'openclaw-weixin']);

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDeliveryChannel(channel: unknown): string | undefined {
  if (typeof channel !== 'string') {
    return undefined;
  }
  const normalized = channel.trim();
  if (!normalized) {
    return undefined;
  }
  return WECHAT_CHANNEL_ALIAS.has(normalized) ? 'openclaw-weixin' : normalized;
}

function isWeChatDeliveryChannel(channel?: string): boolean {
  if (!channel) {
    return false;
  }
  return WECHAT_CHANNEL_ALIAS.has(channel.trim());
}

function getCronDeliveryValidationError(delivery: GatewayCronDelivery): string | undefined {
  if (delivery.mode !== 'announce' || !delivery.channel) {
    return undefined;
  }
  if (!isWeChatDeliveryChannel(delivery.channel)) {
    return undefined;
  }
  if (!delivery.to) {
    return 'WeChat scheduled delivery requires delivery.to (recipient target).';
  }
  if (!delivery.accountId) {
    return 'WeChat scheduled delivery requires delivery.accountId (sending account).';
  }
  return undefined;
}

function mergeCronDelivery(base: GatewayCronDelivery, patch: Record<string, unknown>): GatewayCronDelivery {
  const mode = typeof patch.mode === 'string'
    ? (patch.mode.trim() === 'announce' ? 'announce' : 'none')
    : base.mode;
  const channel = 'channel' in patch
    ? normalizeDeliveryChannel(patch.channel)
    : normalizeDeliveryChannel(base.channel);
  if (mode !== 'announce' || !channel) {
    return { mode: 'none' };
  }
  const to = 'to' in patch
    ? (typeof patch.to === 'string' ? patch.to.trim() : '')
    : (typeof base.to === 'string' ? base.to.trim() : '');
  const accountId = 'accountId' in patch
    ? (typeof patch.accountId === 'string' ? patch.accountId.trim() : '')
    : (typeof base.accountId === 'string' ? base.accountId.trim() : '');
  return {
    mode: 'announce',
    channel,
    ...(to ? { to } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

function normalizeCronDelivery(rawDelivery: unknown): GatewayCronDelivery {
  if (!isRecord(rawDelivery)) {
    return { mode: 'none' };
  }
  const mode = typeof rawDelivery.mode === 'string' && rawDelivery.mode.trim() === 'announce'
    ? 'announce'
    : 'none';
  const channel = normalizeDeliveryChannel(rawDelivery.channel);
  if (mode !== 'announce' || !channel) {
    return { mode: 'none' };
  }
  const to = typeof rawDelivery.to === 'string' ? rawDelivery.to.trim() : '';
  const accountId = typeof rawDelivery.accountId === 'string' ? rawDelivery.accountId.trim() : '';
  return {
    mode,
    channel,
    ...(to ? { to } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

function normalizeCronDeliveryPatch(rawPatch: unknown): Record<string, unknown> | undefined {
  if (!isRecord(rawPatch)) {
    return undefined;
  }
  const patch: Record<string, unknown> = {};
  if ('mode' in rawPatch) {
    patch.mode = (typeof rawPatch.mode === 'string' && rawPatch.mode.trim() === 'announce')
      ? 'announce'
      : 'none';
  }
  if ('channel' in rawPatch) {
    patch.channel = normalizeDeliveryChannel(rawPatch.channel);
  }
  if ('to' in rawPatch) {
    patch.to = typeof rawPatch.to === 'string' ? rawPatch.to.trim() : '';
  }
  if ('accountId' in rawPatch) {
    patch.accountId = typeof rawPatch.accountId === 'string' ? rawPatch.accountId.trim() : '';
  }
  return patch;
}

function asCronCreateInput(value: unknown) {
  if (!isRecord(value)) return null;
  if (typeof value.name !== 'string' || typeof value.message !== 'string' || typeof value.schedule !== 'string') {
    return null;
  }
  return {
    name: value.name,
    message: value.message,
    schedule: value.schedule,
    delivery: normalizeCronDelivery(value.delivery),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
  };
}

function normalizeCronJob(job: Record<string, any>) {
  const payload = isRecord(job.payload) ? job.payload : {};
  const delivery = normalizeCronDelivery(job.delivery);
  const state = isRecord(job.state) ? job.state : {};
  const schedule = isRecord(job.schedule) ? job.schedule : {};
  const message = payload.message || payload.text || '';
  const channelType = delivery.channel;
  const target = channelType
    ? {
      channelType,
      channelId: delivery.accountId || channelType,
      channelName: channelType,
      ...(delivery.to ? { recipient: delivery.to } : {}),
    }
    : undefined;
  const lastRun = state.lastRunAtMs
    ? {
      time: new Date(state.lastRunAtMs).toISOString(),
      success: state.lastStatus === 'ok',
      error: state.lastError,
      duration: state.lastDurationMs,
    }
    : undefined;
  const nextRun = state.nextRunAtMs ? new Date(state.nextRunAtMs).toISOString() : undefined;
  const runningAt = state.runningAtMs ? new Date(state.runningAtMs).toISOString() : undefined;
  return {
    id: job.id,
    name: job.name,
    message,
    schedule,
    delivery,
    target,
    enabled: job.enabled,
    createdAt: new Date(job.createdAtMs).toISOString(),
    updatedAt: new Date(job.updatedAtMs).toISOString(),
    lastRun,
    nextRun,
    runningAt,
  };
}

function parseGatewayCronJobs(value: unknown) {
  const record = isRecord(value) ? value : {};
  const jobs = Array.isArray(record.jobs) ? record.jobs : [];
  return jobs.filter((entry) => isRecord(entry) && typeof entry.id === 'string') as Array<Record<string, any>>;
}

function parseCronSessionKey(sessionKey: string) {
  if (typeof sessionKey !== 'string' || !sessionKey.startsWith('agent:')) {
    return null;
  }
  const parts = sessionKey.split(':');
  if (parts.length < 4 || parts[2] !== 'cron') {
    return null;
  }
  const agentId = parts[1] || 'main';
  const jobId = parts[3];
  if (!jobId) {
    return null;
  }
  if (parts.length === 4) {
    return { agentId, jobId };
  }
  if (parts.length === 6 && parts[4] === 'run' && parts[5]) {
    return { agentId, jobId, runSessionId: parts[5] };
  }
  return null;
}

function normalizeTimestampMs(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function formatDuration(durationMs: unknown) {
  if (!durationMs || !Number.isFinite(Number(durationMs))) return null;
  const numericDuration = Number(durationMs);
  if (numericDuration < 1000) return `${Math.round(numericDuration)}ms`;
  if (numericDuration < 10_000) return `${(numericDuration / 1000).toFixed(1)}s`;
  return `${Math.round(numericDuration / 1000)}s`;
}

function buildCronRunMessage(entry: Record<string, any>, index: number) {
  const timestamp = normalizeTimestampMs(entry.ts) ?? normalizeTimestampMs(entry.runAtMs);
  if (!timestamp) return null;
  const status = typeof entry.status === 'string' ? entry.status.toLowerCase() : '';
  const recoveredSummary = typeof entry.recoveredSummary === 'string' ? entry.recoveredSummary.trim() : '';
  const summary = recoveredSummary || (typeof entry.summary === 'string' ? entry.summary.trim() : '');
  const error = typeof entry.error === 'string' ? entry.error.trim() : '';
  let content = summary || error;
  if (!content) {
    content = status === 'error' ? 'Scheduled task failed.' : 'Scheduled task completed.';
  }
  if (status === 'error' && !content.toLowerCase().startsWith('run failed:')) {
    content = `Run failed: ${content}`;
  }
  const meta: string[] = [];
  const duration = formatDuration(entry.durationMs);
  if (duration) meta.push(`Duration: ${duration}`);
  if (entry.provider && entry.model) meta.push(`Model: ${entry.provider}/${entry.model}`);
  else if (entry.model) meta.push(`Model: ${entry.model}`);
  if (meta.length > 0) {
    content = `${content}\n\n${meta.join(' | ')}`;
  }
  return {
    id: `cron-run-${entry.sessionId ?? entry.ts ?? index}`,
    role: status === 'error' ? 'system' : 'assistant',
    content,
    timestamp,
    ...(status === 'error' ? { isError: true } : {}),
  };
}

export interface CronServiceDeps {
  readonly openclawBridge: CronRouteBridge;
  readonly getOpenClawConfigDir: () => string;
}

export class CronService {
  constructor(private readonly deps: CronServiceDeps) {}

  async usageRecent(payload: unknown, routeUrl: URL) {
    let limit: number | undefined;
    const queryLimitRaw = routeUrl.searchParams.get('limit');
    if (typeof queryLimitRaw === 'string' && queryLimitRaw.trim()) {
      const queryLimit = Number(queryLimitRaw);
      if (Number.isFinite(queryLimit)) {
        limit = Math.max(Math.floor(queryLimit), 0);
      }
    }
    if (limit === undefined && isRecord(payload)) {
      const payloadLimit = Number(payload.limit);
      if (Number.isFinite(payloadLimit)) {
        limit = Math.max(Math.floor(payloadLimit), 0);
      }
    }
    return await getRecentTokenUsageHistory({
      limit,
      openclawConfigDir: this.deps.getOpenClawConfigDir(),
    });
  }

  async listJobs() {
    const listResult = await this.deps.openclawBridge.listCronJobs(true);
    const jobs = parseGatewayCronJobs(listResult);
    for (const job of jobs) {
      const payload = isRecord(job.payload) ? job.payload : {};
      const delivery = isRecord(job.delivery) ? job.delivery : {};
      const isIsolatedAgent = (job.sessionTarget === 'isolated' || !job.sessionTarget)
        && payload.kind === 'agentTurn';
      const needsRepair = isIsolatedAgent && delivery.mode === 'announce' && !delivery.channel;
      if (!needsRepair) {
        continue;
      }
      try {
        await this.deps.openclawBridge.updateCronJob(job.id, { delivery: { mode: 'none' } });
        job.delivery = { mode: 'none' };
        const state = isRecord(job.state) ? job.state : {};
        if (typeof state.lastError === 'string' && state.lastError.includes('Channel is required')) {
          job.state = {
            ...state,
            lastError: undefined,
            lastStatus: 'ok',
          };
        }
      } catch {
        // ignore one job repair failure
      }
    }
    return jobs.map((job) => normalizeCronJob(job));
  }

  async sessionHistory(routeUrl: URL) {
    const sessionKey = routeUrl.searchParams.get('sessionKey')?.trim() || '';
    const parsedSession = parseCronSessionKey(sessionKey);
    if (!parsedSession) {
      return {
        status: 400,
        data: { success: false, error: `Invalid cron sessionKey: ${sessionKey}` },
      };
    }
    const rawLimit = Number(routeUrl.searchParams.get('limit') || '200');
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 200) : 200;
    const runs = await this.readCronRunLog(parsedSession.jobId);
    const messages = this.buildCronSessionFallbackMessages({
      sessionKey,
      runs,
      limit,
    });
    return {
      status: 200,
      data: { messages },
    };
  }

  async createJob(payload: unknown) {
    const input = asCronCreateInput(payload);
    if (!input) {
      return {
        status: 400,
        data: { success: false, error: 'Invalid cron create payload' },
      };
    }
    const deliveryValidationError = getCronDeliveryValidationError(input.delivery);
    if (deliveryValidationError) {
      return {
        status: 400,
        data: { success: false, error: deliveryValidationError },
      };
    }
    const created = await this.deps.openclawBridge.addCronJob({
      name: input.name,
      schedule: { kind: 'cron', expr: input.schedule },
      payload: { kind: 'agentTurn', message: input.message },
      enabled: input.enabled ?? true,
      wakeMode: 'next-heartbeat',
      sessionTarget: 'isolated',
      delivery: input.delivery,
    });
    return {
      status: 200,
      data: isRecord(created) ? normalizeCronJob(created) : created,
    };
  }

  async updateJob(jobId: string, payload: unknown) {
    const input = isRecord(payload) ? payload : null;
    if (!input) {
      return {
        status: 400,
        data: { success: false, error: 'Invalid cron update payload' },
      };
    }
    const patch: Record<string, any> = { ...input };
    if (typeof patch.schedule === 'string') {
      patch.schedule = { kind: 'cron', expr: patch.schedule };
    }
    if (typeof patch.message === 'string') {
      patch.payload = { kind: 'agentTurn', message: patch.message };
      delete patch.message;
    }
    if ('delivery' in patch) {
      patch.delivery = normalizeCronDeliveryPatch(patch.delivery);
      const deliveryPatch = isRecord(patch.delivery) ? patch.delivery : {};
      const currentDelivery = await this.getJobDelivery(jobId);
      const mergedDelivery = mergeCronDelivery(currentDelivery, deliveryPatch);
      const deliveryValidationError = getCronDeliveryValidationError(mergedDelivery);
      if (deliveryValidationError) {
        return {
          status: 400,
          data: { success: false, error: deliveryValidationError },
        };
      }
    }
    return {
      status: 200,
      data: await this.deps.openclawBridge.updateCronJob(jobId, patch),
    };
  }

  async deleteJob(jobId: string) {
    return {
      status: 200,
      data: await this.deps.openclawBridge.removeCronJob(jobId),
    };
  }

  async toggleJob(payload: unknown) {
    const body = isRecord(payload) ? payload : null;
    if (!body || typeof body.id !== 'string' || typeof body.enabled !== 'boolean') {
      return {
        status: 400,
        data: { success: false, error: 'Invalid cron toggle payload' },
      };
    }
    return {
      status: 200,
      data: await this.deps.openclawBridge.updateCronJob(body.id, { enabled: body.enabled }),
    };
  }

  async trigger(payload: unknown) {
    const body = isRecord(payload) ? payload : null;
    if (!body || typeof body.id !== 'string') {
      return {
        status: 400,
        data: { success: false, error: 'Invalid cron trigger payload' },
      };
    }
    return {
      status: 200,
      data: await triggerCronJobWithSplitProfiles({
        openclawBridge: this.deps.openclawBridge,
        id: body.id,
      }),
    };
  }

  private async readCronRunLog(jobId: string) {
    const logPath = join(this.deps.getOpenClawConfigDir(), 'cron', 'runs', `${jobId}.jsonl`);
    const raw = await readFile(logPath, 'utf8').catch(() => '');
    if (!raw.trim()) {
      return [];
    }
    const entries: Array<Record<string, any>> = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const entry = JSON.parse(trimmed);
        if (!isRecord(entry) || entry.jobId !== jobId) {
          continue;
        }
        if (entry.action && entry.action !== 'finished') {
          continue;
        }
        entries.push(entry);
      } catch {
        // ignore malformed line
      }
    }
    return entries;
  }

  private buildCronSessionFallbackMessages(params: {
    sessionKey: string;
    runs: Array<Record<string, any>>;
    limit?: number;
  }) {
    const parsed = parseCronSessionKey(params.sessionKey);
    if (!parsed) {
      return [];
    }
    const matchingRuns = params.runs
      .filter((entry) => {
        if (!parsed.runSessionId) return true;
        return entry.sessionId === parsed.runSessionId
          || entry.sessionKey === params.sessionKey;
      })
      .sort((a, b) => {
        const left = normalizeTimestampMs(a.ts) ?? normalizeTimestampMs(a.runAtMs) ?? 0;
        const right = normalizeTimestampMs(b.ts) ?? normalizeTimestampMs(b.runAtMs) ?? 0;
        return left - right;
      });

    const messages: Array<Record<string, any>> = [];
    matchingRuns.forEach((entry, index) => {
      const message = buildCronRunMessage(entry, index);
      if (message) {
        messages.push(message);
      }
    });
    if (messages.length === 0) {
      messages.push({
        id: `cron-empty-${parsed.jobId}`,
        role: 'system',
        content: 'No chat transcript is available for this scheduled task yet.',
        timestamp: Date.now(),
      });
    }
    const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit))
      : messages.length;
    return messages.slice(-limit);
  }

  private async getJobDelivery(jobId: string): Promise<GatewayCronDelivery> {
    const listResult = await this.deps.openclawBridge.listCronJobs(true);
    const jobs = parseGatewayCronJobs(listResult);
    const matchedJob = jobs.find((job) => job.id === jobId);
    if (!matchedJob || !isRecord(matchedJob.delivery)) {
      return { mode: 'none' };
    }
    return normalizeCronDelivery(matchedJob.delivery);
  }

}
