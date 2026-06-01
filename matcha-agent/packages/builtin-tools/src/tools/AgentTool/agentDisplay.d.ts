/**
 * Shared utilities for displaying agent information.
 * Used by both the CLI `claude agents` handler and the interactive `/agents` command.
 */
import { type SettingSource } from 'src/utils/settings/constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'
type AgentSource = SettingSource | 'built-in' | 'plugin'
export type AgentSourceGroup = {
  label: string
  source: AgentSource
}
/**
 * Ordered list of agent source groups for display.
 * Both the CLI and interactive UI should use this to ensure consistent ordering.
 */
export declare const AGENT_SOURCE_GROUPS: AgentSourceGroup[]
export type ResolvedAgent = AgentDefinition & {
  overriddenBy?: AgentSource
}
/**
 * Annotate agents with override information by comparing against the active
 * (winning) agent list. An agent is "overridden" when another agent with the
 * same type from a higher-priority source takes precedence.
 *
 * Also deduplicates by (agentType, source) to handle git worktree duplicates
 * where the same agent file is loaded from both the worktree and main repo.
 */
export declare function resolveAgentOverrides(
  allAgents: AgentDefinition[],
  activeAgents: AgentDefinition[],
): ResolvedAgent[]
/**
 * Resolve the display model string for an agent.
 * Returns the model alias or 'inherit' for display purposes.
 */
export declare function resolveAgentModelDisplay(
  agent: AgentDefinition,
): string | undefined
/**
 * Get a human-readable label for the source that overrides an agent.
 * Returns lowercase, e.g. "user", "project", "managed".
 */
export declare function getOverrideSourceLabel(source: AgentSource): string
/**
 * Compare agents alphabetically by name (case-insensitive).
 */
export declare function compareAgentsByName(
  a: AgentDefinition,
  b: AgentDefinition,
): number
export {}
