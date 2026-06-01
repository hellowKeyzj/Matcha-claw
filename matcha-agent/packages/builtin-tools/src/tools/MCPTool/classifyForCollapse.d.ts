/**
 * Classify an MCP tool as a search/read operation for UI collapsing.
 * Returns { isSearch: false, isRead: false } for tools that should not
 * collapse (e.g., send_message, create_*, update_*).
 *
 * Uses explicit per-tool allowlists for the most common MCP servers.
 * Tool names are stable across installs (even when the server name varies,
 * e.g., "slack" vs "claude_ai_Slack"), so matching is keyed on the tool
 * name alone after normalizing camelCase/kebab-case to snake_case.
 * Unknown tool names don't collapse (conservative).
 */
export declare function classifyMcpToolForCollapse(
  _serverName: string,
  toolName: string,
): {
  isSearch: boolean
  isRead: boolean
}
