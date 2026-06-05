import { describe, expect, it } from 'vitest';
import { runtimeTopologyRoutes } from '../../runtime-host/api/routes/runtime-topology-routes';
import type { RuntimeTopologySnapshot } from '../../runtime-host/shared/runtime-topology';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

const topology: RuntimeTopologySnapshot = {
  protocols: [{ protocolId: 'acp' }],
  adapters: [{ runtimeAdapterId: 'openclaw', protocolId: 'openclaw-v4', endpointIds: ['openclaw-local'] }],
  connectors: [{ protocolId: 'acp', connectorId: 'acp', endpointIds: ['claude-code', 'hermes'] }],
  adapterInstances: [{ runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local', endpointId: 'openclaw-local', agentIds: ['default'] }],
  endpoints: [
    {
      id: 'claude-code',
      protocolId: 'acp',
      connectorId: 'acp',
      displayName: 'Claude Code',
      agentIds: ['default'],
      acceptsDynamicAgents: false,
      capabilities: {
        chat: true,
        streaming: true,
        tools: true,
        approvals: false,
        replay: true,
        modelSelection: false,
      },
      capabilityAddresses: [{
        kind: 'protocol-connector',
        capabilityId: 'session.prompt',
        protocolId: 'acp',
        connectorId: 'acp',
        endpointId: 'claude-code',
        agentId: 'default',
      }],
      controlState: {
        connection: null,
        readiness: null,
        capabilities: null,
        updatedAt: null,
      },
    },
  ],
};

function readConnectorEndpointPayload(payload: unknown) {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

function validateConnectorEndpointPayload(payload: unknown): { error: string } | null {
  const body = readConnectorEndpointPayload(payload);
  if (typeof body.protocolId !== 'string' || !body.protocolId.trim()) {
    return { error: 'protocolId is required' };
  }
  if (typeof body.connectorId !== 'string' || !body.connectorId.trim()) {
    return { error: 'connectorId is required' };
  }
  if (typeof body.endpointId !== 'string' || !body.endpointId.trim()) {
    return { error: 'endpointId is required' };
  }
  return null;
}

function createService() {
  return {
    snapshotRuntimeTopology: () => topology,
    connectRuntimeConnectorEndpoint: async (payload: unknown) => {
      const invalid = validateConnectorEndpointPayload(payload);
      return invalid
        ? { status: 400, data: { success: false, error: invalid.error } }
        : { status: 200, data: { success: true, readiness: { ready: true, phase: 'connected' }, payload } };
    },
    disconnectRuntimeConnectorEndpoint: async (payload: unknown) => ({ status: 200, data: { success: true, readiness: { ready: false, phase: 'disconnected' }, payload } }),
  };
}

describe('runtime topology routes', () => {
  it('lists runtime adapters', async () => {
    await expect(dispatchRuntimeRouteDefinition(
      runtimeTopologyRoutes,
      'GET',
      '/api/runtime-adapters/list',
      undefined,
      createService(),
    )).resolves.toEqual({
      status: 200,
      data: { adapters: topology.adapters },
    });
  });

  it('lists runtime adapter instances', async () => {
    await expect(dispatchRuntimeRouteDefinition(
      runtimeTopologyRoutes,
      'GET',
      '/api/runtime-adapters/instances/list',
      undefined,
      createService(),
    )).resolves.toEqual({
      status: 200,
      data: { instances: topology.adapterInstances },
    });
  });

  it('lists runtime connectors', async () => {
    await expect(dispatchRuntimeRouteDefinition(
      runtimeTopologyRoutes,
      'GET',
      '/api/runtime-connectors/list',
      undefined,
      createService(),
    )).resolves.toEqual({
      status: 200,
      data: { connectors: topology.connectors },
    });
  });

  it('connects runtime connector endpoint', async () => {
    const payload = { protocolId: 'acp', connectorId: 'acp', endpointId: 'claude-code' };
    await expect(dispatchRuntimeRouteDefinition(
      runtimeTopologyRoutes,
      'POST',
      '/api/runtime-connectors/connect',
      payload,
      createService(),
    )).resolves.toEqual({
      status: 200,
      data: { success: true, readiness: { ready: true, phase: 'connected' }, payload },
    });
  });

  it.each([
    [{ connectorId: 'acp', endpointId: 'claude-code' }, 'protocolId is required'],
    [{ protocolId: 'acp', endpointId: 'claude-code' }, 'connectorId is required'],
    [{ protocolId: 'acp', connectorId: 'acp' }, 'endpointId is required'],
  ] as const)('rejects runtime connector connect requests with missing address fields', async (payload, error) => {
    await expect(dispatchRuntimeRouteDefinition(
      runtimeTopologyRoutes,
      'POST',
      '/api/runtime-connectors/connect',
      payload,
      createService(),
    )).resolves.toEqual({
      status: 400,
      data: { success: false, error },
    });
  });

  it('disconnects runtime connector endpoint', async () => {
    const payload = { protocolId: 'acp', connectorId: 'acp', endpointId: 'claude-code' };
    await expect(dispatchRuntimeRouteDefinition(
      runtimeTopologyRoutes,
      'POST',
      '/api/runtime-connectors/disconnect',
      payload,
      createService(),
    )).resolves.toEqual({
      status: 200,
      data: { success: true, readiness: { ready: false, phase: 'disconnected' }, payload },
    });
  });

  it('lists runtime endpoints with explicit RuntimeAddress entries', async () => {
    await expect(dispatchRuntimeRouteDefinition(
      runtimeTopologyRoutes,
      'GET',
      '/api/runtime-endpoints/list',
      undefined,
      createService(),
    )).resolves.toEqual({
      status: 200,
      data: { endpoints: topology.endpoints },
    });
  });
});
