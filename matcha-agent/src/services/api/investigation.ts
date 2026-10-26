import { AsyncLocalStorage } from 'node:async_hooks'
import {
  InvestigationAdmissionError,
  admitInvestigationIo,
  currentInvestigationScope,
  investigationDigest,
  investigationRemaining,
  investigationSignal,
  investigationUsage,
  observeInvestigationIo,
  rethrowInvestigationAdmission,
  trackInvestigationOperation,
  type InvestigationPermit,
  type InvestigationIoObservation,
} from '../../world/investigation.js'

type Protocol = 'anthropic' | 'vertex' | 'bedrock' | 'openai' | 'grok' | 'gemini' | 'chatgpt'
type Json = Record<string, unknown>

function object(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Json
    : undefined
}

function tokens(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : undefined
}

export { rethrowInvestigationAdmission } from '../../world/investigation.js'

const anthropicCountFields = new Set([
  'model', 'messages', 'system', 'tools', 'tool_choice', 'thinking',
  'cache_control', 'context_management', 'mcp_servers', 'output_config',
  'output_format', 'speed',
])
const anthropicGenerationFields = new Set([
  'max_tokens', 'stream', 'metadata', 'temperature', 'top_p', 'top_k',
  'stop_sequences', 'service_tier', 'anthropic_version',
])
const responsesCountFields = new Set([
  'model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls',
  'previous_response_id', 'conversation', 'reasoning', 'text', 'truncation',
])
const responsesGenerationFields = new Set([
  'stream', 'store', 'max_output_tokens', 'temperature', 'top_p',
  'prompt_cache_key', 'metadata', 'service_tier', 'user', 'stream_options',
])

function countBody(body: Json, fields: Set<string>, generation: Set<string>): Json {
  for (const key of Object.keys(body)) {
    if (!fields.has(key) && !generation.has(key)) {
      throw new InvestigationAdmissionError('investigation_exact_input_count_unavailable')
    }
  }
  return Object.fromEntries(Object.entries(body).filter(([key]) => fields.has(key)))
}

function requireClientTools(body: Json, protocol: Protocol): void {
  if (Array.isArray(body.mcp_servers) && body.mcp_servers.length > 0) {
    throw new InvestigationAdmissionError('investigation_unbounded_provider_tool')
  }
  if (!Array.isArray(body.tools)) return
  for (const tool of body.tools) {
    const definition = object(tool)
    const allowed = protocol === 'gemini'
      ? definition && Object.keys(definition).every(key => key === 'functionDeclarations')
      : protocol === 'openai'
        ? definition?.type === 'function'
        : definition && (definition.type === undefined || definition.type === 'custom')
    if (!allowed) throw new InvestigationAdmissionError('investigation_unbounded_provider_tool')
  }
}

function checkLive(signal: AbortSignal): void {
  const scope = currentInvestigationScope()
  if (signal.aborted || !scope || Date.now() >= scope.deadlineMs) {
    throw new InvestigationAdmissionError('investigation_deadline_or_cancellation')
  }
}

