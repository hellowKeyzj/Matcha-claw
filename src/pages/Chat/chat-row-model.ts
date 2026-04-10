import type { RawMessage, ToolStatus } from '@/stores/chat';
import { extractImages, extractText, extractThinking, extractToolUse } from './message-utils';
import type { TaskStep } from './task-visualization';

export interface ExecutionGraphData {
  id: string;
  anchorMessageKey: string;
  triggerMessageKey: string;
  replyMessageKey?: string;
  agentLabel: string;
  sessionLabel: string;
  steps: TaskStep[];
  active: boolean;
  suppressToolCardMessageKeys?: string[];
}

export type ChatRow =
  | {
    key: string;
    kind: 'message';
    message: RawMessage;
  }
  | {
    key: string;
    kind: 'execution_graph';
    graph: ExecutionGraphData;
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
  executionGraphs?: ExecutionGraphData[];
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
  executionGraphs = [],
}: BuildChatRowsInput): ChatRow[] {
  const graphByAnchorMessageKey = new Map<string, ExecutionGraphData[]>();
  for (const graph of executionGraphs) {
    const anchorKey = graph.anchorMessageKey;
    if (!anchorKey) continue;
    const existing = graphByAnchorMessageKey.get(anchorKey);
    if (!existing) {
      graphByAnchorMessageKey.set(anchorKey, [graph]);
    } else {
      existing.push(graph);
    }
  }

  const insertedGraphIds = new Set<string>();
  const rows: ChatRow[] = [];
  const renderableMessages = messages.filter(isRenderableMessage);
  for (const [index, message] of renderableMessages.entries()) {
    const messageKey = resolveMessageRowKey(message, index);
    rows.push({
      key: messageKey,
      kind: 'message',
      message,
    });
    const graphs = graphByAnchorMessageKey.get(messageKey);
    if (!graphs || graphs.length === 0) {
      continue;
    }
    for (const graph of graphs) {
      if (insertedGraphIds.has(graph.id)) continue;
      insertedGraphIds.add(graph.id);
      rows.push({
        key: `execution_graph:${graph.id}`,
        kind: 'execution_graph',
        graph,
      });
    }
  }

  for (const graph of executionGraphs) {
    if (insertedGraphIds.has(graph.id)) continue;
    insertedGraphIds.add(graph.id);
    rows.push({
      key: `execution_graph:${graph.id}`,
      kind: 'execution_graph',
      graph,
    });
  }

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
