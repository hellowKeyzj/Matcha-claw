import { useMemo } from 'react';
import type { RawMessage } from '@/stores/chat';
import type { ChatSessionRuntimeState } from '@/stores/chat/types';
import type { ChatMessageRow } from './chat-row-model';
import type { ExecutionGraphData } from './execution-graph-model';
import { useExecutionGraphs } from './useExecutionGraphs';
import { getOrBuildStaticRowsCacheEntry } from './chat-rows-cache';

interface ExecutionGraphAgent {
  id: string;
  name?: string;
}

interface UseChatRenderModelInput {
  sessionKey: string;
  messages: RawMessage[];
  runtime: ChatSessionRuntimeState;
  agents: ExecutionGraphAgent[];
  isGatewayRunning: boolean;
  gatewayRpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  showThinking: boolean;
}

export interface ChatExecutionGraphSlots {
  anchoredGraphsByRowKey: ReadonlyMap<string, ReadonlyArray<ExecutionGraphData>>;
  suppressedToolCardRowKeys: ReadonlySet<string>;
}

const EMPTY_EXECUTION_GRAPH_SLOTS: ChatExecutionGraphSlots = {
  anchoredGraphsByRowKey: new Map(),
  suppressedToolCardRowKeys: new Set(),
};

export function buildExecutionGraphSlots(
  rows: ChatMessageRow[],
  executionGraphs: ExecutionGraphData[],
): ChatExecutionGraphSlots {
  if (rows.length === 0 || executionGraphs.length === 0) {
    return EMPTY_EXECUTION_GRAPH_SLOTS;
  }

  const rowKeys = new Set(rows.map((row) => row.key));
  const anchoredGraphsByRowKey = new Map<string, ExecutionGraphData[]>();
  const suppressedRowKeys = new Set<string>();
  for (const graph of executionGraphs) {
    for (const rowKey of graph.suppressToolCardMessageKeys || []) {
      suppressedRowKeys.add(rowKey);
    }
    const anchorRowKey = anchoredGraphsByRowKey.has(graph.anchorMessageKey)
      || rowKeys.has(graph.anchorMessageKey)
      ? graph.anchorMessageKey
      : rows[rows.length - 1]?.key;
    if (!anchorRowKey) {
      continue;
    }
    const current = anchoredGraphsByRowKey.get(anchorRowKey);
    if (current) {
      current.push(graph);
      continue;
    }
    anchoredGraphsByRowKey.set(anchorRowKey, [graph]);
  }

  return {
    anchoredGraphsByRowKey,
    suppressedToolCardRowKeys: suppressedRowKeys,
  };
}

export interface PendingAssistantShell {
  state: 'typing' | 'activity';
}

function buildPendingAssistantShell(
  runtime: ChatSessionRuntimeState,
  messages: RawMessage[],
): PendingAssistantShell | null {
  if (
    !runtime.sending
    || runtime.approvalStatus === 'awaiting_approval'
    || runtime.streamingTools.length > 0
    || messages.some((message) => message.role === 'assistant' && Boolean(message.streaming))
  ) {
    return null;
  }

  return {
    state: runtime.pendingFinal ? 'activity' : 'typing',
  };
}

export function useChatRenderModel(input: UseChatRenderModelInput): {
  rows: ChatMessageRow[];
  executionGraphSlots: ChatExecutionGraphSlots;
  pendingAssistantShell: PendingAssistantShell | null;
} {
  const {
    sessionKey,
    messages,
    runtime,
    agents,
    isGatewayRunning,
    gatewayRpc,
    showThinking,
  } = input;
  const executionGraphs = useExecutionGraphs({
    enabled: isGatewayRunning,
    messages,
    currentSessionKey: sessionKey,
    agents,
    isGatewayRunning,
    gatewayRpc,
    showThinking,
  });

  const rows = useMemo(
    () => getOrBuildStaticRowsCacheEntry(sessionKey, messages).rows,
    [messages, sessionKey],
  );
  const executionGraphSlots = useMemo(
    () => buildExecutionGraphSlots(rows, executionGraphs),
    [executionGraphs, rows],
  );
  const pendingAssistantShell = useMemo(
    () => buildPendingAssistantShell(runtime, messages),
    [
      messages,
      runtime.approvalStatus,
      runtime.pendingFinal,
      runtime.sending,
      runtime.streamingTools.length,
    ],
  );

  return {
    rows,
    executionGraphSlots,
    pendingAssistantShell,
  };
}
