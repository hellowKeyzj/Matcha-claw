import { join } from 'node:path';
import { badRequest, ok } from '../common/application-response';
import type { RuntimeClockPort, RuntimeFileSystemPort } from '../common/runtime-ports';
import type { OpenClawWorkspacePort } from '../openclaw/openclaw-workspace-service';
import { isRecord } from './cron-model';

function parseCronSessionKey(sessionKey: string) {
  if (typeof sessionKey !== 'string' || !sessionKey.trim()) {
    return null;
  }
  const parts = sessionKey.split(':');
  const cronIndex = parts[0] === 'agent' ? 2 : 1;
  if (parts.length < cronIndex + 2 || parts[cronIndex] !== 'cron') {
    return null;
  }
  const agentId = parts[0] === 'agent' ? parts[1] || 'main' : parts[0] || 'main';
  const jobId = parts[cronIndex + 1];
  if (!jobId) {
    return null;
  }
  if (parts.length === cronIndex + 2) {
    return { agentId, jobId };
  }
  if (parts.length === cronIndex + 4 && parts[cronIndex + 2] === 'run' && parts[cronIndex + 3]) {
    return { agentId, jobId, runSessionId: parts[cronIndex + 3] };
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

export interface CronRunHistoryRepositoryDeps {
  workspace: Pick<OpenClawWorkspacePort, 'getConfigDir'>;
  fileSystem: RuntimeFileSystemPort;
}

export interface CronRunHistoryPort {
  readJobRuns(jobId: string): Promise<Array<Record<string, any>>>;
}

export class CronRunHistoryRepository implements CronRunHistoryPort {
  constructor(private readonly deps: CronRunHistoryRepositoryDeps) {}

  async readJobRuns(jobId: string): Promise<Array<Record<string, any>>> {
    const logPath = join(this.deps.workspace.getConfigDir(), 'cron', 'runs', `${jobId}.jsonl`);
    const raw = await this.deps.fileSystem.readTextFile(logPath).catch(() => '');
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
}

export class CronSessionHistoryService {
  constructor(
    private readonly runHistory: CronRunHistoryPort,
    private readonly clock: RuntimeClockPort,
  ) {}

  async read(routeUrl: URL) {
    const sessionKey = routeUrl.searchParams.get('sessionKey')?.trim() || '';
    const parsedSession = parseCronSessionKey(sessionKey);
    if (!parsedSession) {
      return badRequest(`Invalid cron sessionKey: ${sessionKey}`);
    }
    const rawLimit = Number(routeUrl.searchParams.get('limit') || '200');
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 200) : 200;
    const runs = await this.runHistory.readJobRuns(parsedSession.jobId);
    return ok({
        messages: this.buildFallbackMessages({
          sessionKey,
          runs,
          limit,
        }),
      });
  }

  private buildFallbackMessages(params: {
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
        timestamp: this.clock.nowMs(),
      });
    }
    const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit))
      : messages.length;
    return messages.slice(-limit);
  }
}
