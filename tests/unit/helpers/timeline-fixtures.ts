import type {
  SessionAssistantTurnItem,
  SessionMessageRole,
  SessionRenderItem,
  SessionTimelineEntry,
  SessionTimelineMessageEntry,
  SessionTimelineToolActivityEntry,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionTimelineEntryStatus,
  SessionRenderToolStatus,
  SessionRenderToolUse,
  SessionTaskCompletionEvent,
} from '../../../runtime-host/shared/session-adapter-types';
import { extractMessageText, normalizeOptionalString } from '../../../runtime-host/shared/chat-message-normalization';

export interface MessageTimelineMeta {
  entryId: string;
  sessionKey: string;
  laneKey: string;
  turnKey: string;
  status: SessionTimelineEntryStatus;
  timestamp?: number;
  runId?: string;
  agentId?: string;
  sequenceId?: number;
}

export interface RawMessage {
  role: SessionMessageRole;
  content: unknown;
  timestamp?: number;
  id?: string;
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
  uniqueId?: string;
  status?: 'sending' | 'sent' | 'timeout' | 'error';
  streaming?: boolean;
  toolCallId?: string;
  tool_calls?: Array<Record<string, unknown>>;
  toolCalls?: Array<Record<string, unknown>>;
  toolName?: string;
  agentId?: string;
  parentMessageId?: string;
  metadata?: Record<string, unknown>;
  name?: string;
  requestId?: string;
  details?: unknown;
  toolStatuses?: Array<Record<string, unknown>>;
  taskCompletionEvents?: SessionTaskCompletionEvent[];
  isError?: boolean;
  _timeline?: MessageTimelineMeta;
  _attachedFiles?: Array<Record<string, unknown>>;
}

