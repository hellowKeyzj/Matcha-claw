/**
 * Normalize server names to be compatible with the API pattern ^[a-zA-Z0-9_-]{1,64}$
 * Replaces any invalid characters (including dots and spaces) with underscores.
 */
export declare function normalizeNameForMCP(name: string): string
/**
 * Generates the MCP tool/command name prefix for a given server
 */
export declare function getMcpPrefix(serverName: string): string
/**
 * Builds a fully qualified MCP tool name from server and tool names.
 * Inverse of mcpInfoFromString().
 */
export declare function buildMcpToolName(
  serverName: string,
  toolName: string,
): string
/**
 * Extracts MCP server information from a tool name string.
 * @param toolString Expected format: "mcp__serverName__toolName"
 */
export declare function mcpInfoFromString(toolString: string): {
  serverName: string
  toolName: string | undefined
} | null
/**
 * Returns the name to use for permission rule matching.
 */
export declare function getToolNameForPermissionCheck(tool: {
  name: string
  mcpInfo?: {
    serverName: string
    toolName: string
  }
}): string
/**
 * Extracts the display name from an MCP tool/command name
 */
export declare function getMcpDisplayName(
  fullName: string,
  serverName: string,
): string
/**
 * Extracts just the tool/command display name from a userFacingName
 */
export declare function extractMcpToolDisplayName(
  userFacingName: string,
): string
