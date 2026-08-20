import type { RuntimeEndpointRef } from '../../electron/desktop-contract/runtime-address';
import type { GatewayTransportIssue } from './session/runtime-state';

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
  defaultAgentId: string;
}

export interface RuntimeEndpointConnectionStateSummary {
  state: 'connected' | 'reconnecting' | 'disconnected';
  portReachable: boolean;
  gatewayReady: boolean;
  healthSummary: 'healthy' | 'degraded' | 'unresponsive';
  transportEpoch: number;
  lastError?: string;
  lastIssue?: GatewayTransportIssue;
  diagnostics: {
    lastAliveAt?: number;
    lastRpcSuccessAt?: number;
    lastRpcFailureAt?: number;
    lastRpcFailureMethod?: string;
    lastHeartbeatTimeoutAt?: number;
    consecutiveHeartbeatMisses: number;
    lastSocketCloseAt?: number;
    lastSocketCloseCode?: number;
    consecutiveRpcFailures: number;
  };
  updatedAt: number;
}

export interface RuntimeEndpointCapabilitiesSummary {
  methods: readonly string[];
  updatedAt: number;
}

export interface RuntimeEndpointReadinessSummary {
  ready: boolean;
  phase: 'ready' | 'starting' | 'unavailable' | string;
  requiredMethods?: readonly string[];
  missingMethods?: readonly string[];
  retryable?: boolean;
  code?: string;
  error?: string;
  details?: unknown;
  retryAfterMs?: number;
  capabilities?: RuntimeEndpointCapabilitiesSummary;
}

export interface RuntimeEndpointControlStateSummary {
  connection: RuntimeEndpointConnectionStateSummary | null;
  readiness: RuntimeEndpointReadinessSummary | null;
  capabilities: RuntimeEndpointCapabilitiesSummary | null;
  updatedAt: number | null;
}

export type RuntimeCapabilityFamily = 'session' | 'task' | 'team' | 'cron' | 'workspace' | 'skill' | 'channel' | 'lifecycle';

export interface RuntimeEndpointCapabilityFamilySummary {
  family: RuntimeCapabilityFamily;
  availability: 'supported' | 'unsupported';
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
  defaultAgentId: string;
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
  capabilityFamilies: RuntimeEndpointCapabilityFamilySummary[];
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
  defaultAgentId: string;
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
  defaultAgentId: string;
}

export interface RuntimeDirectorySnapshot {
  endpointProfiles: RuntimeEndpointProfileSummary[];
  runtimeInstances: RuntimeInstanceSummary[];
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
