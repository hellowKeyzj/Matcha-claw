import OpenAI from 'openai'
import { randomUUID } from 'crypto'
import { investigationFetch } from '../investigation.js'
import { currentInvestigationScope } from '../../../world/investigation.js'
import { openaiAdapter } from 'src/services/providerUsage/adapters/openai.js'
import { updateProviderBuckets } from 'src/services/providerUsage/store.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import { debugIdentifierHash, traceSessionTiming } from '../../../utils/debug.js'

let requestSequence = 0
export type OpenAIRequestTiming = NonNullable<ReturnType<typeof createOpenAIRequestTiming>>
export function createOpenAIRequestTiming(source?: string) {
  if (process.env.MATCHACLAW_TRACE !== '1') return undefined
  const requestHash = debugIdentifierHash(randomUUID())
  const requestSeq = ++requestSequence
  const startedAt = performance.now()
  const timing = {
    attempt: 0,
    responseHash: undefined as string | undefined,
    providerMessageHash: undefined as string | undefined,
    mark(stage: string, fields: Record<string, unknown> = {}): void {
      traceSessionTiming(`openai_${stage}`, () => ({
        requestHash, requestSeq, sourceHash: source ? debugIdentifierHash(source) : undefined,
        attempt: timing.attempt, responseHash: timing.responseHash,
        providerMessageHash: timing.providerMessageHash,
        elapsedMs: performance.now() - startedAt, ...fields,
      }))
    },
  }
  return timing
}

/** Headers only: no body read, tee, replacement or prefetch. */
export function timedOpenAIFetch(base: typeof fetch, requestTiming?: OpenAIRequestTiming): typeof fetch {
  return (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    if (process.env.MATCHACLAW_TRACE !== '1') return base(...args)
    const timing = requestTiming ?? createOpenAIRequestTiming()!
    const [input, init] = args
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    let path = 'other'
    try {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname
      path = /\/responses$/.test(pathname) ? 'responses'
        : /\/chat\/completions$/.test(pathname) ? 'chat_completions' : 'other'
    } catch { /* Pass nonstandard fetch inputs through unchanged. */ }
    const attempt = ++timing.attempt
    const attemptHash = debugIdentifierHash(randomUUID())
    const startedAt = performance.now()
    timing.mark('request_begin', { path, attempt, attemptHash })
    try {
      const response = await base(...args)
      timing.mark('headers', { path, attempt, attemptHash, status: response.status, fetchMs: performance.now() - startedAt })
      return response
    } catch (error) {
      timing.mark('fetch_error', { path, attempt, attemptHash, outcome: signal?.aborted ? 'aborted' : 'error', fetchMs: performance.now() - startedAt })
      throw error
    }
  }) as typeof fetch
}

const streamTimings = new WeakMap<object, OpenAIRequestTiming>()
export const getOpenAIStreamTiming = (stream: object) => streamTimings.get(stream)

export function observeOpenAIStream<T>(stream: AsyncIterable<T>, timing: OpenAIRequestTiming | undefined, signal: AbortSignal, boundary = 'sdk_delivery'): AsyncIterable<T> {
  if (!timing) return stream
  const observed = (async function* () {
    let nextAt = performance.now(), events = 0, textEvents = 0
    let lastTextAt: number | undefined, textDoneAt: number | undefined
    let terminal = 'none', outcome = 'consumer_return'
    let nextWaitTotalMs = 0, nextWaitMaxMs = 0, yieldPauseTotalMs = 0, yieldPauseMaxMs = 0
    const recordWait = () => {
      const ms = performance.now() - nextAt
      nextWaitTotalMs += ms
      nextWaitMaxMs = Math.max(nextWaitMaxMs, ms)
    }
    const summary = () => ({
      boundary, events, textEvents, terminal,
      lastTextToNowMs: lastTextAt === undefined ? undefined : performance.now() - lastTextAt,
      lastTextToDoneMs: lastTextAt === undefined || textDoneAt === undefined ? undefined : textDoneAt - lastTextAt,
      textDoneToNowMs: textDoneAt === undefined ? undefined : performance.now() - textDoneAt,
      nextWaitTotalMs, nextWaitMaxMs, yieldPauseTotalMs, yieldPauseMaxMs,
    })
    try {
      for await (const event of stream) {
        recordWait()
        const now = performance.now(), record = event as Record<string, unknown>
        const response = record.response as Record<string, unknown> | undefined
        const id = response?.id ?? record.response_id ?? record.id
        if (typeof id === 'string') timing.responseHash = debugIdentifierHash(id)
        if (++events === 1) timing.mark('first_event', summary())
        const choice = (record.choices as Array<{ delta?: { content?: unknown }; finish_reason?: unknown }> | undefined)?.[0]
        if (record.type === 'response.output_text.delta' || (typeof choice?.delta?.content === 'string' && choice.delta.content !== '')) {
          lastTextAt = now
          if (++textEvents === 1) timing.mark('first_text', summary())
        }
        if (record.type === 'response.output_text.done') {
          textDoneAt = now
          timing.mark('text_done', summary())
        }
        if (record.type === 'response.output_item.done') timing.mark('output_item_done', summary())
        if (record.type === 'response.completed' || record.type === 'response.incomplete' || record.type === 'response.failed' || record.type === 'response.error' || record.type === 'error' || choice?.finish_reason != null) {
          terminal = choice?.finish_reason != null ? 'finish_reason'
            : record.type === 'response.completed' ? 'completed'
              : record.type === 'response.incomplete' ? 'incomplete'
                : record.type === 'response.failed' ? 'failed' : 'error_event'
          timing.mark('terminal', summary())
        }
        const yieldedAt = performance.now()
        try { yield event } finally {
          const ms = performance.now() - yieldedAt
          yieldPauseTotalMs += ms
          yieldPauseMaxMs = Math.max(yieldPauseMaxMs, ms)
          nextAt = performance.now()
        }
      }
      recordWait()
      outcome = signal.aborted ? 'aborted' : terminal === 'none' ? 'eof_without_terminal' : 'eof_after_terminal'
    } catch (error) {
      recordWait()
      outcome = signal.aborted ? 'aborted' : 'error'
      throw error
    } finally {
      timing.mark('native_iterator_end', { ...summary(), outcome })
    }
  })()
  streamTimings.set(observed, timing)
  return observed
}

