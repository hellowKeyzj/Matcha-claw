/**
 * Exa AI-based search adapter — uses MCP protocol to call Exa's web search API.
 *
 * Ported from kilocode's production-validated implementation (mcp-exa.ts + websearch.ts).
 * Key improvements over previous version:
 *   - Passes through numResults/livecrawl/type/contextMaxCharacters from options
 *   - Cleaner SSE parsing matching kilocode's approach
 *   - Proper content snippet extraction from Exa responses
 */
import type { SearchResult, SearchOptions, WebSearchAdapter } from './types.js'
export declare class ExaSearchAdapter implements WebSearchAdapter {
  search(query: string, options: SearchOptions): Promise<SearchResult[]>
  private parseSse
  private parseResults
}
