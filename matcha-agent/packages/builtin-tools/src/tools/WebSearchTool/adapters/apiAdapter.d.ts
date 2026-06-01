/**
 * API-based search adapter — delegates to Anthropic's server-side
 * web_search_20250305 tool via a secondary API call.
 */
import type { SearchResult, SearchOptions, WebSearchAdapter } from './types.js'
export declare class ApiSearchAdapter implements WebSearchAdapter {
  search(query: string, options: SearchOptions): Promise<SearchResult[]>
}
