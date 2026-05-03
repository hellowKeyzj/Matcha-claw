export interface ExecutionGraphCacheStats {
  cachedSessionCount: number;
  cachedGraphCount: number;
  graphSignatureCacheEntryCount: number;
  mainStepCacheEntryCount: number;
  childStepCacheEntryCount: number;
  subagentHistorySessionCount: number;
  subagentHistoryMessageCount: number;
}

const EMPTY_EXECUTION_GRAPH_CACHE_STATS: ExecutionGraphCacheStats = {
  cachedSessionCount: 0,
  cachedGraphCount: 0,
  graphSignatureCacheEntryCount: 0,
  mainStepCacheEntryCount: 0,
  childStepCacheEntryCount: 0,
  subagentHistorySessionCount: 0,
  subagentHistoryMessageCount: 0,
};

export function getExecutionGraphCacheStats(): ExecutionGraphCacheStats {
  return EMPTY_EXECUTION_GRAPH_CACHE_STATS;
}
