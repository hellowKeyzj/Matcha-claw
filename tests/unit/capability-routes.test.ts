import { describe, expect, it, vi } from 'vitest';
import { capabilityRoutes } from '../../runtime-host/api/routes/capability-routes';
import type {
  CapabilityTarget,
  RuntimeEndpointRef,
  RuntimeScope,
  SessionIdentity,
} from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor, CapabilityOperationDescriptor } from '../../runtime-host/application/capabilities/contracts/capability-descriptor';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

const claudeCodeEndpoint: RuntimeEndpointRef = {
  kind: 'protocol-connector',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointId: 'claude-code',
};

const hermesEndpoint: RuntimeEndpointRef = {
  ...claudeCodeEndpoint,
  endpointId: 'hermes',
};

const sessionIdentity: SessionIdentity = {
  endpoint: claudeCodeEndpoint,
  agentId: 'default',
  sessionKey: 'claude-code:session:1',
};

const claudeCodeScope: RuntimeScope = {
  kind: 'session',
  identity: sessionIdentity,
};

const hermesScope: RuntimeScope = {
  kind: 'session',
  identity: {
    ...sessionIdentity,
    endpoint: hermesEndpoint,
  },
};

const sessionTarget: CapabilityTarget = {
  kind: 'session',
  identity: sessionIdentity,
};

function createService(overrides: Record<string, unknown> = {}) {
  const capability = descriptor(claudeCodeScope);
  return {
    listCapabilities: () => [capability],
    describeCapability: () => capability,
    executeCapability: async () => ({ status: 200, data: { success: true } }),
    ...overrides,
  };
}

function descriptor(scope: RuntimeScope): CapabilityDescriptor {
  const operations: CapabilityOperationDescriptor[] = [
    { id: 'sessions.create', title: 'Create session', targetKind: 'agent' },
    { id: 'sessions.load', title: 'Load session', targetKind: 'session' },
    { id: 'sessions.prompt', title: 'Prompt session', targetKind: 'session' },
    { id: 'sessions.abort', title: 'Abort session', targetKind: 'session' },
  ];
  return {
    id: 'session.prompt',
    kind: 'session',
    scopeKind: scope.kind,
    scope,
    targetKinds: ['agent', 'session'],
    protocolId: scope.kind === 'session' ? scope.identity.endpoint.kind === 'protocol-connector' ? scope.identity.endpoint.protocolId : undefined : undefined,
    connectorId: scope.kind === 'session' ? scope.identity.endpoint.kind === 'protocol-connector' ? scope.identity.endpoint.connectorId : undefined : undefined,
    endpointId: scope.kind === 'session' ? scope.identity.endpoint.kind === 'protocol-connector' ? scope.identity.endpoint.endpointId : undefined : undefined,
    targetAgentIds: ['default'],
    supportLevel: 'native',
    availability: 'available',
    operations,
    policyScope: 'session.prompt',
    ownerModuleId: 'acp',
    routeOwnerId: 'sessions',
  };
}