async function countRequest(inner: typeof fetch, url: URL, init: RequestInit): Promise<Response> {
  const signal = init.signal!
  checkLive(signal)
  const scope = currentInvestigationScope()!
  if (scope.budget.maxCost != null) throw new InvestigationAdmissionError('exact_cost_basis_unavailable')
  if (!scope.allowedEffects.includes('source_read')) {
    throw new InvestigationAdmissionError('investigation_count_effect_denied')
  }
  const serialized = init.body
  if (typeof serialized !== 'string') throw new InvestigationAdmissionError('investigation_prepared_request_unavailable')
  let request: Json | undefined
  try { request = object(JSON.parse(serialized)) } catch { /* reject below */ }
  if (!request) throw new InvestigationAdmissionError('investigation_prepared_request_unavailable')
  const requestBytes = new TextEncoder().encode(serialized).length
  const remaining = investigationRemaining()
  if (!remaining || BigInt(remaining.bytes) <= BigInt(requestBytes)) {
    throw new InvestigationAdmissionError('investigation_count_byte_budget_exhausted')
  }
  const available = BigInt(remaining.bytes) - BigInt(requestBytes)
  const limit = Number(available < 65536n ? available : 65536n)
  const preparedRequestDigest = investigationDigest({ endpoint: url.toString(), body: request,
    beta: new Headers(init.headers).get('anthropic-beta'), version: new Headers(init.headers).get('anthropic-version') })
  const permit = await admitInvestigationIo({ kind: 'source', preparedRequestDigest,
    reservation: investigationUsage({ sourceReads: '1', rows: '1', bytes: String(requestBytes + limit) }),
    proof: { producer: 'matcha_model_transport', operation: 'input_token_count', effect: 'source_read', endpoint: url.toString(), requestDigest: preparedRequestDigest,
      responseByteLimit: String(limit), requestBytes: String(requestBytes) },
  })
  let sent = false
  let settled = false
  let bytes = 0
  try {
    checkLive(signal)
    sent = true
    const response = await inner(url, { ...init, redirect: 'error' })
    const reader = response.body?.getReader()
    if (!reader) throw new InvestigationAdmissionError('investigation_exact_input_count_unavailable')
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        const { done, value } = await reader.read()
        checkLive(signal)
        if (done) break
        bytes += value.length
        if (bytes > limit) {
          await reader.cancel()
          throw new InvestigationAdmissionError('investigation_count_response_limit')
        }
        chunks.push(value)
      }
    } catch (error) {
      await reader.cancel(error)
      throw error
    } finally { reader.releaseLock() }
    const content = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length }
    let valid = false
    try { valid = response.ok && object(JSON.parse(new TextDecoder().decode(content))) !== undefined } catch { /* unknown result */ }
    const counted = new Response(content, { status: response.status, statusText: response.statusText, headers: response.headers })
    settled = true
    await observeInvestigationIo(permit, { status: valid ? 'complete' : 'unknown',
      ...(valid && { usage: investigationUsage({ sourceReads: '1', rows: '1', bytes: String(requestBytes + bytes) }) }),
      rawUsage: { operation: 'input_token_count', status: response.status, requestBytes: String(requestBytes), responseBytes: String(bytes) },
      ...(!valid && { reason: 'investigation_count_response_invalid' }),
    })
    return counted
  } catch (error) {
    if (!settled) await observeInvestigationIo(permit, { status: sent ? 'unknown' : 'not_sent',
      ...(!sent && { usage: investigationUsage() }), rawUsage: { requestBytes: String(requestBytes), responseBytes: String(bytes) },
      reason: sent ? 'investigation_count_may_have_sent' : 'investigation_count_not_sent' })
    rethrowInvestigationAdmission(error)
    throw new InvestigationAdmissionError('investigation_exact_input_count_unavailable')
  }
}

async function exactCount(
  inner: typeof fetch,
  protocol: Protocol,
  url: URL,
  body: Json,
  headers: Headers,
  init: RequestInit,
): Promise<{ model: string; count: string; method: string; cap: string }> {
  const countUrl = new URL(url)
  let request: Json
  let model = body.model
  let cap: unknown
  let field = 'input_tokens'
  if (protocol === 'anthropic' && /\/messages$/.test(url.pathname)) {
    cap = body.max_tokens
    countUrl.pathname += '/count_tokens'
    request = countBody(body, anthropicCountFields, anthropicGenerationFields)
  } else if (protocol === 'vertex') {
    const match = url.pathname.match(/^(.*\/publishers\/anthropic\/models\/)(.+):(?:streamRawPredict|rawPredict)$/)
    if (!match) throw new InvestigationAdmissionError('investigation_exact_input_count_unavailable')
    model = decodeURIComponent(match[2]!)
    cap = body.max_tokens
    countUrl.pathname = `${match[1]}count-tokens:rawPredict`
    request = { ...countBody(body, anthropicCountFields, anthropicGenerationFields), model,
      anthropic_version: body.anthropic_version }
  } else if (protocol === 'openai' && /\/responses$/.test(url.pathname)) {
    cap = body.max_output_tokens
    countUrl.pathname += '/input_tokens'
    request = countBody(body, responsesCountFields, responsesGenerationFields)
  } else if (protocol === 'gemini') {
    const match = url.pathname.match(/^(.*\/models\/)(.+):(?:streamGenerateContent|generateContent)$/)
    if (!match) throw new InvestigationAdmissionError('investigation_exact_input_count_unavailable')
    model = `models/${decodeURIComponent(match[2]!)}`
    cap = object(body.generationConfig)?.maxOutputTokens
    countUrl.pathname = `${match[1]}${match[2]}:countTokens`
    countUrl.search = ''
    request = { generateContentRequest: { ...body, model } }
    field = 'totalTokens'
  } else {
    // Chat templates, ChatGPT OAuth and signed Bedrock requests have no proven
    // exact counter at this transport. Never substitute a different model/template.
    throw new InvestigationAdmissionError('investigation_exact_input_count_unavailable')
  }
  const outputCap = tokens(cap)
  if (typeof model !== 'string' || !model || !outputCap || outputCap === '0') {
    throw new InvestigationAdmissionError('investigation_output_cap_unavailable')
  }
  requireClientTools(body, protocol)
  const countHeaders = new Headers(headers)
  countHeaders.delete('content-length')
  countHeaders.set('accept', 'application/json')
  if ((protocol === 'anthropic' || protocol === 'vertex') && url.searchParams.get('beta') === 'true') {
    const betas = new Set((countHeaders.get('anthropic-beta') ?? '').split(',').filter(Boolean))
    betas.add('token-counting-2024-11-01')
    countHeaders.set('anthropic-beta', [...betas].join(','))
  }
  let result: Json | undefined
  try {
    const response = await countRequest(inner, countUrl, { ...init, method: 'POST', headers: countHeaders,
      body: JSON.stringify(request), redirect: 'error' })
    if (!response.ok) {
      await response.body?.cancel()
      throw new InvestigationAdmissionError('investigation_exact_input_count_unavailable')
    }
    result = object(await response.json())
  } catch (error) {
    rethrowInvestigationAdmission(error)
    throw new InvestigationAdmissionError('investigation_exact_input_count_unavailable')
  }
  const count = tokens(result?.[field])
  if (!count || (protocol === 'openai' && result?.object !== 'response.input_tokens')) {
    throw new InvestigationAdmissionError('investigation_exact_input_count_unavailable')
  }
  return { model, count, method: countUrl.toString(), cap: outputCap }
}

