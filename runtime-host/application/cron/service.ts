import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { triggerCronJobWithSplitProfiles } from './manual-trigger';
import type { OpenClawBridge } from '../../openclaw-bridge';

type CronRouteBridge = Pick<
  OpenClawBridge,
  'listCronJobs' | 'addCronJob' | 'updateCronJob' | 'removeCronJob' | 'runCronJob'
>;

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
  };
}

function normalizeCronJob(job: Record<string, any>) {
  const payload = isRecord(job.payload) ? job.payload : {};
  const delivery = isRecord(job.delivery) ? job.delivery : {};
  const state = isRecord(job.state) ? job.state : {};
  const schedule = isRecord(job.schedule) ? job.schedule : {};
  const message = payload.message || payload.text || '';
  const channelType = delivery.channel;
  const target = channelType
    ? { channelType, channelId: channelType, channelName: channelType }
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

function toFiniteNumberOr(value: unknown, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return numeric;
}

function parseUsageEntriesFromJsonl(content: string, context: Record<string, string>, limit?: number) {
  const entries: Array<Record<string, any>> = [];
  const lines = String(content || '').split(/\r?\n/).filter(Boolean);
  const maxEntries = typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(Math.floor(limit), 0)
    : Number.POSITIVE_INFINITY;
  for (let index = lines.length - 1; index >= 0 && entries.length < maxEntries; index -= 1) {
    let parsed;
    try {
      parsed = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    const message = isRecord(parsed?.message) ? parsed.message : null;
    const usage = isRecord(message?.usage) ? message.usage : null;
    const timestamp = typeof parsed?.timestamp === 'string' ? parsed.timestamp : '';
    if (!message || !usage || message.role !== 'assistant' || !timestamp) {
      continue;
    }
    const inputTokens = toFiniteNumberOr(usage.input ?? usage.promptTokens, 0);
    const outputTokens = toFiniteNumberOr(usage.output ?? usage.completionTokens, 0);
    const cacheReadTokens = toFiniteNumberOr(usage.cacheRead, 0);
    const cacheWriteTokens = toFiniteNumberOr(usage.cacheWrite, 0);
    const totalTokens = toFiniteNumberOr(
      usage.total ?? usage.totalTokens,
      inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    );
    const costRecord = isRecord(usage.cost) ? usage.cost : null;
    const costTotal = costRecord ? toFiniteNumberOr(costRecord.total, NaN) : NaN;
    if (totalTokens <= 0 && !Number.isFinite(costTotal)) {
      continue;
    }
    entries.push({
      timestamp,
      sessionId: context.sessionId,
      agentId: context.agentId,
      ...(typeof message.model === 'string' ? { model: message.model } : {}),
      ...(typeof message.modelRef === 'string' && !message.model ? { model: message.modelRef } : {}),
      ...(typeof message.provider === 'string' ? { provider: message.provider } : {}),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      ...(Number.isFinite(costTotal) ? { costUsd: costTotal } : {}),
    });
  }
  return entries;
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
    return await this.getRecentTokenUsageHistory(limit);
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
    const created = await this.deps.openclawBridge.addCronJob({
      name: input.name,
      schedule: { kind: 'cron', expr: input.schedule },
      payload: { kind: 'agentTurn', message: input.message },
      enabled: input.enabled ?? true,
      wakeMode: 'next-heartbeat',
      sessionTarget: 'isolated',
      delivery: { mode: 'none' },
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

  private async listRecentSessionFiles() {
    const agentsDir = join(this.deps.getOpenClawConfigDir(), 'agents');
    let agentEntries;
    try {
      agentEntries = await readdir(agentsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: Array<Record<string, any>> = [];
    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory()) {
        continue;
      }
      const agentId = agentEntry.name;
      const sessionsDir = join(agentsDir, agentId, 'sessions');
      let sessionEntries;
      try {
        sessionEntries = await readdir(sessionsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sessionEntry of sessionEntries) {
        if (!sessionEntry.isFile()) {
          continue;
        }
        const fileName = sessionEntry.name;
        if (!fileName.endsWith('.jsonl') || fileName.includes('.deleted.')) {
          continue;
        }
        const filePath = join(sessionsDir, fileName);
        try {
          const fileStats = await stat(filePath);
          files.push({
            filePath,
            sessionId: fileName.replace(/\.jsonl$/, ''),
            agentId,
            mtimeMs: fileStats.mtimeMs,
          });
        } catch {
          // ignore file stat failure
        }
      }
    }
    files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return files;
  }

  private async getRecentTokenUsageHistory(limit?: number) {
    const maxEntries = typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(Math.floor(limit), 0)
      : Number.POSITIVE_INFINITY;
    if (maxEntries === 0) {
      return [];
    }
    const sessionFiles = await this.listRecentSessionFiles();
    const results: Array<Record<string, any>> = [];
    for (const file of sessionFiles) {
      try {
        const content = await readFile(file.filePath, 'utf8');
        const entries = parseUsageEntriesFromJsonl(content, {
          sessionId: file.sessionId,
          agentId: file.agentId,
        });
        results.push(...entries);
      } catch {
        // ignore malformed transcript file
      }
    }
    results.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
    return Number.isFinite(maxEntries) ? results.slice(0, maxEntries) : results;
  }
}
