import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { CoreTool } from '@claude-code-best/agent-tools'
import type { ConnectedMCPServer } from './types.js'
import type { McpClientDependencies } from './interfaces.js'
/** Default max cache size for tool discovery (keyed by server name) */
export declare const MCP_FETCH_CACHE_SIZE = 20
export interface DiscoveryOptions {
  /** Server name for logging and tool naming */
  serverName: string
  /** Connected MCP server client */
  client: Client
  /** Server capabilities (checked before fetching) */
  capabilities: Record<string, unknown>
  /** Whether to skip the mcp__ prefix for tool names */
  skipPrefix?: boolean
  /** Host dependencies for logging */
  deps: McpClientDependencies
}
/**
 * Fetches tools from a connected MCP server and converts them to CoreTool format.
 * Returns empty array if the server doesn't support tools or if fetching fails.
 */
export declare function discoverTools(
  options: DiscoveryOptions,
): Promise<CoreTool[]>
/**
 * Creates a memoized tool discovery function with LRU caching.
 * Cache is keyed by server name (stable across reconnects).
 */
export declare function createCachedToolDiscovery(
  deps: McpClientDependencies,
  cacheSize?: number,
): {
  discover: (
    server: ConnectedMCPServer,
    skipPrefix?: boolean,
  ) => Promise<CoreTool[]>
  cache: {
    delete(key: string): void
    clear(): void
  }
}
