import { vi } from 'vitest';
import * as hostApiModule from '@/lib/host-api';
import type { RuntimeAddress } from '../../../runtime-host/application/agent-runtime/contracts/runtime-address';

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

function capabilityAddress(capabilityId: string): RuntimeAddress {
  return {
    kind: 'native-runtime',
    capabilityId,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
    agentId: 'default',
  };
}

function capabilityDescriptor(capabilityId: string): Record<string, unknown> {
  const address = capabilityAddress(capabilityId);
  return {
    id: capabilityId,
    kind: capabilityId,
    address,
    runtimeAdapterId: address.runtimeAdapterId,
    runtimeInstanceId: address.runtimeInstanceId,
    targetAgentIds: [address.agentId],
    supportLevel: 'native',
    availability: 'available',
    operations: [],
    policyScope: capabilityId,
  };
}

function isGatewayRpcEnvelope(value: unknown): value is GatewayRpcEnvelope {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { success?: unknown }).success === 'boolean',
  );
}

export const gatewayClientRpcMock = vi.fn();
export const hostApiFetchMock = vi.fn();
export const hostCapabilityExecuteMock = vi.fn();
export const hostSessionPromptMock = vi.fn();
export const hostSessionWindowFetchMock = vi.fn();
export const hostSessionDeleteMock = vi.fn();
export const hostSessionListMock = vi.fn();
export const hostSessionPatchMock = vi.fn();

const subagentRuntimeRoutes: Record<string, string> = {
  '/api/subagents/list': 'agents.list',
  '/api/subagents/config/get': 'config.get',
  '/api/subagents/files/get': 'agents.files.get',
  '/api/subagents/files/list': 'agents.files.list',
};

const subagentCapabilityOperations: Record<string, string> = {
  'subagents.config.set': 'config.set',
  'subagents.create': 'agents.create',
  'subagents.update': 'agents.update',
  'subagents.delete': 'agents.delete',
  'subagents.files.set': 'agents.files.set',
};

const settingsCapabilityRoutes: Record<string, string> = {
  'settings.patch': '/api/settings',
  'settings.reset': '/api/settings/reset',
  'settings.setValue': '/api/settings/:key',
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
  return {
    method,
    params: body,
    timeoutMs: init?.timeoutMs,
  };
}

function readCapabilityInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  const { runtimeAddress: _runtimeAddress, ...domainInput } = input as Record<string, unknown>;
  return domainInput;
}

function resolveSettingsCapabilityPath(operationId: string, input: unknown): string {
  if (operationId !== 'settings.setValue') {
    return settingsCapabilityRoutes[operationId] ?? '/api/settings';
  }
  const key = readCapabilityInput(input).key;
  return `/api/settings/${encodeURIComponent(typeof key === 'string' ? key : '')}`;
}

function buildSettingsCapabilityInit(operationId: string, input: unknown): RequestInit | undefined {
  if (operationId === 'settings.reset') {
    return { method: 'POST' };
  }
  if (operationId === 'settings.setValue') {
    return {
      method: 'PUT',
      body: JSON.stringify({ value: readCapabilityInput(input).value }),
    };
  }
  return {
    method: 'PUT',
    body: JSON.stringify(readCapabilityInput(input)),
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
  if (path === '/api/capabilities/list') {
    return {
      capabilities: [
        capabilityDescriptor('plugin.runtime'),
        capabilityDescriptor('skill.management'),
        capabilityDescriptor('subagent.management'),
      ],
    } as TResult;
  }
  return await hostApiFetchMock(path, init) as TResult;
});

vi.spyOn(hostApiModule, 'resolveSingleCapabilityRuntimeAddress').mockImplementation(async (
  capabilityId: string,
) => capabilityAddress(capabilityId));

vi.spyOn(hostApiModule, 'hostCapabilityExecute').mockImplementation(async <TResult = unknown>(
  payload: {
    id: string;
    operationId: string;
    runtimeAddress: RuntimeAddress;
    input?: unknown;
  },
  options?: { timeoutMs?: number },
) => {
  const subagentMethod = payload.id === 'subagent.management'
    ? subagentCapabilityOperations[payload.operationId]
    : undefined;
  if (subagentMethod) {
    return await invokeMockedGatewayRpc<TResult>(
      subagentMethod,
      readCapabilityInput(payload.input),
      options?.timeoutMs,
    );
  }
  if (payload.id === 'settings.runtime' && settingsCapabilityRoutes[payload.operationId]) {
    hostCapabilityExecuteMock(payload, options);
    return await hostApiFetchMock(
      resolveSettingsCapabilityPath(payload.operationId, payload.input),
      buildSettingsCapabilityInit(payload.operationId, payload.input),
    ) as TResult;
  }
  return await hostCapabilityExecuteMock(payload, options) as TResult;
});

vi.spyOn(hostApiModule, 'hostSessionPrompt').mockImplementation(async (
  payload: {
    sessionKey: string;
    message: string;
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
  payload: { sessionKey: string; runtimeAddress: RuntimeAddress },
) => await hostSessionDeleteMock(payload));

vi.spyOn(hostApiModule, 'hostSessionList').mockImplementation(async (
  payload: { runtimeAddress: RuntimeAddress },
) => await hostSessionListMock(payload));

vi.spyOn(hostApiModule, 'hostSessionPatch').mockImplementation(async (
  payload: {
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
    runtimeModelRef: string;
  },
) => await hostSessionPatchMock(payload));

export function resetGatewayClientMocks(): void {
  gatewayClientRpcMock.mockReset();
  hostApiFetchMock.mockReset();
  hostCapabilityExecuteMock.mockReset();
  hostSessionPromptMock.mockReset();
  hostSessionWindowFetchMock.mockReset();
  hostSessionDeleteMock.mockReset();
  hostSessionListMock.mockReset();
  hostSessionPatchMock.mockReset();
}
