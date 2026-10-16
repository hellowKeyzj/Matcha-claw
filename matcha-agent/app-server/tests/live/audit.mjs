import assert from 'node:assert/strict'

const tokenFields = [
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['cache_read_input_tokens', 'cacheReadInputTokens'],
  ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
]
const modelFields = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'webSearchRequests',
  'costUSD',
  'contextWindow',
  'maxOutputTokens',
]
const resultTypes = new Set([
  'success',
  'error_during_execution',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
])

function requireThat(condition, tag, path) {
  if (condition) return
  const error = new assert.AssertionError({ message: `${tag} at ${path}` })
  error.code = `audit_${tag.toLowerCase()}`
  error.location = path
  throw error
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function costPath(path) {
  return (
    (path.length === 1 && path[0] === 'total_cost_usd') ||
    (path.length === 3 && path[0] === 'modelUsage' && path[2] === 'costUSD')
  )
}

// Report structural offsets only: object keys and values can contain private text.
function equal(actual, expected, location, allowCost = false, path = []) {
  if (actual === expected) return
  if (typeof actual === 'number' && typeof expected === 'number') {
    const close =
      allowCost &&
      costPath(path) &&
      Number.isFinite(actual) &&
      Number.isFinite(expected) &&
      Math.abs(actual - expected) <=
        Math.max(Math.abs(actual), Math.abs(expected)) * 1e-15
    requireThat(close, 'NUMBER_MISMATCH', location)
    return
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    requireThat(
      Array.isArray(actual) && Array.isArray(expected),
      'TYPE_MISMATCH',
      location,
    )
    requireThat(actual.length === expected.length, 'LENGTH_MISMATCH', location)
    for (let i = 0; i < actual.length; i++) {
      equal(actual[i], expected[i], `${location}/${i}`, allowCost, [...path, i])
    }
    return
  }
  requireThat(object(actual) && object(expected), 'VALUE_MISMATCH', location)
  const keys = Object.keys(expected)
  requireThat(
    Object.keys(actual).length === keys.length,
    'KEY_COUNT_MISMATCH',
    location,
  )
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const next = `${location}/field/${i}`
    requireThat(Object.hasOwn(actual, key), 'KEY_MISSING', next)
    equal(actual[key], expected[key], next, allowCost, [...path, key])
  }
}

function eventOrder(events) {
  requireThat(Array.isArray(events), 'EVENTS_ARRAY_REQUIRED', '/events')
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    requireThat(object(event), 'EVENT_REQUIRED', `/events/${i}`)
    requireThat(event.seq === i + 1, 'EVENT_SEQUENCE', `/events/${i}/seq`)
    requireThat(
      typeof event.sessionId === 'string' &&
        event.sessionId === events[0].sessionId,
      'EVENT_SESSION',
      `/events/${i}/sessionId`,
    )
  }
}

function visibleBlock(block) {
  return (
    block.type !== 'text' ||
    (block.text.trim() !== '' &&
      block.text !== '(no content)' &&
      block.text !== '[Request interrupted by user for tool use]')
  )
}

function finishBlock(block, path) {
  if (block.value.type !== 'tool_use') return block.value
  let input = block.value.input
  if (block.json !== '') {
    try {
      input = JSON.parse(block.json)
    } catch {
      requireThat(false, 'TOOL_JSON_INVALID', path)
    }
  }
  requireThat(object(input), 'TOOL_INPUT_OBJECT', path)
  return { ...block.value, input }
}

