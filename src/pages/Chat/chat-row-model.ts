import type { RawMessage, ToolStatus } from '@/stores/chat';
import { extractImages, extractText, extractThinking, extractToolUse } from './message-utils';
import type { TaskStep } from './task-viz';

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

interface BuildStaticChatRowsInput {
  sessionKey: string;
  messages: RawMessage[];
  executionGraphs?: ExecutionGraphData[];
}

interface BuildStaticChatRowsResult {
  rows: ChatRow[];
  renderableCount: number;
}

interface AppendRuntimeChatRowsInput {
  sessionKey: string;
  baseRows: ChatRow[];
  sending: boolean;
  pendingFinal: boolean;
  waitingApproval: boolean;
  showThinking: boolean;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  streamingTimestamp: number;
}

function resolveRuntimeRowKey(sessionKey: string, streamMessage?: RawMessage | null): string {
  if (streamMessage?.id) {
    return resolveMessageRowKey(sessionKey, streamMessage, 0);
  }
  return `runtime:${sessionKey}`;
}

const anonymousMessageKeyByRef = new WeakMap<RawMessage, string>();

function hashStringDjb2(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function serializeContentForAnonymousKey(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim().slice(0, 512);
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const type = typeof block.type === 'string' ? block.type : '';
    if (type === 'text' && typeof block.text === 'string') {
      parts.push(`t:${block.text.trim()}`);
      continue;
    }
    if ((type === 'tool_use' || type === 'toolCall')) {
      const id = typeof block.id === 'string' ? block.id : '';
      const name = typeof block.name === 'string' ? block.name : '';
      parts.push(`u:${id}:${name}`);
      continue;
    }
    if ((type === 'tool_result' || type === 'toolResult')) {
      const toolUseId = typeof block.tool_use_id === 'string'
        ? block.tool_use_id
        : (typeof block.toolUseId === 'string' ? block.toolUseId : '');
      parts.push(`r:${toolUseId}`);
      continue;
    }
    if (type) {
      parts.push(`x:${type}`);
    }
  }
  return parts.join('|').slice(0, 512);
}

export function isRenderableChatMessage(message: RawMessage): boolean {
  const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
  return role !== 'toolresult' && role !== 'tool_result';
}

export function canAppendMessageList(
  previous: RawMessage[],
  next: RawMessage[],
): boolean {
  if (previous.length > next.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) {
      return false;
    }
  }
  return true;
}

export function canPrependMessageList(
  previous: RawMessage[],
  next: RawMessage[],
): boolean {
  if (previous.length > next.length) {
    return false;
  }
  const offset = next.length - previous.length;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[offset + index]) {
      return false;
    }
  }
  return true;
}

export function appendMessageRows(
  sessionKey: string,
  baseRows: ChatRow[],
  messages: RawMessage[],
  fromIndex: number,
  startRenderableIndex: number,
): {
  rows: ChatRow[];
  renderableCount: number;
} {
  if (fromIndex >= messages.length) {
    return {
      rows: baseRows,
      renderableCount: startRenderableIndex,
    };
  }

  const rows = [...baseRows];
  const usedRowKeys = new Set(rows.map((row) => row.key));
  let renderableIndex = startRenderableIndex;
  for (let index = fromIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isRenderableChatMessage(message)) {
      continue;
    }
    const baseKey = resolveMessageRowKey(sessionKey, message, renderableIndex);
    let messageRowKey = baseKey;
    let duplicateOrdinal = 1;
    while (usedRowKeys.has(messageRowKey)) {
      messageRowKey = `${baseKey}|dup:${duplicateOrdinal}`;
      duplicateOrdinal += 1;
    }
    usedRowKeys.add(messageRowKey);
    rows.push({
      key: messageRowKey,
      kind: 'message',
      message,
    });
    renderableIndex += 1;
  }

  return {
    rows,
    renderableCount: renderableIndex,
  };
}

export function prependMessageRows(
  sessionKey: string,
  baseRows: ChatRow[],
  messages: RawMessage[],
  toIndexExclusive: number,
  startRenderableCount: number,
): {
  rows: ChatRow[];
  renderableCount: number;
} {
  if (toIndexExclusive <= 0) {
    return {
      rows: baseRows,
      renderableCount: startRenderableCount,
    };
  }

  const prependedRows: ChatRow[] = [];
  const usedRowKeys = new Set(baseRows.map((row) => row.key));
  let prependedRenderableCount = 0;
  for (let index = 0; index < toIndexExclusive; index += 1) {
    const message = messages[index];
    if (!isRenderableChatMessage(message)) {
      continue;
    }
    const baseKey = resolveMessageRowKey(sessionKey, message, prependedRenderableCount);
    let messageRowKey = baseKey;
    let duplicateOrdinal = 1;
    while (usedRowKeys.has(messageRowKey)) {
      messageRowKey = `${baseKey}|dup:${duplicateOrdinal}`;
      duplicateOrdinal += 1;
    }
    usedRowKeys.add(messageRowKey);
    prependedRows.push({
      key: messageRowKey,
      kind: 'message',
      message,
    });
    prependedRenderableCount += 1;
  }

  return {
    rows: prependedRows.length > 0 ? [...prependedRows, ...baseRows] : baseRows,
    renderableCount: startRenderableCount + prependedRenderableCount,
  };
}