describe('capability routes', () => {
  it('lists registered runtime capabilities', async () => {
    const capability = descriptor(claudeCodeScope);
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'GET', '/api/capabilities/list', undefined, createService({
      listCapabilities: () => [capability],
      describeCapability: () => capability,
    }));

    expect(response).toEqual({
      status: 200,
      data: { capabilities: [capability] },
    });
  });

  it('describes a capability by exact scope', async () => {
    const capability = descriptor(claudeCodeScope);
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'POST', '/api/capabilities/describe', {
      id: 'session.prompt',
      scope: claudeCodeScope,
    }, createService({
      listCapabilities: () => [capability],
      describeCapability: (input: { id: string; scope: RuntimeScope }) => {
        expect(input.id).toBe('session.prompt');
        expect(input.scope).toEqual(claudeCodeScope);
        return capability;
      },
    }));

    expect(response).toEqual({
      status: 200,
      data: { capability },
    });
  });

  it('rejects describe without a scope', async () => {
    const capability = descriptor(claudeCodeScope);
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'POST', '/api/capabilities/describe', {
      id: 'session.prompt',
    }, createService({
      listCapabilities: () => [capability],
      describeCapability: () => capability,
    }));

    expect(response).toEqual({
      status: 400,
      data: { success: false, error: 'RuntimeScope must be an object' },
    });
  });

  it('passes execute request to capability service with scope and target', async () => {
    const executeCapability = vi.fn(async () => ({ status: 200, data: { success: true } }));
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'POST', '/api/capabilities/execute', {
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      scope: claudeCodeScope,
      target: sessionTarget,
      input: {
        sessionKey: sessionIdentity.sessionKey,
        message: 'hello',
      },
    }, createService({ executeCapability }));

    expect(response).toEqual({
      status: 200,
      data: { success: true },
    });
    expect(executeCapability).toHaveBeenCalledWith({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      scope: claudeCodeScope,
      target: sessionTarget,
      input: {
        sessionKey: sessionIdentity.sessionKey,
        message: 'hello',
      },
    });
  });

  it('keeps deprecated input.runtimeAddress only as a rejection assertion', async () => {
    const executeCapability = vi.fn(async () => ({ status: 400, data: { success: false, error: 'Capability input runtimeAddress is not allowed' } }));
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'POST', '/api/capabilities/execute', {
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      scope: claudeCodeScope,
      target: sessionTarget,
      input: {
        sessionKey: sessionIdentity.sessionKey,
        runtimeAddress: {},
      },
    }, createService({ executeCapability }));

    expect(response).toEqual({
      status: 400,
      data: { success: false, error: 'Capability input runtimeAddress is not allowed' },
    });
    expect(executeCapability).toHaveBeenCalledWith({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      scope: claudeCodeScope,
      target: sessionTarget,
      input: {
        sessionKey: sessionIdentity.sessionKey,
        runtimeAddress: {},
      },
    });
  });

  it('rejects execute without an operationId before reaching the service', async () => {
    const executeCapability = vi.fn(async () => ({ status: 200, data: { success: true } }));
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'POST', '/api/capabilities/execute', {
      id: 'session.prompt',
      scope: claudeCodeScope,
      target: sessionTarget,
      input: { sessionKey: sessionIdentity.sessionKey, message: 'hello' },
    }, createService({ executeCapability }));

    expect(response).toEqual({
      status: 400,
      data: { success: false, error: 'Capability operationId is required' },
    });
    expect(executeCapability).not.toHaveBeenCalled();
  });

  it('rejects execute without a scope', async () => {
    const capability = descriptor(claudeCodeScope);
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'POST', '/api/capabilities/execute', {
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      input: { sessionKey: sessionIdentity.sessionKey, message: 'hello' },
    }, createService({
      listCapabilities: () => [capability],
      describeCapability: () => capability,
    }));

    expect(response).toEqual({
      status: 400,
      data: { success: false, error: 'RuntimeScope must be an object' },
    });
  });

  it('keeps connector endpoints isolated by full scope', async () => {
    const claudeCodeCapability = descriptor(claudeCodeScope);
    const hermesCapability = descriptor(hermesScope);
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'POST', '/api/capabilities/describe', {
      id: 'session.prompt',
      scope: hermesScope,
    }, createService({
      listCapabilities: () => [claudeCodeCapability, hermesCapability],
      describeCapability: (input: { id: string; scope: RuntimeScope }) => {
        expect(input.scope).toEqual(hermesScope);
        return input.scope.kind === 'session' && input.scope.identity.endpoint.kind === 'protocol-connector' && input.scope.identity.endpoint.endpointId === 'hermes'
          ? hermesCapability
          : claudeCodeCapability;
      },
    }));

    expect(response).toEqual({
      status: 200,
      data: { capability: hermesCapability },
    });
  });
});
