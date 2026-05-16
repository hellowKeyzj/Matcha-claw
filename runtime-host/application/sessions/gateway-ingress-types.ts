import type { GatewayTransportIssue } from '../../shared/gateway-error';
import type {
  SessionRenderToolStatusKind,
  SessionTimelineEntry,
  TaskSnapshotEvent,
} from '../../shared/session-adapter-types';

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

export interface SessionPlanIngressEvent {
  sessionUpdate: 'plan';
  sessionKey: string | null;
  runId: string | null;
  taskSnapshot: TaskSnapshotEvent;
  _meta?: Record<string, unknown>;
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

/**
 * Tool lifecycle events update tool runtime state by toolCallId.
 *
 * They never participate in turn ordering. The corresponding tool segment's
 * position is owned by the chat-stream content array; this event only patches
 * that segment's status/input/output in place, or installs a placeholder
 * if chat content has not yet referenced the toolCallId.
 */
export interface SessionToolStatusUpdateIngressEvent {
  sessionUpdate: 'tool_status_update';
  sessionKey: string | null;
  runId: string | null;
  sequenceId: number;
  timestamp: number;
  toolCallId: string;
  toolName: string;
  phase: 'start' | 'update' | 'result';
  status: SessionRenderToolStatusKind;
  isError: boolean;
  input?: unknown;
  partialResult?: unknown;
  output?: unknown;
  _meta?: Record<string, unknown>;
}

export type GatewaySessionIngressEvent =
  | SessionInfoIngressEvent
  | SessionTimelineIngressEvent
  | SessionToolStatusUpdateIngressEvent
  | SessionPlanIngressEvent;