function resolveAnonymousMessageRowKey(sessionKey: string, message: RawMessage): string {
  const role = typeof message.role === 'string' ? message.role : 'unknown';
  const timestamp = typeof message.timestamp === 'number'
    ? String(message.timestamp)
    : 'na';
  const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
  const contentSignature = hashStringDjb2(serializeContentForAnonymousKey(message.content));
  const deterministic = `session:${sessionKey}|anon:${role}:${timestamp}:${toolCallId}:${contentSignature}`;

  // Preserve old WeakMap fast-path for repeated renders of the same object ref.
  const existing = anonymousMessageKeyByRef.get(message);
  if (existing === deterministic) {
    return existing;
  }
  anonymousMessageKeyByRef.set(message, deterministic);
  return deterministic;
}

export function resolveMessageRowKey(sessionKey: string, message: RawMessage, _index: number): string {
  if (typeof message.id === 'string' && message.id.trim()) {
    return `session:${sessionKey}|id:${message.id}`;
  }
  return resolveAnonymousMessageRowKey(sessionKey, message);
}

export function buildStaticChatRows({
  sessionKey,
  messages,
  executionGraphs = [],
}: BuildStaticChatRowsInput): ChatRow[] {
  return buildStaticChatRowsWithMeta({
    sessionKey,
    messages,
    executionGraphs,
  }).rows;
}

export function buildStaticChatRowsWithMeta({
  sessionKey,
  messages,
  executionGraphs = [],
}: BuildStaticChatRowsInput): BuildStaticChatRowsResult {
  if (executionGraphs.length === 0) {
    const rows: ChatRow[] = [];
    const usedRowKeys = new Set<string>();
    let renderableCount = 0;
    for (const message of messages) {
      if (!isRenderableChatMessage(message)) {
        continue;
      }
      const baseKey = resolveMessageRowKey(sessionKey, message, renderableCount);
      let messageRowKey = baseKey;
      let duplicateOrdinal = 1;
      while (usedRowKeys.has(messageRowKey)) {
        messageRowKey = `${baseKey}|dup:${duplicateOrdinal}`;
        duplicateOrdinal += 1;
      }
      usedRowKeys.add(messageRowKey);
      rows.push({
        key: messageRowKey,
        kind: 'message',
        message,
      });
      renderableCount += 1;
    }
    return {
      rows,
      renderableCount,
    };
  }

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
  const usedRowKeys = new Set<string>();
  let renderableIndex = 0;
  for (const message of messages) {
    if (!isRenderableChatMessage(message)) {
      continue;
    }
    const baseKey = resolveMessageRowKey(sessionKey, message, renderableIndex);
    let messageKey = baseKey;
    let duplicateOrdinal = 1;
    while (usedRowKeys.has(messageKey)) {
      messageKey = `${baseKey}|dup:${duplicateOrdinal}`;
      duplicateOrdinal += 1;
    }
    usedRowKeys.add(messageKey);
    renderableIndex += 1;
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

  return {
    rows,
    renderableCount: renderableIndex,
  };
}

export function appendRuntimeChatRows({
  sessionKey,
  baseRows,
  sending,
  pendingFinal,
  waitingApproval,
  showThinking,
  streamingMessage,
  streamingTools,
  streamingTimestamp,
}: AppendRuntimeChatRowsInput): ChatRow[] {
  let rows = baseRows;
  const ensureMutableRows = () => {
    if (rows === baseRows) {
      rows = [...baseRows];
    }
    return rows;
  };

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
    const streamingRowMessage = (streamMsg
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
        }) as RawMessage;
    ensureMutableRows().push({
      key: resolveRuntimeRowKey(sessionKey, streamingRowMessage),
      kind: 'streaming',
      message: streamingRowMessage,
      streamingTools,
    });
  }

  if (sending && pendingFinal && !waitingApproval && !shouldRenderStreaming) {
    ensureMutableRows().push({
      key: resolveRuntimeRowKey(sessionKey),
      kind: 'activity',
    });
  }

  if (sending && !pendingFinal && !waitingApproval && !hasAnyStreamContent) {
    ensureMutableRows().push({
      key: resolveRuntimeRowKey(sessionKey),
      kind: 'typing',
    });
  }

  return rows;
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
  const baseRows = buildStaticChatRows({
    sessionKey,
    messages,
    executionGraphs,
  });
  return appendRuntimeChatRows({
    sessionKey,
    baseRows,
    sending,
    pendingFinal,
    waitingApproval,
    showThinking,
    streamingMessage,
    streamingTools,
    streamingTimestamp,
  });
}
