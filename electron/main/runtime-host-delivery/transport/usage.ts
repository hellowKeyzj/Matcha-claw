import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { hasExactKeys, isRecord, isSafeNonNegativeInteger, sendLoopbackJson } from './client';

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
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): UsageTransport {
  return {
    async read(limit?: number): Promise<UsageTransportResponse> {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000)) {
        return { status: 400, body: UNAVAILABLE };
      }
      const query = new URLSearchParams();
      if (limit !== undefined) query.set('limit', String(limit));
      return readUsageTransport(fetcher, issuer, runtimeHostTransportPort, '/api/usage/recent', query);
    },

    async readSessionTimeseries(input): Promise<UsageTransportResponse> {
      if (!isSafeSessionId(input.sessionId) || !isSafeAgentId(input.agentId)) {
        return { status: 400, body: UNAVAILABLE };
      }
      const query = new URLSearchParams({
        sessionId: input.sessionId,
        agentId: input.agentId,
      });
      return readUsageTransport(fetcher, issuer, runtimeHostTransportPort, '/api/usage/session-timeseries', query);
    },
  };
}

async function readUsageTransport(
  fetcher: typeof fetch,
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  path: string,
  query: URLSearchParams,
): Promise<UsageTransportResponse> {
  const response = await sendLoopbackJson({
    port,
    path,
    issuer,
    decision: {
      endpoint: '/api/usage/recent',
      scope: 'openclaw:usage-history:read',
      capability: 'openclaw.usage.history',
      subject: 'openclaw-usage-history',
    },
    method: 'GET',
    fetcher,
    query,
  });
  if (response?.status === 200 && isResponse(response.body)) return { status: 200, body: response.body };
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
    && ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'].every((key) => isSafeNonNegativeInteger(value[key]))
    && (value.model === undefined || typeof value.model === 'string')
    && (value.provider === undefined || typeof value.provider === 'string')
    && (value.costUsd === undefined || (typeof value.costUsd === 'number' && Number.isFinite(value.costUsd) && value.costUsd >= 0));
}

function isSafeSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
    && !/^.+\.checkpoint\.[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(value);
}

function isSafeAgentId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}