interface TimelineFixtureEntryMessage {
  role: SessionMessageRole;
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

export interface TimelineFixtureEntry {
  entryId: string;
  sessionKey: string;
  laneKey: string;
  turnKey: string;
  role: SessionMessageRole;
  status: SessionTimelineEntryStatus;
  timestamp?: number;
  runId?: string;
  agentId?: string;
  sequenceId?: number;
  text: string;
  message: TimelineFixtureEntryMessage;
}

function buildTimelineMeta(entry: TimelineFixtureEntry): MessageTimelineMeta {
  return {
    entryId: entry.entryId,
    sessionKey: entry.sessionKey,
    laneKey: entry.laneKey,
    turnKey: entry.turnKey,
    status: entry.status,
    ...(entry.timestamp != null ? { timestamp: entry.timestamp } : {}),
    ...(entry.runId ? { runId: entry.runId } : {}),
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    ...(entry.sequenceId != null ? { sequenceId: entry.sequenceId } : {}),
  };
}

function normalizeIdentifier(value: string | null | undefined): string {
  return normalizeOptionalString(value) ?? '';
}

function resolveTimelineEntryStatus(message: RawMessage): SessionTimelineEntryStatus {
  if (message.streaming) {
    return 'streaming';
  }
  if (message.isError || message.status === 'error') {
    return 'error';
  }
  if (message.status === 'sending' || message.status === 'timeout') {
    return 'pending';
  }
  return 'final';
}

function resolveTimelineEntryId(message: RawMessage, index: number): string {
  return normalizeIdentifier(
    message.messageId
    ?? message.id
    ?? message.uniqueId
    ?? message.requestId
    ?? message.clientId,
  ) || `entry-${index}`;
}

function resolveTimelineLaneKey(message: RawMessage): string {
  const agentId = normalizeIdentifier(message.agentId);
  return agentId ? `member:${agentId}` : 'main';
}

function resolveTimelineTurnKey(message: RawMessage, entryId: string): string {
  const turnIdentity = normalizeIdentifier(
    message.uniqueId
    ?? message.requestId
    ?? message.clientId
    ?? message.messageId
    ?? message.id
    ?? message.originMessageId,
  );
  return turnIdentity || `entry:${entryId}`;
}

function toTimelineEntryMessage(message: RawMessage): TimelineFixtureEntryMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
    ...(message.id ? { id: message.id } : {}),
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(message.originMessageId ? { originMessageId: message.originMessageId } : {}),
    ...(message.clientId ? { clientId: message.clientId } : {}),
    ...(message.uniqueId ? { uniqueId: message.uniqueId } : {}),
    ...(message.requestId ? { requestId: message.requestId } : {}),
    ...(message.status ? { status: message.status } : {}),
    ...(message.streaming != null ? { streaming: message.streaming } : {}),
    ...(message.agentId ? { agentId: message.agentId } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(message.metadata ? { metadata: message.metadata } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(message.details !== undefined ? { details: message.details } : {}),
    ...(message.toolStatuses ? {
      toolStatuses: message.toolStatuses.map((toolStatus) => ({ ...toolStatus })),
    } : {}),
    ...(message.taskCompletionEvents ? {
      taskCompletionEvents: message.taskCompletionEvents.map((event) => ({ ...event })),
    } : {}),
    ...(message.isError != null ? { isError: message.isError } : {}),
    ...(message._attachedFiles ? {
      _attachedFiles: message._attachedFiles.map((file) => ({ ...file })),
    } : {}),
  };
}

export function buildTimelineEntryFromMessage(
  sessionKey: string,
  message: RawMessage,
  index: number,
): TimelineFixtureEntry {
  const timeline = message._timeline ?? null;
  if (timeline) {
    return {
      entryId: timeline.entryId,
      sessionKey: timeline.sessionKey || sessionKey,
      laneKey: timeline.laneKey,
      turnKey: timeline.turnKey,
      role: message.role,
      status: timeline.status,
      ...(timeline.timestamp != null
        ? { timestamp: timeline.timestamp }
        : (message.timestamp != null ? { timestamp: message.timestamp } : {})),
      ...(timeline.runId ? { runId: timeline.runId } : {}),
      ...(timeline.agentId ? { agentId: timeline.agentId } : (message.agentId ? { agentId: message.agentId } : {})),
      ...(timeline.sequenceId != null ? { sequenceId: timeline.sequenceId } : {}),
      text: extractMessageText(message.content),
      message: toTimelineEntryMessage(message),
    };
  }

  const entryId = resolveTimelineEntryId(message, index);
  const laneKey = resolveTimelineLaneKey(message);
  return {
    entryId,
    sessionKey,
    laneKey,
    turnKey: resolveTimelineTurnKey(message, entryId),
    role: message.role,
    status: resolveTimelineEntryStatus(message),
    ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
    ...(message.agentId ? { agentId: message.agentId } : {}),
    text: extractMessageText(message.content),
    message: toTimelineEntryMessage(message),
  };
}

export function buildTimelineEntriesFromMessages(
  sessionKey: string,
  messages: RawMessage[],
): TimelineFixtureEntry[] {
  return messages.map((message, index) => buildTimelineEntryFromMessage(sessionKey, message, index));
}

export function materializeTimelineMessage(entry: TimelineFixtureEntry): RawMessage {
  return {
    ...entry.message,
    ...(entry.agentId && !entry.message.agentId ? { agentId: entry.agentId } : {}),
    ...(entry.status === 'streaming'
      ? { streaming: true }
      : (entry.message.streaming ? { streaming: false } : {})),
    _timeline: buildTimelineMeta(entry),
  };
}

export function materializeTimelineMessages(
  entries: TimelineFixtureEntry[],
): RawMessage[] {
  return entries.map((entry) => materializeTimelineMessage(entry));
}

function cloneAttachedFiles(files: Array<Record<string, unknown>> | undefined): SessionRenderAttachedFile[] {
  return Array.isArray(files)
    ? files.map((file) => ({
        fileName: typeof file.fileName === 'string' ? file.fileName : '',
        mimeType: typeof file.mimeType === 'string' ? file.mimeType : 'application/octet-stream',
        fileSize: typeof file.fileSize === 'number' ? file.fileSize : 0,
        preview: typeof file.preview === 'string' ? file.preview : null,
        ...(typeof file.filePath === 'string' ? { filePath: file.filePath } : {}),
      }))
    : [];
}

function readThinking(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .filter((block): block is { type?: unknown; thinking?: unknown } => Boolean(block) && typeof block === 'object')
    .flatMap((block) => (
      block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()
        ? [block.thinking.trim()]
        : []
    ));
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function readImages(content: unknown): SessionRenderImage[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const images: SessionRenderImage[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const row = block as {
      type?: unknown;
      data?: unknown;
      mimeType?: unknown;
      source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    };
    if (row.type !== 'image') {
      continue;
    }
    if (row.source?.type === 'base64' && typeof row.source.media_type === 'string' && typeof row.source.data === 'string') {
      images.push({ mimeType: row.source.media_type, data: row.source.data });
      continue;
    }
    if (typeof row.data === 'string') {
      images.push({
        mimeType: typeof row.mimeType === 'string' ? row.mimeType : 'image/jpeg',
        data: row.data,
      });
    }
  }
  return images;
}

function readToolUses(content: unknown): SessionRenderToolUse[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const tools: SessionRenderToolUse[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const row = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
      arguments?: unknown;
    };
    if ((row.type === 'tool_use' || row.type === 'toolCall') && typeof row.name === 'string') {
      tools.push({
        id: typeof row.id === 'string' ? row.id : row.name,
        name: row.name,
        input: row.input ?? row.arguments,
      });
    }
  }
  return tools;
}

function readToolStatuses(message: RawMessage): SessionRenderToolStatus[] {
  return Array.isArray(message.toolStatuses)
    ? message.toolStatuses
        .filter((toolStatus): toolStatus is Record<string, unknown> => Boolean(toolStatus) && typeof toolStatus === 'object')
        .flatMap((toolStatus) => {
          const name = typeof toolStatus.name === 'string' ? toolStatus.name : '';
          const status = toolStatus.status;
          if (!name || (status !== 'running' && status !== 'completed' && status !== 'error')) {
            return [];
          }
          return [{
            ...(typeof toolStatus.id === 'string' ? { id: toolStatus.id } : {}),
            ...(typeof toolStatus.toolCallId === 'string' ? { toolCallId: toolStatus.toolCallId } : {}),
            name,
            status,
            ...(typeof toolStatus.durationMs === 'number' ? { durationMs: toolStatus.durationMs } : {}),
            ...(typeof toolStatus.summary === 'string' ? { summary: toolStatus.summary } : {}),
            ...(typeof toolStatus.updatedAt === 'number' ? { updatedAt: toolStatus.updatedAt } : {}),
          }];
        })
    : [];
}

export function buildRenderableTimelineEntriesFromMessages(
  sessionKey: string,
  messages: RawMessage[],
): SessionTimelineEntry[] {
  return buildTimelineEntriesFromMessages(sessionKey, messages)
    .filter((entry) => entry.role !== 'toolresult' && entry.role !== 'tool_result')
    .map((entry) => {
      const message = materializeTimelineMessage(entry);
      const toolUses = readToolUses(message.content);
      const toolStatuses = readToolStatuses(message);
      const base = {
        key: `session:${entry.sessionKey}|entry:${entry.entryId}`,
        sessionKey: entry.sessionKey,
        role: entry.role === 'system' ? 'system' : entry.role === 'user' ? 'user' : 'assistant',
        text: entry.text,
        ...(entry.timestamp != null ? { createdAt: entry.timestamp } : {}),
        status: entry.status,
        ...(entry.runId ? { runId: entry.runId } : {}),
        entryId: entry.entryId,
        ...(entry.sequenceId != null ? { sequenceId: entry.sequenceId } : {}),
        laneKey: entry.laneKey,
        turnKey: entry.turnKey,
        ...(entry.agentId ? { agentId: entry.agentId } : {}),
        ...(entry.role === 'assistant' ? {
          assistantTurnKey: entry.turnKey,
          assistantLaneKey: entry.laneKey,
          assistantLaneAgentId: entry.agentId ?? null,
        } : {}),
      } as const;

      if (base.role === 'assistant' && toolUses.length > 0 && !entry.text.trim()) {
        const row: SessionTimelineToolActivityEntry = {
          ...base,
          kind: 'tool-activity',
          role: 'assistant',
          toolUses,
          toolStatuses,
          attachedFiles: cloneAttachedFiles(message._attachedFiles),
          isStreaming: entry.status === 'streaming',
        };
        return row;
      }

      const row: SessionTimelineMessageEntry = {
        ...base,
        kind: 'message',
        thinking: readThinking(message.content),
        images: readImages(message.content),
        toolUses,
        attachedFiles: cloneAttachedFiles(message._attachedFiles),
        toolStatuses,
        isStreaming: entry.status === 'streaming',
        ...(message.messageId ? { messageId: message.messageId } : {}),
        ...(message.originMessageId ? { originMessageId: message.originMessageId } : {}),
        ...(message.clientId ? { clientId: message.clientId } : {}),
        ...(message.uniqueId ? { uniqueId: message.uniqueId } : {}),
        ...(message.requestId ? { requestId: message.requestId } : {}),
      };
      return row;
    });
}

export function buildRenderItemsFromMessages(
  sessionKey: string,
  messages: RawMessage[],
): SessionRenderItem[] {
  const entries = buildRenderableTimelineEntriesFromMessages(sessionKey, messages);
  const items: SessionRenderItem[] = [];
  let activeAssistantTurn: SessionAssistantTurnItem | null = null;

  const flushAssistantTurn = () => {
    if (!activeAssistantTurn) {
      return;
    }
    items.push(activeAssistantTurn);
    activeAssistantTurn = null;
  };

  for (const entry of entries) {
    if (entry.kind === 'message' && entry.role === 'user') {
      flushAssistantTurn();
      items.push({
        key: entry.key,
        kind: 'user-message',
        sessionKey: entry.sessionKey,
        role: 'user',
        text: entry.text,
        images: entry.images,
        attachedFiles: entry.attachedFiles,
        ...(entry.createdAt != null ? { createdAt: entry.createdAt } : {}),
        ...(entry.createdAt != null ? { updatedAt: entry.createdAt } : {}),
        ...(entry.runId ? { runId: entry.runId } : {}),
        ...(entry.messageId ? { messageId: entry.messageId } : {}),
      });
      continue;
    }

    if (entry.kind === 'message' && entry.role === 'assistant') {
      const turnKey = entry.turnKey ?? entry.messageId ?? entry.key;
      const laneKey = entry.laneKey ?? 'main';
      const turnItemKey = `session:${entry.sessionKey}|assistant-turn:${turnKey}:${laneKey}`;
      if (
        !activeAssistantTurn
        || activeAssistantTurn.turnKey !== turnKey
        || activeAssistantTurn.laneKey !== laneKey
      ) {
        flushAssistantTurn();
        activeAssistantTurn = {
          key: turnItemKey,
          kind: 'assistant-turn',
          sessionKey: entry.sessionKey,
          role: 'assistant',
          ...(entry.createdAt != null ? { createdAt: entry.createdAt } : {}),
          ...(entry.createdAt != null ? { updatedAt: entry.createdAt } : {}),
          ...(entry.runId ? { runId: entry.runId } : {}),
          laneKey,
          turnKey,
          ...(entry.agentId ? { agentId: entry.agentId } : {}),
          status: entry.status === 'error'
            ? 'error'
            : entry.status === 'aborted'
              ? 'aborted'
              : entry.status === 'streaming'
                ? 'streaming'
                : 'final',
          thinking: entry.thinking,
          toolCalls: entry.toolUses,
          toolStatuses: entry.toolStatuses,
          text: entry.text,
          images: entry.images,
          attachedFiles: entry.attachedFiles,
          pendingState: null,
        };
        continue;
      }
      activeAssistantTurn = {
        ...activeAssistantTurn,
        updatedAt: entry.createdAt ?? activeAssistantTurn.updatedAt,
        status: entry.status === 'error'
          ? 'error'
          : entry.status === 'aborted'
            ? 'aborted'
            : entry.status === 'streaming'
              ? 'streaming'
              : activeAssistantTurn.status,
        thinking: entry.thinking ?? activeAssistantTurn.thinking,
        toolCalls: entry.toolUses.length > 0 ? entry.toolUses : activeAssistantTurn.toolCalls,
        toolStatuses: entry.toolStatuses.length > 0 ? entry.toolStatuses : activeAssistantTurn.toolStatuses,
        text: entry.text || activeAssistantTurn.text,
        images: entry.images.length > 0 ? entry.images : activeAssistantTurn.images,
        attachedFiles: entry.attachedFiles.length > 0 ? entry.attachedFiles : activeAssistantTurn.attachedFiles,
      };
      continue;
    }

    if (entry.kind === 'tool-activity') {
      const turnKey = entry.turnKey ?? entry.key;
      const laneKey = entry.laneKey ?? 'main';
      const turnItemKey = `session:${entry.sessionKey}|assistant-turn:${turnKey}:${laneKey}`;
      if (
        !activeAssistantTurn
        || activeAssistantTurn.turnKey !== turnKey
        || activeAssistantTurn.laneKey !== laneKey
      ) {
        flushAssistantTurn();
        activeAssistantTurn = {
          key: turnItemKey,
          kind: 'assistant-turn',
          sessionKey: entry.sessionKey,
          role: 'assistant',
          ...(entry.createdAt != null ? { createdAt: entry.createdAt } : {}),
          ...(entry.createdAt != null ? { updatedAt: entry.createdAt } : {}),
          ...(entry.runId ? { runId: entry.runId } : {}),
          laneKey,
          turnKey,
          ...(entry.agentId ? { agentId: entry.agentId } : {}),
          status: entry.status === 'error'
            ? 'error'
            : entry.status === 'aborted'
              ? 'aborted'
              : entry.status === 'streaming'
                ? 'streaming'
                : 'waiting_tool',
          thinking: null,
          toolCalls: entry.toolUses,
          toolStatuses: entry.toolStatuses,
          text: '',
          images: [],
          attachedFiles: entry.attachedFiles,
          pendingState: entry.isStreaming ? 'activity' : null,
        };
        continue;
      }
      activeAssistantTurn = {
        ...activeAssistantTurn,
        updatedAt: entry.createdAt ?? activeAssistantTurn.updatedAt,
        status: entry.status === 'error'
          ? 'error'
          : entry.status === 'aborted'
            ? 'aborted'
            : entry.status === 'streaming'
              ? 'streaming'
              : 'waiting_tool',
        toolCalls: entry.toolUses.length > 0 ? entry.toolUses : activeAssistantTurn.toolCalls,
        toolStatuses: entry.toolStatuses.length > 0 ? entry.toolStatuses : activeAssistantTurn.toolStatuses,
        attachedFiles: entry.attachedFiles.length > 0 ? entry.attachedFiles : activeAssistantTurn.attachedFiles,
        pendingState: entry.isStreaming ? 'activity' : activeAssistantTurn.pendingState,
      };
      continue;
    }

    flushAssistantTurn();

    if (entry.kind === 'task-completion') {
      items.push({
        key: entry.key,
        kind: 'task-completion',
        sessionKey: entry.sessionKey,
        role: 'system',
        text: entry.text,
        childSessionKey: entry.childSessionKey,
        ...(entry.createdAt != null ? { createdAt: entry.createdAt } : {}),
        ...(entry.createdAt != null ? { updatedAt: entry.createdAt } : {}),
        ...(entry.runId ? { runId: entry.runId } : {}),
        ...(entry.childSessionId ? { childSessionId: entry.childSessionId } : {}),
        ...(entry.childAgentId ? { childAgentId: entry.childAgentId } : {}),
        ...(entry.taskLabel ? { taskLabel: entry.taskLabel } : {}),
        ...(entry.statusLabel ? { statusLabel: entry.statusLabel } : {}),
        ...(entry.result ? { result: entry.result } : {}),
        ...(entry.statsLine ? { statsLine: entry.statsLine } : {}),
        ...(entry.replyInstruction ? { replyInstruction: entry.replyInstruction } : {}),
        ...(entry.anchorItemKey ? { anchorItemKey: entry.anchorItemKey } : {}),
        ...(entry.triggerItemKey ? { triggerItemKey: entry.triggerItemKey } : {}),
        ...(entry.replyItemKey ? { replyItemKey: entry.replyItemKey } : {}),
      });
      continue;
    }

    if (entry.kind === 'execution-graph' || entry.kind === 'system') {
      items.push(entry);
    }
  }

  flushAssistantTurn();
  return items;
}
