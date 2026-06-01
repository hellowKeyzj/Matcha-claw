/**
 * Bing-based search adapter — fetches Bing search pages and extracts
 * search results using regex pattern matching on raw HTML.
 */
import he from 'he'
import type { SearchResult, SearchOptions, WebSearchAdapter } from './types.js'
export declare class BingSearchAdapter implements WebSearchAdapter {
  search(query: string, options: SearchOptions): Promise<SearchResult[]>
}
/**
 * Extract organic search results from Bing HTML.
 * Bing results live in <li class="b_algo"> blocks within <ol id="b_results">.
 */
export declare function extractBingResults(html: string): SearchResult[]
export declare const decodeHtmlEntities: he.Decode
/**
 * Resolve a Bing redirect URL to the actual target URL.
 * Bing uses URLs like: https://www.bing.com/ck/a?...&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbQ...
 * The `u` query parameter is a base64-encoded URL prefixed with a1 (https) or a0 (http).
 * Returns `undefined` for Bing-internal or relative links that should be skipped.
 */
export declare function resolveBingUrl(rawUrl: string): string | undefined
