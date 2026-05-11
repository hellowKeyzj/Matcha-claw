import type { GatewayTransportIssue } from '../../shared/gateway-error';
import type { SessionTimelineEntry } from '../../shared/session-adapter-types';

export interface GatewayConversationMessagePayload {
  state?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  sequenceId?: unknown;
  agentId?: unknown;
  message?: unknown;
}

export interface GatewayConversationLifecyclePayload {
  phase?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  error?: unknown;
  errorMessage?: unknown;
}

export interface GatewayConversationToolLifecyclePayload {
  phase?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  sequenceId?: unknown;
  timestamp?: unknown;
  toolCallId?: unknown;
  name?: unknown;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: unknown;
}

export interface SessionInfoIngressEvent {
  sessionUpdate: 'session_info_update';
  sessionKey: string | null;
  runId: string | null;
  phase: 'started' | 'final' | 'error' | 'aborted' | 'unknown';
  error: string | null;
  transportIssue?: GatewayTransportIssue | null;
  _meta?: Record<string, unknown>;
}

export interface SessionTimelineIngressEvent {
  sessionUpdate: 'agent_message_chunk' | 'agent_message';
  sessionKey: string | null;
  runId: string | null;
  laneKey: string;
  entries: SessionTimelineEntry[];
  _meta?: Record<string, unknown>;
}

export type GatewaySessionIngressEvent =
  | SessionInfoIngressEvent
  | SessionTimelineIngressEvent;
