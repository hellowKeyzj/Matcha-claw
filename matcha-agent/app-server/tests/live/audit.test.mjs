import test from 'node:test'
import assert from 'node:assert/strict'
import { assertWireEvents, assertUsage, assistantText } from './audit.mjs'

const sessionId = 'synthetic-session'
const tokenUsage = {
  input_tokens: 7,
  output_tokens: 3,
  cache_read_input_tokens: 2,
  cache_creation_input_tokens: 1,
}
const modelUsage = {
  example: {
    inputTokens: 7,
    outputTokens: 3,
    cacheReadInputTokens: 2,
    cacheCreationInputTokens: 1,
    webSearchRequests: 0,
    costUSD: 0.023011999999999998,
    contextWindow: 64000,
    maxOutputTokens: 4096,
  },
}

function result(
  uuid = 'result-1',
  usage = tokenUsage,
  cost = 0.023011999999999998,
) {
  return {
    type: 'result',
    subtype: 'success',
    uuid,
    session_id: sessionId,
    is_error: false,
    duration_ms: 20,
    duration_api_ms: 10,
    num_turns: 1,
    stop_reason: 'end_turn',
    total_cost_usd: cost,
    usage: structuredClone(usage),
    modelUsage: structuredClone(modelUsage),
    result: 'done',
  }
}

function fixture() {
  const events = []
  const add = (kind, payload) =>
    events.push({
      sessionId,
      seq: events.length + 1,
      runId: null,
      atMs: 1000 + events.length,
      kind,
      payload,
    })
  const message = value =>
    add('native.message', {
      session_id: sessionId,
      parent_tool_use_id: null,
      ...value,
    })
  const stream = event => message({ type: 'stream_event', event })
  const cycle = (id, definitions, parent = null) => {
    const emit = event =>
      message({ type: 'stream_event', parent_tool_use_id: parent, event })
    emit({
      type: 'message_start',
      message: { id, role: 'assistant', content: [], usage: tokenUsage },
    })
    const content = []
    for (let index = 0; index < definitions.length; index++) {
      const definition = definitions[index]
      const { type, chunks } = definition
      const block =
        type === 'tool_use'
          ? { type, id: definition.id, name: definition.name, input: {} }
          : type === 'thinking'
            ? { type, thinking: '', signature: '' }
            : { type, text: '' }
      emit({ type: 'content_block_start', index, content_block: block })
      for (const fragment of chunks) {
        const delta =
          type === 'tool_use'
            ? { type: 'input_json_delta', partial_json: fragment }
            : type === 'thinking'
              ? { type: 'thinking_delta', thinking: fragment }
              : { type: 'text_delta', text: fragment }
        emit({ type: 'content_block_delta', index, delta })
      }
      emit({ type: 'content_block_stop', index })
      content.push(
        type === 'tool_use'
          ? { ...block, input: JSON.parse(chunks.join('') || '{}') }
          : type === 'thinking'
            ? { ...block, thinking: chunks.join('') }
            : { ...block, text: chunks.join('') },
      )
    }
    emit({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: tokenUsage,
    })
    for (let index = 0; index < content.length; index++) {
      message({
        type: 'assistant',
        parent_tool_use_id: parent,
        uuid: `${id}-block-${index}`,
        message: {
          id,
          model: 'example',
          role: 'assistant',
          content: [content[index]],
        },
      })
    }
    emit({ type: 'message_stop' })
  }
  add('cli.started', { instanceId: 'instance-1' })
  cycle('model-1', [
    { type: 'thinking', chunks: ['synthetic ', 'reason'] },
    { type: 'text', chunks: ['Visible ', 'answer'] },
    {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Read',
      chunks: ['{"file_path":', '"/synthetic.txt"}'],
    },
  ])
  message({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'synthetic file',
        },
      ],
    },
  })
  cycle('model-2', [{ type: 'text', chunks: [' done'] }])
  add('native.result', result())
  return { events, add, message, stream, cycle }
}

