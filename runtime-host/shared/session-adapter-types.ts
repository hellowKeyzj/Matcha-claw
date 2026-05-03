export type SessionTimelineEntryRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'toolresult'
  | 'tool_result';

export type SessionTimelineEntryStatus =
  | 'pending'
  | 'streaming'
  | 'final'
  | 'error'
  | 'aborted';

export interface SessionTaskCompletionEvent {
  kind: 'task_completion';
  source: 'subagent' | 'cron' | 'unknown';
  childSessionKey: string;
  childSessionId?: string;
  childAgentId?: string;
  announceType?: string;
  taskLabel?: string;
  statusLabel?: string;
  result?: string;
  statsLine?: string;
  replyInstruction?: string;
}

export type SessionExecutionGraphStepStatus = 'running' | 'completed' | 'error';
export type SessionExecutionGraphStepKind = 'thinking' | 'tool' | 'system';

export interface SessionExecutionGraphStep {
  id: string;
  label: string;
  status: SessionExecutionGraphStepStatus;
  kind: SessionExecutionGraphStepKind;
  detail?: string;
  depth: number;
  parentId?: string;
}

export interface SessionExecutionGraph {
  id: string;
  anchorEntryId: string;
  anchorTurnKey?: string;
  anchorLaneKey?: string;
  triggerEntryId: string;
  replyEntryId?: string;
  childSessionKey: string;
  childSessionId?: string;
  childAgentId?: string;
  agentLabel: string;
  sessionLabel: string;
  steps: SessionExecutionGraphStep[];
  active: boolean;
}

export interface SessionTimelineEntryMessage {
  role: SessionTimelineEntryRole;
  content: unknown;
  timestamp?: number;
  id?: string;
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
  uniqueId?: string;
  requestId?: string;
  status?: 'sending' | 'sent' | 'timeout' | 'error';
  streaming?: boolean;
  agentId?: string;
  toolCallId?: string;
  tool_calls?: Array<Record<string, unknown>>;
  toolCalls?: Array<Record<string, unknown>>;
  toolName?: string;
  metadata?: Record<string, unknown>;
  name?: string;
  details?: unknown;
  toolStatuses?: Array<Record<string, unknown>>;
  taskCompletionEvents?: SessionTaskCompletionEvent[];
  isError?: boolean;
  _attachedFiles?: Array<Record<string, unknown>>;
}

export interface SessionTimelineEntry {
  entryId: string;
  sessionKey: string;
  laneKey: string;
  turnKey: string;
  role: SessionTimelineEntryRole;
  status: SessionTimelineEntryStatus;
  timestamp?: number;
  runId?: string;
  agentId?: string;
  sequenceId?: number;
  text: string;
  message: SessionTimelineEntryMessage;
}

export interface SessionRuntimeStateSnapshot {
  sending: boolean;
  activeRunId: string | null;
  runPhase: 'idle' | 'submitted' | 'streaming' | 'waiting_tool' | 'finalizing' | 'done' | 'error' | 'aborted';
  streamingMessageId: string | null;
  pendingFinal: boolean;
  lastUserMessageAt: number | null;
  updatedAt: number | null;
}

export interface SessionWindowStateSnapshot {
  totalEntryCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
}

export interface SessionRenderAttachedFile {
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  filePath?: string;
}

export interface SessionRenderImage {
  url?: string;
  data?: string;
  mimeType: string;
}

export interface SessionRenderToolStatus {
  id?: string;
  toolCallId?: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  durationMs?: number;
  summary?: string;
  updatedAt?: number;
}

export interface SessionRenderToolUse {
  id: string;
  name: string;
  input: unknown;
  status?: SessionRenderToolStatus['status'];
  summary?: string;
  durationMs?: number;
}

export interface SessionRenderRowBase {
  key: string;
  kind:
    | 'message'
    | 'tool-activity'
    | 'task-completion'
    | 'pending-assistant'
    | 'execution-graph'
    | 'system';
  sessionKey: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt?: number;
  status?: SessionTimelineEntryStatus;
  runId?: string;
  entryId?: string;
  laneKey?: string;
  turnKey?: string;
  agentId?: string;
  assistantTurnKey?: string | null;
  assistantLaneKey?: string | null;
  assistantLaneAgentId?: string | null;
}

