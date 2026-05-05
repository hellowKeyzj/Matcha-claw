import type {
  SessionAssistantTurnSegment,
  SessionAssistantTurnItem,
  SessionMessageRole,
  SessionRenderItem,
  SessionTimelineEntry,
  SessionTimelineMessageEntry,
  SessionTimelineToolActivityEntry,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRenderToolCard,
  SessionTimelineEntryStatus,
  SessionRenderToolStatus,
  SessionRenderToolUse,
  SessionTaskCompletionEvent,
  SessionTurnBindingConfidence,
  SessionTurnBindingSource,
  SessionTurnIdentityConfidence,
  SessionTurnIdentityMode,
} from '../../../runtime-host/shared/session-adapter-types';
import { extractMessageText, normalizeOptionalString } from '../../../runtime-host/shared/chat-message-normalization';
import { assembleAuthoritativeAssistantTurns } from '../../../runtime-host/application/sessions/assistant-turn-assembler';
import {
  buildToolCardsFromMessage,
  mergeToolCards,
} from '../../../runtime-host/shared/tool-card-render';

export interface MessageTimelineMeta {
  entryId: string;
  sessionKey: string;
  laneKey: string;
  turnKey: string;
  turnBindingSource: SessionTurnBindingSource;
  turnBindingConfidence: SessionTurnBindingConfidence;
  turnIdentityMode: SessionTurnIdentityMode;
  turnIdentityConfidence: SessionTurnIdentityConfidence;
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
  turnBindingSource?: SessionTurnBindingSource;
  turnBindingConfidence?: SessionTurnBindingConfidence;
  turnIdentityMode?: SessionTurnIdentityMode;
  turnIdentityConfidence?: SessionTurnIdentityConfidence;
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
  const binding = resolveTimelineTurnBinding({
    ...entry.message,
    _timeline: entry.runId ? { runId: entry.runId } as MessageTimelineMeta : undefined,
  });
  return {
    entryId: entry.entryId,
    sessionKey: entry.sessionKey,
    laneKey: entry.laneKey,
    turnKey: entry.turnKey,
    turnBindingSource: entry.turnBindingSource ?? binding.source,
    turnBindingConfidence: entry.turnBindingConfidence ?? binding.confidence,
    turnIdentityMode: entry.turnIdentityMode ?? binding.mode,
    turnIdentityConfidence: entry.turnIdentityConfidence ?? binding.confidence,
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
    ?? message.clientId,
  ) || `entry-${index}`;
}

function resolveTimelineLaneKey(message: RawMessage): string {
  const agentId = normalizeIdentifier(message.agentId);
  return agentId ? `member:${agentId}` : 'main';
}

function resolveTimelineTurnKey(message: RawMessage, entryId: string): string {
  const turnIdentity = resolveTimelineTurnBinding(message).key;
  return turnIdentity || `entry:${entryId}`;
}

function resolveTimelineTurnBinding(message: RawMessage): {
  key: string;
  source: SessionTurnBindingSource;
  confidence: SessionTurnIdentityConfidence;
  mode: SessionTurnIdentityMode;
} {
  const runId = normalizeIdentifier(message._timeline?.runId);
  if (runId) {
    return {
      key: runId,
      source: 'run',
      mode: 'run',
      confidence: 'strong',
    };
  }
  const messageId = normalizeIdentifier(message.messageId);
  if (messageId) {
    return {
      key: messageId,
      source: 'message',
      mode: 'message',
      confidence: 'strong',
    };
  }
  const originMessageId = normalizeIdentifier(message.originMessageId);
  if (originMessageId) {
    return {
      key: originMessageId,
      source: 'origin',
      mode: 'origin',
      confidence: 'fallback',
    };
  }
  const clientId = normalizeIdentifier(message.clientId);
  if (clientId) {
    return {
      key: clientId,
      source: 'client',
      mode: 'client',
      confidence: 'fallback',
    };
  }
  return {
    key: '',
    source: 'heuristic',
    mode: 'heuristic',
    confidence: 'fallback',
  };
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
      turnBindingSource: timeline.turnBindingSource,
      turnBindingConfidence: timeline.turnBindingConfidence,
      turnIdentityMode: timeline.turnIdentityMode,
      turnIdentityConfidence: timeline.turnIdentityConfidence,
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
    turnBindingSource: resolveTimelineTurnBinding(message).source,
    turnBindingConfidence: resolveTimelineTurnBinding(message).confidence,
    turnIdentityMode: resolveTimelineTurnBinding(message).mode,
    turnIdentityConfidence: resolveTimelineTurnBinding(message).confidence,
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
      const toolCallId = typeof row.id === 'string' ? row.id : undefined;
      tools.push({
        id: toolCallId || row.name,
        ...(toolCallId ? { toolCallId } : {}),
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
            ...(Object.prototype.hasOwnProperty.call(toolStatus, 'result') ? { output: toolStatus.result } : {}),
            ...(Object.prototype.hasOwnProperty.call(toolStatus, 'output') ? { output: toolStatus.output } : {}),
            ...(typeof toolStatus.outputText === 'string' ? { outputText: toolStatus.outputText } : {}),
          }];
        })
    : [];
}

