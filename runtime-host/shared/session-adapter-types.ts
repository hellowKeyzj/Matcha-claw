import type { GatewayTransportIssue } from './gateway-error';

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

export type SessionTurnIdentityMode =
  | 'tool_call'
  | 'run'
  | 'message'
  | 'origin'
  | 'client'
  | 'heuristic';

export type SessionTurnBindingConfidence = 'strong' | 'fallback';
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

export type SessionExecutionGraphStepStatus = 'running' | 'completed' | 'error' | 'missing_result';
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

export type SessionRunPhase =
  | 'idle'
  | 'submitted'
  | 'streaming'
  | 'waiting_tool'
  | 'finalizing'
  | 'done'
  | 'error'
  | 'aborted';

export type SessionRuntimeActivity = 'compacting';

export interface SessionRuntimeStateSnapshot {
  activeRunId: string | null;
  runPhase: SessionRunPhase;
  activeTurnItemKey: string | null;
  pendingTurnKey: string | null;
  pendingTurnLaneKey: string | null;
  runtimeActivity: SessionRuntimeActivity | null;
  lastUserMessageAt: number | null;
  lastError: string | null;
  lastIssue: GatewayTransportIssue | null;
  updatedAt: number | null;
}

const ACTIVE_RUN_PHASES: ReadonlySet<SessionRunPhase> = new Set([
  'submitted',
  'streaming',
  'waiting_tool',
  'finalizing',
]);

/**
 * 单一事实源：runPhase 决定运行态。
 * isRunActive = 当前回合正在被 Gateway 处理（已 submit、还没收到 final/error/aborted）
 */
export function isRunActive(runtime: { runPhase: SessionRunPhase }): boolean {
  return ACTIVE_RUN_PHASES.has(runtime.runPhase);
}

/**
 * 是否在等工具结果（运行中且某个 tool 还在 running）。
 */
export function isWaitingTool(runtime: { runPhase: SessionRunPhase }): boolean {
  return runtime.runPhase === 'waiting_tool';
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
  gatewayUrl?: string;
  source?: 'user-upload' | 'tool-result' | 'message-ref';
}

export interface SessionRenderImage {
  url?: string;
  data?: string;
  mimeType: string;
}

export type SessionRenderToolStatusKind = 'running' | 'completed' | 'error' | 'missing_result';

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
  status: SessionRenderToolStatusKind;
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
    | 'user-message'
    | 'assistant-turn'
    | 'execution-graph'
    | 'system';
  sessionKey: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt?: number;
  updatedAt?: number;
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
}

export interface SessionTimelineUserMessageEntry extends SessionTimelineEntryBase {
  kind: 'user-message';
  role: 'user';
  images: ReadonlyArray<SessionRenderImage>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
}

/**
 * Render projection for one assistant turn.
 *
 * Authoritative ordering lives in `segments`, projected from canonical message
 * snapshots and canonical tool events for the same run/lane.
 */
export interface SessionTimelineAssistantTurnEntry extends SessionTimelineEntryBase {
  kind: 'assistant-turn';
  role: 'assistant';
  segments: ReadonlyArray<SessionAssistantTurnSegment>;
  isStreaming: boolean;
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
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
  | SessionTimelineUserMessageEntry
  | SessionTimelineAssistantTurnEntry
  | SessionRenderExecutionGraphItem
  | SessionRenderSystemItem;

export type SessionExecutionGraphItem = SessionRenderExecutionGraphItem;

export interface SessionRenderItemBase {
  key: string;
  kind: 'user-message' | 'assistant-turn' | 'execution-graph' | 'system';
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
  identityMode: SessionTurnIdentityMode;
  identityConfidence: SessionTurnIdentityConfidence;
  status: 'streaming' | 'waiting_tool' | 'final' | 'error' | 'aborted';
  /** Authoritative presentation order projected from canonical state. */
  segments: ReadonlyArray<SessionAssistantTurnSegment>;
  thinking: string | null;
  tools: ReadonlyArray<SessionRenderToolCard>;
  embeddedToolResults?: ReadonlyArray<SessionRenderAssistantBubbleToolResult>;
  text: string;
  images: ReadonlyArray<SessionRenderImage>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  pendingState?: 'typing' | 'activity' | 'compacting' | null;
}

export type SessionRenderItem =
  | SessionRenderUserMessageItem
  | SessionAssistantTurnItem
  | SessionRenderExecutionGraphItem
  | SessionRenderSystemItem;

export type SessionTimelineItem = SessionTimelineEntry;

export type SessionApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

export interface SessionApprovalRequestItem {
  id: string;
  sessionKey: string;
  runId?: string;
  title: string;
  command?: string;
  allowedDecisions: ReadonlyArray<SessionApprovalDecision>;
  request?: Record<string, unknown>;
  createdAtMs: number;
  expiresAtMs?: number;
}

export interface SessionUsageSnapshotItem {
  id: string;
  sessionKey: string;
  runId?: string;
  timestamp?: number;
  payload: unknown;
}

export interface SessionArtifactSnapshotItem {
  id: string;
  sessionKey: string;
  runId?: string;
  timestamp?: number;
  payload: unknown;
}

export interface SessionStateSnapshot {
  sessionKey: string;
  catalog: SessionCatalogItem;
  items: SessionRenderItem[];
  approvals: SessionApprovalRequestItem[];
  usage: SessionUsageSnapshotItem[];
  artifacts: SessionArtifactSnapshotItem[];
  taskSnapshot?: TaskSnapshotEvent;
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
  status?: 'active' | 'completed' | 'archived' | 'deleted';
  label?: string;
  titleSource?: SessionCatalogTitleSource;
  displayName?: string;
  model?: string;
  updatedAt?: number;
}

export interface SessionListResult {
  sessions: SessionCatalogItem[];
  ready: boolean;
  refreshing: boolean;
  updatedAt: number | null;
  error: string | null;
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
  error: string | null;
  transportIssue?: GatewayTransportIssue | null;
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

export interface SessionPlanUpdateEvent {
  sessionUpdate: 'plan';
  sessionKey: string | null;
  runId: string | null;
  taskSnapshot: TaskSnapshotEvent;
  snapshot: SessionStateSnapshot;
  _meta?: Record<string, unknown>;
}

export type SessionUpdateEvent =
  | SessionInfoUpdateEvent
  | SessionItemChunkUpdateEvent
  | SessionItemUpdateEvent
  | SessionPlanUpdateEvent;

export interface SessionPromptResult {
  success: boolean;
  sessionKey: string;
  runId: string | null;
  item: SessionRenderItem | null;
  snapshot: SessionStateSnapshot;
}

export interface SessionNewResult {
  success: boolean;
  sessionKey: string;
  snapshot: SessionStateSnapshot;
}

export type TaskDataStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface TaskData {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskDataStatus;
  metadata?: Record<string, unknown>;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  createdAt?: number;
  updatedAt?: number;
  content?: string;
  dependencies?: string[];
}

export interface TodoItem {
  id?: string;
  content: string;
  activeForm?: string;
  status: TaskDataStatus;
  owner?: string;
}

export interface TaskScopeSnapshot {
  type: 'session' | 'team';
  key: string;
  label: string;
  sessionKey?: string;
  teamKey?: string;
  agentId?: string;
}

export interface TaskSnapshotEvent {
  sessionKey: string;
  scope?: TaskScopeSnapshot;
  tasks: TaskData[];
  todos?: TodoItem[];
  source: 'tool' | 'todo' | 'plan' | 'artifact' | 'replay';
  enableEdit?: boolean;
  uri?: string;
}
