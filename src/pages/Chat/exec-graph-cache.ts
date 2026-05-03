import type { ExecutionGraphData } from './execution-graph-model';
import {
  EMPTY_EXECUTION_GRAPHS,
  EXECUTION_GRAPH_CACHE_MAX_SESSIONS,
  type IdleCallbackHandle,
  type SessionExecutionCache,
} from './exec-graph-types';
import type { SessionTimelineEntry } from '../../../runtime-host/shared/session-adapter-types';

interface IdleDeadlineLike {
  readonly didTimeout: boolean;
  timeRemaining: () => number;
}

type IdleCallback = (deadline: IdleDeadlineLike) => void;

export const globalSessionExecutionCache = new Map<string, SessionExecutionCache>();
export const globalSubagentHistoryBySession = new Map<string, SessionTimelineEntry[]>();

export interface ExecutionGraphCacheStats {
  cachedSessionCount: number;
  cachedGraphCount: number;
  cachedSuppressedLaneTurnKeyCount: number;
  graphSignatureCacheEntryCount: number;
  mainStepCacheEntryCount: number;
  childStepCacheEntryCount: number;
  subagentHistorySessionCount: number;
  subagentHistoryMessageCount: number;
}

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

export function getExecutionGraphCacheStats(): ExecutionGraphCacheStats {
  let cachedGraphCount = 0;
  let cachedSuppressedLaneTurnKeyCount = 0;
  let graphSignatureCacheEntryCount = 0;
  let mainStepCacheEntryCount = 0;
  let childStepCacheEntryCount = 0;

  for (const cache of globalSessionExecutionCache.values()) {
    cachedGraphCount += cache.executionGraphs.length;
    cachedSuppressedLaneTurnKeyCount += cache.executionGraphs.reduce(
      (total, graph) => total + (graph.suppressToolCardLaneTurnKeys?.length ?? 0),
      0,
    );
    graphSignatureCacheEntryCount += cache.graphCacheBySignature.size;
    mainStepCacheEntryCount += cache.mainStepsCacheBySignature.size;
    childStepCacheEntryCount += cache.childStepsCacheBySignature.size;
  }

  let subagentHistoryMessageCount = 0;
  for (const timelineEntries of globalSubagentHistoryBySession.values()) {
    subagentHistoryMessageCount += timelineEntries.length;
  }

  return {
    cachedSessionCount: globalSessionExecutionCache.size,
    cachedGraphCount,
    cachedSuppressedLaneTurnKeyCount,
    graphSignatureCacheEntryCount,
    mainStepCacheEntryCount,
    childStepCacheEntryCount,
    subagentHistorySessionCount: globalSubagentHistoryBySession.size,
    subagentHistoryMessageCount,
  };
}
