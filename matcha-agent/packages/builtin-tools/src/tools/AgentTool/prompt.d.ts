import type { AgentDefinition } from './loadAgentsDir.js'
/**
 * Format one agent line for the agent_listing_delta attachment message:
 * `- type: whenToUse (Tools: ...)`.
 */
export declare function formatAgentLine(agent: AgentDefinition): string
/**
 * Whether the agent list should be injected as an attachment message instead
 * of embedded in the tool description. When true, getPrompt() returns a static
 * description and attachments.ts emits an agent_listing_delta attachment.
 *
 * The dynamic agent list was ~10.2% of fleet cache_creation tokens: MCP async
 * connect, /reload-plugins, or permission-mode changes mutate the list →
 * description changes → full tool-schema cache bust.
 *
 * Override with CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=true/false for testing.
 */
export declare function shouldInjectAgentListInMessages(): boolean
export declare function getPrompt(
  agentDefinitions: AgentDefinition[],
  isCoordinator?: boolean,
  allowedAgentTypes?: string[],
): Promise<string>
