import type { GatewayTransportIssue } from '../../../shared/gateway-error';
import type {
  SessionApprovalRequestItem,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRuntimeStateSnapshot,
  TaskSnapshotEvent,
} from '../../../shared/session-adapter-types';
import type { RuntimeSessionContext } from '../../agent-runtime/contracts/runtime-endpoint-types';
import type {
  CanonicalArtifactEvent,
  CanonicalBindingConfidence,
  CanonicalBindingSource,
  CanonicalTeamEvent,
  CanonicalUsageEvent,
} from './canonical-events';
import type { CanonicalMessageStatus, RuntimeProtocolId, RuntimeEndpointId } from './canonical-events';

export interface CanonicalMessageState {
  key: string;
  role: 'user' | 'assistant' | 'system';
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
  runId?: string;
  turnId?: string;
  laneKey: string;
  agentId?: string;
  ownerTurnKey?: string;
  ownerMessageKey?: string;
  turnBindingSource?: CanonicalBindingSource;
  turnBindingConfidence?: CanonicalBindingConfidence;
  messageBindingSource?: CanonicalBindingSource;
  messageBindingConfidence?: CanonicalBindingConfidence;
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
  turnId?: string;
  laneKey: string;
  agentId?: string;
  ownerTurnKey?: string;
  ownerMessageKey?: string;
  turnBindingSource?: CanonicalBindingSource;
  turnBindingConfidence?: CanonicalBindingConfidence;
  messageBindingSource?: CanonicalBindingSource;
  messageBindingConfidence?: CanonicalBindingConfidence;
  text: string;
  status: CanonicalMessageStatus;
  seq?: number;
  updatedAt?: number;
}

export interface CanonicalToolState {
  key: string;
  toolCallId: string;
  runId?: string;
  turnId?: string;
  laneKey: string;
  agentId?: string;
  ownerTurnKey?: string;
  ownerMessageKey?: string;
  turnBindingSource?: CanonicalBindingSource;
  turnBindingConfidence?: CanonicalBindingConfidence;
  messageBindingSource?: CanonicalBindingSource;
  messageBindingConfidence?: CanonicalBindingConfidence;
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
  protocolId: RuntimeProtocolId;
  runtimeEndpointId: RuntimeEndpointId;
  context: RuntimeSessionContext;
  eventIds: string[];
  eventIdSet: Set<string>;
  messageIndexByKey: Map<string, number>;
  messageIndexByMessageKey: Map<string, number>;
  thoughtIndexByKey: Map<string, number>;
  toolIndexByKey: Map<string, number>;
  toolKeysByOwnerMessageKey: Map<string, string[]>;
  thoughtKeysByOwnerMessageKey: Map<string, string[]>;
  toolKeysByOwnerTurnKey: Map<string, string[]>;
  thoughtKeysByOwnerTurnKey: Map<string, string[]>;
  approvalIndexById: Map<string, number>;
  terminalRunIds: Set<string>;
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

function appendOwnerKey(map: Map<string, string[]>, ownerKey: string | undefined, valueKey: string): void {
  if (!ownerKey) {
    return;
  }
  const current = map.get(ownerKey);
  if (!current) {
    map.set(ownerKey, [valueKey]);
    return;
  }
  current.push(valueKey);
}

export function rebuildCanonicalSessionIndexes(state: CanonicalSessionState): void {
  state.eventIdSet = new Set(state.eventIds);
  state.messageIndexByKey = new Map(state.messages.map((message, index) => [message.key, index]));
  state.messageIndexByMessageKey = new Map(
    state.messages
      .map((message, index) => [message.ownerMessageKey ?? message.key, index] as const),
  );
  state.thoughtIndexByKey = new Map(state.thoughts.map((thought, index) => [thought.key, index]));
  state.toolIndexByKey = new Map(state.tools.map((tool, index) => [tool.key, index]));
  state.toolKeysByOwnerMessageKey = new Map<string, string[]>();
  state.thoughtKeysByOwnerMessageKey = new Map<string, string[]>();
  state.toolKeysByOwnerTurnKey = new Map<string, string[]>();
  state.thoughtKeysByOwnerTurnKey = new Map<string, string[]>();
  for (const tool of state.tools) {
    appendOwnerKey(state.toolKeysByOwnerMessageKey, tool.ownerMessageKey, tool.key);
    appendOwnerKey(state.toolKeysByOwnerTurnKey, tool.ownerTurnKey, tool.key);
  }
  for (const thought of state.thoughts) {
    appendOwnerKey(state.thoughtKeysByOwnerMessageKey, thought.ownerMessageKey, thought.key);
    appendOwnerKey(state.thoughtKeysByOwnerTurnKey, thought.ownerTurnKey, thought.key);
  }
  state.approvalIndexById = new Map(state.approvals.map((approval, index) => [approval.id, index]));
  state.terminalRunIds = new Set(state.terminalRunIds ?? []);
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
