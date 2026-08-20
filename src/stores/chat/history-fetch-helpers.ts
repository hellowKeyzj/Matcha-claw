import { hostSessionLoad } from '@/lib/host-api';
import {
  logSessionTrace,
  summarizeError,
  summarizeIdentifier,
  summarizeSessionIdentity,
} from '@/lib/session-trace';
import type { SessionIdentity } from '../../../electron/desktop-contract/runtime-address';
import {
  decodeSessionView,
  type SessionFact,
  type SessionView,
  type SessionWindowStateSnapshot,
} from '../../types/session/snapshot';
import { resolveSessionThinkingLevelFromList } from './session-helpers';
import type { ChatSession } from './types';
import type {
  SessionMessageRole,
  SessionRenderItem,
  SessionTimelineEntryStatus,
} from '../../types/session/render-item';
import type {
  SessionAssistantTurnSegment,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRenderToolCard,
  SessionTimelineContentBlock,
} from '../../types/session/tool-card';

export interface HistoryWindowResult {
  view: SessionView;
  thinkingLevel: string | null;
}

export function resolveSessionViewError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.toLowerCase().includes('incomplete')
    ? 'Session view is incomplete'
    : 'Session view is unavailable');
}

function resolvedFact<T>(fact: SessionFact<T>): T | null {
  if (fact === 'unavailable' || fact === 'unknown') {
    return null;
  }
  return 'complete' in fact ? fact.complete : fact.incomplete.facts;
}

export function sessionViewWindow(view: SessionView): SessionWindowStateSnapshot {
  const window = resolvedFact(view.window);
  if (!window) {
    throw new Error('Session view window is unavailable');
  }
  return {
    totalItemCount: Number(window.totalItemCount),
    windowStartOffset: Number(window.windowStartOffset),
    windowEndOffset: Number(window.windowEndOffset),
    hasMore: window.hasMore,
    hasNewer: window.hasNewer,
    isAtLatest: window.isAtLatest,
  };
}

export function decodeHistorySessionView(value: unknown): SessionView {
  try {
    const view = decodeSessionView(value);
    if (view.completeness === 'unavailable' || view.completeness === 'unknown') {
      throw new Error('Session view is unavailable');
    }
    return view;
  } catch (error) {
    if (error instanceof Error && error.message === 'Session view is unavailable') {
      throw error;
    }
    throw new Error('Session view is unavailable', { cause: error });
  }
}

export interface RichTimelineMessage {
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

function richMessageStatus(message: RichTimelineMessage): SessionTimelineEntryStatus | undefined {
  if (message.role === 'assistant') {
    return message.runId ? 'final' : undefined;
  }
  return undefined;
}

function richMedia(content: SessionTimelineContentBlock): {
  images: SessionRenderImage[];
  attachedFiles: SessionRenderAttachedFile[];
} {
  if (content.kind !== 'media' || !content.reference) {
    return { images: [], attachedFiles: [] };
  }
  const reference = content.reference.trim();
  if (!reference || reference.startsWith('data:') || reference.startsWith('file:')) {
    return { images: [], attachedFiles: [] };
  }
  const mimeType = content.mediaType ?? 'application/octet-stream';
  if (mimeType.toLowerCase().startsWith('image/')) {
    return { images: [{ url: reference, mimeType }], attachedFiles: [] };
  }
  return {
    images: [],
    attachedFiles: [{
      fileName: 'media',
      mimeType,
      fileSize: 0,
      preview: null,
      gatewayUrl: reference,
      source: 'message-ref',
    }],
  };
}

function richToolCard(
  toolCallId: string,
  name: string,
  result?: { summary?: string; isError?: boolean },
): SessionRenderToolCard {
  const summary = result?.summary?.trim() || undefined;
  const status = result?.isError ? 'error' : summary ? 'completed' : 'running';
  return {
    id: toolCallId,
    toolCallId,
    name,
    displayTitle: name,
    input: {},
    status,
    ...(summary ? { summary } : {}),
    result: summary
      ? { kind: 'text', surface: 'tool-card', collapsedPreview: summary, bodyText: summary }
      : { kind: 'none', surface: 'tool-card' },
  };
}

function richKey(message: RichTimelineMessage, index: number): string {
  return message.messageId || message.originMessageId || `${message.role}:${message.sequenceId ?? index}`;
}

export function richTimelineItems(
  sessionKey: string,
  messages: ReadonlyArray<RichTimelineMessage>,
): SessionRenderItem[] {
  const resultByToolCallId = new Map<string, { summary: string; isError: boolean }>();
  for (const message of messages) {
    if ((message.role === 'tool_result' || message.role === 'toolresult') && message.toolCallId) {
      resultByToolCallId.set(message.toolCallId, {
        summary: message.text,
        isError: message.content?.some((block) => block.kind === 'toolResult' && block.isError === true) ?? false,
      });
    }
    for (const content of message.content ?? []) {
      if (content.kind === 'toolResult' && content.toolCallId) {
        resultByToolCallId.set(content.toolCallId, {
          summary: content.summary ?? '',
          isError: content.isError === true,
        });
      }
    }
  }

  const items: SessionRenderItem[] = [];
  for (const [index, message] of messages.entries()) {
    const key = richKey(message, index);
    if (message.role === 'user') {
      const media = (message.content ?? []).map(richMedia);
      items.push({
        key,
        kind: 'user-message',
        role: 'user',
        sessionKey,
        text: message.text,
        images: media.flatMap((entry) => entry.images),
        attachedFiles: media.flatMap((entry) => entry.attachedFiles),
        ...(message.messageId ? { messageId: message.messageId } : {}),
      });
      continue;
    }
    if (message.role === 'system') {
      items.push({
        key,
        kind: 'system',
        role: 'system',
        sessionKey,
        text: message.text,
        level: 'info',
        ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt }),
        ...(message.updatedAt === undefined ? {} : { updatedAt: message.updatedAt }),
      });
      continue;
    }
    if (message.role === 'tool_result' || message.role === 'toolresult') {
      continue;
    }

