import { useDeferredValue, useEffect, useMemo, useState, type MutableRefObject } from 'react';
import type { RawMessage, ToolStatus } from '@/stores/chat';
import { scheduleIdleReady } from '@/lib/idle-ready';
import type { ChatRow } from './chat-row-model';
import type { ExecutionGraphData } from './execution-graph-model';
import { useExecutionGraphs } from './useExecutionGraphs';
import { useChatRows } from './useRows';
import { getSessionCacheValue, rememberSessionCacheValue } from './chat-session-cache';

const EMPTY_MESSAGES: RawMessage[] = [];

interface ExecutionGraphAgent {
  id: string;
  name?: string;
}

interface SessionPipelineCost {
  sessionKey: string;
  staticRowsMs: number;
  runtimeRowsMs: number;
}

interface UseViewportListItemsInput {
  scopeKey: string;
  sessionKey: string;
  messages: RawMessage[];
  agents: ExecutionGraphAgent[];
  isGatewayRunning: boolean;
  gatewayRpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  sending: boolean;
  pendingFinal: boolean;
  waitingApproval: boolean;
  showThinking: boolean;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  sessionPipelineCostRef: MutableRefObject<SessionPipelineCost>;
}

export type ViewportListItem =
  | {
    key: string;
    kind: 'message';
    row: Extract<ChatRow, { kind: 'message' }>;
  }
  | {
    key: string;
    kind: 'activity';
    row: Extract<ChatRow, { kind: 'activity' }>;
  }
  | {
    key: string;
    kind: 'typing';
    row: Extract<ChatRow, { kind: 'typing' }>;
  }
  | {
    key: string;
    kind: 'execution_graph';
    graph: ExecutionGraphData;
  };

interface SessionViewportListItemsCache {
  rowsRef: ChatRow[];
  executionGraphsRef: ExecutionGraphData[];
  items: ViewportListItem[];
}

export interface ViewportListItemsCacheStats {
  cachedSessionCount: number;
  cachedItemCount: number;
}

const globalViewportListItemsCache = new Map<string, SessionViewportListItemsCache>();

function createViewportRowItem(row: ChatRow): ViewportListItem {
  if (row.kind === 'message') {
    return {
      key: row.key,
      kind: 'message',
      row,
    };
  }
  if (row.kind === 'activity') {
    return {
      key: row.key,
      kind: 'activity',
      row,
    };
  }
  return {
    key: row.key,
    kind: 'typing',
    row,
  };
}

export function buildViewportListItems(
  rows: ChatRow[],
  executionGraphs: ExecutionGraphData[] = [],
): ViewportListItem[] {
  if (executionGraphs.length === 0) {
    return rows.map(createViewportRowItem);
  }

  const graphByAnchorMessageKey = new Map<string, ExecutionGraphData[]>();
  for (const graph of executionGraphs) {
    const anchorKey = graph.anchorMessageKey;
    if (!anchorKey) {
      continue;
    }
    const existing = graphByAnchorMessageKey.get(anchorKey);
    if (!existing) {
      graphByAnchorMessageKey.set(anchorKey, [graph]);
    } else {
      existing.push(graph);
    }
  }

  const items: ViewportListItem[] = [];
  const insertedGraphIds = new Set<string>();

  for (const row of rows) {
    items.push(createViewportRowItem(row));
    if (row.kind !== 'message') {
      continue;
    }
    const anchoredGraphs = graphByAnchorMessageKey.get(row.key);
    if (!anchoredGraphs) {
      continue;
    }
    for (const graph of anchoredGraphs) {
      if (insertedGraphIds.has(graph.id)) {
        continue;
      }
      insertedGraphIds.add(graph.id);
      items.push({
        key: `execution_graph:${graph.id}`,
        kind: 'execution_graph',
        graph,
      });
    }
  }

  for (const graph of executionGraphs) {
    if (insertedGraphIds.has(graph.id)) {
      continue;
    }
    insertedGraphIds.add(graph.id);
    items.push({
      key: `execution_graph:${graph.id}`,
      kind: 'execution_graph',
      graph,
    });
  }

  return items;
}

