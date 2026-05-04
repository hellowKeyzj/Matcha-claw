export type SessionMessageRole =
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
  streamingAnchorKey: string | null;
  pendingFinal: boolean;
  lastUserMessageAt: number | null;
  updatedAt: number | null;
}

export interface SessionWindowStateSnapshot {
  totalItemCount: number;
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

export interface SessionTimelineEntryBase {
  key: string;
  kind:
    | 'message'
    | 'tool-activity'
    | 'task-completion'
    | 'execution-graph'
    | 'system';
  sessionKey: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt?: number;
  status?: SessionTimelineEntryStatus;
  runId?: string;
  entryId?: string;
  sequenceId?: number;
  laneKey?: string;
  turnKey?: string;
  agentId?: string;
  sourceRole?: SessionMessageRole;
  assistantTurnKey?: string | null;
  assistantLaneKey?: string | null;
  assistantLaneAgentId?: string | null;
}

export interface SessionTimelineMessageEntry extends SessionTimelineEntryBase {
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

export interface SessionTimelineToolActivityEntry extends SessionTimelineEntryBase {
  kind: 'tool-activity';
  role: 'assistant';
  toolUses: ReadonlyArray<SessionRenderToolUse>;
  toolStatuses: ReadonlyArray<SessionRenderToolStatus>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  isStreaming: boolean;
}

export interface SessionTimelineTaskCompletionEntry extends SessionTimelineEntryBase {
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
  anchorItemKey?: string;
  triggerItemKey?: string;
  replyItemKey?: string;
}

export interface SessionRenderExecutionGraphItem extends SessionTimelineEntryBase {
  kind: 'execution-graph';
  role: 'assistant';
  graphId: string;
  completionItemKey: string;
  anchorItemKey?: string;
  childSessionKey: string;
  childSessionId?: string;
  childAgentId?: string;
  agentLabel: string;
  sessionLabel: string;
  steps: ReadonlyArray<SessionExecutionGraphStep>;
  active: boolean;
  triggerItemKey?: string;
  replyItemKey?: string;
}

export interface SessionRenderSystemItem extends SessionTimelineEntryBase {
  kind: 'system';
  role: 'system';
  level: 'info' | 'warning' | 'error';
}

export type SessionTimelineEntry =
  | SessionTimelineMessageEntry
  | SessionTimelineToolActivityEntry
  | SessionTimelineTaskCompletionEntry
  | SessionRenderExecutionGraphItem
  | SessionRenderSystemItem;
export type SessionExecutionGraphItem = SessionRenderExecutionGraphItem;

export interface SessionRenderItemBase {
  key: string;
  kind: 'user-message' | 'assistant-turn' | 'task-completion' | 'execution-graph' | 'system';
  sessionKey: string;
  createdAt?: number;
  updatedAt?: number;
  runId?: string;
  laneKey?: string;
  turnKey?: string;
  agentId?: string;
}

export interface SessionRenderUserMessageItem extends SessionRenderItemBase {
  kind: 'user-message';
  role: 'user';
  text: string;
  images: ReadonlyArray<SessionRenderImage>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  messageId?: string;
}

export interface SessionAssistantTurnItem extends SessionRenderItemBase {
  kind: 'assistant-turn';
  role: 'assistant';
  status: 'streaming' | 'waiting_tool' | 'final' | 'error' | 'aborted';
  thinking: string | null;
  toolCalls: ReadonlyArray<SessionRenderToolUse>;
  toolStatuses: ReadonlyArray<SessionRenderToolStatus>;
  text: string;
  images: ReadonlyArray<SessionRenderImage>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  pendingState?: 'typing' | 'activity' | null;
}

export interface SessionRenderTaskCompletionItem extends SessionRenderItemBase {
  kind: 'task-completion';
  role: 'system';
  text: string;
  childSessionKey: string;
  childSessionId?: string;
  childAgentId?: string;
  taskLabel?: string;
  statusLabel?: string;
  result?: string;
  statsLine?: string;
  replyInstruction?: string;
  anchorItemKey?: string;
  triggerItemKey?: string;
  replyItemKey?: string;
}

export type SessionRenderItem =
  | SessionRenderUserMessageItem
  | SessionAssistantTurnItem
  | SessionRenderTaskCompletionItem
  | SessionRenderExecutionGraphItem
  | SessionRenderSystemItem;

export interface SessionStateSnapshot {
  sessionKey: string;
  catalog: SessionCatalogItem;
  items: SessionRenderItem[];
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

export interface SessionItemChunkUpdateEvent {
  sessionUpdate: 'session_item_chunk';
  sessionKey: string | null;
  runId: string | null;
  item: SessionRenderItem | null;
  snapshot: SessionStateSnapshot;
  _meta?: Record<string, unknown>;
}

export interface SessionItemUpdateEvent {
  sessionUpdate: 'session_item';
  sessionKey: string | null;
  runId: string | null;
  item: SessionRenderItem | null;
  snapshot: SessionStateSnapshot;
  _meta?: Record<string, unknown>;
}

export type SessionUpdateEvent =
  | SessionInfoUpdateEvent
  | SessionItemChunkUpdateEvent
  | SessionItemUpdateEvent;

export interface SessionPromptResult {
  success: boolean;
  sessionKey: string;
  runId: string | null;
  promptId: string;
  item: SessionRenderItem | null;
  snapshot: SessionStateSnapshot;
}

export interface SessionNewResult {
  success: boolean;
  sessionKey: string;
  snapshot: SessionStateSnapshot;
}
