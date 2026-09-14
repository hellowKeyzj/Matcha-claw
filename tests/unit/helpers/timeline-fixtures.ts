import { extractMessageText } from '../../../src/stores/chat/message-content';
import {
  sanitizeAssistantDisplayText,
  sanitizeCanonicalUserText,
} from '../../../src/stores/chat/message-display';
import { isInternalRuntimeDisplayMessage } from '../../../src/stores/chat/message-filter';
import type {
  SessionMessageRole,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRenderItem,
  SessionRenderToolCard,
  SessionTimelineEntry,
  SessionTimelineEntryStatus,
  SessionTaskCompletionEvent,
  SessionTurnBindingConfidence,
  SessionTurnBindingSource,
  SessionTurnIdentityConfidence,
  SessionTurnIdentityMode,
} from '../../../src/types/session/render-item';

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
  taskCompletionEvents?: SessionTaskCompletionEvent[];
  isError?: boolean;
  _timeline?: MessageTimelineMeta;
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
  message: RawMessage;
}

function text(value: unknown): string {
  return extractMessageText(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function contentBlocks(message: RawMessage): Record<string, unknown>[] {
  return Array.isArray(message.content)
    ? message.content.flatMap((value) => {
      const block = record(value);
      return block ? [block] : [];
    })
    : [];
}

function userText(message: RawMessage): string {
  return sanitizeCanonicalUserText(text(message.content));
}

function userTextOrAttachment(message: RawMessage): string {
  return userText(message);
}

function assistantTextSegments(message: RawMessage): string[] {
  const textBlocks = contentBlocks(message)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => sanitizeAssistantDisplayText(block.text as string))
    .filter(Boolean);
  return textBlocks.length ? textBlocks : [sanitizeAssistantDisplayText(message.content)].filter(Boolean);
}

function assistantThinking(message: RawMessage): string | null {
  const parts = contentBlocks(message)
    .filter((block) => block.type === 'thinking' && typeof block.thinking === 'string')
    .map((block) => block.thinking as string);
  return parts.length ? parts.join('\n') : null;
}

function assistantImages(message: RawMessage): SessionRenderImage[] {
  return contentBlocks(message).flatMap((block) => (
    block.type === 'image' && typeof block.mimeType === 'string'
      && (typeof block.data === 'string' || typeof block.url === 'string')
      ? [{
        mimeType: block.mimeType,
        ...(typeof block.data === 'string' ? { data: block.data } : {}),
        ...(typeof block.url === 'string' ? { url: block.url } : {}),
      }]
      : []
  ));
}

function isToolCall(block: Record<string, unknown>): boolean {
  return block.type === 'toolCall' || block.type === 'tool_use';
}

function toolCallId(block: Record<string, unknown>): string | null {
  if (typeof block.id === 'string') return block.id;
  if (typeof block.toolCallId === 'string') return block.toolCallId;
  return null;
}

function toolResultFor(message: RawMessage, id: string): Record<string, unknown> | null {
  return contentBlocks(message).find((block) => (
    block.type === 'tool_result'
    && (block.id === id || block.toolCallId === id)
  )) ?? null;
}

function status(message: RawMessage): SessionTimelineEntryStatus {
  if (message.streaming) return 'streaming';
  if (message.isError || message.status === 'error') return 'error';
  if (message.status === 'sending' || message.status === 'timeout') return 'pending';
  return 'final';
}

function identity(message: RawMessage, index: number) {
  const entryId = message.messageId ?? message.id ?? message.clientId ?? `entry-${index}`;
  const runId = message._timeline?.runId;
  if (runId) return { entryId, turnKey: runId, source: 'run' as const, mode: 'run' as const, confidence: 'strong' as const };
  const messageId = message.messageId ?? message.id;
  if (messageId) return { entryId, turnKey: messageId, source: 'message' as const, mode: 'message' as const, confidence: 'strong' as const };
  const originMessageId = message.originMessageId;
  if (originMessageId) return { entryId, turnKey: originMessageId, source: 'origin' as const, mode: 'origin' as const, confidence: 'fallback' as const };
  const clientId = message.clientId;
  if (clientId) return { entryId, turnKey: clientId, source: 'client' as const, mode: 'client' as const, confidence: 'fallback' as const };
  return { entryId, turnKey: `entry:${entryId}`, source: 'heuristic' as const, mode: 'heuristic' as const, confidence: 'fallback' as const };
}

function attachedFiles(message: RawMessage): SessionRenderAttachedFile[] {
  return (message._attachedFiles ?? []).flatMap((file) => (
    typeof file.fileName === 'string' && typeof file.mimeType === 'string' && typeof file.fileSize === 'number'
      ? [{
        fileName: file.fileName,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        preview: typeof file.preview === 'string' ? file.preview : null,
        ...(file.previewStatus === 'unavailable' ? { previewStatus: file.previewStatus } : {}),
        ...(typeof file.attachmentStatus === 'string' ? { attachmentStatus: file.attachmentStatus as SessionRenderAttachedFile['attachmentStatus'] } : {}),
        ...(typeof file.filePath === 'string' ? { filePath: file.filePath } : {}),
        ...(file.source === 'user-upload' || file.source === 'tool-result' || file.source === 'message-ref'
          ? { source: file.source }
          : {}),
      }]
      : []
  ));
}

function toolCards(message: RawMessage): SessionRenderToolCard[] {
  const calls = [
    ...(message.toolCalls ?? message.tool_calls ?? []),
    ...contentBlocks(message).filter(isToolCall),
  ].filter((call) => call.name !== 'TodoWrite');
  return calls.map((call, index) => {
    const id = toolCallId(call) ?? message.toolCallId ?? `tool-${index}`;
    const name = typeof call.name === 'string' ? call.name : (message.toolName ?? 'tool');
    const result = toolResultFor(message, id);
    const resultValue = result?.content ?? result?.result;
    const canvas = record(resultValue);
    const view = record(canvas?.view);
    const isAssistantBubble = record(canvas?.presentation)?.target === 'assistant_message';
    const input = call.input ?? {};
    const inputText = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
    const filePath = record(input)?.filePath;
    const yamlDescription = typeof input === 'string'
      ? /^---[\s\S]*?\bdescription:\s*'([^']+)'/m.exec(input)?.[1]
      : undefined;
    const displayDetail = typeof filePath === 'string' && name === 'read'
      ? `读取，${filePath}`
      : yamlDescription;
    const canvasResult = canvas?.kind === 'canvas' && view && typeof view.id === 'string' && typeof view.url === 'string' && isAssistantBubble
      ? {
        kind: 'canvas' as const,
        surface: 'assistant-bubble' as const,
        collapsedPreview: name,
        preview: {
          kind: 'canvas' as const,
          surface: 'assistant_message' as const,
          render: 'url' as const,
          viewId: view.id,
          url: view.url,
          ...(typeof view.title === 'string' ? { title: view.title } : {}),
          ...(typeof view.preferred_height === 'number' ? { preferredHeight: view.preferred_height } : {}),
        },
      }
      : null;
    const canvasRawText = canvasResult && typeof resultValue === 'object'
      ? JSON.stringify(resultValue)
      : undefined;
    const resultText = typeof resultValue === 'string'
      ? resultValue
      : record(resultValue)?.text;
    const toolResult = canvasResult
      ? { ...canvasResult, ...(canvasRawText ? { rawText: canvasRawText } : {}) }
      : (typeof resultText === 'string'
      ? (() => {
        try {
          return {
            kind: 'json' as const,
            surface: 'tool-card' as const,
            collapsedPreview: name,
            bodyText: JSON.stringify(JSON.parse(resultText), null, 2),
          };
        } catch {
          return {
            kind: 'text' as const,
            surface: 'tool-card' as const,
            collapsedPreview: name,
            bodyText: resultText,
          };
        }
      })()
      : { kind: 'none' as const, surface: 'tool-card' as const });
    return {
      id,
      toolCallId: id,
      name,
      displayTitle: name,
      ...(displayDetail ? { displayDetail } : {}),
      input,
      inputText,
      status: result ? 'completed' as const : 'running' as const,
      result: toolResult,
    };
  });
}

