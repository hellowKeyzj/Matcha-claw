import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { hasExactKeys, isRecord, isSafeNonNegativeInteger, sendLoopbackJson } from './client';
import { isProductRuntimeScope, type ProductRuntimeScope } from './runtime-scope';

const UNAVAILABLE = { success: false, error: 'OpenClaw usage history is unavailable' } as const;
const MATCHA_UNAVAILABLE = { success: false, error: 'Matcha usage history is unavailable' } as const;

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
  body: Readonly<{ entries: readonly UsageHistoryEntry[] }> | typeof UNAVAILABLE | typeof MATCHA_UNAVAILABLE;
}>;

export interface UsageTransport {
  read(limit?: number, scope?: unknown): Promise<UsageTransportResponse>;
  readSessionTimeseries(input: { sessionId: string; agentId: string; scope?: unknown }): Promise<UsageTransportResponse>;
}

export function createUsageTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): UsageTransport {
  return {
    async read(limit?: number, scope?: unknown): Promise<UsageTransportResponse> {
      if ((scope !== undefined && !isProductRuntimeScope(scope))
        || (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000))) {
        return { status: 400, body: UNAVAILABLE };
      }
      const query = new URLSearchParams();
      if (limit !== undefined) query.set('limit', String(limit));
      return readUsageTransport(fetcher, issuer, runtimeHostTransportPort, '/api/usage/recent', query, scope);
    },

    async readSessionTimeseries(input): Promise<UsageTransportResponse> {
      if ((input.scope !== undefined && !isProductRuntimeScope(input.scope))
        || !isSafeSessionId(input.sessionId) || !isSafeAgentId(input.agentId, input.scope?.endpoint.runtimeAdapterId)) {
        return { status: 400, body: UNAVAILABLE };
      }
      const query = new URLSearchParams({
        sessionId: input.sessionId,
        agentId: input.agentId,
      });
      return readUsageTransport(fetcher, issuer, runtimeHostTransportPort, '/api/usage/session-timeseries', query, input.scope);
    },
  };
}

async function readUsageTransport(
  fetcher: typeof fetch,
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  path: string,
  query: URLSearchParams,
  scope?: ProductRuntimeScope,
): Promise<UsageTransportResponse> {
  if (scope !== undefined) query.set('scope', JSON.stringify(scope));
  const runtimeAdapterId = scope?.endpoint.runtimeAdapterId ?? 'openclaw';
  const response = await sendLoopbackJson({
    port,
    path,
    issuer,
    decision: {
      endpoint: '/api/usage/recent',
      scope: `${runtimeAdapterId}:usage-history:read`,
      capability: `${runtimeAdapterId}.usage.history`,
      subject: `${runtimeAdapterId}-usage-history`,
    },
    method: 'GET',
    fetcher,
    query,
  });
  if (response?.status === 200 && isResponse(response.body, runtimeAdapterId)) return { status: 200, body: response.body };
  return { status: 503, body: runtimeAdapterId === 'matcha-agent' ? MATCHA_UNAVAILABLE : UNAVAILABLE };
}

function isResponse(value: unknown, runtimeAdapterId: string): value is Readonly<{ entries: readonly UsageHistoryEntry[] }> {
  return isRecord(value)
    && hasExactKeys(value, ['entries'])
    && Array.isArray(value.entries)
    && value.entries.every((entry) => isEntry(entry, runtimeAdapterId));
}

function isEntry(value: unknown, runtimeAdapterId: string): value is UsageHistoryEntry {
  if (!isRecord(value)) return false;
  const expected = ['sessionId', 'agentId', 'timestamp', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];
  const optional = ['model', 'provider', 'costUsd'];
  const keys = Object.keys(value);
  if (!expected.every((key) => Object.hasOwn(value, key)) || keys.some((key) => !expected.includes(key) && !optional.includes(key))) return false;
  return isSafeSessionId(value.sessionId)
    && isSafeAgentId(value.agentId, runtimeAdapterId)
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

function isSafeAgentId(value: unknown, runtimeAdapterId = 'openclaw'): value is string {
  return typeof value === 'string' && (runtimeAdapterId === 'matcha-agent'
    ? /^[A-Za-z0-9_-]+$/.test(value) : /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value));
}