export function assertWireEvents(events, rawMessages, liveEvents) {
  eventOrder(events)
  requireThat(Array.isArray(liveEvents), 'LIVE_ARRAY_REQUIRED', '/live')
  requireThat(liveEvents.length === events.length, 'LIVE_COUNT', '/live')
  for (let i = 0; i < events.length; i++) {
    const actual = liveEvents[i]
    const expected = events[i]
    requireThat(object(actual), 'LIVE_EVENT_REQUIRED', `/live/${i}`)
    const { payload: actualPayload, ...actualHeader } = actual
    const { payload: expectedPayload, ...expectedHeader } = expected
    equal(actualHeader, expectedHeader, `/live/${i}/header`)
    equal(actualPayload, expectedPayload, `/live/${i}/payload`)
  }

  requireThat(Array.isArray(rawMessages), 'RAW_ARRAY_REQUIRED', '/raw')
  const native = events.filter(
    event => event.kind === 'native.message' || event.kind === 'native.result',
  )
  requireThat(native.length === rawMessages.length, 'RAW_COUNT', '/raw')
  for (let i = 0; i < native.length; i++) {
    equal(
      native[i].payload,
      rawMessages[i],
      `/raw/${i}`,
      native[i].kind === 'native.result',
    )
  }

  const stats = {
    nativeEvents: native.length,
    modelMessages: 0,
    thinkingBlocks: 0,
    thinkingChars: 0,
    textBlocks: 0,
    toolUses: 0,
    toolResults: 0,
    deltas: 0,
    interruptedMessages: 0,
    partialBlocks: 0,
  }
  const lanes = new Map()
  const cycles = []
  const uses = new Set()
  const results = new Set()
  let boundary = {
    users: new Map(),
    interruptSeq: null,
    results: [],
    idleSeq: null,
  }

  for (let i = 0; i < events.length; i++) {
    const stored = events[i]
    const message = stored.payload
    const path = `/events/${i}/payload`
    if (stored.kind === 'run.terminal') {
      requireThat(object(message), 'TERMINAL_REQUIRED', path)
      if (
        message.reason === 'cancelled_before_send' ||
        message.reason === 'session_closed_before_send' ||
        message.reason === 'server_shutdown_before_send'
      )
        continue
      const active = [...lanes.entries()].filter(
        ([, lane]) => lane.active !== null,
      )
      if (active.length > 0) {
        const cycle = active[0][1].active
        const ackSeq = boundary.users.get(message.messageId)
        requireThat(
          active.length === 1 &&
            active[0][0] === null &&
            message.status === 'cancelled' &&
            message.reason === 'native_interruption_observed' &&
            message.sessionId === stored.sessionId &&
            message.runId === stored.runId &&
            typeof message.runId === 'string' &&
            message.runId !== '' &&
            Number.isSafeInteger(message.cancelRequestedAtMs) &&
            message.cancelRequestedAtMs >= 0 &&
            Number.isInteger(ackSeq) &&
            boundary.interruptSeq > ackSeq &&
            boundary.interruptSeq > cycle.startedSeq &&
            boundary.results.length === 1 &&
            boundary.results[0].seq > boundary.interruptSeq &&
            boundary.results[0].payload.session_id === stored.sessionId &&
            boundary.idleSeq > boundary.results[0].seq,
          'INTERRUPTION_UNPROVEN',
          path,
        )
        equal(message.result, boundary.results[0].payload, `${path}/result`)
        requireThat(
          cycle.blocks.every(block => block.stopped),
          'INTERRUPTION_WITH_OPEN_BLOCK',
          path,
        )
        cycle.interrupted = true
        active[0][1].active = null
        stats.interruptedMessages++
      }
      boundary = {
        users: new Map(),
        interruptSeq: null,
        results: [],
        idleSeq: null,
      }
      continue
    }
    if (stored.kind === 'native.result') {
      requireThat(object(message), 'NATIVE_MESSAGE_REQUIRED', path)
      boundary.results.push(stored)
      continue
    }
    if (stored.kind !== 'native.message') continue
    requireThat(object(message), 'NATIVE_MESSAGE_REQUIRED', path)
    if (message.type === 'user') {
      const content = message.message?.content
      const interrupted =
        Array.isArray(content) &&
        content.some(
          block =>
            block.type === 'text' &&
            [
              '[Request interrupted by user]',
              '[Request interrupted by user for tool use]',
            ].includes(block.text),
        )
      if (interrupted) boundary.interruptSeq = stored.seq
      else if (typeof message.uuid === 'string')
        boundary.users.set(message.uuid, stored.seq)
    }
    if (
      message.type === 'system' &&
      message.subtype === 'session_state_changed' &&
      message.state === 'idle'
    )
      boundary.idleSeq = stored.seq
    const laneId = message.parent_tool_use_id ?? null
    requireThat(
      laneId === null || typeof laneId === 'string',
      'PARENT_TOOL_ID',
      path,
    )
    if (!lanes.has(laneId)) lanes.set(laneId, { active: null, byId: new Map() })
    const lane = lanes.get(laneId)

    if (message.type === 'stream_event') {
      const event = message.event
      requireThat(object(event), 'STREAM_EVENT_REQUIRED', path)
      if (event.type === 'message_start') {
        requireThat(lane.active === null, 'MESSAGE_OVERLAP', path)
        const id = event.message?.id
        requireThat(typeof id === 'string' && id !== '', 'MESSAGE_ID', path)
        requireThat(!lane.byId.has(id), 'MESSAGE_DUPLICATE', path)
        const cycle = {
          blocks: [],
          assistants: [],
          stopped: false,
          interrupted: false,
          deltaSeen: false,
          startedSeq: stored.seq,
          path,
        }
        lane.active = cycle
        lane.byId.set(id, cycle)
        cycles.push(cycle)
        stats.modelMessages++
        continue
      }
      const cycle = lane.active
      requireThat(cycle !== null, 'STREAM_WITHOUT_MESSAGE', path)
      if (event.type === 'content_block_start') {
        requireThat(!cycle.deltaSeen, 'BLOCK_AFTER_MESSAGE_DELTA', path)
        requireThat(event.index === cycle.blocks.length, 'BLOCK_INDEX', path)
        const value = event.content_block
        requireThat(object(value), 'BLOCK_REQUIRED', path)
        requireThat(
          ['thinking', 'text', 'tool_use', 'redacted_thinking'].includes(
            value.type,
          ),
          'BLOCK_TYPE',
          path,
        )
        if (value.type === 'thinking') {
          requireThat(
            typeof value.thinking === 'string' &&
              typeof value.signature === 'string',
            'THINKING_BLOCK',
            path,
          )
          stats.thinkingBlocks++
          stats.thinkingChars += value.thinking.length
        } else if (value.type === 'text') {
          requireThat(typeof value.text === 'string', 'TEXT_BLOCK', path)
          stats.textBlocks++
        } else if (value.type === 'tool_use') {
          requireThat(
            typeof value.id === 'string' &&
              value.id !== '' &&
              typeof value.name === 'string' &&
              value.name !== '' &&
              object(value.input),
            'TOOL_BLOCK',
            path,
          )
        }
        cycle.blocks.push({ value: { ...value }, json: '', stopped: false })
      } else if (
        event.type === 'content_block_delta' ||
        event.type === 'content_block_stop'
      ) {
        requireThat(
          Number.isInteger(event.index) && event.index >= 0,
          'BLOCK_INDEX',
          path,
        )
        const block = cycle.blocks[event.index]
        requireThat(block && !block.stopped, 'BLOCK_NOT_OPEN', path)
        if (event.type === 'content_block_stop') {
          block.stopped = true
          continue
        }
        const delta = event.delta
        requireThat(object(delta), 'DELTA_REQUIRED', path)
        const target = {
          text_delta: ['text', 'text'],
          thinking_delta: ['thinking', 'thinking'],
          signature_delta: ['thinking', 'signature'],
          input_json_delta: ['tool_use', 'partial_json'],
        }[delta.type]
        requireThat(
          target &&
            block.value.type === target[0] &&
            typeof delta[target[1]] === 'string',
          'DELTA_TYPE',
          path,
        )
        if (delta.type === 'input_json_delta') block.json += delta.partial_json
        else if (delta.type === 'signature_delta')
          block.value.signature = delta.signature
        else block.value[target[1]] += delta[target[1]]
        if (delta.type === 'thinking_delta')
          stats.thinkingChars += delta.thinking.length
        stats.deltas++
      } else if (event.type === 'message_delta') {
        requireThat(
          cycle.blocks.every(block => block.stopped),
          'MESSAGE_DELTA_WITH_OPEN_BLOCK',
          path,
        )
        cycle.deltaSeen = true
      } else if (event.type === 'message_stop') {
        requireThat(
          cycle.deltaSeen && cycle.blocks.every(block => block.stopped),
          'MESSAGE_NOT_CLOSED',
          path,
        )
        cycle.stopped = true
        lane.active = null
      } else {
        requireThat(false, 'STREAM_EVENT_TYPE', path)
      }
    } else if (message.type === 'assistant') {
      const content = message.message?.content
      requireThat(Array.isArray(content), 'ASSISTANT_CONTENT', path)
      if (message.message.model !== '<synthetic>') {
        const cycle = lane.byId.get(message.message.id)
        requireThat(cycle, 'ASSISTANT_WITHOUT_STREAM', path)
        cycle.assistants.push(...content)
      }
      for (const block of content) {
        if (block.type !== 'tool_use') continue
        requireThat(
          typeof block.id === 'string' && !uses.has(block.id),
          'TOOL_USE_DUPLICATE',
          path,
        )
        uses.add(block.id)
        stats.toolUses++
      }
    } else if (
      message.type === 'user' &&
      Array.isArray(message.message?.content)
    ) {
      for (const block of message.message.content) {
        if (block.type !== 'tool_result') continue
        requireThat(uses.has(block.tool_use_id), 'TOOL_RESULT_BEFORE_USE', path)
        requireThat(
          !results.has(block.tool_use_id),
          'TOOL_RESULT_DUPLICATE',
          path,
        )
        results.add(block.tool_use_id)
        stats.toolResults++
      }
    }
  }

  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i]
    requireThat(
      cycle.stopped || cycle.interrupted,
      'MESSAGE_UNCLOSED',
      cycle.path,
    )
    const rebuilt = cycle.blocks.map((block, index) =>
      finishBlock(block, `/model/${i}/block/${index}`),
    )
    equal(cycle.assistants, rebuilt.filter(visibleBlock), `/model/${i}/content`)
  }
  return stats
}

