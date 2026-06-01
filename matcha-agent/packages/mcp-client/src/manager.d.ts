import type { CoreTool } from '@claude-code-best/agent-tools'
import type { McpServerConfig, MCPServerConnection } from './types.js'
import type { McpClientDependencies } from './interfaces.js'
export type McpManagerEvents = {
  connected: (name: string) => void
  disconnected: (name: string, error?: Error) => void
  toolsChanged: (serverName: string, tools: CoreTool[]) => void
  error: (name: string, error: Error) => void
  authRequired: (name: string) => void
}
type EventHandler = (...args: any[]) => void
export interface McpManager {
  connect(name: string, config: McpServerConfig): Promise<MCPServerConnection>
  disconnect(name: string): Promise<void>
  disconnectAll(): Promise<void>
  getConnections(): Map<string, MCPServerConnection>
  getTools(serverName: string): CoreTool[]
  getAllTools(): CoreTool[]
  callTool(
    serverName: string,
    toolName: string,
    args: unknown,
  ): Promise<unknown>
  on<E extends keyof McpManagerEvents>(
    event: E,
    handler: McpManagerEvents[E],
  ): void
  off(event: string, handler: EventHandler): void
}
/**
 * Creates a new MCP manager instance.
 *
 * The manager handles connection lifecycle, tool discovery, and event notification.
 * The host must call `setConnectFn()` to provide the transport-level connection logic.
 *
 * @param deps Host dependency injections (logger, auth, proxy, etc.)
 * @returns McpManager instance
 *
 * @example
 * ```typescript
 * const manager = createMcpManager({
 *   logger: console,
 *   httpConfig: { getUserAgent: () => 'my-app/1.0' },
 * })
 *
 * manager.setConnectFn(async (name, config) => {
 *   // Transport-level connection logic here
 * })
 *
 * manager.on('connected', (name) => console.log(`Connected to ${name}`))
 * manager.on('toolsChanged', (name, tools) => console.log(`${name}: ${tools.length} tools`))
 *
 * await manager.connect('my-server', { command: 'npx', args: ['my-mcp-server'] })
 * const tools = manager.getAllTools()
 * ```
 */
export declare function createMcpManager(
  deps: McpClientDependencies,
): McpManager
export {}
