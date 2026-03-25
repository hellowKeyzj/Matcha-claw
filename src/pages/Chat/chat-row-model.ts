import type { RawMessage, ToolStatus } from '@/stores/chat';
import { extractImages, extractText, extractThinking, extractToolUse } from './message-utils';

export type ChatRow =
  | {
    key: string;
    kind: 'message';
    message: RawMessage;
  }
  | {
    key: string;
    kind: 'streaming';
    message: RawMessage;
    streamingTools: ToolStatus[];
  }
  | {
    key: string;
    kind: 'activity';
  }
  | {
    key: string;
    kind: 'typing';
  };

interface BuildChatRowsInput {
  sessionKey: string;
  messages: RawMessage[];
  sending: boolean;
  pendingFinal: boolean;
  waitingApproval: boolean;
  showThinking: boolean;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  streamingTimestamp: number;
}

function isRenderableMessage(message: RawMessage): boolean {
  const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
  return role !== 'toolresult' && role !== 'tool_result';
}

export function resolveMessageRowKey(message: RawMessage, index: number): string {
  if (typeof message.id === 'string' && message.id.trim()) {
    return `id:${message.id}`;
  }
  const role = typeof message.role === 'string' ? message.role : 'unknown';
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : 'na';
  const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
  return `fallback:${role}:${timestamp}:${toolCallId}:${index}`;
}

export function buildChatRows({
  sessionKey,
  messages,
  sending,
  pendingFinal,
  waitingApproval,
  showThinking,
  streamingMessage,
  streamingTools,
  streamingTimestamp,
}: BuildChatRowsInput): ChatRow[] {
  const rows: ChatRow[] = messages
    .filter(isRenderableMessage)
    .map((message, index) => ({
      key: resolveMessageRowKey(message, index),
      kind: 'message' as const,
      message,
    }));

  const streamMsg = streamingMessage && typeof streamingMessage === 'object'
    ? streamingMessage as { role?: string; content?: unknown; timestamp?: number }
    : null;
  const streamText = streamMsg ? extractText(streamMsg) : (typeof streamingMessage === 'string' ? streamingMessage : '');
  const streamThinking = streamMsg ? extractThinking(streamMsg) : null;
  const streamTools = streamMsg ? extractToolUse(streamMsg) : [];
  const streamImages = streamMsg ? extractImages(streamMsg) : [];

  const hasStreamText = streamText.trim().length > 0;
  const hasStreamThinking = showThinking && !!streamThinking && streamThinking.trim().length > 0;
  const hasStreamTools = streamTools.length > 0;
  const hasStreamImages = streamImages.length > 0;
  const hasStreamToolStatus = streamingTools.length > 0;
  const hasAnyStreamContent = hasStreamText || hasStreamThinking || hasStreamTools || hasStreamImages || hasStreamToolStatus;
  const shouldRenderStreaming = sending && hasAnyStreamContent;

  if (shouldRenderStreaming) {
    rows.push({
      key: `streaming:${sessionKey}`,
      kind: 'streaming',
      message: (streamMsg
        ? {
            ...(streamMsg as Record<string, unknown>),
            role: (typeof streamMsg.role === 'string' ? streamMsg.role : 'assistant') as RawMessage['role'],
            content: streamMsg.content ?? streamText,
            timestamp: streamMsg.timestamp ?? streamingTimestamp,
          }
        : {
            role: 'assistant',
            content: streamText,
            timestamp: streamingTimestamp,
          }) as RawMessage,
      streamingTools,
    });
  }

  if (sending && pendingFinal && !waitingApproval && !shouldRenderStreaming) {
    rows.push({
      key: `activity:${sessionKey}`,
      kind: 'activity',
    });
  }

  if (sending && !pendingFinal && !waitingApproval && !hasAnyStreamContent) {
    rows.push({
      key: `typing:${sessionKey}`,
      kind: 'typing',
    });
  }

  return rows;
}
