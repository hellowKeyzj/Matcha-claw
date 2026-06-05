import { describe, expect, it, vi } from 'vitest';
import { capabilityRoutes } from '../../runtime-host/api/routes/capability-routes';
import type { RuntimeAddress } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor } from '../../runtime-host/application/capabilities/contracts/capability-descriptor';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

const claudeCodeAddress: RuntimeAddress = {
  kind: 'protocol-connector',
  capabilityId: 'session.prompt',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointId: 'claude-code',
  agentId: 'default',
};

const hermesAddress: RuntimeAddress = {
  ...claudeCodeAddress,
  endpointId: 'hermes',
};

function createService(overrides: Record<string, unknown> = {}) {
  const capability = descriptor(claudeCodeAddress);
  return {
    listCapabilities: () => [capability],
    describeCapability: () => capability,
    executeCapability: async () => ({ status: 200, data: { success: true } }),
    ...overrides,
  };
}

function descriptor(address: RuntimeAddress): CapabilityDescriptor {
  return {
    id: address.capabilityId,
    kind: 'session',
    address,
    ...(address.kind === 'native-runtime'
      ? {
        runtimeAdapterId: address.runtimeAdapterId,
        runtimeInstanceId: address.runtimeInstanceId,
      }
      : {
        protocolId: address.protocolId,
        connectorId: address.connectorId,
        endpointId: address.endpointId,
      }),
    targetAgentIds: [address.agentId],
    supportLevel: 'native',
    availability: 'available',
    operations: [
      { id: 'sessions.create', title: 'Create session' },
      { id: 'sessions.load', title: 'Load session' },
      { id: 'sessions.prompt', title: 'Prompt session' },
      { id: 'sessions.abort', title: 'Abort session' },
    ],
    policyScope: address.capabilityId,
  };
}

describe('capability routes', () => {
  it('lists registered runtime capabilities', async () => {
    const capability = descriptor(claudeCodeAddress);
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'GET', '/api/capabilities/list', undefined, createService({
      listCapabilities: () => [capability],
      describeCapability: () => capability,
    }));

    expect(response).toEqual({
      status: 200,
      data: { capabilities: [capability] },
    });
  });

  it('describes a capability by exact RuntimeAddress', async () => {
    const capability = descriptor(claudeCodeAddress);
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'POST', '/api/capabilities/describe', {
      id: 'session.prompt',
      runtimeAddress: claudeCodeAddress,
    }, createService({
      listCapabilities: () => [capability],
      describeCapability: (input: { id: string; address: RuntimeAddress }) => {
        expect(input.id).toBe('session.prompt');
        expect(input.address).toEqual(claudeCodeAddress);
        return capability;
      },
    }));

    expect(response).toEqual({
      status: 200,
      data: { capability },
    });
  });

  it('rejects describe without a RuntimeAddress', async () => {
    const capability = descriptor(claudeCodeAddress);
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'POST', '/api/capabilities/describe', {
      id: 'session.prompt',
    }, createService({
      listCapabilities: () => [capability],
      describeCapability: () => capability,
    }));

    expect(response).toEqual({
      status: 400,
      data: { success: false, error: 'RuntimeAddress is required' },
    });
  });

  it('rejects describe when id does not match RuntimeAddress capability', async () => {
    const capability = descriptor(claudeCodeAddress);
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'POST', '/api/capabilities/describe', {
      id: 'tool.invoke',
      runtimeAddress: claudeCodeAddress,
    }, createService({
      listCapabilities: () => [capability],
      describeCapability: () => capability,
    }));

    expect(response).toEqual({
      status: 400,
      data: { success: false, error: 'Capability id does not match RuntimeAddress capabilityId' },
    });
  });

  it('passes execute request to capability service with the exact RuntimeAddress', async () => {
    const executeCapability = vi.fn(async () => ({ status: 200, data: { success: true } }));
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'POST', '/api/capabilities/execute', {
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      runtimeAddress: claudeCodeAddress,
      input: {
        sessionKey: 'claude-code:session:1',
        message: 'hello',
        runtimeAddress: claudeCodeAddress,
      },
    }, createService({ executeCapability }));

    expect(response).toEqual({
      status: 200,
      data: { success: true },
    });
    expect(executeCapability).toHaveBeenCalledWith({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      address: claudeCodeAddress,
      input: {
        sessionKey: 'claude-code:session:1',
        message: 'hello',
        runtimeAddress: claudeCodeAddress,
      },
    });
  });

  it('passes mismatched input RuntimeAddress through to the capability service', async () => {
    const executeCapability = vi.fn(async () => ({ status: 400, data: { success: false, error: 'Capability input RuntimeAddress does not match request RuntimeAddress' } }));
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'POST', '/api/capabilities/execute', {
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      runtimeAddress: claudeCodeAddress,
      input: {
        sessionKey: 'claude-code:session:1',
        runtimeAddress: hermesAddress,
      },
    }, createService({ executeCapability }));

    expect(response).toEqual({
      status: 400,
      data: { success: false, error: 'Capability input RuntimeAddress does not match request RuntimeAddress' },
    });
    expect(executeCapability).toHaveBeenCalledWith({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      address: claudeCodeAddress,
      input: {
        sessionKey: 'claude-code:session:1',
        runtimeAddress: hermesAddress,
      },
    });
  });

  it('rejects execute without an operationId before reaching the service', async () => {
    const executeCapability = vi.fn(async () => ({ status: 200, data: { success: true } }));
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'POST', '/api/capabilities/execute', {
      id: 'session.prompt',
      runtimeAddress: claudeCodeAddress,
      input: { sessionKey: 'claude-code:session:1', message: 'hello' },
    }, createService({ executeCapability }));

    expect(response).toEqual({
      status: 400,
      data: { success: false, error: 'Capability operationId is required' },
    });
    expect(executeCapability).not.toHaveBeenCalled();
  });

  it('rejects execute without a RuntimeAddress', async () => {
    const capability = descriptor(claudeCodeAddress);
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'POST', '/api/capabilities/execute', {
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      input: { sessionKey: 'claude-code:session:1', message: 'hello' },
    }, createService({
      listCapabilities: () => [capability],
      describeCapability: () => capability,
    }));

    expect(response).toEqual({
      status: 400,
      data: { success: false, error: 'RuntimeAddress is required' },
    });
  });

  it('keeps connector endpoints isolated by full RuntimeAddress', async () => {
    const claudeCodeCapability = descriptor(claudeCodeAddress);
    const hermesCapability = descriptor(hermesAddress);
    const response = await dispatchRuntimeRouteDefinition(capabilityRoutes, 'POST', '/api/capabilities/describe', {
      id: 'session.prompt',
      runtimeAddress: hermesAddress,
    }, createService({
      listCapabilities: () => [claudeCodeCapability, hermesCapability],
      describeCapability: (input: { id: string; address: RuntimeAddress }) => {
        expect(input.address).toEqual(hermesAddress);
        return input.address.kind === 'protocol-connector' && input.address.endpointId === 'hermes' ? hermesCapability : claudeCodeCapability;
      },
    }));

    expect(response).toEqual({
      status: 200,
      data: { capability: hermesCapability },
    });
  });
});
