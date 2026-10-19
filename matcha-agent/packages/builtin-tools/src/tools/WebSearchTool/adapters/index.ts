/**
 * Search adapter factory — selects the appropriate backend.
 *
 * Priority (highest first):
 *   1. WEB_SEARCH_ADAPTER environment variable (explicit override)
 *   2. settings.webSearchAdapter (user-configurable via /web-tools)
 *   3. Default: tavily
 */

import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { ApiSearchAdapter } from './apiAdapter.js'
import { BingSearchAdapter } from './bingAdapter.js'
import { BraveSearchAdapter } from './braveAdapter.js'
import { ExaSearchAdapter } from './exaAdapter.js'
import { SearxngSearchAdapter } from './searxngAdapter.js'
import { TavilySearchAdapter } from './tavilyAdapter.js'
import type { WebSearchAdapter } from './types.js'

export type {
  SearchResult,
  SearchOptions,
  SearchProgress,
  WebSearchAdapter,
} from './types.js'

export type SearchAdapterKey =
  | 'api'
  | 'bing'
  | 'brave'
  | 'exa'
  | 'tavily'
  | 'searxng'

let cachedAdapter: WebSearchAdapter | null = null
let cachedAdapterIdentity: string | null = null

export function getSearchAdapterKey(): SearchAdapterKey {
  // 1. Explicit env override
  const envAdapter = process.env.WEB_SEARCH_ADAPTER
  // 2. Settings preference (set via /web-tools panel)
  const settingsAdapter = getSettings_DEPRECATED().webSearchAdapter

  return envAdapter === 'api' ||
    envAdapter === 'bing' ||
    envAdapter === 'brave' ||
    envAdapter === 'exa' ||
    envAdapter === 'tavily' ||
    envAdapter === 'searxng'
    ? envAdapter
    : settingsAdapter === 'api' ||
        settingsAdapter === 'bing' ||
        settingsAdapter === 'brave' ||
        settingsAdapter === 'exa' ||
        settingsAdapter === 'tavily' ||
        settingsAdapter === 'searxng'
      ? settingsAdapter
      : 'tavily' // 3. Default
}

export function createAdapter(): WebSearchAdapter {
  const adapterKey = getSearchAdapterKey()
  const settings = getSettings_DEPRECATED()
  // Bound to one instance; configuration changes cannot retain an old adapter.
  const identity = JSON.stringify([
    adapterKey,
    settings.searxng,
    settings.tavilyEndpointUrl,
    settings.braveApiKey,
    settings.exaApiKey,
    settings.exaEndpointUrl,
  ])
  if (cachedAdapter && cachedAdapterIdentity === identity) return cachedAdapter

  switch (adapterKey) {
    case 'searxng':
      if (!settings.searxng)
        throw new Error('SearXNG search settings are missing')
      cachedAdapter = new SearxngSearchAdapter(settings.searxng)
      break
    case 'api':
      cachedAdapter = new ApiSearchAdapter()
      break
    case 'bing':
      cachedAdapter = new BingSearchAdapter()
      break
    case 'brave':
      cachedAdapter = new BraveSearchAdapter()
      break
    case 'exa':
      cachedAdapter = new ExaSearchAdapter()
      break
    case 'tavily':
    default:
      cachedAdapter = new TavilySearchAdapter()
      break
  }

  cachedAdapterIdentity = identity
  return cachedAdapter
}
