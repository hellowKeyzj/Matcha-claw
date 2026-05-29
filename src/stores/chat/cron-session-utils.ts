export interface CronSessionKeyParts {
  agentId: string;
  jobId: string;
  runSessionId?: string;
}

export function parseCronSessionKey(sessionKey: string): CronSessionKeyParts | null {
  if (!sessionKey.trim()) return null;
  const parts = sessionKey.split(':');
  const cronIndex = parts[0] === 'agent' ? 2 : 1;
  if (parts.length < cronIndex + 2 || parts[cronIndex] !== 'cron') return null;

  const agentId = parts[0] === 'agent' ? parts[1] || 'main' : parts[0] || 'main';
  const jobId = parts[cronIndex + 1];
  if (!jobId) return null;

  if (parts.length === cronIndex + 2) {
    return { agentId, jobId };
  }

  if (parts.length === cronIndex + 4 && parts[cronIndex + 2] === 'run' && parts[cronIndex + 3]) {
    return { agentId, jobId, runSessionId: parts[cronIndex + 3] };
  }

  return null;
}

export function isCronSessionKey(sessionKey: string): boolean {
  return parseCronSessionKey(sessionKey) != null;
}

export function buildCronSessionHistoryPath(sessionKey: string, limit = 200): string {
  const params = new URLSearchParams({ sessionKey });
  if (Number.isFinite(limit) && limit > 0) {
    params.set('limit', String(Math.floor(limit)));
  }
  return `/api/cron/session-history?${params.toString()}`;
}