export interface SessionMessageRow extends SessionRenderRowBase {
  kind: 'message';
  text: string;
  thinking: string | null;
  images: ReadonlyArray<SessionRenderImage>;
  toolUses: ReadonlyArray<SessionRenderToolUse>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  toolStatuses: ReadonlyArray<SessionRenderToolStatus>;
  isStreaming: boolean;
  messageId?: string;
}

export interface SessionToolActivityRow extends SessionRenderRowBase {
  kind: 'tool-activity';
  role: 'assistant';
  toolUses: ReadonlyArray<SessionRenderToolUse>;
  toolStatuses: ReadonlyArray<SessionRenderToolStatus>;
  isStreaming: boolean;
}

export interface SessionTaskCompletionRow extends SessionRenderRowBase {
  kind: 'task-completion';
  role: 'system';
  childSessionKey: string;
  childSessionId?: string;
  childAgentId?: string;
  taskLabel?: string;
  statusLabel?: string;
  result?: string;
  statsLine?: string;
  replyInstruction?: string;
}

export interface SessionPendingAssistantRow extends SessionRenderRowBase {
  kind: 'pending-assistant';
  role: 'assistant';
  pendingState: 'typing' | 'activity';
}

export interface SessionExecutionGraphRow extends SessionRenderRowBase {
  kind: 'execution-graph';
  role: 'assistant';
  graphId: string;
  childSessionKey: string;
  childSessionId?: string;
  childAgentId?: string;
  agentLabel: string;
  sessionLabel: string;
  steps: ReadonlyArray<SessionExecutionGraphStep>;
  active: boolean;
  triggerRowKey?: string;
  replyRowKey?: string;
}

export interface SessionSystemRow extends SessionRenderRowBase {
  kind: 'system';
  role: 'system';
  level: 'info' | 'warning' | 'error';
}

export type SessionRenderRow =
  | SessionMessageRow
  | SessionToolActivityRow
  | SessionTaskCompletionRow
  | SessionPendingAssistantRow
  | SessionExecutionGraphRow
  | SessionSystemRow;

export interface SessionStateSnapshot {
  sessionKey: string;
  rows: SessionRenderRow[];
  replayComplete: boolean;
  runtime: SessionRuntimeStateSnapshot;
  window: SessionWindowStateSnapshot;
}

export interface SessionLoadResult {
  snapshot: SessionStateSnapshot;
}

export interface SessionCatalogItem {
  key: string;
  label?: string;
  displayName?: string;
  updatedAt?: number;
}

export interface SessionListResult {
  sessions: SessionCatalogItem[];
}

export interface SessionWindowResult {
  snapshot: SessionStateSnapshot;
}

export interface SessionInfoUpdateEvent {
  sessionUpdate: 'session_info_update';
  sessionKey: string | null;
  runId: string | null;
  phase: 'started' | 'final' | 'error' | 'aborted' | 'unknown';
  snapshot: SessionStateSnapshot;
  _meta?: Record<string, unknown>;
}

export interface SessionRowChunkUpdateEvent {
  sessionUpdate: 'session_row_chunk';
  sessionKey: string | null;
  runId: string | null;
  row: SessionRenderRow | null;
  snapshot: SessionStateSnapshot;
  _meta?: Record<string, unknown>;
}

export interface SessionRowUpdateEvent {
  sessionUpdate: 'session_row';
  sessionKey: string | null;
  runId: string | null;
  row: SessionRenderRow | null;
  snapshot: SessionStateSnapshot;
  _meta?: Record<string, unknown>;
}

export type SessionUpdateEvent =
  | SessionInfoUpdateEvent
  | SessionRowChunkUpdateEvent
  | SessionRowUpdateEvent;

export interface SessionPromptResult {
  success: boolean;
  sessionKey: string;
  runId: string | null;
  promptId: string;
  row: SessionRenderRow | null;
  snapshot: SessionStateSnapshot;
}

export interface SessionNewResult {
  success: boolean;
  sessionKey: string;
  snapshot: SessionStateSnapshot;
}
