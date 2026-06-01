import type {
  AssistantMessage,
  Message as MessageType,
} from 'src/types/message.js'
/**
 * Fork subagent feature gate.
 *
 * When enabled:
 * - `subagent_type` becomes optional on the Agent tool schema
 * - Omitting `subagent_type` triggers an implicit fork: the child inherits
 *   the parent's full conversation context and system prompt
 * - All agent spawns run in the background (async) for a unified
 *   `<task-notification>` interaction model
 * - `/fork <directive>` slash command is available
 *
 * Mutually exclusive with coordinator mode — coordinator already owns the
 * orchestration role and has its own delegation model.
 */
export declare function isForkSubagentEnabled(): boolean
/** Synthetic agent type name used for analytics when the fork path fires. */
export declare const FORK_SUBAGENT_TYPE = 'fork'
/**
 * Synthetic agent definition for the fork path.
 *
 * Not registered in builtInAgents — used only when `!subagent_type` and the
 * experiment is active. `tools: ['*']` with `useExactTools` means the fork
 * child receives the parent's exact tool pool (for cache-identical API
 * prefixes). `permissionMode: 'bubble'` surfaces permission prompts to the
 * parent terminal. `model: 'inherit'` keeps the parent's model for context
 * length parity.
 *
 * The getSystemPrompt here is unused: the fork path passes
 * `override.systemPrompt` with the parent's already-rendered system prompt
 * bytes, threaded via `toolUseContext.renderedSystemPrompt`. Reconstructing
 * by re-calling getSystemPrompt() can diverge (GrowthBook cold→warm) and
 * bust the prompt cache; threading the rendered bytes is byte-exact.
 */
export declare const FORK_AGENT: {
  agentType: string
  whenToUse: string
  tools: string[]
  maxTurns: number
  model: string
  permissionMode: 'bubble'
  source: 'built-in'
  baseDir: 'built-in'
  getSystemPrompt: () => string
}
/**
 * Guard against recursive forking. Fork children keep the Agent tool in their
 * tool pool for cache-identical tool definitions, so we reject fork attempts
 * at call time by detecting the fork boilerplate tag in conversation history.
 */
export declare function isInForkChild(messages: MessageType[]): boolean
/**
 * Build the forked conversation messages for the child agent.
 *
 * For prompt cache sharing, all fork children must produce byte-identical
 * API request prefixes. This function:
 * 1. Keeps the full parent assistant message (all tool_use blocks, thinking, text)
 * 2. Builds a single user message with tool_results for every tool_use block
 *    using an identical placeholder, then appends a per-child directive text block
 *
 * Result: [...history, assistant(all_tool_uses), user(placeholder_results..., directive)]
 * Only the final text block differs per child, maximizing cache hits.
 */
export declare function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): MessageType[]
export declare function buildChildMessage(directive: string): string
/**
 * Notice injected into fork children running in an isolated worktree.
 * Tells the child to translate paths from the inherited context, re-read
 * potentially stale files, and that its changes are isolated.
 */
export declare function buildWorktreeNotice(
  parentCwd: string,
  worktreeCwd: string,
): string
