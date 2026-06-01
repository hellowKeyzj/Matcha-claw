/**
 * Recursively sanitizes Unicode characters in MCP server responses.
 * Removes or replaces problematic Unicode that could cause display or parsing issues.
 */
export declare function recursivelySanitizeUnicode<T>(data: T): T
