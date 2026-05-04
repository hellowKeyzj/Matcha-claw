export type SessionMessageRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'toolresult'
  | 'tool_result';

export type SessionRowStatus =
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
export type SessionCatalogKind = 'main' | 'subsession' | 'session' | 'named';
export type SessionCatalogTitleSource = 'user' | 'assistant' | 'none';

export interface SessionExecutionGraphStep {
  id: string;
  label: string;
  status: SessionExecutionGraphStepStatus;
  kind: SessionExecutionGraphStepKind;
  detail?: string;
  depth: number;
  parentId?: string;
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
  totalRowCount: number;
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
  status?: SessionRowStatus;
  runId?: string;
  rowId?: string;
  sequenceId?: number;
  laneKey?: string;
  turnKey?: string;
  agentId?: string;
  sourceRole?: SessionMessageRole;
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
  originMessageId?: string;
  clientId?: string;
  uniqueId?: string;
  requestId?: string;
}

export interface SessionToolActivityRow extends SessionRenderRowBase {
  kind: 'tool-activity';
  role: 'assistant';
  toolUses: ReadonlyArray<SessionRenderToolUse>;
  toolStatuses: ReadonlyArray<SessionRenderToolStatus>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
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
  anchorRowKey?: string;
  triggerRowKey?: string;
  replyRowKey?: string;
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
  completionRowKey: string;
  anchorRowKey?: string;
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
  catalog: SessionCatalogItem;
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
  agentId: string;
  kind: SessionCatalogKind;
  preferred: boolean;
  label?: string;
  titleSource?: SessionCatalogTitleSource;
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
