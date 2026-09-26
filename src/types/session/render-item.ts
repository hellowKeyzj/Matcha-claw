import type { SessionIdentity } from '../desktop/runtime-address';
import type {
  SessionAssistantTurnSegment,
  SessionLargeTextMetadata,
  SessionRenderAssistantBubbleToolResult,
  SessionRenderAttachedFile,
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

type SessionImageGenerationToolCandidate = Pick<SessionRenderToolCard, 'id' | 'toolCallId' | 'name' | 'status'>
  & Partial<Pick<SessionRenderToolCard, 'summary' | 'inputText' | 'output' | 'result'>>;

const IMAGE_GENERATION_BACKGROUND_START_PATTERN = /^Background task started for image generation\s*\(([0-9a-f-]{36})\)\.?/i;

function stringifyToolPayload(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  return typeof value === 'string' ? value : JSON.stringify(value) ?? null;
}

function imageGenerationToolTextCandidates(tool: SessionImageGenerationToolCandidate): string[] {
  const result = tool.result;
  return [
    tool.summary,
    tool.inputText,
    stringifyToolPayload(tool.output),
    result && 'collapsedPreview' in result ? result.collapsedPreview : null,
    result && 'bodyText' in result ? result.bodyText : null,
    result && 'rawText' in result ? result.rawText : null,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function imageGenerationBackgroundTaskId(tool: SessionImageGenerationToolCandidate): string | null {
  for (const text of imageGenerationToolTextCandidates(tool)) {
    const match = IMAGE_GENERATION_BACKGROUND_START_PATTERN.exec(text.trim());
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function hasImageGenerationBackgroundStart(tool: SessionImageGenerationToolCandidate): boolean {
  return imageGenerationBackgroundTaskId(tool) != null;
}

function imageGenerationToolTaskId(tool: SessionImageGenerationToolCandidate): string {
  return imageGenerationBackgroundTaskId(tool) ?? tool.toolCallId ?? tool.id;
}

export function isSessionImageGenerationStatusNarration(text: string): boolean {
  const value = text.trim();
  if (!value) {
    return false;
  }
  if (IMAGE_GENERATION_BACKGROUND_START_PATTERN.test(value)) {
    return true;
  }
  if (value.length > 120) {
    return false;
  }
  if (/^(?:图片(?:正在)?生成中|正在生成(?:图片|图像)|生成中)[，,。！!\s]*(?:请)?(?:稍候|稍等|等一下)?[，,。！!\s]*$/i.test(value)) {
    return true;
  }
  return /(?:稍等|稍候|please wait|one moment)/i.test(value) && /(?:图片|图像|image|generat)/i.test(value);
}

function hasImageGenerationMedia(item: SessionAssistantTurnItem): boolean {
  return item.images.length > 0
    || item.attachedFiles.some((file) => file.mimeType.toLowerCase().startsWith('image/') || !!file.gatewayUrl)
    || item.segments.some((segment) => (
      segment.kind === 'media'
      && (
        segment.images.length > 0
        || segment.attachedFiles.some((file) => file.mimeType.toLowerCase().startsWith('image/') || !!file.gatewayUrl)
      )
    ));
}

function hasImageGenerationCompletionContent(item: SessionAssistantTurnItem): boolean {
  if (hasImageGenerationMedia(item)) {
    return true;
  }
  const text = item.text.trim();
  return text.length > 0
    && !isSessionImageGenerationStatusNarration(text)
    && /(?:图片|图像|image|generat|生成|failed|failure|error|失败|出错|无法|cannot|unable)/i.test(text);
}

export function deriveSessionImageGenerationPendingStateFromItems(
  items: ReadonlyArray<SessionRenderItem>,
  current?: SessionImageGenerationPendingState | null,
): SessionImageGenerationPendingState {
  const taskIds = new Set(current?.pendingTaskIds ?? []);
  for (const item of items) {
    if (item.kind !== 'assistant-turn') {
      continue;
    }
    for (const tool of item.tools) {
      if (!isSessionImageGenerationToolName(tool.name)) {
        continue;
      }
      const taskId = imageGenerationToolTaskId(tool);
      const backgroundStart = hasImageGenerationBackgroundStart(tool);
      if (tool.status === 'running' || backgroundStart) {
        taskIds.add(taskId);
        continue;
      }
      taskIds.delete(taskId);
    }
    if (taskIds.size > 0 && hasImageGenerationCompletionContent(item)) {
      taskIds.clear();
    }
  }
  const pendingTaskIds = [...taskIds];
  return {
    active: pendingTaskIds.length > 0,
    pendingTaskIds,
  };
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
