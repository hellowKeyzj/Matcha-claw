import { vi } from 'vitest';
import * as hostApiModule from '@/lib/host-api';

type GatewayRpcEnvelope<TResult = unknown> = {
  success: boolean;
  result?: TResult;
  error?: string;
};

type RpcCall = {
  method: string;
  params: unknown;
  timeoutMs?: number;
};

function isGatewayRpcEnvelope(value: unknown): value is GatewayRpcEnvelope {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { success?: unknown }).success === 'boolean',
  );
}

export const gatewayClientRpcMock = vi.fn();
export const hostApiFetchMock = vi.fn();
export const hostSessionPromptMock = vi.fn();
export const hostSessionWindowFetchMock = vi.fn();
export const hostSessionDeleteMock = vi.fn();
export const hostSessionListMock = vi.fn();
export const hostSessionPatchMock = vi.fn();

const subagentRuntimeRoutes: Record<string, string> = {
  '/api/subagents/list': 'agents.list',
  '/api/subagents/config/get': 'config.get',
  '/api/subagents/config/set': 'config.set',
  '/api/subagents/create': 'agents.create',
  '/api/subagents/update': 'agents.update',
  '/api/subagents/delete': 'agents.delete',
  '/api/subagents/files/get': 'agents.files.get',
  '/api/subagents/files/set': 'agents.files.set',
  '/api/subagents/files/list': 'agents.files.list',
  '/api/subagents/agent-wait': 'agent.wait',
};

function parseJsonBody(init?: RequestInit & { timeoutMs?: number }): unknown {
  if (typeof init?.body !== 'string' || !init.body) {
    return {};
  }
  try {
    return JSON.parse(init.body) as unknown;
  } catch {
    return {};
  }
}

function buildSubagentRpcCall(path: string, init?: RequestInit & { timeoutMs?: number }): RpcCall | undefined {
  const method = subagentRuntimeRoutes[path];
  if (!method) {
    return undefined;
  }
  const body = parseJsonBody(init);
  if (method === 'agent.wait') {
    const payload = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const timeoutMs = typeof payload.timeoutMs === 'number'
      ? Math.max(1000, Math.floor(payload.timeoutMs)) + 10000
      : init?.timeoutMs;
    return {
      method,
      params: body,
      timeoutMs,
    };
  }
  return {
    method,
    params: body,
    timeoutMs: init?.timeoutMs,
  };
}

async function invokeMockedGatewayRpc<TResult>(
  method: string,
  params: unknown,
  timeoutMs?: number,
): Promise<TResult> {
  const response = await gatewayClientRpcMock(method, params, timeoutMs);
  if (isGatewayRpcEnvelope(response)) {
    if (!response.success) {
      throw new Error(response.error || `Gateway RPC failed: ${method}`);
    }
    return response.result as TResult;
  }
  return response as TResult;
}

vi.spyOn(hostApiModule, 'hostApiFetch').mockImplementation(async <TResult = unknown>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
) => {
  const subagentRpcCall = buildSubagentRpcCall(path, init);
  if (subagentRpcCall) {
    return await invokeMockedGatewayRpc<TResult>(
      subagentRpcCall.method,
      subagentRpcCall.params,
      subagentRpcCall.timeoutMs,
    );
  }
  return await hostApiFetchMock(path, init) as TResult;
});

vi.spyOn(hostApiModule, 'hostSessionPrompt').mockImplementation(async (
  payload: {
    sessionKey: string;
    message: string;
    promptId?: string;
    idempotencyKey?: string;
    deliver?: boolean;
    media?: Array<{
      filePath: string;
      mimeType?: string;
      fileName?: string;
    }>;
  },
) => await hostSessionPromptMock(payload));

vi.spyOn(hostApiModule, 'hostSessionWindowFetch').mockImplementation(async (
  payload: {
    sessionKey: string;
    mode?: 'latest' | 'older' | 'newer';
    limit?: number;
    offset?: number;
    includeCanonical?: boolean;
  },
) => await hostSessionWindowFetchMock(payload));

vi.spyOn(hostApiModule, 'hostSessionDelete').mockImplementation(async (
  payload: { sessionKey: string },
) => await hostSessionDeleteMock(payload));

vi.spyOn(hostApiModule, 'hostSessionList').mockImplementation(async () => await hostSessionListMock());

vi.spyOn(hostApiModule, 'hostSessionPatch').mockImplementation(async (
  payload: {
    sessionKey: string;
    model: string;
  },
) => await hostSessionPatchMock(payload));

export function resetGatewayClientMocks(): void {
  gatewayClientRpcMock.mockReset();
  hostApiFetchMock.mockReset();
  hostSessionPromptMock.mockReset();
  hostSessionWindowFetchMock.mockReset();
  hostSessionDeleteMock.mockReset();
  hostSessionListMock.mockReset();
  hostSessionPatchMock.mockReset();
}