function cancelledFixture() {
  const sample = fixture()
  const { events, add, message, cycle } = sample
  events.splice(1)
  cycle('cancel-model', [
    { type: 'thinking', chunks: ['synthetic ', 'reason'] },
  ])
  const assistant = events.find(event => event.payload.type === 'assistant')
  const kept = events.filter(
    event =>
      event !== assistant &&
      !['message_delta', 'message_stop'].includes(event.payload.event?.type),
  )
  events.splice(0, events.length, ...kept)
  message({
    type: 'user',
    uuid: 'submitted-input',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'synthetic input' }],
    },
  })
  message(assistant.payload)
  message({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '[Request interrupted by user]' }],
    },
  })
  const cancelledResult = {
    ...result(),
    subtype: 'error_during_execution',
    is_error: true,
  }
  add('native.result', cancelledResult)
  message({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
  add('run.terminal', {
    sessionId,
    runId: 'cancel-run',
    messageId: 'submitted-input',
    status: 'cancelled',
    reason: 'native_interruption_observed',
    cancelRequestedAtMs: 1001,
    result: structuredClone(cancelledResult),
  })
  const terminal = events.at(-1)
  terminal.runId = 'cancel-run'
  cycle('reuse-model', [{ type: 'text', chunks: ['reused'] }])
  events.forEach((event, index) => {
    event.seq = index + 1
  })
  return { ...sample, terminal }
}

function wire(events, raw, live) {
  return assertWireEvents(
    events,
    raw ??
      structuredClone(
        events
          .filter(event =>
            ['native.message', 'native.result'].includes(event.kind),
          )
          .map(event => event.payload),
      ),
    live ?? structuredClone(events),
  )
}

function streamEvent(events, type, deltaType) {
  return events.find(
    event =>
      event.payload.event?.type === type &&
      (!deltaType || event.payload.event.delta?.type === deltaType),
  )
}

function expectFailure(events, tag, raw, live) {
  assert.throws(
    () => wire(events, raw, live),
    error => {
      assert.match(error.message, new RegExp(`^${tag} at /`))
      assert.doesNotMatch(
        error.message,
        /synthetic reason|Visible answer|PRIVATE_SENTINEL|api-key/,
      )
      return true
    },
  )
}

function resultRef(event) {
  return {
    seq: event.seq,
    runId: event.runId,
    atMs: event.atMs,
    subtype: event.payload.subtype,
    isError: event.payload.is_error,
  }
}

function availableCounter(value, seq) {
  return {
    status: 'available',
    scope: 'nativeCumulative',
    value,
    seq,
    counterResetObserved: false,
    reason: null,
    lastKnown: null,
  }
}

function unknownCounter() {
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

function expectedUsage(events, results) {
  const latest = results.at(-1)
  return {
    sessionId,
    agentId: 'synthetic-agent',
    throughSeq: events.at(-1)?.seq ?? 0,
    resultCount: results.length,
    usage: {
      status: results.length ? 'available' : 'unknown',
      scope: 'observedNativeQueries',
      reason: results.length ? null : 'no_native_result',
      value: results.length
        ? {
            inputTokens: 7 * results.length,
            outputTokens: 3 * results.length,
            cacheReadInputTokens: 2 * results.length,
            cacheCreationInputTokens: results.length,
          }
        : null,
    },
    instances: [
      {
        instanceId: 'instance-1',
        startedSeq: 1,
        baselineStatus: 'unknown',
        resultCount: results.length,
        latestResult: latest ? resultRef(latest) : null,
        totalCostUsd: latest
          ? availableCounter(latest.payload.total_cost_usd, latest.seq)
          : unknownCounter(),
        modelUsage: latest
          ? availableCounter(latest.payload.modelUsage, latest.seq)
          : unknownCounter(),
      },
    ],
    budgets: {
      limitUsd: null,
      limitStatus: 'unknown',
      exceededResults: [],
      enforcement: 'nativeOnly',
    },
  }
}

test('thinking/text/tool reconstruction and cost-only f64 tolerance', () => {
  const { events } = fixture()
  const raw = structuredClone(
    events
      .filter(event => event.kind.startsWith('native.'))
      .map(event => event.payload),
  )
  raw.at(-1).total_cost_usd = 0.023012
  raw.at(-1).modelUsage.example.costUSD = 0.023012
  const stats = wire(events, raw)
  assert.deepEqual(stats, {
    nativeEvents: events.length - 1,
    modelMessages: 2,
    thinkingBlocks: 1,
    thinkingChars: 16,
    textBlocks: 2,
    toolUses: 1,
    toolResults: 1,
    deltas: 7,
    interruptedMessages: 0,
    partialBlocks: 0,
  })
  assert.equal(assistantText(events), 'Visible answer done')
})

test('empty thinking survives; parent tool scopes separate message IDs', () => {
  const { events, cycle } = fixture()
  cycle(
    'model-1',
    [
      { type: 'thinking', chunks: [] },
      { type: 'text', chunks: ['child'] },
    ],
    'tool-1',
  )
  const stats = wire(events)
  assert.equal(stats.modelMessages, 3)
  assert.equal(stats.thinkingBlocks, 2)
  assert.equal(stats.thinkingChars, 16)
})

test('sequence must start at one and cannot be sorted to hide a gap', () => {
  const { events } = fixture()
  events[1].seq++
  expectFailure(events, 'EVENT_SEQUENCE')
})

test('live order and duplicate deliveries fail without sorting or deduplication', () => {
  const { events } = fixture()
  const reordered = structuredClone(events)
  ;[reordered[2], reordered[3]] = [reordered[3], reordered[2]]
  expectFailure(events, 'NUMBER_MISMATCH', undefined, reordered)
  const duplicate = structuredClone(events)
  duplicate.splice(3, 0, structuredClone(duplicate[2]))
  expectFailure(events, 'LIVE_COUNT', undefined, duplicate)
})

test('missing delta is detected even when raw and live repeat the same defect', () => {
  const { events } = fixture()
  const index = events.indexOf(
    streamEvent(events, 'content_block_delta', 'thinking_delta'),
  )
  events.splice(index, 1)
  events.forEach((event, i) => {
    event.seq = i + 1
  })
  expectFailure(events, 'VALUE_MISMATCH')
})

test('text delta cannot enter a thinking block', () => {
  const { events } = fixture()
  streamEvent(
    events,
    'content_block_delta',
    'thinking_delta',
  ).payload.event.delta = {
    type: 'text_delta',
    text: 'PRIVATE_SENTINEL',
  }
  expectFailure(events, 'DELTA_TYPE')
})

test('tool results require a preceding use and may not repeat', () => {
  const { events } = fixture()
  const toolResult = events.find(event => event.payload.type === 'user')
  events.splice(events.indexOf(toolResult), 1)
  events.splice(1, 0, toolResult)
  events.forEach((event, i) => {
    event.seq = i + 1
  })
  expectFailure(events, 'TOOL_RESULT_BEFORE_USE')
  const second = fixture()
  second.message({
    type: 'user',
    message: structuredClone(toolResult.payload.message),
  })
  expectFailure(second.events, 'TOOL_RESULT_DUPLICATE')
})

test('tool JSON, name, and ID are checked against streamed blocks', () => {
  for (const field of ['name', 'id', 'input']) {
    const { events } = fixture()
    const tool = events.find(
      event =>
        event.payload.type === 'assistant' &&
        event.payload.message.content[0].type === 'tool_use',
    ).payload.message.content[0]
    if (field === 'input') tool.input.file_path = '/different.txt'
    else tool[field] = 'different'
    if (field === 'id') expectFailure(events, 'TOOL_RESULT_BEFORE_USE')
    else expectFailure(events, 'VALUE_MISMATCH')
  }
  const { events } = fixture()
  streamEvent(
    events,
    'content_block_delta',
    'input_json_delta',
  ).payload.event.delta.partial_json = '{bad'
  expectFailure(events, 'TOOL_JSON_INVALID')
})

test('native unclosed messages fail, while closed cancellation can leave a tool without result', () => {
  const { events } = fixture()
  events.pop()
  events.pop()
  expectFailure(events, 'MESSAGE_UNCLOSED')
  const closed = fixture()
  const index = closed.events.findIndex(event => event.payload.type === 'user')
  closed.events.splice(index)
  const stats = wire(closed.events)
  assert.equal(stats.toolUses, 1)
  assert.equal(stats.toolResults, 0)
})

test('duplicate block stop and delta after close fail', () => {
  const { events } = fixture()
  const stopped = streamEvent(events, 'content_block_stop')
  const index = events.indexOf(stopped)
  events.splice(index + 1, 0, structuredClone(stopped))
  events.forEach((event, i) => {
    event.seq = i + 1
  })
  expectFailure(events, 'BLOCK_NOT_OPEN')
})

test('all non-cost fields compare strictly and failure output does not leak keys or values', () => {
  const { events } = fixture()
  const raw = structuredClone(
    events
      .filter(event => event.kind.startsWith('native.'))
      .map(event => event.payload),
  )
  raw.at(-1).usage.output_tokens += 1e-12
  expectFailure(events, 'NUMBER_MISMATCH', raw)
  const live = structuredClone(events)
  live[0].payload = { 'api-key-PRIVATE_SENTINEL': 'PRIVATE_SENTINEL' }
  expectFailure(events, 'KEY_MISSING', undefined, live)
  const strict = structuredClone(raw)
  strict.at(-1).usage.output_tokens = 3
  strict.at(-1).total_cost_usd += 1e-8
  expectFailure(events, 'NUMBER_MISMATCH', strict)
})

test('usage sums per-query tokens but keeps the latest instance cumulative snapshot', () => {
  const { events, add } = fixture()
  const first = events.at(-1)
  add('native.result', result('result-2', tokenUsage, 0.04))
  const second = events.at(-1)
  const usage = expectedUsage(events, [first, second])
  assert.deepEqual(assertUsage(events, usage), {
    status: 'available',
    resultCount: 2,
    instances: 1,
    inputTokens: 14,
    outputTokens: 6,
    cacheReadInputTokens: 4,
    cacheCreationInputTokens: 2,
  })
  const wrong = structuredClone(usage)
  wrong.instances[0].totalCostUsd.value += first.payload.total_cost_usd
  assert.throws(() => assertUsage(events, wrong), {
    code: 'audit_number_mismatch',
  })
  const wrongTokens = structuredClone(usage)
  wrongTokens.usage.value.inputTokens++
  assert.throws(() => assertUsage(events, wrongTokens), {
    code: 'audit_number_mismatch',
  })
})

test('usage deduplicates result UUID within an instance, not across instances', () => {
  const { events, add } = fixture()
  const first = events.at(-1)
  add('native.result', structuredClone(first.payload))
  const usage = expectedUsage(events, [first])
  assert.equal(assertUsage(events, usage).resultCount, 1)
  add('cli.started', { instanceId: 'instance-2' })
  const started = events.at(-1)
  add('native.result', structuredClone(first.payload))
  const last = events.at(-1)
  const resumed = expectedUsage(events, [first, last])
  resumed.instances[0] = usage.instances[0]
  resumed.instances.push({
    ...structuredClone(usage.instances[0]),
    instanceId: 'instance-2',
    startedSeq: started.seq,
    latestResult: resultRef(last),
    totalCostUsd: availableCounter(last.payload.total_cost_usd, last.seq),
    modelUsage: availableCounter(last.payload.modelUsage, last.seq),
  })
  assert.equal(assertUsage(events, resumed).instances, 2)
  const wrong = structuredClone(resumed)
  wrong.resultCount = 3
  assert.throws(() => assertUsage(events, wrong), {
    code: 'audit_number_mismatch',
  })
})

test('live replay comparison is exact even for the two raw cost tolerance paths', () => {
  const { events } = fixture()
  for (const update of [
    payload => {
      payload.total_cost_usd = 0.023012
    },
    payload => {
      payload.modelUsage.example.costUSD = 0.023012
    },
  ]) {
    const live = structuredClone(events)
    update(live.at(-1).payload)
    expectFailure(events, 'NUMBER_MISMATCH', undefined, live)
  }
})

test('signature deltas replace the prior signature as the native producer does', () => {
  const { events } = fixture()
  const index = events.indexOf(streamEvent(events, 'content_block_stop'))
  const signatureEvents = [
    'synthetic-signature-1',
    'synthetic-signature-2',
  ].map(signature => {
    const event = structuredClone(events[index - 1])
    event.payload.event.delta = { type: 'signature_delta', signature }
    return event
  })
  events.splice(index, 0, ...signatureEvents)
  events.forEach((event, i) => {
    event.seq = i + 1
  })
  const thinking = events.find(
    event =>
      event.payload.type === 'assistant' &&
      event.payload.message.content[0].type === 'thinking',
  ).payload.message.content[0]
  thinking.signature = 'synthetic-signature-2'
  assert.equal(wire(events).deltas, 9)
  thinking.signature = 'synthetic-signature-1synthetic-signature-2'
  expectFailure(events, 'VALUE_MISMATCH')
})

test('synthetic cancellation messages do not pretend to have an API stream', () => {
  const { events, message } = fixture()
  message({
    type: 'assistant',
    uuid: 'cancel-synthetic',
    message: {
      id: 'synthetic-message',
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text: '[Request interrupted by user]' }],
    },
  })
  assert.equal(wire(events).modelMessages, 2)
})

