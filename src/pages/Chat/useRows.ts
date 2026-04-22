import { useMemo } from 'react';
import type { RawMessage, ToolStatus } from '@/stores/chat';
import {
  appendRuntimeChatRows,
  appendMessageRows,
  buildStaticChatRowsWithMeta,
  canAppendMessageList,
  canPrependMessageList,
  prependMessageRows,
  type ChatRow,
  type ExecutionGraphData,
} from './chat-row-model';
import { getSessionCacheValue, rememberSessionCacheValue } from './chat-session-cache';

interface SessionStaticRowsCache {
  messagesRef: RawMessage[];
  executionGraphsRef: ExecutionGraphData[];
  rows: ChatRow[];
  renderableCount: number;
}

interface UseChatRowsInput {
  currentSessionKey: string;
  rowSourceMessages: RawMessage[];
  executionGraphs: ExecutionGraphData[];
  sending: boolean;
  pendingFinal: boolean;
  waitingApproval: boolean;
  showThinking: boolean;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  streamingTimestamp: number;
}

interface UseChatRowsResult {
  chatRows: ChatRow[];
  staticRowsCostMs: number;
  runtimeRowsCostMs: number;
}

const globalStaticRowsCache = new Map<string, SessionStaticRowsCache>();

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
    streamingMessage,
    streamingTools,
    streamingTimestamp,
  } = input;

  const staticRowsResult = useMemo(
    () => {
      const startedAt = nowMs();
      const previousCache = getSessionCacheValue(globalStaticRowsCache, currentSessionKey);
      if (
        previousCache
        && previousCache.messagesRef === rowSourceMessages
        && previousCache.executionGraphsRef === executionGraphs
      ) {
        return {
          rows: previousCache.rows,
          costMs: Math.max(0, nowMs() - startedAt),
        };
      }

      let rows: ChatRow[];
      let renderableCount: number;
      const canIncrementalAppend = Boolean(
        previousCache
        && previousCache.executionGraphsRef === executionGraphs
        && canAppendMessageList(previousCache.messagesRef, rowSourceMessages),
      );
      const canIncrementalPrepend = Boolean(
        previousCache
        && previousCache.executionGraphsRef === executionGraphs
        && canPrependMessageList(previousCache.messagesRef, rowSourceMessages),
      );
      if (canIncrementalAppend && previousCache) {
        const appended = appendMessageRows(
          currentSessionKey,
          previousCache.rows,
          rowSourceMessages,
          previousCache.messagesRef.length,
          previousCache.renderableCount,
        );
        rows = appended.rows;
        renderableCount = appended.renderableCount;
      } else if (canIncrementalPrepend && previousCache) {
        const prepended = prependMessageRows(
          currentSessionKey,
          previousCache.rows,
          rowSourceMessages,
          rowSourceMessages.length - previousCache.messagesRef.length,
          previousCache.renderableCount,
        );
        rows = prepended.rows;
        renderableCount = prepended.renderableCount;
      } else {
        const built = buildStaticChatRowsWithMeta({
          sessionKey: currentSessionKey,
          messages: rowSourceMessages,
          executionGraphs,
        });
        rows = built.rows;
        renderableCount = built.renderableCount;
      }

      rememberSessionCacheValue(globalStaticRowsCache, currentSessionKey, {
        messagesRef: rowSourceMessages,
        executionGraphsRef: executionGraphs,
        rows,
        renderableCount,
      });

      return {
        rows,
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