function toItems(sessionKey: string, message: RawMessage, index: number): SessionRenderItem[] {
  if (message.role === 'toolresult' || message.role === 'tool_result') return [];
  if (isInternalRuntimeDisplayMessage(message)) return [];
  const binding = identity(message, index);
  const key = `session:${sessionKey}|${message.role}:${binding.entryId}`;
  const createdAt = message.timestamp;
  if (message.role === 'user') {
    const messageText = userTextOrAttachment(message);
    const files = attachedFiles(message);
    return messageText || files.length > 0 ? [{
      key,
      kind: 'user-message',
      role: 'user',
      sessionKey,
      text: messageText,
      images: [],
      attachedFiles: files,
      ...(message.messageId ?? message.id ? { messageId: message.messageId ?? message.id } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    }] : [];
  }
  if (message.role === 'system') {
    return [{
      key,
      kind: 'system',
      role: 'system',
      sessionKey,
      text: text(message.content),
      level: message.isError ? 'error' : 'info',
      ...(createdAt !== undefined ? { createdAt } : {}),
    }];
  }
  const messageTextSegments = assistantTextSegments(message);
  const messageText = messageTextSegments.join('\n');
  const thinking = assistantThinking(message);
  const images = assistantImages(message);
  const files = attachedFiles(message);
  const tools = toolCards(message);
  const assistantStatus = message.streaming ? 'streaming' : (message.isError || message.status === 'error' ? 'error' : 'final');
  const mainItem = messageText || thinking || images.length || files.length || tools.length > 0
    ? [{
      key,
      kind: 'assistant-turn' as const,
      role: 'assistant' as const,
      sessionKey,
      identitySource: binding.source,
      identityMode: binding.mode,
      identityConfidence: binding.confidence,
      status: assistantStatus,
      segments: [
        ...(thinking ? [{ kind: 'thinking' as const, key: `${key}:thinking`, text: thinking }] : []),
        ...messageTextSegments.map((value, textIndex) => ({
          kind: 'message' as const,
          key: `${key}:text:${textIndex}`,
          text: value,
        })),
        ...((images.length || files.length) ? [{ kind: 'media' as const, key: `${key}:media`, images, attachedFiles: files }] : []),
      ],
      thinking,
      tools: [],
      text: messageText,
      images,
      attachedFiles: files,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(message._timeline?.runId ? { runId: message._timeline.runId } : {}),
      ...(message.agentId ? { agentId: message.agentId } : {}),
      laneKey: message._timeline?.laneKey ?? (message.agentId ? `member:${message.agentId}` : 'main'),
      turnKey: message._timeline?.turnKey ?? binding.turnKey,
    }] : [];
  const toolItems = tools.map((tool) => ({
    key: `${key}:tool:${tool.id}`,
    kind: 'assistant-turn' as const,
    role: 'assistant' as const,
    sessionKey,
    identitySource: 'tool_call' as const,
    identityMode: 'tool_call' as const,
    identityConfidence: 'strong' as const,
    status: tool.status === 'running' ? 'streaming' as const : 'final' as const,
    segments: [{ kind: 'tool' as const, key: `${key}:tool:${tool.id}`, tool }],
    thinking: null,
    tools: [tool],
    ...(tool.result.kind === 'canvas' ? {
      embeddedToolResults: [{
        key: tool.toolCallId ?? tool.id,
        ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}),
        toolName: tool.name,
        preview: tool.result.preview,
      }],
    } : {}),
    text: '',
    images: [],
    attachedFiles: [],
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(message._timeline?.runId ? { runId: message._timeline.runId } : {}),
    ...(message.agentId ? { agentId: message.agentId } : {}),
    laneKey: message._timeline?.laneKey ?? (message.agentId ? `member:${message.agentId}` : 'main'),
    turnKey: `tool:${tool.id}`,
  }));
  return tools.length > 0 && mainItem.length === 0
    ? [{
      ...toolItems[0]!,
      key,
      turnKey: message._timeline?.turnKey ?? binding.turnKey,
      ...(toolItems.length > 1 ? {} : {}),
    }, ...toolItems.slice(1)]
    : [...mainItem, ...toolItems];
}

