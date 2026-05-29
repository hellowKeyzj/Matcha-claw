import type { GatewayTransportIssue } from '../../../shared/gateway-error';
import type {
  SessionApprovalDecision,
  SessionApprovalRequestItem,
  SessionMessageRole,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRenderToolStatusKind,
  SessionRunPhase,
  SessionTaskCompletionEvent,
  TaskSnapshotEvent,
} from '../../../shared/session-adapter-types';

export type CanonicalProvider = 'openclaw-v4' | 'claude-code' | 'codex';
export type CanonicalEventSource = 'live' | 'replay' | 'imported' | 'snapshot' | 'control';
export type CanonicalMessageStatus = 'streaming' | 'final' | 'error' | 'aborted';
export type CanonicalLifecyclePhase = 'started' | 'final' | 'error' | 'aborted';
export type CanonicalReplayBoundaryPhase = 'start' | 'end' | 'failed';

export interface CanonicalOrigin {
  providerEventType?: string;
  providerIds?: {
    sessionKey?: string;
    sessionId?: string;
    turnId?: string;
    runId?: string;
    laneKey?: string;
    agentId?: string;
    taskId?: string;
    threadId?: string;
    toolUseId?: string;
    parentToolUseId?: string;
    approvalId?: string;
    seq?: string;
  };
  raw?: unknown;
}

export interface CanonicalEventBase {
  eventId: string;
  type: string;
  provider: CanonicalProvider;
  source: CanonicalEventSource;
  sessionId: string;
  runId?: string;
  turnId?: string;
  seq?: number;
  timestamp?: number;
  laneKey?: string;
  agentId?: string;
  origin: CanonicalOrigin;
}

export interface CanonicalMessageSnapshotEvent extends CanonicalEventBase {
  type: 'message_snapshot';
  role: Extract<SessionMessageRole, 'user' | 'assistant' | 'system'>;
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
  content: unknown;
  text: string;
  status: CanonicalMessageStatus;
  images?: ReadonlyArray<SessionRenderImage>;
  attachedFiles?: ReadonlyArray<SessionRenderAttachedFile>;
}

export interface CanonicalThoughtSnapshotEvent extends CanonicalEventBase {
  type: 'thought_snapshot';
  thoughtId?: string;
  text: string;
  status: CanonicalMessageStatus;
}

export interface CanonicalToolCallEvent extends CanonicalEventBase {
  type: 'tool_call';
  toolCallId: string;
  name: string;
  input?: unknown;
}

export interface CanonicalToolProgressEvent extends CanonicalEventBase {
  type: 'tool_progress';
  toolCallId: string;
  partialResult?: unknown;
  outputText?: string;
}

export interface CanonicalToolResultEvent extends CanonicalEventBase {
  type: 'tool_result';
  toolCallId: string;
  name?: string;
  output?: unknown;
  outputText?: string;
  isError: boolean;
}

export interface CanonicalLifecycleEvent extends CanonicalEventBase {
  type: 'lifecycle';
  phase: CanonicalLifecyclePhase;
  runPhase: SessionRunPhase;
  error: string | null;
  transportIssue?: GatewayTransportIssue | null;
}

export interface CanonicalRuntimeActivityEvent extends CanonicalEventBase {
  type: 'runtime_activity';
  activity: 'compacting';
  phase: 'started' | 'completed';
}

export interface CanonicalApprovalEvent extends CanonicalEventBase {
  type: 'approval';
  approvalId: string;
  status: 'pending' | 'resolved';
  decision?: SessionApprovalDecision;
  title: string;
  command?: string;
  allowedDecisions: SessionApprovalRequestItem['allowedDecisions'];
  request?: Record<string, unknown>;
  createdAtMs: number;
  expiresAtMs?: number;
}

export interface CanonicalTeamEvent extends CanonicalEventBase {
  type: 'team';
  event: SessionTaskCompletionEvent;
}

export interface CanonicalPlanEvent extends CanonicalEventBase {
  type: 'plan';
  taskSnapshot: TaskSnapshotEvent;
}

export interface CanonicalUsageEvent extends CanonicalEventBase {
  type: 'usage';
  payload: unknown;
}

export interface CanonicalArtifactEvent extends CanonicalEventBase {
  type: 'artifact';
  payload: unknown;
}

export interface CanonicalControlEvent extends CanonicalEventBase {
  type: 'control';
  controlType: 'transport_connected' | 'transport_issue' | 'capabilities_updated' | 'control_ready';
  transportEpoch?: number;
  issue?: GatewayTransportIssue | null;
  capabilities?: unknown;
  ready?: boolean;
  phase?: string;
}

export interface CanonicalReplayBoundaryEvent extends CanonicalEventBase {
  type: 'replay_boundary';
  phase: CanonicalReplayBoundaryPhase;
}

export type CanonicalSessionEvent =
  | CanonicalMessageSnapshotEvent
  | CanonicalThoughtSnapshotEvent
  | CanonicalToolCallEvent
  | CanonicalToolProgressEvent
  | CanonicalToolResultEvent
  | CanonicalLifecycleEvent
  | CanonicalRuntimeActivityEvent
  | CanonicalApprovalEvent
  | CanonicalTeamEvent
  | CanonicalPlanEvent
  | CanonicalUsageEvent
  | CanonicalArtifactEvent
  | CanonicalControlEvent
  | CanonicalReplayBoundaryEvent;