test('confirmed native interruption permits missing message stop, not missing block stop, before reuse', () => {
  const { events } = cancelledFixture()
  const stats = wire(events)
  assert.equal(stats.interruptedMessages, 1)
  assert.equal(stats.partialBlocks, 0)
  assert.equal(stats.modelMessages, 2)
  assert.equal(stats.thinkingChars, 16)
  assert.equal(assistantText(events), 'reused')
})

test('cancelled classification requires matching terminal, ACK, interruption, result, and idle evidence', () => {
  const mutations = [
    ({ events }) => {
      events.find(
        event =>
          event.payload.message?.content?.[0]?.text ===
          '[Request interrupted by user]',
      ).payload.message.content[0].text = 'synthetic ordinary user'
    },
    ({ terminal }) => {
      terminal.payload.messageId = 'wrong-input'
    },
    ({ terminal }) => {
      terminal.payload.runId = 'wrong-run'
    },
    ({ terminal }) => {
      terminal.payload.sessionId = 'wrong-session'
    },
    ({ terminal }) => {
      terminal.payload.status = 'succeeded'
    },
    ({ terminal }) => {
      terminal.payload.reason = 'native_result'
    },
    ({ terminal }) => {
      terminal.payload.cancelRequestedAtMs = null
    },
    ({ events }) => {
      events.find(
        event => event.payload.subtype === 'session_state_changed',
      ).payload.state = 'running'
    },
    ({ events }) => {
      const index = events.findIndex(event => event.kind === 'native.result')
      events.splice(index, 0, structuredClone(events[index]))
    },
  ]
  for (const mutate of mutations) {
    const sample = cancelledFixture()
    mutate(sample)
    sample.events.forEach((event, index) => {
      event.seq = index + 1
    })
    expectFailure(sample.events, 'INTERRUPTION_UNPROVEN')
  }
  const mismatched = cancelledFixture()
  mismatched.terminal.payload.result.uuid = 'wrong-result'
  expectFailure(mismatched.events, 'VALUE_MISMATCH')
})