    const segments: SessionAssistantTurnSegment[] = [];
    let messageIndex = 0;
    let thinkingIndex = 0;
    let mediaIndex = 0;
    let toolIndex = 0;
    for (const [contentIndex, content] of (message.content ?? []).entries()) {
      if (content.kind === 'text') {
        segments.push({ kind: 'message', key: `${key}:message:${messageIndex++}`, text: content.text });
      } else if (content.kind === 'thinking') {
        segments.push({ kind: 'thinking', key: `${key}:thinking:${thinkingIndex++}`, text: content.text });
      } else if (content.kind === 'media') {
        const media = richMedia(content);
        if (media.images.length || media.attachedFiles.length) {
          segments.push({ kind: 'media', key: `${key}:media:${mediaIndex++}`, ...media });
        }
      } else if (content.kind === 'toolUse') {
        const toolResult = content.toolCallId ? resultByToolCallId.get(content.toolCallId) : undefined;
        const tool = richToolCard(content.toolCallId ?? `${key}:tool:${toolIndex++}`, content.name, toolResult);
        segments.push({ kind: 'tool', key: `${key}:tool:${content.toolCallId ?? contentIndex}`, tool });
      }
    }
    items.push({
      key,
      kind: 'assistant-turn',
      role: 'assistant',
      sessionKey,
      identitySource: message.runId ? 'run' : 'message',
      identityMode: message.runId ? 'run' : 'message',
      identityConfidence: 'strong',
      status: richMessageStatus(message) === 'final' ? 'final' : 'streaming',
      segments,
      thinking: segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'thinking' }> => segment.kind === 'thinking').map((segment) => segment.text).join('\\n') || null,
      tools: segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'tool' }> => segment.kind === 'tool').map((segment) => segment.tool),
      text: segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'message' }> => segment.kind === 'message').map((segment) => segment.text).join('') || message.text,
      images: segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'media' }> => segment.kind === 'media').flatMap((segment) => segment.images),
      attachedFiles: segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'media' }> => segment.kind === 'media').flatMap((segment) => segment.attachedFiles),
      ...(message.messageId ? { messageId: message.messageId } : {}),
      ...(message.runId ? { runId: message.runId } : {}),
    });
  }
  return items;
}

export function timelineItems(
  sessionKey: string,
  messages: ReadonlyArray<RichTimelineMessage>,
): SessionRenderItem[] {
  return richTimelineItems(sessionKey, messages);
}

interface FetchHistoryWindowInput {
  recordKey: string;
  backendSessionKey: string;
  endpointSessionId?: string;
  sessionIdentity: SessionIdentity;
  sessions: ChatSession[];
  limit: number;
  timeoutMs?: number;
  traceId?: string | null;
}

export async function fetchHistoryWindow(
  input: FetchHistoryWindowInput,
): Promise<HistoryWindowResult> {
  const {
    recordKey,
    backendSessionKey,
    endpointSessionId,
    sessionIdentity,
    sessions,
    limit,
    timeoutMs,
    traceId,
  } = input;

  logSessionTrace('history.transport.request', traceId, {
    recordKey: summarizeIdentifier(recordKey),
    backendSessionKey: summarizeIdentifier(backendSessionKey),
    endpointSessionId: summarizeIdentifier(endpointSessionId),
    sessionIdentity: summarizeSessionIdentity(sessionIdentity),
    limit,
    timeoutMs: timeoutMs ?? null,
  });
  let rawView: unknown;
  try {
    rawView = await hostSessionLoad({
      sessionKey: backendSessionKey,
      ...(endpointSessionId ? { endpointSessionId } : {}),
      sessionIdentity,
      limit,
    }, { timeoutMs, traceId });
    logSessionTrace('history.transport.response', traceId, {
      rawType: rawView && typeof rawView === 'object' ? 'object' : typeof rawView,
    });
  } catch (error) {
    logSessionTrace('history.transport.error', traceId, {
      ...summarizeError(error),
    });
    throw resolveSessionViewError(error);
  }

  const view = decodeHistorySessionView(rawView);
  return {
    view,
    thinkingLevel: resolveSessionThinkingLevelFromList(sessions, recordKey),
  };
}