export function assistantText(events) {
  return events
    .flatMap(event =>
      event.kind === 'native.message' && event.payload?.type === 'assistant'
        ? (event.payload.message?.content ?? [])
            .filter(block => block.type === 'text')
            .map(block => block.text)
        : [],
    )
    .join('')
}

function nonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function readTokens(value) {
  if (
    !object(value) ||
    !tokenFields.every(
      ([field]) => Number.isSafeInteger(value[field]) && value[field] >= 0,
    )
  ) {
    return null
  }
  return Object.fromEntries(
    tokenFields.map(([field, projected]) => [projected, value[field]]),
  )
}

function modelUsage(value) {
  if (!object(value)) return null
  const entries = []
  for (const [name, usage] of Object.entries(value)) {
    if (
      !object(usage) ||
      !modelFields.every(field => nonnegative(usage[field]))
    )
      return null
    entries.push([
      name,
      Object.fromEntries(modelFields.map(field => [field, usage[field]])),
    ])
  }
  return Object.fromEntries(entries)
}

function counter() {
  return {
    status: 'unknown',
    scope: 'nativeCumulative',
    value: null,
    seq: null,
    counterResetObserved: false,
    reason: 'no_native_result',
    lastKnown: null,
  }
}

function decreased(previous, current) {
  if (typeof previous === 'number' && typeof current === 'number')
    return current < previous
  return (
    object(previous) &&
    Object.entries(previous).some(
      ([key, value]) =>
        !['contextWindow', 'maxOutputTokens'].includes(key) &&
        (!Object.hasOwn(current, key) || decreased(value, current[key])),
    )
  )
}