function usageObserver(protocol: Protocol) {
  let raw: Json = {}
  let terminal = false
  let failed = false
  const ingest = (value: unknown) => {
    const event = object(value)
    if (!event) return
    if (event.type === 'error' || event.error != null) failed = true
    if (protocol === 'anthropic' || protocol === 'vertex') {
      const usage = object(event.usage) ?? object(object(event.message)?.usage)
      if (usage) raw = { ...raw, ...usage }
      const stopReason = object(event.delta)?.stop_reason ?? event.stop_reason
      if (stopReason != null) raw.stop_reason = stopReason
      if (event.type === 'message_stop' || (event.type === 'message' && event.stop_reason != null)) terminal = true
    } else if (protocol === 'openai') {
      const response = object(event.response) ?? (event.object === 'response' ? event : undefined)
      const usage = object(response?.usage) ?? object(event.usage)
      if (usage) raw = { ...raw, ...usage }
      if (response?.error != null || response?.incomplete_details != null
        || event.type === 'response.failed' || event.type === 'response.incomplete') failed = true
      if ((event.type === 'response.completed' || event.object === 'response') && response?.status === 'completed') terminal = true
    } else if (protocol === 'gemini') {
      const usage = object(event.usageMetadata)
      if (usage) raw = { ...raw, ...usage }
      if (Array.isArray(event.candidates)) {
        for (const candidate of event.candidates) {
          const reason = object(candidate)?.finishReason
          if (reason === 'STOP') terminal = true
          else if (reason != null) failed = true
        }
      }
    }
  }
  return {
    ingest,
    observation(complete: boolean): InvestigationIoObservation {
      let input: string | undefined
      let output: string | undefined
      if (protocol === 'anthropic' || protocol === 'vertex') {
        const uncached = tokens(raw.input_tokens)
        const read = tokens(raw.cache_read_input_tokens)
        const write = tokens(raw.cache_creation_input_tokens)
        if (uncached !== undefined && read !== undefined && write !== undefined) {
          const total = BigInt(uncached) + BigInt(read) + BigInt(write)
          if (total <= 18446744073709551615n) input = total.toString()
        }
        output = tokens(raw.output_tokens)
        if (!['end_turn', 'stop_sequence', 'tool_use', 'pause_turn', 'compaction', 'refusal'].includes(String(raw.stop_reason))) failed = true
      } else if (protocol === 'openai') {
        input = tokens(raw.input_tokens)
        output = tokens(raw.output_tokens)
      } else if (protocol === 'gemini') {
        input = tokens(raw.promptTokenCount)
        const total = tokens(raw.totalTokenCount)
        if (input !== undefined && total !== undefined && BigInt(total) >= BigInt(input)) {
          output = (BigInt(total) - BigInt(input)).toString()
        }
      }
      const covered = complete && terminal && !failed && input !== undefined && output !== undefined
      return {
        status: covered ? 'complete' as const : 'unknown' as const,
        ...(covered && { usage: investigationUsage({ modelCalls: '1', inputTokens: input, outputTokens: output }) }),
        rawUsage: { protocol, usage: raw, terminal, failed, costBasis: 'unavailable' },
        ...(!covered && { reason: 'investigation_provider_usage_incomplete' }),
      }
    },
  }
}

