import type { Tool } from 'src/Tool.js'
export { SEARCH_EXTRA_TOOLS_TOOL_NAME } from './constants.js'
/**
 * Check if a tool should be deferred (requires SearchExtraTools to load).
 * A tool is deferred if it is NOT in CORE_TOOLS and does NOT have alwaysLoad: true.
 * Core tools are always loaded — never deferred.
 * All other tools (non-core built-in + all MCP tools) are deferred
 * and must be discovered via SearchExtraToolsTool / ExecuteExtraTool.
 */
export declare function isDeferredTool(tool: Tool): boolean
/**
 * Format one deferred-tool line for the <available-deferred-tools> user
 * message. Search hints (tool.searchHint) are not rendered — the
 * hints A/B (exp_xenhnnmn0smrx4, stopped Mar 21) showed no benefit.
 */
export declare function formatDeferredToolLine(tool: Tool): string
export declare function getPrompt(): string
