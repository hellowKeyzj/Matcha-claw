import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpClientDependencies } from './interfaces.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from './types.js'
/** Default connection timeout in milliseconds */
export declare const DEFAULT_CONNECTION_TIMEOUT_MS = 30000
/** Maximum length for MCP descriptions/instructions */
export declare const MAX_MCP_DESCRIPTION_LENGTH = 2048
/** Maximum consecutive terminal errors before triggering reconnection */
export declare const MAX_ERRORS_BEFORE_RECONNECT = 3
export interface CreateClientOptions {
  /** Client name (e.g., "claude-code") */
  name: string
  /** Client title */
  title?: string
  /** Client version */
  version: string
  /** Client description */
  description?: string
  /** Client website URL */
  websiteUrl?: string
  /** Root URI for ListRoots requests (defaults to current working directory) */
  rootUri?: string
}
/**
 * Creates a configured MCP Client instance with standard capabilities and handlers.
 * The host can further customize the client before connecting.
 */
export declare function createMcpClient(options: CreateClientOptions): Client
/**
 * Wraps a connection promise with a timeout.
 * Returns the result of connectPromise or rejects with a timeout error.
 */
export declare function withConnectionTimeout<T>(
  connectPromise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void> | void,
): Promise<T>
/**
 * Sets up stderr capture for stdio transports.
 * Returns the stderr output accumulator and cleanup function.
 */
export declare function captureStderr(
  transport: StdioClientTransport,
  maxSize?: number,
): {
  getOutput: () => string
  clearOutput: () => void
  removeHandler: () => void
}
/**
 * Terminal connection error patterns that indicate the connection is broken.
 */
export declare function isTerminalConnectionError(msg: string): boolean
/**
 * Detects MCP "Session not found" errors (HTTP 404 + JSON-RPC code -32001).
 */
export declare function isMcpSessionExpiredError(error: Error): boolean
export interface ConnectionMonitorOptions {
  serverName: string
  transportType: string
  logger: McpClientDependencies['logger']
  /** Called when the transport should be closed to trigger reconnection */
  closeTransport: () => void
  /** Called to clear connection caches on close */
  onConnectionClosed?: () => void
}
/**
 * Installs enhanced error and close handlers on an MCP Client for
 * connection drop detection and automatic reconnection.
 *
 * Returns the cleanup function to remove handlers.
 */
export declare function installConnectionMonitor(
  client: Client,
  options: ConnectionMonitorOptions,
): () => void
/**
 * Terminates a stdio child process with escalating signals:
 * SIGINT (100ms) → SIGTERM (400ms) → SIGKILL
 *
 * Total maximum cleanup time: ~500ms
 */
export declare function terminateWithSignalEscalation(
  childPid: number,
  logger: McpClientDependencies['logger'],
  serverName: string,
): Promise<void>
export interface CleanupOptions {
  client: Client
  transport: Transport
  transportType: string
  childPid?: number
  inProcessServer?: {
    close(): Promise<void>
  }
  stderrCleanup?: {
    removeHandler: () => void
  }
  logger: McpClientDependencies['logger']
  serverName: string
}
/**
 * Creates a cleanup function for an MCP connection.
 * Handles in-process servers, stderr listener removal, signal escalation, and client close.
 */
export declare function createCleanup(
  options: CleanupOptions,
): () => Promise<void>
export interface BuildConnectedServerOptions {
  name: string
  client: Client
  config: ScopedMcpServerConfig
  cleanup: () => Promise<void>
}
/**
 * Builds a ConnectedMCPServer result from a connected client.
 * Truncates server instructions if they exceed MAX_MCP_DESCRIPTION_LENGTH.
 */
export declare function buildConnectedServer(
  options: BuildConnectedServerOptions,
  logger: McpClientDependencies['logger'],
): ConnectedMCPServer
