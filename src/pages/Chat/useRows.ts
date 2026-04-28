import { useMemo } from 'react';
import type { RawMessage, ToolStatus } from '@/stores/chat';
import {
  appendRuntimeChatRows,
  type ChatRow,
} from './chat-row-model';
import {
  getOrBuildStaticRowsCacheEntry,
  peekStaticRowsCacheEntry,
} from './chat-rows-cache';

interface UseChatRowsInput {
  currentSessionKey: string;
  rowSourceMessages: RawMessage[];
  sending: boolean;
  pendingFinal: boolean;
  waitingApproval: boolean;
  showThinking: boolean;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
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
    sending,
    pendingFinal,
    waitingApproval,
    showThinking,
    streamingMessage,
    streamingTools,
  } = input;

  const staticRowsResult = useMemo(
    () => {
      const startedAt = nowMs();
      const cached = peekStaticRowsCacheEntry(currentSessionKey, rowSourceMessages);
      if (cached) {
        return {
          rows: cached.rows,
          costMs: Math.max(0, nowMs() - startedAt),
        };
      }
      const next = getOrBuildStaticRowsCacheEntry(currentSessionKey, rowSourceMessages);

      return {
        rows: next.rows,
        costMs: Math.max(0, nowMs() - startedAt),
      };
    },
    [currentSessionKey, rowSourceMessages],
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
        streamingMessage,
        streamingTools,
      });
      return {
        rows,
        costMs: Math.max(0, nowMs() - startedAt),
      };
    },
    [
      currentSessionKey,
      pendingFinal,
      sending,
      showThinking,
      staticRowsResult.rows,
      streamingMessage,
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
