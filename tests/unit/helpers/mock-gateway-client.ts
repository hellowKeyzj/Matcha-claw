import { vi } from 'vitest';
import * as hostApiModule from '@/lib/host-api';

type GatewayRpcEnvelope<TResult = unknown> = {
  success: boolean;
  result?: TResult;
  error?: string;
};

function isGatewayRpcEnvelope(value: unknown): value is GatewayRpcEnvelope {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { success?: unknown }).success === 'boolean',
  );
}

export const gatewayClientRequestMock = vi.fn();
export const gatewayClientRpcMock = vi.fn();
export const hostApiFetchMock = vi.fn();
export const hostSessionPromptMock = vi.fn();
export const hostSessionWindowFetchMock = vi.fn();
export const hostSessionDeleteMock = vi.fn();
export const hostSessionListMock = vi.fn();

vi.spyOn(hostApiModule.gatewayClient, 'request').mockImplementation(async <TResult = unknown>(
  method: string,
  params?: unknown,
  timeoutMs?: number,
) => {
  const response = await gatewayClientRequestMock(method, params, timeoutMs);
  if (isGatewayRpcEnvelope(response)) {
    return response as GatewayRpcEnvelope<TResult>;
  }
  return {
    success: true,
    result: response as TResult,
  };
});

vi.spyOn(hostApiModule.gatewayClient, 'rpc').mockImplementation(async <TResult = unknown>(
  method: string,
  params?: unknown,
  timeoutMs?: number,
) => {
  const response = await gatewayClientRpcMock(method, params, timeoutMs);
  if (isGatewayRpcEnvelope(response)) {
    if (!response.success) {
      throw new Error(response.error || `Gateway RPC failed: ${method}`);
    }
    return response.result as TResult;
  }
  return response as TResult;
});

vi.spyOn(hostApiModule, 'hostGatewayRequest').mockImplementation(async <TResult = unknown>(
  method: string,
  params?: unknown,
  timeoutMs?: number,
) => {
  const response = await gatewayClientRequestMock(method, params, timeoutMs);
  if (isGatewayRpcEnvelope(response)) {
    return response as GatewayRpcEnvelope<TResult>;
  }
  return {
    success: true,
    result: response as TResult,
  };
});

vi.spyOn(hostApiModule, 'hostGatewayRpc').mockImplementation(async <TResult = unknown>(
  method: string,
  params?: unknown,
  timeoutMs?: number,
) => {
  const response = await gatewayClientRpcMock(method, params, timeoutMs);
  if (isGatewayRpcEnvelope(response)) {
    if (!response.success) {
      throw new Error(response.error || `Gateway RPC failed: ${method}`);
    }
    return response.result as TResult;
  }
  return response as TResult;
});

vi.spyOn(hostApiModule, 'hostApiFetch').mockImplementation(async <TResult = unknown>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
) => {
  if (path === '/api/gateway/rpc') {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    let parsedBody: { method?: string; params?: unknown; timeoutMs?: number } = {};
    try {
      parsedBody = bodyText ? JSON.parse(bodyText) as { method?: string; params?: unknown; timeoutMs?: number } : {};
    } catch {
      parsedBody = {};
    }
    const method = typeof parsedBody.method === 'string' ? parsedBody.method : '';
    const params = parsedBody.params;
    const timeoutMs = parsedBody.timeoutMs;

    if (gatewayClientRequestMock.getMockImplementation()) {
      return await gatewayClientRequestMock(method, params, timeoutMs) as TResult;
    }

    const rpcResponse = await gatewayClientRpcMock(method, params, timeoutMs);
    if (isGatewayRpcEnvelope(rpcResponse)) {
      return rpcResponse as TResult;
    }
    return {
      success: true,
      result: rpcResponse,
    } as TResult;
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

export function resetGatewayClientMocks(): void {
  gatewayClientRequestMock.mockReset();
  gatewayClientRpcMock.mockReset();
  hostApiFetchMock.mockReset();
  hostSessionPromptMock.mockReset();
  hostSessionWindowFetchMock.mockReset();
  hostSessionDeleteMock.mockReset();
  hostSessionListMock.mockReset();
}