function observeResponse(response: Response, protocol: Protocol, permit: InvestigationPermit,
  signal: AbortSignal, requestBytes: bigint, responseByteLimit: bigint): Response {
  const inScope = AsyncLocalStorage.snapshot()
  const observer = usageObserver(protocol)
  const reader = response.body?.getReader()
  const sse = response.headers.get('content-type')?.includes('text/event-stream') === true
  const decoder = new TextDecoder()
  let buffer = ''
  let parseable = true
  let responseBytes = 0n
  let settled: Promise<void> | undefined
  let reading: ReturnType<NonNullable<typeof reader>['read']> | undefined
  let cancelling: Promise<void> | undefined
  let released = false
  let resolveCompletion!: () => void
  let rejectCompletion!: (error: unknown) => void
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  void trackInvestigationOperation(completion).catch(() => {})
  const ingest = (text: string, end = false) => {
    if (!parseable) return
    buffer += text
    // Observation never buffers an unbounded provider output or changes its bytes.
    if (buffer.length > 8 * 1024 * 1024) {
      parseable = false
      buffer = ''
      return
    }
    if (sse) {
      buffer = buffer.replace(/\r\n/g, '\n')
      let split = buffer.indexOf('\n\n')
      while (split >= 0 || (end && buffer.length > 0)) {
        const frame = split >= 0 ? buffer.slice(0, split) : buffer
        buffer = split >= 0 ? buffer.slice(split + 2) : ''
        const data = frame.split('\n').filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n')
        if (data && data !== '[DONE]') {
          try { observer.ingest(JSON.parse(data)) } catch { parseable = false }
        }
        split = buffer.indexOf('\n\n')
      }
    } else if (end) {
      try { observer.ingest(JSON.parse(buffer)) } catch { parseable = false }
      buffer = ''
    }
  }
  let lifecycleComplete = false
  const finish = (complete: boolean, primary?: unknown) => {
    if (!complete) {
      lifecycleComplete = false
      if (reader && !released && !cancelling) cancelling = Promise.resolve().then(() => reader.cancel(primary))
    } else if (!settled) lifecycleComplete = true
    if (!settled) {
      settled = (async () => {
        const failures: unknown[] = primary === undefined ? [] : [primary]
        try { await reading } catch (error) { failures.push(error) }
        try { await cancelling } catch (error) { failures.push(error) }
        try {
          if (reader && !released) { reader.releaseLock(); released = true }
        } catch (error) { failures.push(error) }
        signal.removeEventListener('abort', abort)
        const observation = observer.observation(lifecycleComplete && parseable && !signal.aborted && failures.length === 0)
        if (observation.usage) observation.usage.bytes = (requestBytes + responseBytes).toString()
        observation.rawUsage = { ...observation.rawUsage, requestBytes: requestBytes.toString(), responseBytes: responseBytes.toString() }
        try { await inScope(() => observeInvestigationIo(permit, observation)) } catch (error) { failures.push(error) }
        if (failures.length) {
          const failure = new InvestigationAdmissionError(primary instanceof InvestigationAdmissionError
            ? primary.reason : 'investigation_model_response_unknown')
          Object.defineProperty(failure, 'cause', { value: failures.length === 1 ? failures[0] : new AggregateError(failures) })
          throw failure
        }
      })()
      void settled.then(resolveCompletion, rejectCompletion)
    }
    return settled
  }
  const abort = () => {
    void finish(false, new InvestigationAdmissionError('investigation_deadline_or_cancellation')).catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  if (!reader) {
    void finish(false).catch(() => {})
    return response
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (settled) { await settled; controller.close(); return }
        const pendingRead = reader.read()
        reading = pendingRead
        const { value, done } = await pendingRead
        reading = undefined
        if (done) {
          ingest(decoder.decode(), true)
          await finish(response.ok && !signal.aborted)
          controller.close()
        } else {
          responseBytes += BigInt(value.length)
          if (responseBytes > responseByteLimit) throw new InvestigationAdmissionError('investigation_model_response_limit')
          if (signal.aborted) throw new InvestigationAdmissionError('investigation_deadline_or_cancellation')
          ingest(decoder.decode(value, { stream: true }))
          controller.enqueue(value)
        }
      } catch (error) {
        try { await finish(false, error); controller.error(error) }
        catch (settlementError) { controller.error(settlementError) }
      }
    },
    cancel(reason) { return finish(false, reason) },
  })
  const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  Object.defineProperties(observed, {
    url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
  })
  return observed
}

