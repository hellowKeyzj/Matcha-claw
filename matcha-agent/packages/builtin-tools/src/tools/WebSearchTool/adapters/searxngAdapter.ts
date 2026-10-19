import axios from 'axios'
import he from 'he'
import { AbortError } from 'src/utils/errors.js'
import type { SettingsJson } from 'src/utils/settings/types.js'
import type { SearchOptions, SearchResult, WebSearchAdapter } from './types.js'

export type SearxngSettings = NonNullable<SettingsJson['searxng']>

type Engine = { name: string; categories: string[]; enabled: boolean }

export class SearxngSearchAdapter implements WebSearchAdapter {
  constructor(private readonly settings: SearxngSettings) {}

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { signal, onProgress } = options
    if (signal?.aborted) throw new AbortError()
    const count = options.numResults ?? this.settings.resultCount
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      throw new Error('SearXNG num_results must be an integer from 1 to 10')
    }
    if (
      options.livecrawl ||
      options.searchType ||
      options.contextMaxCharacters
    ) {
      throw new Error(
        'SearXNG does not support livecrawl, search_type or context_max_characters',
      )
    }
    // Native query directives override structured engine/language options in SearXNG.
    if (/(?:^|\s)[!:<]\S*/u.test(query)) {
      throw new Error(
        'SearXNG query directives are unsupported; use the structured search options',
      )
    }
    const safeSearch = options.safeSearch ?? this.settings.safeSearch
    if (![0, 1, 2].includes(safeSearch))
      throw new Error('SearXNG safesearch must be 0, 1 or 2')
    const language = options.language ?? this.settings.language
    if (!language.trim()) throw new Error('SearXNG language must not be empty')
    const allowed = normalizeDomains(options.allowedDomains)
    const blocked = normalizeDomains(options.blockedDomains)
    const categories = csv(options.categories ?? this.settings.categories)
    const requestedEngines = options.engines ?? this.settings.engines
    const catalog = await this.getJson('config', undefined, signal)
    if (
      !isRecord(catalog) ||
      !Array.isArray(catalog.categories) ||
      !Array.isArray(catalog.engines)
    ) {
      throw new Error('SearXNG returned an invalid engine catalog')
    }
    const catalogCategories = catalog.categories
    if (categories.some(category => !catalogCategories.includes(category))) {
      throw new Error(
        'SearXNG categories must name categories in the service catalog',
      )
    }
    const engines = catalog.engines.filter(
      (engine): engine is Engine =>
        isRecord(engine) &&
        typeof engine.name === 'string' &&
        Array.isArray(engine.categories) &&
        engine.categories.every(category => typeof category === 'string') &&
        typeof engine.enabled === 'boolean',
    )
    let selected: string[]
    if (requestedEngines !== undefined) {
      selected = csv(requestedEngines)
      if (
        selected.some(name => !engines.some(engine => engine.name === name))
      ) {
        throw new Error(
          'SearXNG engines must name engines in the service catalog',
        )
      }
      // An explicit engine selection wins over default categories. Explicit per-call
      // categories narrow that selection, never expand it with other category engines.
      if (options.categories !== undefined) {
        selected = selected.filter(name =>
          engines.some(
            engine =>
              engine.name === name &&
              engine.categories.some(category => categories.includes(category)),
          ),
        )
      }
    } else {
      selected = engines
        .filter(
          engine =>
            engine.enabled &&
            engine.categories.some(category => categories.includes(category)),
        )
        .map(engine => engine.name)
    }
    if (!selected.length)
      throw new Error('SearXNG engine/category selection is empty')
    onProgress?.({ type: 'query_update', query })
    // Supplying categories alongside engines makes SearXNG add category engines.
    const payload = await this.getJson(
      'search',
      {
        q: query,
        format: 'json',
        engines: selected.join(','),
        language,
        safesearch: safeSearch,
      },
      signal,
    )
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      throw new Error('SearXNG returned an invalid JSON search response')
    }
    const results: SearchResult[] = []
    for (const hit of payload.results) {
      if (!isRecord(hit) || typeof hit.url !== 'string') continue
      let parsed: URL
      try {
        parsed = new URL(hit.url)
      } catch {
        continue
      }
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        continue
      const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
      const matches = (domain: string) =>
        host === domain || host.endsWith(`.${domain}`)
      if (blocked.some(matches) || (allowed.length && !allowed.some(matches)))
        continue
      results.push({
        title: plainText(typeof hit.title === 'string' ? hit.title : hit.url),
        url: parsed.href,
        snippet:
          typeof hit.content === 'string' ? plainText(hit.content) : undefined,
      })
      if (results.length === count) break
    }
    onProgress?.({
      type: 'search_results_received',
      resultCount: results.length,
      query,
    })
    return results
  }

  private async getJson(
    path: string,
    params?: Record<string, string | number>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      const response = await axios.get<unknown>(
        `${this.settings.baseUrl.replace(/\/$/, '')}/${path}`,
        {
          signal,
          timeout: path === 'config' ? 5_000 : 125_000,
          maxContentLength: 2 * 1024 * 1024,
          maxRedirects: 0,
          headers: { Accept: 'application/json' },
          params,
        },
      )
      if (signal?.aborted) throw new AbortError()
      return response.data
    } catch (error) {
      if (axios.isCancel(error) || signal?.aborted) throw new AbortError()
      // Axios errors retain the private endpoint and query in their request config.
      throw new Error(
        'SearXNG request failed; check the service and JSON search access',
      )
    }
  }
}

function csv(value: string): string[] {
  const values = value.split(',').map(value => value.trim())
  if (values.some(value => !value))
    throw new Error(
      'SearXNG selections must contain non-empty comma-separated IDs',
    )
  return [...new Set(values)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeDomains(domains: string[] = []): string[] {
  return domains.map(domain => {
    const value = domain.trim().toLowerCase().replace(/\.$/, '')
    if (!value || /[/:@?#*\s]/.test(value)) {
      throw new Error(
        'Domain filters must contain hostnames, without URLs or wildcards',
      )
    }
    const hostname = new URL(`https://${value}`).hostname
    if (!hostname)
      throw new Error('Domain filters must contain valid hostnames')
    return hostname
  })
}

function plainText(value: string): string {
  return he.decode(value.replace(/<[^>]*>/g, '')).trim()
}
