import { vi } from 'vitest';
import * as hostApiModule from '@/lib/host-api';
import type { RuntimeEndpointRef, RuntimeScope, SessionIdentity } from '../../../runtime-host/application/agent-runtime/contracts/runtime-address';

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

const runtimeEndpoint: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};

function capabilityScope(capabilityId: string): RuntimeScope {
  return capabilityId === 'subagent.management'
    ? { kind: 'agent', endpoint: runtimeEndpoint, agentId: 'default' }
    : { kind: 'runtime-instance', endpoint: runtimeEndpoint };
}

function capabilityDescriptor(capabilityId: string): Record<string, unknown> {
  const scope = capabilityScope(capabilityId);
  return {
    id: capabilityId,
    kind: capabilityId,
    scopeKind: scope.kind,
    scope,
    targetKinds: ['none'],
    runtimeAdapterId: runtimeEndpoint.runtimeAdapterId,
    runtimeInstanceId: runtimeEndpoint.runtimeInstanceId,
    targetAgentIds: ['default'],
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
export const capabilityExecuteMock = vi.fn();
export const hostSessionPromptMock = vi.fn();
export const hostSessionWindowFetchMock = vi.fn();
export const hostSessionDeleteMock = vi.fn();
export const hostSessionListMock = vi.fn();
export const hostSessionPatchMock = vi.fn();
export const hostRuntimeEndpointsListMock = vi.fn();

const subagentCapabilityOperations: Record<string, string> = {
  'subagents.list': 'agents.list',
  'subagents.config.get': 'config.get',
  'subagents.config.set': 'config.set',
  'subagents.create': 'agents.create',
  'subagents.update': 'agents.update',
  'subagents.delete': 'agents.delete',
  'subagents.files.get': 'agents.files.get',
  'subagents.files.set': 'agents.files.set',
  'subagents.files.list': 'agents.files.list',
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

function readCapabilityInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
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
  if (path === '/api/capabilities/list') {
    return {
      capabilities: [
        capabilityDescriptor('plugin.runtime'),
        capabilityDescriptor('skill.management'),
        capabilityDescriptor('subagent.management'),
      ],
    } as TResult;
  }
  if (path === '/api/capabilities/execute') {
    const payload = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    return await mockedCapabilityExecute<TResult>(payload, { timeoutMs: init?.timeoutMs });
  }
  return await hostApiFetchMock(path, init) as TResult;
});

vi.spyOn(hostApiModule, 'resolveSingleCapabilityScope').mockImplementation(async (
  capabilityId: string,
) => capabilityScope(capabilityId));

vi.spyOn(hostApiModule, 'hostRuntimeEndpointsList').mockImplementation(async () => {
  const response = await hostRuntimeEndpointsListMock();
  if (response) {
    return response;
  }
  return {
    endpoints: [{
      id: 'openclaw-local',
      protocolId: 'openclaw-v4',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
      displayName: 'OpenClaw Local',
      agentIds: ['default'],
      acceptsDynamicAgents: true,
      capabilities: {
        chat: true,
        streaming: true,
        tools: true,
        approvals: true,
        replay: true,
        modelSelection: true,
      },
      capabilitySummaries: [capabilityDescriptor('session.prompt')],
      controlState: {
        connection: null,
        readiness: null,
        capabilities: null,
        updatedAt: null,
      },
    }],
  };
});

async function mockedCapabilityExecute<TResult = unknown>(
  payload: {
    id: string;
    operationId: string;
    scope: RuntimeScope;
    target?: unknown;
    input?: unknown;
  },
  options?: { timeoutMs?: number },
): Promise<TResult> {
  const subagentMethod = payload.id === 'subagent.management'
    ? subagentCapabilityOperations[payload.operationId]
    : undefined;
  if (subagentMethod) {
    capabilityExecuteMock(payload, options);
    return await invokeMockedGatewayRpc<TResult>(
      subagentMethod,
      readCapabilityInput(payload.input),
      options?.timeoutMs,
    );
  }
  if (payload.id === 'settings.runtime' && settingsCapabilityRoutes[payload.operationId]) {
    capabilityExecuteMock(payload, options);
    return await hostApiFetchMock(
      resolveSettingsCapabilityPath(payload.operationId, payload.input),
      buildSettingsCapabilityInit(payload.operationId, payload.input),
    ) as TResult;
  }
  return await capabilityExecuteMock(payload, options) as TResult;
}

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
  payload: { sessionKey: string; sessionIdentity: SessionIdentity },
) => await hostSessionDeleteMock(payload));

vi.spyOn(hostApiModule, 'hostSessionList').mockImplementation(async (
  payload: { endpoint: RuntimeEndpointRef },
) => await hostSessionListMock(payload));

vi.spyOn(hostApiModule, 'hostSessionPatch').mockImplementation(async (
  payload: {
    sessionKey: string;
    sessionIdentity: SessionIdentity;
    runtimeModelRef: string;
  },
) => await hostSessionPatchMock(payload));

export function resetGatewayClientMocks(): void {
  gatewayClientRpcMock.mockReset();
  hostApiFetchMock.mockReset();
  capabilityExecuteMock.mockReset();
  hostSessionPromptMock.mockReset();
  hostSessionWindowFetchMock.mockReset();
  hostSessionDeleteMock.mockReset();
  hostSessionListMock.mockReset();
  hostSessionPatchMock.mockReset();
  hostRuntimeEndpointsListMock.mockReset();
}
