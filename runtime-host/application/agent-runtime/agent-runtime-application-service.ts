import type { RuntimeAddress } from './contracts/runtime-address';
import type { AgentRuntimeRegistry } from './contracts/agent-runtime-registry';
import type { CapabilityExecuteRequest } from '../capabilities/contracts/capability-router';
import { CapabilityRouter } from '../capabilities/contracts/capability-router';
import { badRequest, ok } from '../common/application-response';
import type { RuntimeConnectorEndpointLifecycleResult, RuntimeTopologySnapshot } from '../../shared/runtime-topology';

interface RuntimeConnectorEndpointRequest {
  protocolId?: string;
  connectorId?: string;
  endpointId?: string;
}

function readRuntimeConnectorEndpointRequest(payload: unknown): RuntimeConnectorEndpointRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  const body = payload as Record<string, unknown>;
  return {
    protocolId: typeof body.protocolId === 'string' ? body.protocolId.trim() : undefined,
    connectorId: typeof body.connectorId === 'string' ? body.connectorId.trim() : undefined,
    endpointId: typeof body.endpointId === 'string' ? body.endpointId.trim() : undefined,
  };
}

export interface AgentRuntimeApplicationServiceDeps {
  agentRuntimeRegistry: AgentRuntimeRegistry;
  capabilityRouter: CapabilityRouter;
}

export class AgentRuntimeApplicationService {
  constructor(private readonly deps: AgentRuntimeApplicationServiceDeps) {}

  listCapabilities() {
    return this.deps.agentRuntimeRegistry.listCapabilities();
  }

  describeCapability(input: { id: string; address: RuntimeAddress }) {
    return this.deps.agentRuntimeRegistry.getCapability(input);
  }

  async executeCapability(request: CapabilityExecuteRequest) {
    return await this.deps.capabilityRouter.execute(request);
  }

  snapshotRuntimeTopology(): RuntimeTopologySnapshot {
    return this.deps.agentRuntimeRegistry.snapshotTopology();
  }

  async connectRuntimeConnectorEndpoint(payload: unknown) {
    const request = readRuntimeConnectorEndpointRequest(payload);
    if (!request.protocolId) {
      return badRequest('protocolId is required');
    }
    if (!request.connectorId) {
      return badRequest('connectorId is required');
    }
    if (!request.endpointId) {
      return badRequest('endpointId is required');
    }
    const readiness = await this.deps.agentRuntimeRegistry.connectRuntimeEndpoint({
      protocolId: request.protocolId,
      connectorId: request.connectorId,
      endpointId: request.endpointId,
    });
    return ok<RuntimeConnectorEndpointLifecycleResult>({ success: true, readiness });
  }

  async disconnectRuntimeConnectorEndpoint(payload: unknown) {
    const request = readRuntimeConnectorEndpointRequest(payload);
    if (!request.protocolId) {
      return badRequest('protocolId is required');
    }
    if (!request.connectorId) {
      return badRequest('connectorId is required');
    }
    if (!request.endpointId) {
      return badRequest('endpointId is required');
    }
    const readiness = this.deps.agentRuntimeRegistry.disconnectRuntimeEndpoint({
      protocolId: request.protocolId,
      connectorId: request.connectorId,
      endpointId: request.endpointId,
    });
    return ok<RuntimeConnectorEndpointLifecycleResult>({ success: true, readiness });
  }
}
