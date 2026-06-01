import type { QuerySource } from 'src/constants/querySource.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import type { Tools, ToolUseContext } from 'src/Tool.js'
import type { AgentId } from 'src/types/ids.js'
import type { Message } from 'src/types/message.js'
import { type CacheSafeParams } from 'src/utils/forkedAgent.js'
import type { ModelAlias } from 'src/utils/model/aliases.js'
import { type SystemPrompt } from 'src/utils/systemPromptType.js'
import type { ContentReplacementState } from 'src/utils/toolResultStorage.js'
import { type AgentDefinition } from './loadAgentsDir.js'
export { filterIncompleteToolCalls } from './filterIncompleteToolCalls.js'
export declare function runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  canUseTool,
  isAsync,
  canShowPermissionPrompts,
  forkContextMessages,
  querySource,
  override,
  model,
  maxTurns,
  preserveToolUseResults,
  availableTools,
  allowedTools,
  onCacheSafeParams,
  contentReplacementState,
  useExactTools,
  worktreePath,
  description,
  transcriptSubdir,
  onQueryProgress,
}: {
  agentDefinition: AgentDefinition
  promptMessages: Message[]
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  isAsync: boolean
  /** Whether this agent can show permission prompts. Defaults to !isAsync.
   * Set to true for in-process teammates that run async but share the terminal. */
  canShowPermissionPrompts?: boolean
  forkContextMessages?: Message[]
  querySource: QuerySource
  override?: {
    userContext?: {
      [k: string]: string
    }
    systemContext?: {
      [k: string]: string
    }
    systemPrompt?: SystemPrompt
    abortController?: AbortController
    agentId?: AgentId
  }
  model?: ModelAlias
  maxTurns?: number
  /** Preserve toolUseResult on messages for subagents with viewable transcripts */
  preserveToolUseResults?: boolean
  /** Precomputed tool pool for the worker agent. Computed by the caller
   * (AgentTool.tsx) to avoid a circular dependency between runAgent and tools.ts.
   * Always contains the full tool pool assembled with the worker's own permission
   * mode, independent of the parent's tool restrictions. */
  availableTools: Tools
  /** Tool permission rules to add to the agent's session allow rules.
   * When provided, replaces ALL allow rules so the agent only has what's
   * explicitly listed (parent approvals don't leak through). */
  allowedTools?: string[]
  /** Optional callback invoked with CacheSafeParams after constructing the agent's
   * system prompt, context, and tools. Used by background summarization to fork
   * the agent's conversation for periodic progress summaries. */
  onCacheSafeParams?: (params: CacheSafeParams) => void
  /** Replacement state reconstructed from a resumed sidechain transcript so
   * the same tool results are re-replaced (prompt cache stability). When
   * omitted, createSubagentContext clones the parent's state. */
  contentReplacementState?: ContentReplacementState
  /** When true, use availableTools directly without filtering through
   * resolveAgentTools(). Also inherits the parent's thinkingConfig and
   * isNonInteractiveSession instead of overriding them. Used by the fork
   * subagent path to produce byte-identical API request prefixes for
   * prompt cache hits. */
  useExactTools?: boolean
  /** Worktree path if the agent was spawned with isolation: "worktree".
   * Persisted to metadata so resume can restore the correct cwd. */
  worktreePath?: string
  /** Original task description from AgentTool input. Persisted to metadata
   * so a resumed agent's notification can show the original description. */
  description?: string
  /** Optional subdirectory under subagents/ to group this agent's transcript
   * with related ones (e.g. workflows/<runId> for workflow subagents). */
  transcriptSubdir?: string
  /** Optional callback fired on every message yielded by query() — including
   * stream_event deltas that runAgent otherwise drops. Use to detect liveness
   * during long single-block streams (e.g. thinking) where no assistant
   * message is yielded for >60s. */
  onQueryProgress?: () => void
}): AsyncGenerator<Message, void>