function mergeTools(
  existingTools: ReadonlyArray<SessionRenderToolCard>,
  message: RawMessage,
  toolUses: ReadonlyArray<SessionRenderToolUse>,
  toolStatuses: ReadonlyArray<SessionRenderToolStatus>,
): SessionRenderToolCard[] {
  const contentDerivedTools = buildToolCardsFromMessage({
    content: message.content,
    role: message.role,
    toolName: message.toolName ?? message.name,
    toolCallId: message.toolCallId,
    toolStatuses,
    toolCalls: message.tool_calls ?? message.toolCalls,
  });
  return mergeToolCards({
    existingTools: existingTools.length > 0 ? existingTools : contentDerivedTools,
    toolUses,
    toolStatuses,
  });
}

function buildEmbeddedToolResults(
  tools: ReadonlyArray<SessionRenderToolCard>,
): NonNullable<SessionAssistantTurnItem['embeddedToolResults']> {
  return tools.flatMap((tool, index) => {
    if (tool.result.kind !== 'canvas' || tool.result.surface !== 'assistant-bubble' || tool.result.preview.surface !== 'assistant_message') {
      return [];
    }
    return [{
      key: tool.toolCallId || tool.id || `${tool.name}:${index}`,
      ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}),
      toolName: tool.name,
      preview: tool.result.preview,
      ...(tool.result.rawText ? { rawText: tool.result.rawText } : {}),
    }];
  });
}

function buildThinkingSegment(key: string, text: string): SessionAssistantTurnSegment | null {
  const cleaned = text.trim();
  if (!cleaned) {
    return null;
  }
  return {
    kind: 'thinking',
    key,
    text: cleaned,
  };
}

function buildMessageSegment(key: string, text: string): SessionAssistantTurnSegment | null {
  const cleaned = typeof text === 'string' ? text.trim() : '';
  if (!cleaned) {
    return null;
  }
  return {
    kind: 'message',
    key,
    text: cleaned,
  };
}

function buildMediaSegment(input: {
  key: string;
  images: ReadonlyArray<SessionRenderImage>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
}): SessionAssistantTurnSegment | null {
  if (input.images.length === 0 && input.attachedFiles.length === 0) {
    return null;
  }
  return {
    kind: 'media',
    key: input.key,
    images: structuredClone(input.images),
    attachedFiles: structuredClone(input.attachedFiles),
  };
}

function buildToolSegment(tool: SessionRenderToolCard): SessionAssistantTurnSegment {
  return {
    kind: 'tool',
    key: tool.toolCallId || tool.id || tool.name,
    tool: structuredClone(tool),
  };
}

function findToolCardIndexForBlock(input: {
  toolCards: ReadonlyArray<SessionRenderToolCard>;
  consumedIndices: Set<number>;
  toolCallId?: string;
  toolName?: string;
}): number {
  const toolCallId = normalizeOptionalString(input.toolCallId) ?? '';
  if (toolCallId) {
    for (let index = 0; index < input.toolCards.length; index += 1) {
      if (input.consumedIndices.has(index)) {
        continue;
      }
      const tool = input.toolCards[index];
      if ((tool?.toolCallId ?? tool?.id) === toolCallId) {
        return index;
      }
    }
  }
  const toolName = normalizeOptionalString(input.toolName) ?? '';
  if (toolName) {
    for (let index = 0; index < input.toolCards.length; index += 1) {
      if (input.consumedIndices.has(index)) {
        continue;
      }
      const tool = input.toolCards[index];
      if (tool?.name === toolName) {
        return index;
      }
    }
  }
  return -1;
}

