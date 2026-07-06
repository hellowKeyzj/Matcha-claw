import type { GatewayCapabilitiesSnapshot, GatewayConnectionStatePayload, GatewayControlReadiness } from '../application/gateway/gateway-runtime-port';
import type { CapabilityTargetKind, RuntimeEndpointRef, RuntimeScope, RuntimeScopeKind } from './runtime-address';

export interface RuntimeProtocolSummary {
  protocolId: string;
}

export interface RuntimeAdapterSummary {
  runtimeAdapterId: string;
  protocolId: string;
  endpointIds: string[];
}

export interface RuntimeConnectorSummary {
  protocolId: string;
  connectorId: string;
  endpointIds: string[];
}

export interface RuntimeEndpointSourceSummary {
  kind: 'runtime-adapter' | 'protocol-connector';
  runtimeAdapterId?: string;
  runtimeInstanceId?: string;
  protocolId?: string;
  connectorId?: string;
  endpointId?: string;
}

export interface RuntimeEndpointLocationSummary {
  kind: 'local' | 'remote';
  nodeId?: string;
}

export interface RuntimeEndpointLifecycleSummary {
  phase: 'declared' | 'connecting' | 'ready' | 'unavailable' | 'disconnected';
  connected: boolean;
  ready: boolean;
  updatedAt: number | null;
  error?: string;
}

export interface RuntimeAgentProfileSummary {
  agentId: string;
  displayName?: string;
  source: 'declared' | 'discovered' | 'dynamic';
  capabilities: {
    chat: boolean;
    streaming: boolean;
    tools: boolean;
    approvals: boolean;
    replay: boolean;
    modelSelection: boolean;
  };
}

export interface RuntimeAdapterInstanceSummary {
  runtimeAdapterId: string;
  runtimeInstanceId: string;
  endpointId: string;
  endpointRef: RuntimeEndpointRef;
  source: RuntimeEndpointSourceSummary;
  location: RuntimeEndpointLocationSummary;
  lifecycle: RuntimeEndpointLifecycleSummary;
  agentIds: string[];
}

export interface RuntimeEndpointControlStateSummary {
  connection: GatewayConnectionStatePayload | null;
  readiness: GatewayControlReadiness | null;
  capabilities: GatewayCapabilitiesSnapshot | null;
  updatedAt: number | null;
}

export interface RuntimeEndpointCapabilityOperationSummary {
  id: string;
  targetKind: CapabilityTargetKind;
  targetRequired?: boolean;
}

export interface RuntimeEndpointCapabilitySummary {
  id: string;
  scopeKind: RuntimeScopeKind;
  scope: RuntimeScope;
  targetKinds: CapabilityTargetKind[];
  operations: RuntimeEndpointCapabilityOperationSummary[];
  availability: 'available' | 'unavailable';
}

export interface RuntimeEndpointSummary {
  id: string;
  protocolId: string;
  connectorId?: string;
  runtimeAdapterId?: string;
  runtimeInstanceId?: string;
  endpointRef: RuntimeEndpointRef;
  source: RuntimeEndpointSourceSummary;
  location: RuntimeEndpointLocationSummary;
  lifecycle: RuntimeEndpointLifecycleSummary;
  displayName: string;
  agentIds: string[];
  agents: RuntimeAgentProfileSummary[];
  acceptsDynamicAgents: boolean;
  capabilities: {
    chat: boolean;
    streaming: boolean;
    tools: boolean;
    approvals: boolean;
    replay: boolean;
    modelSelection: boolean;
  };
  capabilitySummaries: RuntimeEndpointCapabilitySummary[];
  controlState: RuntimeEndpointControlStateSummary;
}

export interface RuntimeEndpointProfileSummary {
  id: string;
  protocolId: string;
  connectorId?: string;
  runtimeAdapterId?: string;
  runtimeInstanceId?: string;
  endpointRef: RuntimeEndpointRef;
  source: RuntimeEndpointSourceSummary;
  location: RuntimeEndpointLocationSummary;
  lifecycle: RuntimeEndpointLifecycleSummary;
  displayName: string;
  agentIds: string[];
  agents: RuntimeAgentProfileSummary[];
  acceptsDynamicAgents: boolean;
  capabilities: RuntimeEndpointSummary['capabilities'];
}

export interface RuntimeInstanceSummary {
  endpointRef: RuntimeEndpointRef;
  source: RuntimeEndpointSourceSummary;
  location: RuntimeEndpointLocationSummary;
  lifecycle: RuntimeEndpointLifecycleSummary;
  endpointId: string;
  agentIds: string[];
}

export interface RuntimeDirectorySnapshot {
  endpointProfiles: RuntimeEndpointProfileSummary[];
  runtimeInstances: RuntimeInstanceSummary[];
}

export interface RuntimeEndpointReadinessSummary {
  ready: boolean;
  phase: string;
  error?: string;
  details?: unknown;
}

export interface RuntimeConnectorEndpointLifecycleResult {
  success: true;
  readiness: RuntimeEndpointReadinessSummary;
}

export interface RuntimeTopologySnapshot {
  protocols: RuntimeProtocolSummary[];
  adapters: RuntimeAdapterSummary[];
  connectors: RuntimeConnectorSummary[];
  adapterInstances: RuntimeAdapterInstanceSummary[];
  runtimeInstances: RuntimeInstanceSummary[];
  directory: RuntimeDirectorySnapshot;
  endpoints: RuntimeEndpointSummary[];
}
