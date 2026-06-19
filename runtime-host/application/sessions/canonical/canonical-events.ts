import type { GatewayTransportIssue } from '../../../shared/gateway-error';
import type {
  SessionApprovalDecision,
  SessionApprovalRequestItem,
  SessionMessageRole,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRunPhase,
  SessionTaskCompletionEvent,
  TaskSnapshotEvent,
} from '../../../shared/session-adapter-types';
import type { RuntimeProtocolId, RuntimeEndpointId } from '../../agent-runtime/contracts/runtime-endpoint-types';

export type { RuntimeProtocolId, RuntimeEndpointId } from '../../agent-runtime/contracts/runtime-endpoint-types';
export type CanonicalEventSource = 'live' | 'replay' | 'imported' | 'snapshot' | 'control';
export type CanonicalMessageStatus = 'streaming' | 'final' | 'error' | 'aborted';
export type CanonicalLifecyclePhase = 'started' | 'final' | 'error' | 'aborted';
export type CanonicalReplayBoundaryPhase = 'start' | 'end' | 'failed';
export type CanonicalBindingSource = 'runtime' | 'adapter' | 'synthetic';
export type CanonicalBindingConfidence = 'high' | 'medium' | 'low';

export interface CanonicalOrderKey {
  seq: number;
  subSeq: number;
  sourceIndex: number;
  timestamp?: number;
}

export interface CanonicalOrigin {
  runtimeEventType?: string;
  runtimeIds?: {
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
  protocolId: RuntimeProtocolId;
  runtimeEndpointId: RuntimeEndpointId;
  source: CanonicalEventSource;
  sessionId: string;
  runId?: string;
  turnId?: string;
  seq?: number;
  timestamp?: number;
  laneKey?: string;
  agentId?: string;
  ownerTurnKey?: string;
  ownerMessageKey?: string;
  turnBindingSource?: CanonicalBindingSource;
  turnBindingConfidence?: CanonicalBindingConfidence;
  messageBindingSource?: CanonicalBindingSource;
  messageBindingConfidence?: CanonicalBindingConfidence;
  order?: CanonicalOrderKey;
  origin: CanonicalOrigin;
}

export interface CanonicalMessagePartEvent extends CanonicalEventBase {
  type: 'message_part';
  partId: string;
  role: Extract<SessionMessageRole, 'user' | 'assistant' | 'system'>;
  kind: 'text' | 'media';
  mode: 'delta' | 'snapshot' | 'replace' | 'final';
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
  content: unknown;
  text: string;
  status: CanonicalMessageStatus;
  images?: ReadonlyArray<SessionRenderImage>;
  attachedFiles?: ReadonlyArray<SessionRenderAttachedFile>;
}

export interface CanonicalThoughtEvent extends CanonicalEventBase {
  type: 'thought';
  thoughtId: string;
  mode: 'delta' | 'snapshot' | 'replace' | 'final';
  text: string;
  status: CanonicalMessageStatus;
}

export interface CanonicalToolEvent extends CanonicalEventBase {
  type: 'tool';
  toolCallId: string;
  phase: 'started' | 'updated' | 'completed' | 'failed';
  name?: string;
  input?: unknown;
  inputDelta?: string;
  partialResult?: unknown;
  output?: unknown;
  outputText?: string;
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
  | CanonicalMessagePartEvent
  | CanonicalThoughtEvent
  | CanonicalToolEvent
  | CanonicalLifecycleEvent
  | CanonicalRuntimeActivityEvent
  | CanonicalApprovalEvent
  | CanonicalTeamEvent
  | CanonicalPlanEvent
  | CanonicalUsageEvent
  | CanonicalArtifactEvent
  | CanonicalControlEvent
  | CanonicalReplayBoundaryEvent;
