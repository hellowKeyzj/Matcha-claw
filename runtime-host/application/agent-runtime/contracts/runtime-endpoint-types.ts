import type { RuntimeEndpointRef, SessionIdentity } from './runtime-address';
import type { CapabilityDescriptor } from '../../capabilities/contracts/capability-descriptor';
import type { CanonicalSessionEvent, CanonicalApprovalEvent } from '../../sessions/canonical/canonical-events';
import type {
  GatewayChatPort,
  GatewayRpcPort,
} from '../../gateway/gateway-runtime-port';
import type { SessionApprovalDecision } from '../../../shared/session-adapter-types';

export type RuntimeProtocolId = string;
export type RuntimeEndpointId = string;
export type RuntimeAdapterId = string;
export type RuntimeConnectorId = string;

export interface RuntimeEndpointIdentity {
  scopeKey: string;
  protocolId?: string;
  connectorId?: string;
  endpointId?: string;
  runtimeAdapterId?: string;
  runtimeInstanceId?: string;
}

export interface RuntimeSessionContext {
  identity: SessionIdentity;
  sessionKey: string;
  protocolId: RuntimeProtocolId;
  runtimeEndpointId: RuntimeEndpointId;
  endpoint: RuntimeEndpointIdentity;
  endpointRef: RuntimeEndpointRef;
  endpointSessionId?: string;
  agentId: string;
}

export interface RuntimeEndpointCapabilities {
  chat: boolean;
  streaming: boolean;
  tools: boolean;
  approvals: boolean;
  replay: boolean;
  modelSelection: boolean;
}

export interface RuntimeLauncherConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface RuntimeStorageProfile {
  namespace: string;
}

export interface RuntimeSessionKeyProfile {
  namespace: string;
}

export interface RuntimeEndpointProfile {
  id: RuntimeEndpointId;
  protocolId: RuntimeProtocolId;
  connectorId?: RuntimeConnectorId;
  runtimeAdapterId?: RuntimeAdapterId;
  runtimeInstanceId?: string;
  displayName: string;
  agentIds: readonly string[];
  acceptsDynamicAgents?: boolean;
  capabilities: RuntimeEndpointCapabilities;
  launcher?: RuntimeLauncherConfig;
  storage?: RuntimeStorageProfile;
  keying?: RuntimeSessionKeyProfile;
}

export interface RuntimePromptRequest {
  context: RuntimeSessionContext;
  message: string;
  runId: string;
  payload: unknown;
}

export interface RuntimePromptResult {
  success: boolean;
  error?: string;
  payload?: unknown;
}

export interface RuntimeAbortRequest {
  context: RuntimeSessionContext;
  approvalIds?: readonly string[];
  runId?: string;
}

export interface RuntimeResolveApprovalRequest {
  context: RuntimeSessionContext;
  id: string;
  decision: SessionApprovalDecision;
}

export interface RuntimePatchModelRequest {
  context: RuntimeSessionContext;
  runtimeModelRef: string;
}

export interface RuntimePatchModelResult {
  runtimeModelRef: string;
  payload?: unknown;
}

export interface RuntimeEndpointReadiness {
  ready: boolean;
  phase: string;
  error?: string;
  details?: unknown;
}

export interface RuntimeEndpointDiscovery {
  displayName?: string;
  agentIds?: readonly string[];
  acceptsDynamicAgents?: boolean;
  capabilities?: RuntimeEndpointCapabilities;
}

export interface RuntimeSessionTransport {
  sendPrompt(input: RuntimePromptRequest): Promise<RuntimePromptResult>;
  abortSession(input: RuntimeAbortRequest): Promise<void>;
  resolveApproval(input: RuntimeResolveApprovalRequest): Promise<unknown>;
  patchSessionModel?(input: RuntimePatchModelRequest): Promise<RuntimePatchModelResult>;
  inspectReadiness?(): Promise<RuntimeEndpointReadiness>;
  discoverEndpoint?(): Promise<RuntimeEndpointDiscovery | null>;
}

export interface RuntimeEventAdapter {
  canTranslate(input: unknown, context: RuntimeSessionContext): boolean;
  translate(input: unknown, context: RuntimeSessionContext): CanonicalSessionEvent[];
}

export type RuntimeReplayTranscriptSource = string | Iterable<string> | AsyncIterable<string>;

export interface RuntimeReplayAdapter {
  replayTranscript(sessionKey: string, transcript: RuntimeReplayTranscriptSource, context: RuntimeSessionContext): AsyncIterable<CanonicalSessionEvent> | Iterable<CanonicalSessionEvent>;
}

export interface RuntimeIdentityPolicy {
  buildMessageId(input: {
    identity: SessionIdentity;
    runId: string;
    laneKey: string;
    role: string;
    messageIndex: number;
  }): string;
}

export interface RuntimeApprovalNotificationAdapter {
  translateNotification(notification: unknown, nowMs: number): CanonicalApprovalEvent[];
}

export interface RuntimeProtocolAdapter {
  protocolId: RuntimeProtocolId;
  eventAdapter: RuntimeEventAdapter;
  replayAdapter: RuntimeReplayAdapter;
  identityPolicy: RuntimeIdentityPolicy;
}

export interface RuntimeAdapter {
  runtimeAdapterId: RuntimeAdapterId;
  protocol: RuntimeProtocolAdapter;
  endpoints: RuntimeEndpointProfile[];
  capabilities: CapabilityDescriptor[];
  approvalNotifications?: RuntimeApprovalNotificationAdapter;
  createTransport(endpoint: RuntimeEndpointProfile, runtimePorts: { gateway: GatewayChatPort & Pick<GatewayRpcPort, 'gatewayRpc'> }): RuntimeSessionTransport;
}

export interface RuntimeProtocolConnector {
  connectorId: RuntimeConnectorId;
  protocol: RuntimeProtocolAdapter;
  endpoints: RuntimeEndpointProfile[];
  approvalNotifications?: RuntimeApprovalNotificationAdapter;
  connect(endpoint: RuntimeEndpointProfile): RuntimeSessionTransport;
  disconnect?(endpointId: RuntimeEndpointId): void;
  inspectEndpointReadiness?(endpointId: RuntimeEndpointId): Promise<RuntimeEndpointReadiness>;
}

export interface RuntimeEndpointRegistration {
  runtimeAdapters?: RuntimeAdapter[];
  protocolConnectors?: RuntimeProtocolConnector[];
}

export interface RuntimeAdapterRegistrationFactory {
  create(): readonly RuntimeAdapter[];
}
