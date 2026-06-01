/**
 * Base error class for all MCP-related errors.
 */
export declare class McpError extends Error {
  readonly serverName: string
  readonly code: string
  constructor(message: string, serverName: string, code: string)
}
/**
 * Error thrown when connection to an MCP server fails.
 */
export declare class McpConnectionError extends McpError {
  readonly cause?: Error | undefined
  constructor(serverName: string, message: string, cause?: Error | undefined)
}
/**
 * Error thrown when authentication is required but not available.
 */
export declare class McpAuthError extends McpError {
  constructor(serverName: string, message: string)
}
/**
 * Error thrown when a connection or request times out.
 */
export declare class McpTimeoutError extends McpError {
  readonly timeoutMs: number
  constructor(serverName: string, timeoutMs: number)
}
/**
 * Error thrown when an MCP tool call fails.
 */
export declare class McpToolCallError extends McpError {
  readonly toolName: string
  constructor(serverName: string, toolName: string, message: string)
}
/**
 * Error thrown when an MCP session has expired.
 */
export declare class McpSessionExpiredError extends McpError {
  constructor(serverName: string)
}
