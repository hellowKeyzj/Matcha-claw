import type { ConnectedMCPServer } from './types.js'
import type { McpClientDependencies } from './interfaces.js'
export interface CallToolOptions {
  /** The connected MCP server to call */
  client: ConnectedMCPServer
  /** Tool name (as registered on the server, not the fully qualified name) */
  tool: string
  /** Tool arguments */
  args: Record<string, unknown>
  /** Optional metadata to send with the call */
  meta?: Record<string, unknown>
  /** Abort signal for cancellation */
  signal: AbortSignal
  /** Progress callback */
  onProgress?: (data: {
    progress?: number
    total?: number
    message?: string
  }) => void
  /** Tool call timeout in ms (defaults to ~27.8 hours) */
  timeoutMs?: number
}
export interface CallToolResult {
  content: unknown
  _meta?: Record<string, unknown>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}
/**
 * Call a tool on a connected MCP server with timeout and progress handling.
 *
 * This is the protocol-level tool execution function. The host is responsible for:
 * - Session management (reconnection on expiry)
 * - Result transformation (content processing, truncation, persistence)
 * - Error wrapping for telemetry
 */
export declare function callMcpTool(
  options: CallToolOptions,
  deps: McpClientDependencies,
): Promise<CallToolResult>