export function buildRenderItemsFromMessages(sessionKey: string, messages: RawMessage[]): SessionRenderItem[] {
  return messages.flatMap((message, index) => toItems(sessionKey, message, index));
}

export function buildTimelineEntriesFromMessages(sessionKey: string, messages: RawMessage[]): TimelineFixtureEntry[] {
  return messages.map((message, index) => {
    const binding = identity(message, index);
    return {
      entryId: message._timeline?.entryId ?? binding.entryId,
      sessionKey: message._timeline?.sessionKey ?? sessionKey,
      laneKey: message._timeline?.laneKey ?? (message.agentId ? `member:${message.agentId}` : 'main'),
      turnKey: message._timeline?.turnKey ?? binding.turnKey,
      turnBindingSource: message._timeline?.turnBindingSource ?? binding.source,
      turnBindingConfidence: message._timeline?.turnBindingConfidence ?? binding.confidence,
      turnIdentityMode: message._timeline?.turnIdentityMode ?? binding.mode,
      turnIdentityConfidence: message._timeline?.turnIdentityConfidence ?? binding.confidence,
      role: message.role,
      status: message._timeline?.status ?? status(message),
      ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
      ...(message._timeline?.runId ? { runId: message._timeline.runId } : {}),
      ...(message.agentId ? { agentId: message.agentId } : {}),
      text: text(message.content),
      message: { ...message },
    };
  });
}

