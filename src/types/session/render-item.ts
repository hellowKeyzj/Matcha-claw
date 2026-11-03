import type { SessionIdentity } from '../desktop/runtime-address';
import type {
  SessionAssistantTurnSegment,
  SessionLargeTextMetadata,
  SessionRenderAssistantBubbleToolResult,
  SessionRenderAttachedFile,
  SessionRenderContentNotice,
  SessionRenderImage,
  SessionRenderToolCard,
  SessionTimelineContentBlock,
} from './tool-card';

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
  childSessionIdentity?: SessionIdentity;
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

export interface SessionExecutionGraphStep {
  id: string;
  label: string;
  status: SessionExecutionGraphStepStatus;
  kind: SessionExecutionGraphStepKind;
  detail?: string;
  depth: number;
  parentId?: string;
}

export interface SessionTimelineMessage {
  role: SessionMessageRole;
  text: string;
  messageId?: string;
  parentMessageId?: string;
  parentId?: string;
  originMessageId?: string;
  origin?: string;
  toolCallId?: string;
  runId?: string;
  sequenceId?: number;
  createdAt?: number;
  updatedAt?: number;
  content?: ReadonlyArray<SessionTimelineContentBlock>;
}

export interface SessionTimelineRichMessage extends SessionTimelineMessage {
  role: SessionMessageRole;
}

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
  childSessionIdentity?: SessionIdentity;
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

export interface SessionImageGenerationPendingState {
  active: boolean;
  pendingTaskIds: ReadonlyArray<string>;
}

const IMAGE_GENERATION_TOOL_NAME_PATTERN = /(?:^|[_:-])image[_:-]?(?:generate|generation)(?:$|[_:-])|(?:^|[_:-])generate[_:-]?image(?:$|[_:-])/i;

export function isSessionImageGenerationToolName(value: string | null | undefined): boolean {
  return typeof value === 'string' && IMAGE_GENERATION_TOOL_NAME_PATTERN.test(value);
}

type SessionImageGenerationTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'deleted';

export function sessionImageGenerationTask(tool: SessionRenderToolCard): { taskId: string; runId: string | null; status: SessionImageGenerationTaskStatus } | null {
  if (tool.runtimeAdapterId !== 'openclaw' || tool.name !== 'image_generate'
    || !tool.details || typeof tool.details !== 'object') return null;
  const details = tool.details as Record<string, unknown>;
  const task = details.task;
  if (!task || typeof task !== 'object') return null;
  const { taskId, status, runId } = task as Record<string, unknown>;
  if (typeof taskId !== 'string' || !taskId || taskId !== details.taskId) return null;
  if (status !== 'queued' && status !== 'running' && status !== 'completed'
    && status !== 'failed' && status !== 'timed_out' && status !== 'cancelled' && status !== 'deleted') return null;
  const taskRunId = typeof runId === 'string' && runId ? runId : details.runId;
  return { taskId, runId: typeof taskRunId === 'string' && taskRunId ? taskRunId : null, status };
}

export function deriveSessionImageGenerationPendingStateFromItems(
  items: ReadonlyArray<SessionRenderItem>,
): SessionImageGenerationPendingState {
  const taskIds = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'assistant-turn') continue;
    for (const tool of item.tools) {
      if (!isSessionImageGenerationToolName(tool.name)) continue;
      const task = sessionImageGenerationTask(tool);
      if (task ? task.status === 'queued' || task.status === 'running'
        : tool.status === 'running' && (item.status === 'streaming' || item.status === 'waiting_tool')) {
        taskIds.add(task?.taskId ?? tool.toolCallId ?? tool.id);
      }
    }
  }
  const pendingTaskIds = [...taskIds];
  return { active: pendingTaskIds.length > 0, pendingTaskIds };
}

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
  contentNotices?: ReadonlyArray<SessionRenderContentNotice>;
  largeText?: SessionLargeTextMetadata;
  messageId?: string;
  clientId?: string;
  status?: 'pending' | 'sending';
  /** Renderer-only receipt for an accepted attachment send. */
  rendererReceiptRunId?: string;
}

export interface SessionAssistantTurnItem extends SessionRenderItemBase {
  kind: 'assistant-turn';
  role: 'assistant';
  messageId?: string;
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
  pendingLabel?: string | null;
}

export type SessionRenderItem =
  | SessionRenderUserMessageItem
  | SessionAssistantTurnItem
  | SessionRenderExecutionGraphItem
  | SessionRenderSystemItem;

export type SessionTimelineItem = SessionTimelineEntry;
