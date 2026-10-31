import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import type { CronTransport } from '../../main/runtime-host-delivery/transport/cron';
import { readRuntimeScopeQuery } from '../../main/runtime-host-delivery/transport/runtime-scope';

const INVALID = {
  success: false,
  error: 'Cron request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Cron service is unavailable',
} as const;

const INVALID_SESSION_KEY = (sessionKey: string) => ({
  success: false,
  error: `Invalid cron sessionKey: ${sessionKey}`,
});

type CronOperation = 'create' | 'update' | 'remove' | 'toggle' | 'result';

export async function handleCronRoutes(
  req: HostApiRequest,
  url: URL,
  transport: CronTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname === '/api/cron/session-history' && req.method === 'GET') {
    const sessionKey = url.searchParams.get('sessionKey')?.trim() || '';
    if (!isCronSessionKey(sessionKey)) {
      return jsonResult(400, INVALID_SESSION_KEY(sessionKey));
    }

    const rawLimit = Number(url.searchParams.get('limit') || '200');
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.floor(rawLimit), 1), 200)
      : 200;
    try {
      const response = await transport.history(sessionKey, limit, readRuntimeScopeQuery(url.searchParams));
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, UNAVAILABLE);
    }
  }

  if (url.pathname === '/api/cron/jobs' && req.method === 'GET') {
    try {
      const response = await transport.list(readRuntimeScopeQuery(url.searchParams));
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, UNAVAILABLE);
    }
  }

  const operation = resolveMutation(url.pathname, req.method);
  if (!operation) return undefined;

  let request: unknown;
  try {
    request = await req.readJson<unknown>();
  } catch {
    return jsonResult(400, INVALID);
  }

  try {
    const response = await transport[operation](request);
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}

function isCronSessionKey(value: string): boolean {
  if (!value || value.length > 4096 || value.includes('\0')) return false;
  const parts = value.split(':');
  const cronIndex = parts[0] === 'agent' ? 2 : 1;
  if (parts.length < cronIndex + 2 || parts[cronIndex] !== 'cron') return false;
  const agentId = parts[0] === 'agent' ? parts[1]?.trim() : parts[0]?.trim();
  const jobId = parts[cronIndex + 1];
  if (!agentId || !jobId) return false;
  return parts.length === cronIndex + 2
    || (parts.length === cronIndex + 4 && parts[cronIndex + 2] === 'run' && Boolean(parts[cronIndex + 3]));
}

function resolveMutation(pathname: string, method: string | undefined): CronOperation | undefined {
  if (method !== 'POST') return undefined;
  switch (pathname) {
    case '/api/cron/jobs/create': return 'create';
    case '/api/cron/jobs/update': return 'update';
    case '/api/cron/jobs/delete': return 'remove';
    case '/api/cron/jobs/toggle': return 'toggle';
    case '/api/cron/results': return 'result';
    default: return undefined;
  }
}
