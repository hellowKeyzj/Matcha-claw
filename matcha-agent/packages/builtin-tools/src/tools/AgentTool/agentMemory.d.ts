export type AgentMemoryScope = 'user' | 'project' | 'local'
/**
 * Returns the agent memory directory for a given agent type and scope.
 * - 'user' scope: <memoryBase>/agent-memory/<agentType>/
 * - 'project' scope: <cwd>/.claude/agent-memory/<agentType>/
 * - 'local' scope: see getLocalAgentMemoryDir()
 */
export declare function getAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
): string
export declare function isAgentMemoryPath(absolutePath: string): boolean
/**
 * Returns the agent memory file path for a given agent type and scope.
 */
export declare function getAgentMemoryEntrypoint(
  agentType: string,
  scope: AgentMemoryScope,
): string
export declare function getMemoryScopeDisplay(
  memory: AgentMemoryScope | undefined,
): string
/**
 * Load persistent memory for an agent with memory enabled.
 * Creates the memory directory if needed and returns a prompt with memory contents.
 *
 * @param agentType The agent's type name (used as directory name)
 * @param scope 'user' for ~/.claude/agent-memory/ or 'project' for .claude/agent-memory/
 */
export declare function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
): string
