import { useMemo } from 'react';
import type { RawMessage, ToolStatus } from '@/stores/chat';
import {
  appendRuntimeChatRows,
  type ChatRow,
  type ExecutionGraphData,
} from './chat-row-model';
import {
  getOrBuildStaticRowsCacheEntry,
  peekStaticRowsCacheEntry,
} from './chat-rows-cache';

interface UseChatRowsInput {
  currentSessionKey: string;
  rowSourceMessages: RawMessage[];
  executionGraphs: ExecutionGraphData[];
  sending: boolean;
  pendingFinal: boolean;
  waitingApproval: boolean;
  showThinking: boolean;
  pendingUserMessage?: RawMessage | null;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  streamingTimestamp: number;
}

interface UseChatRowsResult {
  chatRows: ChatRow[];
  staticRowsCostMs: number;
  runtimeRowsCostMs: number;
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function useChatRows(
  input: UseChatRowsInput,
): UseChatRowsResult {
  const {
    currentSessionKey,
    rowSourceMessages,
    executionGraphs,
    sending,
    pendingFinal,
    waitingApproval,
    showThinking,
    pendingUserMessage,
    streamingMessage,
    streamingTools,
    streamingTimestamp,
  } = input;

  const staticRowsResult = useMemo(
    () => {
      const startedAt = nowMs();
      const cached = peekStaticRowsCacheEntry(currentSessionKey, rowSourceMessages, executionGraphs);
      if (cached) {
        return {
          rows: cached.rows,
          costMs: Math.max(0, nowMs() - startedAt),
        };
      }
      const next = getOrBuildStaticRowsCacheEntry(currentSessionKey, rowSourceMessages, executionGraphs);

      return {
        rows: next.rows,
        costMs: Math.max(0, nowMs() - startedAt),
      };
    },
    [currentSessionKey, executionGraphs, rowSourceMessages],
  );

  const runtimeRowsResult = useMemo(
    () => {
      const startedAt = nowMs();
      const rows = appendRuntimeChatRows({
        sessionKey: currentSessionKey,
        baseRows: staticRowsResult.rows,
        sending,
        pendingFinal,
        waitingApproval,
        showThinking,
        pendingUserMessage,
        streamingMessage,
        streamingTools,
        streamingTimestamp,
      });
      return {
        rows,
        costMs: Math.max(0, nowMs() - startedAt),
      };
    },
    [
      currentSessionKey,
      pendingFinal,
      pendingUserMessage,
      sending,
      showThinking,
      staticRowsResult.rows,
      streamingMessage,
      streamingTimestamp,
      streamingTools,
      waitingApproval,
    ],
  );

  return {
    chatRows: runtimeRowsResult.rows,
    staticRowsCostMs: staticRowsResult.costMs,
    runtimeRowsCostMs: runtimeRowsResult.costMs,
  };
}

export { getStaticRowsCacheStats } from './chat-rows-cache';