/** Each SDK retry reaches this gate with its actual serialized request. No client captures a scope. */
export function investigationFetch(inner: typeof fetch, protocol: Protocol): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const scope = currentInvestigationScope()
    if (!scope) return inner(input, init)
    const signals = [investigationSignal(), init?.signal,
      input instanceof Request ? input.signal : undefined].filter((value): value is AbortSignal => value != null)
    const signal = AbortSignal.any(signals)
    checkLive(signal)
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const options = { ...init, signal, redirect: 'error' as const }
    if (scope.budget.maxCost != null) {
      throw new InvestigationAdmissionError('exact_cost_basis_unavailable')
    }
    // Protocol counters are not model generations, but still require durable admission.
    if ((protocol === 'anthropic' && /\/messages\/count_tokens$/.test(url.pathname))
      || (protocol === 'openai' && /\/responses\/input_tokens$/.test(url.pathname))
      || (protocol === 'vertex' && /\/publishers\/anthropic\/models\/count-tokens:rawPredict$/.test(url.pathname))
      || (protocol === 'gemini' && /\/models\/[^/]+:countTokens$/.test(url.pathname))) {
      const serialized = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined)
      return countRequest(inner, url, { ...options, method: 'POST', headers, body: serialized })
    }
    if (!scope.allowedEffects.includes('probabilistic')) {
      throw new InvestigationAdmissionError('investigation_model_effect_denied')
    }
    const serialized = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined)
    let body: Json | undefined
    try { body = typeof serialized === 'string' ? object(JSON.parse(serialized)) : undefined } catch { /* reject below */ }
    if (!body) throw new InvestigationAdmissionError('investigation_prepared_request_unavailable')
    const preparedRequestDigest = investigationDigest({ protocol, endpoint: url.toString(),
      body, beta: headers.get('anthropic-beta'), version: headers.get('anthropic-version') })
    const counted = await exactCount(inner, protocol, url, body, headers, options)
    checkLive(signal)
    const requestBytes = BigInt(new TextEncoder().encode(serialized as string).length)
    const remaining = investigationRemaining()
    if (!remaining || BigInt(remaining.bytes) <= requestBytes) {
      throw new InvestigationAdmissionError('investigation_model_byte_budget_exhausted')
    }
    const responseByteLimit = BigInt(remaining.bytes) - requestBytes
    const permit = await admitInvestigationIo({ kind: 'model', preparedRequestDigest,
      reservation: investigationUsage({ bytes: remaining.bytes, modelCalls: '1', inputTokens: counted.count, outputTokens: counted.cap }),
      proof: { producer: 'matcha_model_transport', effect: 'probabilistic', protocol, model: counted.model, endpoint: url.toString(), requestDigest: preparedRequestDigest,
        inputCount: { exact: true, tokens: counted.count, method: counted.method, requestDigest: preparedRequestDigest },
        outputCap: counted.cap, outputCapEnforced: true, costBasis: 'unavailable',
        requestBytes: requestBytes.toString(), responseByteLimit: responseByteLimit.toString() },
    })
    let sent = false
    try {
      checkLive(signal)
      sent = true
      const response = await inner(input, options)
      return permit ? observeResponse(response, protocol, permit, signal, requestBytes, responseByteLimit) : response
    } catch (error) {
      await observeInvestigationIo(permit, { status: sent ? 'unknown' : 'not_sent',
        ...(!sent && { usage: investigationUsage() }), reason: sent ? 'investigation_transport_may_have_sent' : 'investigation_transport_not_sent' })
      if (signal.aborted) throw new InvestigationAdmissionError('investigation_deadline_or_cancellation')
      throw error
    }
  }) as typeof fetch
}