test('queued cancellation and absent terminal cannot release an unfinished message', () => {
  const queued = cancelledFixture()
  queued.terminal.payload.reason = 'cancelled_before_send'
  expectFailure(queued.events, 'MESSAGE_OVERLAP')
  const absent = cancelledFixture()
  absent.events.splice(absent.events.indexOf(absent.terminal), 1)
  absent.events.forEach((event, index) => {
    event.seq = index + 1
  })
  expectFailure(absent.events, 'MESSAGE_OVERLAP')
})

test('confirmed interruption still compares completed thinking and rejects open blocks or invalid deltas', () => {
  const changed = cancelledFixture()
  changed.events.find(
    event => event.payload.type === 'assistant',
  ).payload.message.content[0].thinking = 'PRIVATE_SENTINEL'
  expectFailure(changed.events, 'VALUE_MISMATCH')
  const open = cancelledFixture()
  open.events.splice(
    open.events.indexOf(streamEvent(open.events, 'content_block_stop')),
    1,
  )
  open.events.forEach((event, index) => {
    event.seq = index + 1
  })
  expectFailure(open.events, 'INTERRUPTION_WITH_OPEN_BLOCK')
  const malformed = cancelledFixture()
  streamEvent(malformed.events, 'content_block_delta').payload.event.delta = {
    type: 'text_delta',
    text: 'PRIVATE_SENTINEL',
  }
  expectFailure(malformed.events, 'DELTA_TYPE')
})

test('no native result legitimately projects unknown usage with zero safe counts', () => {
  const { events } = fixture()
  events.splice(1)
  const usage = expectedUsage(events, [])
  assert.deepEqual(assertUsage(events, usage), {
    status: 'unknown',
    resultCount: 0,
    instances: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  })
})
