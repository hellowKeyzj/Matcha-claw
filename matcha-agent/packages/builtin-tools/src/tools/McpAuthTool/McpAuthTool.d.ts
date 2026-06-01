import { z } from 'zod/v4'
import type { ScopedMcpServerConfig } from 'src/services/mcp/types.js'
import type { Tool } from 'src/Tool.js'
declare const inputSchema: () => z.ZodObject<{}, z.core.$strip>
type InputSchema = ReturnType<typeof inputSchema>
export type McpAuthOutput = {
  status: 'auth_url' | 'unsupported' | 'error'
  message: string
  authUrl?: string
}
/**
 * Creates a pseudo-tool for an MCP server that is installed but not
 * authenticated. Surfaced in place of the server's real tools so the model
 * knows the server exists and can start the OAuth flow on the user's behalf.
 *
 * When called, starts performMCPOAuthFlow with skipBrowserOpen and returns
 * the authorization URL. The OAuth callback completes in the background;
 * once it fires, reconnectMcpServerImpl runs and the server's real tools
 * are swapped into appState.mcp.tools via the existing prefix-based
 * replacement (useManageMCPConnections.updateServer wipes anything matching
 * mcp__<server>__*, so this pseudo-tool is removed automatically).
 */
export declare function createMcpAuthTool(
  serverName: string,
  config: ScopedMcpServerConfig,
): Tool<InputSchema, McpAuthOutput>
export {}
