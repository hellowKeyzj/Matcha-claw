import type { RuntimeHostDeliveryIssuer } from '../bootstrap';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = { success: false, error: 'OpenClaw usage history is unavailable' } as const;

export type UsageHistoryEntry = Readonly<{
  sessionId: string;
  agentId: string;
  timestamp: string;
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
}>;

export type UsageTransportResponse = Readonly<{
  status: 200 | 400 | 503;
  body: Readonly<{ entries: readonly UsageHistoryEntry[] }> | typeof UNAVAILABLE;
}>;

export interface UsageTransport {
  read(limit?: number): Promise<UsageTransportResponse>;
  readSessionTimeseries(input: { sessionId: string; agentId: string }): Promise<UsageTransportResponse>;
}

export function createUsageTransport(
  issuer: RuntimeHostDeliveryIssuer,
  usageTransportPort: number,
  fetcher: typeof fetch = fetch,
): UsageTransport {
  const baseUrl = `http://127.0.0.1:${usageTransportPort}`;
  return {
    async read(limit?: number): Promise<UsageTransportResponse> {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000)) {
        return { status: 400, body: UNAVAILABLE };
      }
      const query = limit === undefined ? '' : `?limit=${String(limit)}`;
      return readUsageTransport(fetcher, issuer, `${baseUrl}/api/usage/recent${query}`);
    },

    async readSessionTimeseries(input): Promise<UsageTransportResponse> {
      if (!isSafeSessionId(input.sessionId) || !isSafeAgentId(input.agentId)) {
        return { status: 400, body: UNAVAILABLE };
      }
      const query = new URLSearchParams({
        sessionId: input.sessionId,
        agentId: input.agentId,
      });
      return readUsageTransport(fetcher, issuer, `${baseUrl}/api/usage/session-timeseries?${query.toString()}`);
    },
  };
}

async function readUsageTransport(
  fetcher: typeof fetch,
  issuer: RuntimeHostDeliveryIssuer,
  url: string,
): Promise<UsageTransportResponse> {
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${issuer.signDecision({
          principal: 'electron-main-local',
          endpoint: '/api/usage/recent',
          scope: 'openclaw:usage-history:read',
          capability: 'openclaw.usage.history',
          subject: 'openclaw-usage-history',
          expiresAt: Date.now() + DECISION_TTL_MS,
          revision: '1',
        })}`,
      },
    });
    const body: unknown = await response.json();
    if (response.status === 200 && isResponse(body)) return { status: 200, body };
  } catch {
    // The public contract deliberately suppresses transport details.
  }
  return { status: 503, body: UNAVAILABLE };
}

function isResponse(value: unknown): value is Readonly<{ entries: readonly UsageHistoryEntry[] }> {
  return isRecord(value)
    && hasExactKeys(value, ['entries'])
    && Array.isArray(value.entries)
    && value.entries.every(isEntry);
}

function isEntry(value: unknown): value is UsageHistoryEntry {
  if (!isRecord(value)) return false;
  const expected = ['sessionId', 'agentId', 'timestamp', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];
  const optional = ['model', 'provider', 'costUsd'];
  const keys = Object.keys(value);
  if (!expected.every((key) => Object.hasOwn(value, key)) || keys.some((key) => !expected.includes(key) && !optional.includes(key))) return false;
  return isSafeSessionId(value.sessionId)
    && isSafeAgentId(value.agentId)
    && typeof value.timestamp === 'string'
    && Number.isFinite(Date.parse(value.timestamp))
    && ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'].every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
    && (value.model === undefined || typeof value.model === 'string')
    && (value.provider === undefined || typeof value.provider === 'string')
    && (value.costUsd === undefined || (typeof value.costUsd === 'number' && Number.isFinite(value.costUsd) && value.costUsd >= 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
    && !/^.+\.checkpoint\.[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(value);
}

function isSafeAgentId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
