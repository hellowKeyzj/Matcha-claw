import type { CanonicalSessionEvent } from '../canonical/canonical-events';
import type { SessionApprovalDecision } from '../../../shared/session-adapter-types';

export type RuntimeProtocolId = string;
export type RuntimeProviderId = string;

export const OPENCLAW_RUNTIME_PROVIDER_ID = 'openclaw';
export const OPENCLAW_RUNTIME_PROTOCOL_ID = 'openclaw-v4';
export const ACP_RUNTIME_PROTOCOL_ID = 'acp';

export interface RuntimeSessionContext {
  sessionKey: string;
  protocolId: RuntimeProtocolId;
  runtimeProviderId: RuntimeProviderId;
  providerSessionId?: string;
  agentId?: string;
}

export interface RuntimeProviderCapabilities {
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
  legacyPrefix?: string;
  namespace: string;
}

export interface RuntimeProviderProfile {
  id: RuntimeProviderId;
  protocolId: RuntimeProtocolId;
  displayName: string;
  capabilities: RuntimeProviderCapabilities;
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

export interface RuntimeProviderReadiness {
  ready: boolean;
  phase: string;
  error?: string;
  details?: unknown;
}

export interface RuntimeSessionTransport {
  sendPrompt(input: RuntimePromptRequest): Promise<RuntimePromptResult>;
  abortSession(input: RuntimeAbortRequest): Promise<void>;
  resolveApproval(input: RuntimeResolveApprovalRequest): Promise<unknown>;
  patchSessionModel?(input: RuntimePatchModelRequest): Promise<RuntimePatchModelResult>;
  inspectReadiness?(): Promise<RuntimeProviderReadiness>;
}

export interface RuntimeEventAdapter {
  canTranslate(input: unknown, context: RuntimeSessionContext): boolean;
  translate(input: unknown, context: RuntimeSessionContext): CanonicalSessionEvent[];
}

export interface RuntimeReplayAdapter {
  replayTranscript(sessionKey: string, transcript: unknown, context: RuntimeSessionContext): Iterable<CanonicalSessionEvent>;
}

export interface RuntimeIdentityPolicy {
  buildMessageId(input: {
    sessionKey: string;
    runId?: string;
    turnId?: string;
    laneKey?: string;
    role: string;
    messageIndex: number;
    runtimeProviderId?: RuntimeProviderId;
  }): string;
}

export interface RuntimeProtocolAdapter {
  protocolId: RuntimeProtocolId;
  createTransport(profile: RuntimeProviderProfile): RuntimeSessionTransport;
  eventAdapter: RuntimeEventAdapter;
  replayAdapter: RuntimeReplayAdapter;
  identityPolicy: RuntimeIdentityPolicy;
}

export interface RuntimeProviderRegistration {
  protocol: RuntimeProtocolAdapter;
  profiles: RuntimeProviderProfile[];
}