/**
 * Environment variables:
 *
 * OPENAI_API_KEY: Required. API key for the OpenAI-compatible endpoint.
 * OPENAI_BASE_URL: Recommended. Base URL for the endpoint (e.g. http://localhost:11434/v1).
 * OPENAI_ORG_ID: Optional. Organization ID.
 * OPENAI_PROJECT_ID: Optional. Project ID.
 */

let cachedClient: OpenAI | null = null
let cachedBaseFetch: typeof fetch | undefined

/**
 * Wrap a fetch so that every response's rate-limit headers are fed into the
 * provider usage store. Errors in parsing must never break the request.
 *
 * The cast to `typeof fetch` is safe: OpenAI SDK only calls the function form,
 * not the static `preconnect` method that Bun/Node's `fetch` type declares.
 */
function wrapFetchForUsage(base: typeof fetch): typeof fetch {
  const wrapped = async (
    ...args: Parameters<typeof fetch>
  ): Promise<Response> => {
    const res = await base(...args)
    try {
      updateProviderBuckets('openai', openaiAdapter.parseHeaders(res.headers))
    } catch {
      // Ignore — usage tracking must not affect the request path.
    }
    return res
  }
  return wrapped as unknown as typeof fetch
}

export function getOpenAIClient(options?: {
  maxRetries?: number
  fetchOverride?: typeof fetch
  source?: string
  timing?: OpenAIRequestTiming
}): OpenAI {
  if (cachedClient && !currentInvestigationScope()) {
    return options?.timing ? cachedClient.withOptions({
      fetch: wrapFetchForUsage(investigationFetch(timedOpenAIFetch(cachedBaseFetch!, options.timing), 'openai')),
    }) : cachedClient
  }

  const apiKey = process.env.OPENAI_API_KEY || ''
  const baseURL = process.env.OPENAI_BASE_URL

  const baseFetch = options?.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const wrappedFetch = wrapFetchForUsage(
    investigationFetch(timedOpenAIFetch(baseFetch), 'openai'),
  )

  const client = new OpenAI({
    apiKey,
    ...(baseURL && { baseURL }),
    maxRetries: currentInvestigationScope() ? 0 : (options?.maxRetries ?? 0),
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    ...(process.env.OPENAI_ORG_ID && {
      organization: process.env.OPENAI_ORG_ID,
    }),
    ...(process.env.OPENAI_PROJECT_ID && {
      project: process.env.OPENAI_PROJECT_ID,
    }),
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: false }),
    fetch: wrappedFetch,
  })

  if (!options?.fetchOverride && !currentInvestigationScope()) {
    cachedClient = client
    cachedBaseFetch = baseFetch
  }

  return options?.timing ? client.withOptions({
    fetch: wrapFetchForUsage(investigationFetch(timedOpenAIFetch(baseFetch, options.timing), 'openai')),
  }) : client
}

/** Clear the cached client (useful when env vars change). */
export function clearOpenAIClientCache(): void {
  cachedClient = null
}