function observeCounter(target, value, seq, reason) {
  const previous =
    target.value !== null
      ? { value: target.value, seq: target.seq }
      : target.lastKnown
  target.seq = seq
  if (value !== null) {
    if (previous && decreased(previous.value, value))
      target.counterResetObserved = true
    Object.assign(target, {
      status: 'available',
      value,
      reason: null,
      lastKnown: null,
    })
  } else {
    Object.assign(target, {
      status: 'unknown',
      value: null,
      reason,
      lastKnown: previous,
    })
  }
}

export function assertUsage(events, usage) {
  eventOrder(events)
  requireThat(object(usage), 'USAGE_REQUIRED', '/usage')
  const sessionId = events[0]?.sessionId ?? usage.sessionId
  const tokens = Object.fromEntries(tokenFields.map(([, field]) => [field, 0]))
  const instances = []
  const exceededResults = []
  const seen = new Set()
  let resultCount = 0
  let unknown = null
  const newInstance = (instanceId, startedSeq) => ({
    instanceId,
    startedSeq,
    baselineStatus: 'unknown',
    resultCount: 0,
    latestResult: null,
    totalCostUsd: counter(),
    modelUsage: counter(),
  })

  for (const event of events) {
    if (event.kind === 'cli.started') {
      instances.push(
        newInstance(
          typeof event.payload?.instanceId === 'string'
            ? event.payload.instanceId
            : null,
          event.seq,
        ),
      )
      continue
    }
    if (event.kind !== 'native.result') continue
    if (instances.length === 0) instances.push(newInstance(null, null))
    const instance = instances.at(-1)
    const payload = event.payload
    requireThat(
      object(payload),
      'RESULT_REQUIRED',
      `/events/${event.seq - 1}/payload`,
    )
    if (typeof payload.uuid === 'string') {
      const identity = JSON.stringify([instance.instanceId, payload.uuid])
      if (seen.has(identity)) continue
      seen.add(identity)
    } else unknown ??= 'native_result_identity_missing'
    resultCount++
    instance.resultCount++
    instance.latestResult = {
      seq: event.seq,
      runId: event.runId ?? null,
      atMs: event.atMs,
      subtype:
        typeof payload.subtype === 'string' ? payload.subtype : 'unknown',
      isError: typeof payload.is_error === 'boolean' ? payload.is_error : null,
    }
    if (payload.session_id !== sessionId) {
      unknown ??= 'native_result_session_mismatch'
      observeCounter(
        instance.totalCostUsd,
        null,
        event.seq,
        'native_result_session_mismatch',
      )
      observeCounter(
        instance.modelUsage,
        null,
        event.seq,
        'native_result_session_mismatch',
      )
      continue
    }
    if (payload.subtype === 'error_max_budget_usd')
      exceededResults.push(instance.latestResult)
    const current = readTokens(payload.usage)
    const placeholder =
      payload.subtype === 'error_during_execution' &&
      ['duration_ms', 'duration_api_ms', 'num_turns', 'total_cost_usd'].every(
        field => payload[field] === 0,
      ) &&
      object(payload.modelUsage) &&
      Object.keys(payload.modelUsage).length === 0 &&
      current !== null &&
      Object.values(current).every(value => value === 0)
    observeCounter(
      instance.totalCostUsd,
      !placeholder && nonnegative(payload.total_cost_usd)
        ? payload.total_cost_usd
        : null,
      event.seq,
      placeholder
        ? 'native_execution_error_placeholder'
        : 'native_cost_missing_or_invalid',
    )
    observeCounter(
      instance.modelUsage,
      placeholder ? null : modelUsage(payload.modelUsage),
      event.seq,
      placeholder
        ? 'native_execution_error_placeholder'
        : 'native_model_usage_missing_or_invalid',
    )
    if (placeholder) unknown ??= 'native_execution_error_placeholder'
    else if (!resultTypes.has(payload.subtype))
      unknown ??= 'native_usage_scope_unknown'
    else if (current === null) unknown ??= 'native_usage_missing_or_invalid'
    else {
      for (const [, field] of tokenFields) {
        tokens[field] += current[field]
        requireThat(
          Number.isSafeInteger(tokens[field]),
          'TOKEN_SUM_UNSAFE',
          '/usage/usage/value',
        )
      }
    }
  }

  equal(usage.sessionId, sessionId, '/usage/sessionId')
  equal(usage.throughSeq, events.at(-1)?.seq ?? 0, '/usage/throughSeq')
  equal(usage.resultCount, resultCount, '/usage/resultCount')
  const available = resultCount > 0 && unknown === null
  equal(
    usage.usage,
    {
      status: available ? 'available' : 'unknown',
      scope: 'observedNativeQueries',
      value: available ? tokens : null,
      reason: resultCount === 0 ? 'no_native_result' : unknown,
    },
    '/usage/usage',
  )
  equal(usage.instances, instances, '/usage/instances')
  equal(
    usage.budgets,
    {
      limitUsd: null,
      limitStatus: 'unknown',
      exceededResults,
      enforcement: 'nativeOnly',
    },
    '/usage/budgets',
  )
  return {
    status: available ? 'available' : 'unknown',
    resultCount,
    instances: instances.length,
    ...Object.fromEntries(
      tokenFields.map(([, field]) => [field, available ? tokens[field] : 0]),
    ),
  }
}
