/**
 * Brave-based search adapter — fetches Brave's LLM context API and maps the
 * grounding payload into SearchResult objects.
 */
import type { SearchResult, SearchOptions, WebSearchAdapter } from './types.js'
interface BraveGroundingResult {
  title?: string
  url?: string
  snippets?: string[]
}
interface BraveSearchResponse {
  grounding?: {
    generic?: BraveGroundingResult[]
    map?: BraveGroundingResult[]
    poi?: BraveGroundingResult | null
  }
}
export declare class BraveSearchAdapter implements WebSearchAdapter {
  search(query: string, options: SearchOptions): Promise<SearchResult[]>
}
export declare function extractBraveResults(
  payload: BraveSearchResponse,
): SearchResult[]
export {}
