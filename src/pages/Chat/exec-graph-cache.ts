import type { RawMessage } from '@/stores/chat';
import type { ExecutionGraphData } from './chat-row-model';
import {
  EMPTY_EXECUTION_GRAPHS,
  EMPTY_SUPPRESSED_KEYS,
  EXECUTION_GRAPH_CACHE_MAX_SESSIONS,
  type IdleCallbackHandle,
  type SessionExecutionCache,
} from './exec-graph-types';

interface IdleDeadlineLike {
  readonly didTimeout: boolean;
  timeRemaining: () => number;
}

type IdleCallback = (deadline: IdleDeadlineLike) => void;

export const globalSessionExecutionCache = new Map<string, SessionExecutionCache>();
export const globalSubagentHistoryBySession = new Map<string, RawMessage[]>();

export function rememberSessionExecutionCache(sessionKey: string, cache: SessionExecutionCache): void {
  if (globalSessionExecutionCache.has(sessionKey)) {
    globalSessionExecutionCache.delete(sessionKey);
  }
  globalSessionExecutionCache.set(sessionKey, cache);
  while (globalSessionExecutionCache.size > EXECUTION_GRAPH_CACHE_MAX_SESSIONS) {
    const oldestKey = globalSessionExecutionCache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    globalSessionExecutionCache.delete(oldestKey);
  }
}

export function scheduleIdleCallback(callback: IdleCallback): IdleCallbackHandle {
  if (typeof window !== 'undefined') {
    const win = window as Window & {
      requestIdleCallback?: (cb: IdleCallback, options?: { timeout?: number }) => number;
    };
    if (typeof win.requestIdleCallback === 'function') {
      return win.requestIdleCallback(callback, { timeout: 120 });
    }
  }
  return setTimeout(() => {
    callback({
      didTimeout: true,
      timeRemaining: () => 0,
    });
  }, 0);
}

export function cancelIdleCallbackSafe(handle: IdleCallbackHandle): void {
  if (typeof window !== 'undefined') {
    const win = window as Window & {
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof win.cancelIdleCallback === 'function' && typeof handle === 'number') {
      win.cancelIdleCallback(handle);
      return;
    }
  }
  clearTimeout(handle);
}

export function snapshotExecutionGraphs(executionGraphs: ExecutionGraphData[]): ExecutionGraphData[] {
  return executionGraphs.length > 0 ? [...executionGraphs] : EMPTY_EXECUTION_GRAPHS;
}

export function snapshotSuppressedToolCardRowKeys(keys: Set<string>): Set<string> {
  return keys.size > 0 ? new Set(keys) : EMPTY_SUPPRESSED_KEYS;
}
