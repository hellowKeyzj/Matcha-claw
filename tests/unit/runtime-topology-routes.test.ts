import { describe, expect, it } from 'vitest';
import { runtimeTopologyRoutes } from '../../runtime-host/api/routes/runtime-topology-routes';
import type { RuntimeEndpointRef } from '../../runtime-host/shared/runtime-address';
import type {
  RuntimeDirectorySnapshot,
  RuntimeEndpointLifecycleSummary,
  RuntimeEndpointLocationSummary,
  RuntimeEndpointSourceSummary,
  RuntimeTopologySnapshot,
} from '../../runtime-host/shared/runtime-topology';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

const openClawEndpointRef: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};

const claudeCodeEndpointRef: RuntimeEndpointRef = {
  kind: 'protocol-connector',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointId: 'claude-code',
};

const hermesEndpointRef: RuntimeEndpointRef = {
  kind: 'protocol-connector',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointId: 'hermes',
};

const openClawSource: RuntimeEndpointSourceSummary = {
  kind: 'runtime-adapter',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};

const claudeCodeSource: RuntimeEndpointSourceSummary = {
  kind: 'protocol-connector',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointId: 'claude-code',
};

const hermesSource: RuntimeEndpointSourceSummary = {
  kind: 'protocol-connector',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointId: 'hermes',
};

const localRuntimeLocation: RuntimeEndpointLocationSummary = { kind: 'local' };

const readyLifecycle: RuntimeEndpointLifecycleSummary = {
  phase: 'ready',
  connected: true,
  ready: true,
  updatedAt: null,
};

const declaredLifecycle: RuntimeEndpointLifecycleSummary = {
  phase: 'declared',
  connected: false,
  ready: false,
  updatedAt: null,
};

const openClawCapabilities = {
  chat: true,
  streaming: true,
  tools: true,
  approvals: true,
  replay: true,
  modelSelection: true,
};

const claudeCodeCapabilities = {
  chat: true,
  streaming: true,
  tools: true,
  approvals: false,
  replay: true,
  modelSelection: false,
};

const openClawAgent = {
  agentId: 'default',
  source: 'declared' as const,
  capabilities: openClawCapabilities,
};

const claudeCodeAgent = {
  agentId: 'default',
  source: 'discovered' as const,
  capabilities: claudeCodeCapabilities,
};

const openClawEndpointProfile = {
  id: 'openclaw-local',
  protocolId: 'openclaw-v4',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  endpointRef: openClawEndpointRef,
  source: openClawSource,
  location: localRuntimeLocation,
  lifecycle: readyLifecycle,
  displayName: 'OpenClaw',
  agentIds: ['default'],
  agents: [openClawAgent],
  acceptsDynamicAgents: true,
  capabilities: openClawCapabilities,
};

const claudeCodeEndpointProfile = {
  id: 'claude-code',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointRef: claudeCodeEndpointRef,
  source: claudeCodeSource,
  location: localRuntimeLocation,
  lifecycle: readyLifecycle,
  displayName: 'Claude Code',
  agentIds: ['default'],
  agents: [claudeCodeAgent],
  acceptsDynamicAgents: false,
  capabilities: claudeCodeCapabilities,
};

const hermesEndpointProfile = {
  id: 'hermes',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointRef: hermesEndpointRef,
  source: hermesSource,
  location: localRuntimeLocation,
  lifecycle: declaredLifecycle,
  displayName: 'Hermes',
  agentIds: ['default'],
  agents: [{ ...claudeCodeAgent, source: 'declared' as const }],
  acceptsDynamicAgents: false,
  capabilities: claudeCodeCapabilities,
};

const runtimeInstances = [
  {
    endpointRef: openClawEndpointRef,
    source: openClawSource,
    location: localRuntimeLocation,
    lifecycle: readyLifecycle,
    endpointId: 'openclaw-local',
    agentIds: ['default'],
  },
  {
    endpointRef: claudeCodeEndpointRef,
    source: claudeCodeSource,
    location: localRuntimeLocation,
    lifecycle: readyLifecycle,
    endpointId: 'claude-code',
    agentIds: ['default'],
  },
];

const directory: RuntimeDirectorySnapshot = {
  endpointProfiles: [openClawEndpointProfile, claudeCodeEndpointProfile, hermesEndpointProfile],
  runtimeInstances,
};

const topology: RuntimeTopologySnapshot = {
  protocols: [{ protocolId: 'openclaw-v4' }, { protocolId: 'acp' }],
  adapters: [{ runtimeAdapterId: 'openclaw', protocolId: 'openclaw-v4', endpointIds: ['openclaw-local'] }],
  connectors: [{ protocolId: 'acp', connectorId: 'acp', endpointIds: ['claude-code', 'hermes'] }],
  adapterInstances: [{
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
    endpointId: 'openclaw-local',
    endpointRef: openClawEndpointRef,
    source: openClawSource,
    location: localRuntimeLocation,
    lifecycle: readyLifecycle,
    agentIds: ['default'],
  }],
  runtimeInstances,
  directory,
  endpoints: [
    {
      ...openClawEndpointProfile,
      capabilitySummaries: [],
      controlState: {
        connection: null,
        readiness: null,
        capabilities: null,
        updatedAt: null,
      },
    },
    {
      ...claudeCodeEndpointProfile,
      capabilitySummaries: [{
        id: 'session.prompt',
        scopeKind: 'agent',
        scope: {
          kind: 'agent',
          endpoint: {
            kind: 'protocol-connector',
            protocolId: 'acp',
            connectorId: 'acp',
            endpointId: 'claude-code',
          },
          agentId: 'default',
        },
        targetKinds: ['agent', 'session'],
        operations: [
          { id: 'sessions.create', targetKind: 'agent' },
          { id: 'sessions.prompt', targetKind: 'session' },
        ],
        availability: 'available',
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

  it('rejects runtime connector connect without dispatching lifecycle service', async () => {
    const service = createService();
    await expect(dispatchRuntimeRouteDefinition(
      runtimeTopologyRoutes,
      'POST',
      '/api/runtime-connectors/connect',
      { protocolId: 'acp', connectorId: 'acp', endpointId: 'claude-code' },
      service,
    )).resolves.toMatchObject({
      status: 400,
      data: { success: false },
    });
  });

  it('rejects runtime connector disconnect without dispatching lifecycle service', async () => {
    const service = createService();
    await expect(dispatchRuntimeRouteDefinition(
      runtimeTopologyRoutes,
      'POST',
      '/api/runtime-connectors/disconnect',
      { protocolId: 'acp', connectorId: 'acp', endpointId: 'claude-code' },
      service,
    )).resolves.toMatchObject({
      status: 400,
      data: { success: false },
    });
  });

  it('lists runtime endpoints with explicit capability summaries', async () => {
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
