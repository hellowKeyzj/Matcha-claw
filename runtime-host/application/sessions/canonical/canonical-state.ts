import type { GatewayTransportIssue } from '../../../shared/gateway-error';
import type {
  SessionApprovalRequestItem,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRuntimeStateSnapshot,
  TaskSnapshotEvent,
} from '../../../shared/session-adapter-types';
import type {
  CanonicalArtifactEvent,
  CanonicalTeamEvent,
  CanonicalUsageEvent,
} from './canonical-events';
import type { CanonicalMessageStatus, CanonicalProvider } from './canonical-events';

export interface CanonicalMessageState {
  key: string;
  role: 'user' | 'assistant' | 'system';
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
  runId?: string;
  laneKey: string;
  agentId?: string;
  content: unknown;
  text: string;
  status: CanonicalMessageStatus;
  images: SessionRenderImage[];
  attachedFiles: SessionRenderAttachedFile[];
  seq?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface CanonicalThoughtState {
  key: string;
  runId?: string;
  laneKey: string;
  agentId?: string;
  text: string;
  status: CanonicalMessageStatus;
  seq?: number;
  updatedAt?: number;
}

export interface CanonicalToolState {
  key: string;
  toolCallId: string;
  runId?: string;
  laneKey: string;
  agentId?: string;
  name: string;
  input?: unknown;
  partialResult?: unknown;
  output?: unknown;
  outputText?: string;
  status: 'running' | 'completed' | 'error';
  seq?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface CanonicalControlState {
  transportEpoch: number | null;
  ready: boolean | null;
  phase: string | null;
  issue: GatewayTransportIssue | null;
  issueTransportEpoch: number | null;
  capabilities: unknown | null;
  updatedAt: number | null;
}

export interface CanonicalSessionState {
  sessionId: string;
  provider: CanonicalProvider;
  eventIds: string[];
  eventIdSet: Set<string>;
  messageIndexByKey: Map<string, number>;
  thoughtIndexByKey: Map<string, number>;
  toolIndexByKey: Map<string, number>;
  approvalIndexById: Map<string, number>;
  messages: CanonicalMessageState[];
  thoughts: CanonicalThoughtState[];
  tools: CanonicalToolState[];
  approvals: SessionApprovalRequestItem[];
  teams: CanonicalTeamEvent[];
  usage: CanonicalUsageEvent[];
  artifacts: CanonicalArtifactEvent[];
  taskSnapshot: TaskSnapshotEvent | null;
  control: CanonicalControlState;
  runtime: SessionRuntimeStateSnapshot;
  replayDepth: number;
  hydrated: boolean;
  updatedAt: number | null;
}

export function rebuildCanonicalSessionIndexes(state: CanonicalSessionState): void {
  state.eventIdSet = new Set(state.eventIds);
  state.messageIndexByKey = new Map(state.messages.map((message, index) => [message.key, index]));
  state.thoughtIndexByKey = new Map(state.thoughts.map((thought, index) => [thought.key, index]));
  state.toolIndexByKey = new Map(state.tools.map((tool, index) => [tool.key, index]));
  state.approvalIndexById = new Map(state.approvals.map((approval, index) => [approval.id, index]));
}

export function cloneCanonicalSessionState(state: CanonicalSessionState): CanonicalSessionState {
  const clone = structuredClone({
    ...state,
    eventIdSet: undefined,
    messageIndexByKey: undefined,
    thoughtIndexByKey: undefined,
    toolIndexByKey: undefined,
    approvalIndexById: undefined,
  }) as CanonicalSessionState;
  rebuildCanonicalSessionIndexes(clone);
  return clone;
}
