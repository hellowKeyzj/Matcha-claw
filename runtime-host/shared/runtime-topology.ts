import type { GatewayCapabilitiesSnapshot, GatewayConnectionStatePayload, GatewayControlReadiness } from '../application/gateway/gateway-runtime-port';
import type { RuntimeAddress } from './runtime-address';

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

export interface RuntimeAdapterInstanceSummary {
  runtimeAdapterId: string;
  runtimeInstanceId: string;
  endpointId: string;
  agentIds: string[];
}

export interface RuntimeEndpointControlStateSummary {
  connection: GatewayConnectionStatePayload | null;
  readiness: GatewayControlReadiness | null;
  capabilities: GatewayCapabilitiesSnapshot | null;
  updatedAt: number | null;
}

export interface RuntimeEndpointSummary {
  id: string;
  protocolId: string;
  connectorId?: string;
  runtimeAdapterId?: string;
  runtimeInstanceId?: string;
  displayName: string;
  agentIds: string[];
  acceptsDynamicAgents: boolean;
  capabilities: {
    chat: boolean;
    streaming: boolean;
    tools: boolean;
    approvals: boolean;
    replay: boolean;
    modelSelection: boolean;
  };
  capabilityAddresses: RuntimeAddress[];
  controlState: RuntimeEndpointControlStateSummary;
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
  endpoints: RuntimeEndpointSummary[];
}