export function buildRenderableTimelineEntriesFromMessages(
  sessionKey: string,
  messages: RawMessage[],
): SessionTimelineEntry[] {
  return buildRenderItemsFromMessages(sessionKey, messages).map((item) => ({
    ...item,
    text: item.text,
    status: item.kind === 'assistant-turn' ? (item.status === 'waiting_tool' ? 'pending' : item.status) : 'final',
  })) as SessionTimelineEntry[];
}

export function buildTimelineEntryFromMessage(sessionKey: string, message: RawMessage, index: number): TimelineFixtureEntry {
  return buildTimelineEntriesFromMessages(sessionKey, [message])[index]!;
}

export function materializeTimelineMessage(entry: TimelineFixtureEntry): RawMessage {
  return {
    ...entry.message,
    _timeline: {
      entryId: entry.entryId,
      sessionKey: entry.sessionKey,
      laneKey: entry.laneKey,
      turnKey: entry.turnKey,
      turnBindingSource: entry.turnBindingSource ?? 'heuristic',
      turnBindingConfidence: entry.turnBindingConfidence ?? 'fallback',
      turnIdentityMode: entry.turnIdentityMode ?? 'heuristic',
      turnIdentityConfidence: entry.turnIdentityConfidence ?? 'fallback',
      status: entry.status,
      ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
      ...(entry.runId ? { runId: entry.runId } : {}),
      ...(entry.agentId ? { agentId: entry.agentId } : {}),
      ...(entry.sequenceId !== undefined ? { sequenceId: entry.sequenceId } : {}),
    },
  };
}

export function materializeTimelineMessages(entries: TimelineFixtureEntry[]): RawMessage[] {
  return entries.map(materializeTimelineMessage);
}
