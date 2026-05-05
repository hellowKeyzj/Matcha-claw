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

export type SessionTurnBindingSource =
  | 'tool_call'
  | 'run'
  | 'message'
  | 'origin'
  | 'client'
  | 'heuristic';

/**
 * Assistant turn identity mode.
 *
 * Rules:
 * - `tool_call` means the turn was anchored by authoritative `toolCallId`.
 * - `run` means the turn was anchored by authoritative live `runId`.
 * - `message` means the turn was anchored by authoritative assistant `messageId`.
 * - `origin` / `client` are supplemental upstream identities only.
 * - `heuristic` means no strong upstream turn identity existed; binding is controlled fallback only.
 *
 * Explicitly not supported as turn identity:
 * - `uniqueId`
 * - `requestId`
 * - any legacy row-era synthetic pseudo turn id
 */
export type SessionTurnIdentityMode =
  | 'tool_call'
  | 'run'
  | 'message'
  | 'origin'
  | 'client'
  | 'heuristic';

export type SessionTurnBindingConfidence = 'strong' | 'fallback';
/**
 * Binding confidence for the final assistant-turn render model.
 *
 * - `strong`: backed by authoritative upstream identity.
 * - `fallback`: controlled heuristic grouping only, not guaranteed 100% exact.
 */
export type SessionTurnIdentityConfidence = 'strong' | 'fallback';

export interface SessionTaskCompletionEvent {
  kind: 'task_completion';
  source: 'subagent' | 'cron' | 'unknown';
  childSessionKey: string;
  sequenceId?: number;
  laneKey?: string;
  turnKey?: string;
  turnBindingSource?: SessionTurnBindingSource;
  turnBindingConfidence?: SessionTurnBindingConfidence;
  turnIdentityMode?: SessionTurnIdentityMode;
  turnIdentityConfidence?: SessionTurnIdentityConfidence;
  agentId?: string;
  sourceRole?: SessionMessageRole;
  assistantTurnKey?: string | null;
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
  activeTurnItemKey: string | null;
  pendingTurnKey: string | null;
  pendingTurnLaneKey: string | null;
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
  output?: unknown;
  outputText?: string;
}

export interface SessionRenderToolUse {
  id: string;
  toolCallId?: string;
  name: string;
  input: unknown;
  status?: SessionRenderToolStatus['status'];
  summary?: string;
  durationMs?: number;
}

export interface SessionRenderToolPreviewCanvas {
  kind: 'canvas';
  surface: 'assistant_message';
  render: 'url';
  title?: string;
  preferredHeight?: number;
  url: string;
  viewId: string;
}

export type SessionRenderToolPreview = SessionRenderToolPreviewCanvas;

export interface SessionRenderToolResultNone {
  kind: 'none';
  surface: 'tool-card';
}

export interface SessionRenderToolResultText {
  kind: 'text';
  surface: 'tool-card';
  collapsedPreview: string;
  bodyText: string;
}

export interface SessionRenderToolResultJson {
  kind: 'json';
  surface: 'tool-card';
  collapsedPreview: string;
  bodyText: string;
}

export interface SessionRenderToolResultCanvas {
  kind: 'canvas';
  surface: 'assistant-bubble';
  collapsedPreview: string;
  preview: SessionRenderToolPreview;
  rawText?: string;
}

export type SessionRenderToolResult =
  | SessionRenderToolResultNone
  | SessionRenderToolResultText
  | SessionRenderToolResultJson
  | SessionRenderToolResultCanvas;

export interface SessionRenderAssistantBubbleToolResult {
  key: string;
  toolCallId?: string;
  toolName: string;
  preview: SessionRenderToolPreview;
  rawText?: string;
}

export interface SessionRenderToolCard {
  id: string;
  toolCallId?: string;
  name: string;
  displayTitle: string;
  displayDetail?: string;
  input: unknown;
  inputText?: string;
  status: SessionRenderToolStatus['status'];
  summary?: string;
  durationMs?: number;
  updatedAt?: number;
  output?: unknown;
  result: SessionRenderToolResult;
}

export interface SessionAssistantThinkingSegment {
  kind: 'thinking';
  key: string;
  text: string;
}

export interface SessionAssistantToolSegment {
  kind: 'tool';
  key: string;
  tool: SessionRenderToolCard;
}

export interface SessionAssistantMessageSegment {
  kind: 'message';
  key: string;
  text: string;
}

export interface SessionAssistantMediaSegment {
  kind: 'media';
  key: string;
  images: ReadonlyArray<SessionRenderImage>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
}

export type SessionAssistantTurnSegment =
  | SessionAssistantThinkingSegment
  | SessionAssistantToolSegment
  | SessionAssistantMessageSegment
  | SessionAssistantMediaSegment;

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
  turnBindingSource?: SessionTurnBindingSource;
  turnBindingConfidence?: SessionTurnBindingConfidence;
  turnIdentityMode?: SessionTurnIdentityMode;
  turnIdentityConfidence?: SessionTurnIdentityConfidence;
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
  assistantSegments: ReadonlyArray<SessionAssistantTurnSegment>;
  images: ReadonlyArray<SessionRenderImage>;
  toolUses: ReadonlyArray<SessionRenderToolUse>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  toolStatuses: ReadonlyArray<SessionRenderToolStatus>;
  toolCards: ReadonlyArray<SessionRenderToolCard>;
  isStreaming: boolean;
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
}

export interface SessionTimelineToolActivityEntry extends SessionTimelineEntryBase {
  kind: 'tool-activity';
  role: 'assistant';
  assistantSegments: ReadonlyArray<SessionAssistantTurnSegment>;
  toolUses: ReadonlyArray<SessionRenderToolUse>;
  toolStatuses: ReadonlyArray<SessionRenderToolStatus>;
  toolCards: ReadonlyArray<SessionRenderToolCard>;
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
  identitySource: SessionTurnBindingSource;
  /**
   * `messageId` is optional in upstream history and must not be assumed to exist.
   * `toolCallId` is the strongest tool identity when present.
   */
  identityMode: SessionTurnIdentityMode;
  identityConfidence: SessionTurnIdentityConfidence;
  status: 'streaming' | 'waiting_tool' | 'final' | 'error' | 'aborted';
  /**
   * Authoritative presentation order for one assistant turn.
   *
   * The UI must render assistant turns from `segments`, not by independently
   * arranging `thinking`, `tools`, `text`, or media summary fields.
   */
  segments: ReadonlyArray<SessionAssistantTurnSegment>;
  /**
   * Derived convenience summary built from `segments`.
   */
  thinking: string | null;
  /**
   * Derived convenience summary built from `segments`.
   */
  tools: ReadonlyArray<SessionRenderToolCard>;
  /**
   * Derived convenience summary built from `segments`.
   */
  embeddedToolResults?: ReadonlyArray<SessionRenderAssistantBubbleToolResult>;
  /**
   * Derived convenience summary built from `segments`.
   */
  text: string;
  /**
   * Derived convenience summary built from `segments`.
   */
  images: ReadonlyArray<SessionRenderImage>;
  /**
   * Derived convenience summary built from `segments`.
   */
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
