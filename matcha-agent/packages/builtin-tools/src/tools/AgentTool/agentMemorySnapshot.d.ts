import { type AgentMemoryScope } from './agentMemory.js'
/**
 * Returns the path to the snapshot directory for an agent in the current project.
 * e.g., <cwd>/.claude/agent-memory-snapshots/<agentType>/
 */
export declare function getSnapshotDirForAgent(agentType: string): string
/**
 * Check if a snapshot exists and whether it's newer than what we last synced.
 */
export declare function checkAgentMemorySnapshot(
  agentType: string,
  scope: AgentMemoryScope,
): Promise<{
  action: 'none' | 'initialize' | 'prompt-update'
  snapshotTimestamp?: string
}>
/**
 * Initialize local agent memory from a snapshot (first-time setup).
 */
export declare function initializeFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void>
/**
 * Replace local agent memory with the snapshot.
 */
export declare function replaceFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void>
/**
 * Mark the current snapshot as synced without changing local memory.
 */
export declare function markSnapshotSynced(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void>