function useCachedViewportListItems(
  currentSessionKey: string,
  rows: ChatRow[],
  executionGraphs: ExecutionGraphData[],
): ViewportListItem[] {
  return useMemo(() => {
    const cached = getSessionCacheValue(globalViewportListItemsCache, currentSessionKey);
    if (cached && cached.rowsRef === rows && cached.executionGraphsRef === executionGraphs) {
      return cached.items;
    }

    const items = buildViewportListItems(rows, executionGraphs);
    rememberSessionCacheValue(globalViewportListItemsCache, currentSessionKey, {
      rowsRef: rows,
      executionGraphsRef: executionGraphs,
      items,
    });
    return items;
  }, [currentSessionKey, executionGraphs, rows]);
}

export function useViewportListItems(input: UseViewportListItemsInput): {
  items: ViewportListItem[];
  suppressedToolCardRowKeys: Set<string>;
  runtimeRowsCostMs: number;
} {
  const {
    scopeKey,
    sessionKey,
    messages,
    agents,
    isGatewayRunning,
    gatewayRpc,
    sending,
    pendingFinal,
    waitingApproval,
    showThinking,
    streamingMessage,
    streamingTools,
    sessionPipelineCostRef,
  } = input;

  const [executionGraphsEnabled, setExecutionGraphsEnabled] = useState(false);

  useEffect(() => {
    setExecutionGraphsEnabled(false);
    const cancel = scheduleIdleReady(() => {
      setExecutionGraphsEnabled(true);
    }, {
      idleTimeoutMs: 240,
      fallbackDelayMs: 90,
    });
    return cancel;
  }, [scopeKey]);

  const deferredMessages = useDeferredValue(messages);
  const deferredSessionKey = useDeferredValue(scopeKey);
  const executionGraphInputReady = deferredSessionKey === scopeKey && deferredMessages === messages;
  const { executionGraphs, suppressedToolCardRowKeys } = useExecutionGraphs({
    enabled: executionGraphsEnabled && executionGraphInputReady,
    messages: executionGraphInputReady ? messages : EMPTY_MESSAGES,
    currentSessionKey: scopeKey,
    agents,
    isGatewayRunning,
    gatewayRpc,
    showThinking,
  });

  const {
    chatRows,
    staticRowsCostMs,
    runtimeRowsCostMs,
  } = useChatRows({
    currentSessionKey: sessionKey,
    rowSourceMessages: messages,
    sending,
    pendingFinal,
    waitingApproval,
    showThinking,
    streamingMessage,
    streamingTools,
  });

  useEffect(() => {
    if (staticRowsCostMs <= 0) {
      return;
    }
    const cost = sessionPipelineCostRef.current;
    if (cost.sessionKey === scopeKey) {
      cost.staticRowsMs += staticRowsCostMs;
    }
  }, [scopeKey, sessionPipelineCostRef, staticRowsCostMs]);

  useEffect(() => {
    if (runtimeRowsCostMs <= 0) {
      return;
    }
    const cost = sessionPipelineCostRef.current;
    if (cost.sessionKey === scopeKey) {
      cost.runtimeRowsMs += runtimeRowsCostMs;
    }
  }, [runtimeRowsCostMs, scopeKey, sessionPipelineCostRef]);

  const items = useCachedViewportListItems(scopeKey, chatRows, executionGraphs);

  return {
    items,
    suppressedToolCardRowKeys,
    runtimeRowsCostMs,
  };
}

export function getViewportListItemsCacheStats(): ViewportListItemsCacheStats {
  let cachedItemCount = 0;
  for (const cache of globalViewportListItemsCache.values()) {
    cachedItemCount += cache.items.length;
  }

  return {
    cachedSessionCount: globalViewportListItemsCache.size,
    cachedItemCount,
  };
}