function buildAssistantSegmentsFromMessage(input: {
  entryKey: string;
  message: RawMessage;
  text: string;
  images: ReadonlyArray<SessionRenderImage>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  toolCards: ReadonlyArray<SessionRenderToolCard>;
}): ReadonlyArray<SessionAssistantTurnSegment> {
  if (input.message.role !== 'assistant') {
    return [];
  }

  const segments: SessionAssistantTurnSegment[] = [];
  const consumedToolIndices = new Set<number>();
  let emittedInlineMedia = false;

  if (Array.isArray(input.message.content)) {
    for (const [index, block] of input.message.content.entries()) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      const row = block as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        id?: unknown;
        toolCallId?: unknown;
        name?: unknown;
      };
      const type = typeof row.type === 'string' ? row.type : '';
      if (type === 'thinking' && typeof row.thinking === 'string') {
        const thinkingSegment = buildThinkingSegment(`${input.entryKey}:thinking:${index}`, row.thinking);
        if (thinkingSegment) {
          segments.push(thinkingSegment);
        }
        continue;
      }
      if (type === 'text' && typeof row.text === 'string') {
        const messageSegment = buildMessageSegment(`${input.entryKey}:message:${index}`, row.text);
        if (messageSegment) {
          segments.push(messageSegment);
        }
        continue;
      }
      if (type === 'image') {
        const mediaSegment = buildMediaSegment({
          key: `${input.entryKey}:media:${index}`,
          images: readImages([row]),
          attachedFiles: input.attachedFiles,
        });
        if (mediaSegment) {
          emittedInlineMedia = true;
          segments.push(mediaSegment);
        }
        continue;
      }
      if (type === 'tool_use' || type === 'toolCall' || type === 'tool_result' || type === 'toolResult') {
        const toolIndex = findToolCardIndexForBlock({
          toolCards: input.toolCards,
          consumedIndices: consumedToolIndices,
          toolCallId: typeof row.toolCallId === 'string'
            ? row.toolCallId
            : (typeof row.id === 'string' ? row.id : undefined),
          toolName: typeof row.name === 'string' ? row.name : undefined,
        });
        if (toolIndex >= 0) {
          consumedToolIndices.add(toolIndex);
          const tool = input.toolCards[toolIndex];
          if (tool) {
            segments.push(buildToolSegment(tool));
          }
        }
      }
    }
  }

  if (segments.length === 0) {
    const messageSegment = buildMessageSegment(`${input.entryKey}:message:full`, input.text);
    if (messageSegment) {
      segments.push(messageSegment);
    }
  }

  for (let index = 0; index < input.toolCards.length; index += 1) {
    if (consumedToolIndices.has(index)) {
      continue;
    }
    const tool = input.toolCards[index];
    if (tool) {
      segments.push(buildToolSegment(tool));
    }
  }

  if (!emittedInlineMedia) {
    const mediaSegment = buildMediaSegment({
      key: `${input.entryKey}:media:tail`,
      images: input.images,
      attachedFiles: input.attachedFiles,
    });
    if (mediaSegment) {
      segments.push(mediaSegment);
    }
  }

  return segments;
}

function buildAssistantSegmentsFromToolCards(
  toolCards: ReadonlyArray<SessionRenderToolCard>,
): ReadonlyArray<SessionAssistantTurnSegment> {
  return toolCards.map((tool) => buildToolSegment(tool));
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
        turnBindingSource: entry.turnBindingSource,
        turnBindingConfidence: entry.turnBindingConfidence,
        turnIdentityMode: entry.turnIdentityMode,
        turnIdentityConfidence: entry.turnIdentityConfidence,
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
          assistantSegments: buildAssistantSegmentsFromToolCards(mergeTools([], message, toolUses, toolStatuses)),
          toolUses,
          toolStatuses,
          toolCards: mergeTools([], message, toolUses, toolStatuses),
          attachedFiles: cloneAttachedFiles(message._attachedFiles),
          isStreaming: entry.status === 'streaming',
        };
        return row;
      }

      const row: SessionTimelineMessageEntry = {
        ...base,
        kind: 'message',
        thinking: readThinking(message.content),
        assistantSegments: buildAssistantSegmentsFromMessage({
          entryKey: base.key,
          message,
          text: entry.text,
          images: readImages(message.content),
          attachedFiles: cloneAttachedFiles(message._attachedFiles),
          toolCards: mergeTools([], message, toolUses, toolStatuses),
        }),
        images: readImages(message.content),
        toolUses,
        attachedFiles: cloneAttachedFiles(message._attachedFiles),
        toolStatuses,
        toolCards: mergeTools([], message, toolUses, toolStatuses),
        isStreaming: entry.status === 'streaming',
        ...(message.messageId ? { messageId: message.messageId } : {}),
        ...(message.originMessageId ? { originMessageId: message.originMessageId } : {}),
        ...(message.clientId ? { clientId: message.clientId } : {}),
      };
      return row;
    });
}

export function buildRenderItemsFromMessages(
  sessionKey: string,
  messages: RawMessage[],
): SessionRenderItem[] {
  const entries = buildRenderableTimelineEntriesFromMessages(sessionKey, messages);
  const assembledTurns = assembleAuthoritativeAssistantTurns({
    sessionKey,
    timelineEntries: entries,
    runtime: {
      sending: false,
      activeRunId: null,
      runPhase: 'idle',
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      pendingFinal: false,
      lastUserMessageAt: null,
      updatedAt: null,
    },
  });
  const items: SessionRenderItem[] = [];
  const emittedAssistantTurnKeys = new Set<string>();

  for (const entry of entries) {
    if (entry.kind === 'message' && entry.role === 'user') {
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

    if ((entry.kind === 'message' || entry.kind === 'tool-activity') && entry.role === 'assistant') {
      const assistantTurn = assembledTurns.turnsByLatestTimelineKey.get(entry.key);
      if (!assistantTurn || emittedAssistantTurnKeys.has(assistantTurn.key)) {
        continue;
      }
      emittedAssistantTurnKeys.add(assistantTurn.key);
      items.push({
        ...assistantTurn,
        embeddedToolResults: buildEmbeddedToolResults(assistantTurn.tools),
      });
      continue;
    }

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

  return items;
}
