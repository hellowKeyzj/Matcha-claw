import { readFile, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { assertWireEvents, assertUsage, assistantText } from './audit.mjs'

class ValidationError extends Error {
  constructor(tag) {
    super(tag)
    this.name = 'ValidationError'
    this.tag = tag
  }
}
class RpcError extends Error {
  constructor(error) {
    super('rpc_failed')
    this.name = 'RpcError'
    this.code = Number.isInteger(error?.code) ? error.code : 0
    this.kind = /^[a-z][a-z0-9_]{0,90}$/.test(error?.data?.kind ?? '')
      ? error.data.kind
      : 'unknown'
  }
}
const check = (condition, tag) => {
  if (!condition) throw new ValidationError(tag)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const terminal = run =>
  ['succeeded', 'failed', 'cancelled', 'outcomeUnknown'].includes(run.status)
const nativeEvents = events =>
  events.filter(e => ['native.message', 'native.result'].includes(e.kind))
const blocks = events =>
  events.flatMap(e =>
    e.kind === 'native.message' && Array.isArray(e.payload?.message?.content)
      ? e.payload.message.content
      : [],
  )
const compact = text => text.toUpperCase().replace(/\s/g, '')
const isFilePath = (value, expected) =>
  typeof value === 'string' &&
  path.isAbsolute(value) &&
  !value.split(/[\\/]/).includes('..') &&
  path.resolve(value) === path.resolve(expected)

function safeError(error) {
  if (error instanceof RpcError)
    return { type: error.name, code: error.code, kind: error.kind }
  if (error instanceof ValidationError)
    return { type: error.name, tag: error.tag }
  // Never copy arbitrary Error.message: native/assertion errors can contain model output or secrets.
  return { type: 'Error', tag: 'unexpected_error' }
}

async function main() {
  const root = process.env.MATCHA_TEST_ROOT
  check(typeof root === 'string' && path.isAbsolute(root), 'test_root_required')
  const report = {
    schemaVersion: 1,
    status: 'failed',
    cases: [],
    thinking: { status: 'notObserved', blocks: 0, chars: 0 },
  }
  const sessions = []
  const results = new Map()
  const live = []
  const waiting = new Map()
  let socket
  let transportError
  let nextId = 0
  let timeout = 180_000

  async function caseOf(name, dependencies, operation) {
    if (
      dependencies.some(
        dependency => results.get(dependency)?.status !== 'passed',
      )
    ) {
      const result = {
        name,
        status: 'skipped',
        error: { tag: 'dependency_failed' },
      }
      report.cases.push(result)
      results.set(name, result)
      return undefined
    }
    const previousRuns = new Set(sessions.flatMap(session => session.runs))
    const result = { name, status: 'failed' }
    report.cases.push(result)
    results.set(name, result)
    try {
      const value = await operation()
      result.status = 'passed'
      if (value?.counts) result.counts = value.counts
      if (value?.usage) result.usage = value.usage
      return value
    } catch (error) {
      result.error = safeError(error)
      for (const session of sessions) {
        for (const runId of session.runs.filter(id => !previousRuns.has(id))) {
          try {
            const run = await rpc('runs.get', { runId })
            if (!terminal(run)) {
              await rpc('runs.cancel', { runId })
              await waitRun(session, runId)
            }
          } catch {
            session.blocked = true
          }
        }
      }
      return undefined
    }
  }

  async function until(probe, tag, deadline = Date.now() + timeout) {
    while (Date.now() < deadline) {
      if (transportError) throw transportError
      const value = await probe()
      if (value) return value
      await sleep(40)
    }
    throw new ValidationError(tag)
  }

  function rpc(method, params = {}) {
    if (transportError) return Promise.reject(transportError)
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new ValidationError('rpc_deadline'))
      }, timeout)
      waiting.set(id, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      } catch {
        clearTimeout(timer)
        waiting.delete(id)
        reject(new ValidationError('rpc_send_failed'))
      }
    })
  }

  function failTransport(tag) {
    transportError ??= new ValidationError(tag)
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer)
      pending.reject(transportError)
    }
    waiting.clear()
  }

  async function expectRpcError(method, params, kind) {
    try {
      await rpc(method, params)
    } catch (error) {
      check(
        error instanceof RpcError && error.kind === kind,
        'unexpected_rpc_error',
      )
      return
    }
    throw new ValidationError('expected_rpc_error_missing')
  }

  async function replay(session) {
    const events = []
    let cursor = 0
    while (true) {
      const page = await rpc('events.replay', {
        sessionId: session.id,
        afterSeq: cursor,
        limit: 128,
      })
      check(
        page.sessionId === session.id && Array.isArray(page.events),
        'replay_shape',
      )
      for (const event of page.events) {
        check(
          event.sessionId === session.id && event.seq === cursor + 1,
          'replay_sequence',
        )
        events.push(event)
        cursor = event.seq
      }
      check(
        page.nextSeq === cursor && page.latestSeq >= cursor,
        'replay_cursor',
      )
      if (cursor >= page.latestSeq) return events
      check(page.events.length > 0, 'replay_stalled')
    }
  }

  async function lines(file, optional = false) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (optional && error.code === 'ENOENT') return []
      throw new ValidationError('capture_read_failed')
    }
    const end = text.lastIndexOf('\n')
    if (end === -1) return []
    try {
      return text
        .slice(0, end)
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line))
    } catch {
      throw new ValidationError('capture_json_invalid')
    }
  }

  async function capture(session) {
    const children = await lines(path.join(root, 'children.jsonl'), true)
    const raw = []
    const pids = []
    for (const child of children) {
      if (!Number.isInteger(child.pid) || typeof child.cwd !== 'string')
        throw new ValidationError('child_capture_shape')
      const messages = await lines(
        path.join(root, 'raw', `${child.pid}.ndjson`),
        true,
      )
      if (!messages.some(message => message.session_id === session.id)) continue
      check(
        path.resolve(child.cwd) === path.resolve(session.workspace),
        'child_workspace_mismatch',
      )
      check(!pids.includes(child.pid), 'child_capture_duplicate')
      pids.push(child.pid)
      // A child is identified by its explicit session identity. Preserve its sid-less facts too.
      raw.push(
        ...messages.filter(
          message =>
            !message.type?.startsWith('control_') &&
            (message.session_id === undefined ||
              message.session_id === session.id),
        ),
      )
    }
    return { raw, pids }
  }

  async function audit(session) {
    const events = await replay(session)
    const watermark = events.at(-1)?.seq ?? 0
    await until(
      () =>
        watermark === 0 ||
        live.some(
          event => event.sessionId === session.id && event.seq === watermark,
        ),
      'live_watermark_deadline',
    )
    const selectedLive = live.filter(
      event => event.sessionId === session.id && event.seq <= watermark,
    )
    const captured = await until(async () => {
      const value = await capture(session)
      return value.raw.length >= nativeEvents(events).length ? value : undefined
    }, 'raw_capture_deadline')
    let counts
    let usage
    try {
      counts = assertWireEvents(events, captured.raw, selectedLive)
      usage = assertUsage(
        events,
        await rpc('usage.get', { sessionId: session.id }),
      )
    } catch (error) {
      if (error instanceof RpcError) throw error
      // audit owns safe structured labels; never retain native assertion messages.
      const tag = /^audit_[a-z0-9_]+$/.test(error?.code ?? '')
        ? error.code
        : 'audit_failed'
      throw new ValidationError(tag)
    }
    session.audit = { counts, usage }
    return { counts, usage }
  }

  async function createSession(agentId, workspace) {
    const created = await rpc('sessions.create', { agentId })
    check(
      created.status === 'open' && typeof created.sessionId === 'string',
      'session_create_shape',
    )
    const session = {
      id: created.sessionId,
      agentId,
      workspace,
      runs: [],
      allowedPaths: new Set(),
    }
    sessions.push(session)
    await rpc('events.subscribe', { sessionId: session.id, afterSeq: 0 })
    return session
  }

  async function submit(session, content) {
    check(!session.blocked, 'session_dependency_failed')
    const receipt = await rpc('runs.submit', { sessionId: session.id, content })
    check(
      receipt.sessionId === session.id &&
        receipt.status === 'queued' &&
        typeof receipt.runId === 'string',
      'submit_receipt_shape',
    )
    session.runs.push(receipt.runId)
    return receipt.runId
  }

  async function rejectUnexpected(item, family) {
    const response =
      family === 'approvals'
        ? {
            type: 'permission',
            decision: {
              behavior: 'deny',
              message: 'Unexpected operation rejected by the live test.',
              interrupt: true,
            },
          }
        : item.category === 'askUserQuestion'
          ? {
              type: 'askUserQuestion',
              answer: {
                action: 'decline',
                message: 'Unexpected question rejected by the live test.',
                interrupt: true,
              },
            }
          : { type: 'elicitation', action: 'decline' }
    await rpc(`${family}.respond`, {
      sessionId: item.sessionId,
      instanceId: item.instanceId,
      nativeRequestId: item.nativeRequestId,
      response,
    })
  }

  async function interactions(session, handler) {
    for (const family of ['approvals', 'questions']) {
      const pending = await rpc(`${family}.list`, { sessionId: session.id })
      for (const item of pending.items) {
        const expected = handler && (await handler(item, family))
        if (!expected) {
          await rejectUnexpected(item, family)
          throw new ValidationError('unexpected_interaction')
        }
      }
    }
  }

  async function waitRun(session, runId, handler) {
    const run = await until(async () => {
      await interactions(session, handler)
      const current = await rpc('runs.get', { runId })
      check(
        current.sessionId === session.id && current.runId === runId,
        'run_identity_mismatch',
      )
      return terminal(current) ? current : undefined
    }, 'run_terminal_deadline')
    check(run.finishedAtMs !== null, 'run_terminal_timestamp')
    return run
  }

  async function success(session, runId, handler) {
    const run = await waitRun(session, runId, handler)
    check(
      run.status === 'succeeded' &&
        run.reason === 'native_result' &&
        run.result?.is_error === false,
      'run_not_succeeded',
    )
    return run
  }

  function runEvents(events, run) {
    const index = events.findIndex(
      event =>
        event.kind === 'run.terminal' && event.payload.runId === run.runId,
    )
    check(index >= 0, 'run_terminal_event_missing')
    let start = index - 1
    while (start >= 0 && events[start].kind !== 'run.terminal') start--
    return events.slice(start + 1, index + 1)
  }

  function remember(events, marker, label, otherMarker) {
    const text = compact(assistantText(events))
    check(text.includes(compact(marker)), 'memory_marker_missing')
    if (label) check(text.includes(label), 'memory_label_missing')
    if (otherMarker)
      check(!text.includes(compact(otherMarker)), 'session_context_leaked')
  }

  async function instance(session) {
    const snapshot = await rpc('sessions.native', { sessionId: session.id })
    check(
      typeof snapshot.instanceId === 'string' &&
        snapshot.initialize !== null &&
        snapshot.launching === false,
      'native_not_ready',
    )
    return snapshot.instanceId
  }

  async function pidState(session) {
    return until(async () => {
      const state = await capture(session)
      return state.pids.length ? state : undefined
    }, 'child_capture_deadline')
  }

  function runningWindow(events) {
    const states = events.filter(
      event =>
        event.kind === 'native.message' &&
        event.payload.type === 'system' &&
        event.payload.subtype === 'session_state_changed',
    )
    const running = states.find(event => event.payload.state === 'running')
    const idle = states.find(
      event =>
        event.payload.state === 'idle' &&
        event.seq > (running?.seq ?? Infinity),
    )
    check(
      running && idle && running.atMs < idle.atMs,
      'native_running_interval_missing',
    )
    return [running.atMs, idle.atMs]
  }

  function checkToolPaths(events, session) {
    for (const block of blocks(events).filter(
      block => block.type === 'tool_use',
    )) {
      check(
        ['Read', 'Write', 'Edit', 'AskUserQuestion'].includes(block.name),
        'unexpected_tool_use',
      )
      if (block.name !== 'AskUserQuestion')
        check(
          [...session.allowedPaths].some(file =>
            isFilePath(block.input?.file_path, file),
          ),
          'tool_path_mismatch',
        )
    }
  }

  async function fileEquals(file, expected) {
    check(
      (await readFile(file, 'utf8').catch(() => null)) === expected,
      'file_content_mismatch',
    )
  }
  async function absent(file) {
    try {
      await access(file)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw new ValidationError('file_check_failed')
    }
    throw new ValidationError('denied_file_exists')
  }

  try {
    timeout = Number(process.env.MATCHA_TEST_TIMEOUT ?? 180) * 1000
    check(Number.isFinite(timeout) && timeout > 0, 'timeout_invalid')
    let models
    try {
      models = JSON.parse(process.env.MATCHA_TEST_MODELS ?? 'null')
    } catch {
      throw new ValidationError('models_invalid')
    }
    check(
      Array.isArray(models) &&
        models.length > 0 &&
        models.every(
          model =>
            typeof model === 'string' && model.length > 0 && !/\s/.test(model),
        ),
      'models_invalid',
    )
    const baseUrl = process.env.MATCHA_TEST_BASE_URL
    let providerUrl
    let address
    try {
      providerUrl = new URL(baseUrl)
      address = new URL(process.argv[2])
    } catch {
      throw new ValidationError('url_invalid')
    }
    check(
      ['http:', 'https:'].includes(providerUrl.protocol) &&
        !providerUrl.username &&
        !providerUrl.password &&
        !providerUrl.search &&
        !providerUrl.hash,
      'provider_url_invalid',
    )
    check(
      address.protocol === 'http:' &&
        address.hostname === '127.0.0.1' &&
        !address.username &&
        !address.password &&
        !address.search &&
        !address.hash &&
        address.pathname === '/',
      'server_url_invalid',
    )
    check(
      typeof process.env.MATCHA_TEST_AUTH === 'string' &&
        process.env.MATCHA_TEST_AUTH.length > 0,
      'management_auth_missing',
    )
    check(
      ['0', '1'].includes(process.env.MATCHA_TEST_REQUIRE_THINKING ?? '0'),
      'thinking_option_invalid',
    )
    report.models = models.length
    const setup = await caseOf('setup', [], async () => {
      address.protocol = 'ws:'
      address.pathname = '/ws'
      socket = new WebSocket(address)
      socket.addEventListener('message', event => {
        let messages
        try {
          messages = JSON.parse(event.data)
        } catch {
          failTransport('rpc_json_invalid')
          return
        }
        for (const message of Array.isArray(messages) ? messages : [messages]) {
          if (message.method === 'session.event') live.push(message.params)
          else if (message.method === 'events.subscriptionError')
            failTransport('live_subscription_failed')
          else if (waiting.has(message.id)) {
            const pending = waiting.get(message.id)
            waiting.delete(message.id)
            clearTimeout(pending.timer)
            if (message.error) pending.reject(new RpcError(message.error))
            else pending.resolve(message.result)
          }
        }
      })
      socket.addEventListener('error', () => failTransport('socket_error'))
      socket.addEventListener('close', () => failTransport('socket_closed'))
      await until(
        () => socket.readyState === WebSocket.OPEN,
        'socket_open_deadline',
      )
      await rpc('initialize', {
        protocolVersion: 'matcha-app-server-v1',
        token: process.env.MATCHA_TEST_AUTH,
      })
      const matrix = []
      for (const [index, model] of models.entries()) {
        const agentId = `model-${index}`
        await rpc('providers.set', {
          id: agentId,
          provider: {
            kind: 'openai',
            baseUrl,
            model,
            env: {
              OPENAI_API_KEY: 'MATCHA_TEST_KEY',
              OPENAI_SMALL_FAST_MODEL: `MATCHA_TEST_FAST_${index}`,
              OPENAI_MAX_TOKENS: 'MATCHA_TEST_MAX_TOKENS',
            },
          },
        })
        const workspace = path.join(
          root,
          'server',
          'agents',
          agentId,
          'workspace',
        )
        await rpc('agents.create', {
          agentId,
          definition: {
            name: agentId,
            provider: agentId,
            model,
            tools: [],
            systemPrompt:
              'Follow the test instructions precisely. Do not use tools, commands, network, subagents, or files. Remember only the marker given in this conversation.',
          },
        })
        const pair = await Promise.all([
          createSession(agentId, workspace),
          createSession(agentId, workspace),
        ])
        pair.forEach((session, slot) => {
          session.marker = `LIVE_${index}_${slot}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
        })
        matrix.push(pair)
      }
      const toolAgent = 'tool-cases'
      await rpc('agents.create', {
        agentId: toolAgent,
        definition: {
          name: toolAgent,
          provider: 'model-0',
          model: models[0],
          tools: ['Read', 'Write', 'Edit', 'AskUserQuestion'],
          settings: {
            permissions: {
              defaultMode: 'default',
              ask: ['Read', 'Write', 'Edit', 'AskUserQuestion'],
            },
          },
          systemPrompt:
            'Use only the tools and exact absolute file paths requested. Never use commands, network, subagents, or other paths. Make each requested mutation once; if denied, stop without retries or alternate actions. Preserve literal file content. Answer briefly.',
        },
      })
      const tools = await createSession(
        toolAgent,
        path.join(root, 'server', 'agents', toolAgent, 'workspace'),
      )
      return {
        matrix,
        tools,
        counts: { models: models.length, sessions: sessions.length },
      }
    })
    if (!setup) throw new ValidationError('setup_failed')
    const { matrix, tools } = setup

    for (const [index, pair] of matrix.entries()) {
      const first = `model_${index}_concurrent_first`
      await caseOf(first, ['setup'], async () => {
        const products = [5461, 6533]
        const ids = await Promise.all(
          pair.map((session, slot) =>
            submit(
              session,
              `Remember the exact marker ${session.marker} for future turns. Compute ${slot === 0 ? '127 * 43' : '139 * 47'}. Reply with the marker and numeric answer, then 15 short numbered arithmetic checks. Do not use tools.`,
            ),
          ),
        )
        await Promise.all(
          pair.map((session, slot) => success(session, ids[slot])),
        )
        const events = await Promise.all(pair.map(replay))
        for (const slot of [0, 1]) {
          remember(events[slot], pair[slot].marker, null, pair[1 - slot].marker)
          check(
            compact(assistantText(events[slot]))
              .replaceAll(',', '')
              .includes(String(products[slot])),
            'arithmetic_incorrect',
          )
          pair[slot].instance = await instance(pair[slot])
          pair[slot].pids = (await pidState(pair[slot])).pids
          check(pair[slot].pids.length === 1, 'initial_child_count')
        }
        const windows = events.map(runningWindow)
        check(
          Math.max(windows[0][0], windows[1][0]) <
            Math.min(windows[0][1], windows[1][1]),
          'native_sessions_not_overlapping',
        )
        check(
          pair[0].instance !== pair[1].instance &&
            pair[0].pids[0] !== pair[1].pids[0],
          'native_session_not_independent',
        )
        return { counts: { sessions: 2, runs: 2, independentPids: 2 } }
      })
      const queued = `model_${index}_queued_memory`
      await caseOf(queued, [first], async () => {
        const submitted = await Promise.all(
          pair.map(async session => {
            const second = await submit(
              session,
              'Recall my exact marker from the first turn, print it with the word SECOND, then give 15 brief numbered arithmetic checks. Do not use tools.',
            )
            const third = await submit(
              session,
              'Recall my exact original marker and print it with the word THIRD. Do not use tools.',
            )
            const pending = await rpc('runs.get', { runId: third })
            check(
              pending.status === 'queued' && pending.startedAtMs === null,
              'same_session_queue_not_observed',
            )
            return [second, third]
          }),
        )
        for (const slot of [0, 1]) {
          const [second, third] = await Promise.all(
            submitted[slot].map(id => success(pair[slot], id)),
          )
          const events = await replay(pair[slot])
          remember(
            runEvents(events, second),
            pair[slot].marker,
            'SECOND',
            pair[1 - slot].marker,
          )
          remember(
            runEvents(events, third),
            pair[slot].marker,
            'THIRD',
            pair[1 - slot].marker,
          )
          check(
            third.startedAtMs >= second.finishedAtMs,
            'same_session_execution_overlap',
          )
          check(
            (await instance(pair[slot])) === pair[slot].instance,
            'native_instance_not_reused',
          )
          const pids = (await pidState(pair[slot])).pids
          check(
            pids.length === 1 && pids[0] === pair[slot].pids[0],
            'native_pid_not_reused',
          )
        }
        return { counts: { sessions: 2, runs: 4 } }
      })
    }

    const file = path.join(tools.workspace, 'allowed.txt').replaceAll('\\', '/')
    const denied = path
      .join(tools.workspace, 'denied.txt')
      .replaceAll('\\', '/')
    tools.allowedPaths = new Set([file, denied])
    const original = `alpha-${randomUUID()}\n`
    const edited = original.replace('alpha-', 'beta-')
    function permissionHandler(
      tool,
      expectedInput,
      behavior,
      exerciseIdempotency = false,
    ) {
      const state = { count: 0, readCount: 0 }
      const handler = async (item, family) => {
        if (family !== 'approvals' || item.category !== 'permission')
          return false
        const input = item.request.input
        if (
          item.request.tool_name === 'Read' &&
          behavior === 'allow' &&
          state.count === 1 &&
          state.readCount === 0
        ) {
          if (
            !isFilePath(input?.file_path, expectedInput.file_path) ||
            Object.keys(input).some(key => key !== 'file_path')
          )
            return false
          state.readCount++
          const receipt = await rpc('approvals.respond', {
            sessionId: item.sessionId,
            instanceId: item.instanceId,
            nativeRequestId: item.nativeRequestId,
            response: { type: 'permission', decision: { behavior: 'allow' } },
          })
          check(receipt.delivery === 'sent', 'read_delivery_unconfirmed')
          return true
        }
        if (item.request.tool_name !== tool || state.count !== 0) return false
        if (!isFilePath(input?.file_path, expectedInput.file_path)) return false
        if (Object.keys(input).some(key => !Object.hasOwn(expectedInput, key)))
          return false
        if (
          Object.entries(expectedInput).some(
            ([key, value]) => key !== 'file_path' && input[key] !== value,
          )
        )
          return false
        state.count++
        const params = {
          sessionId: item.sessionId,
          instanceId: item.instanceId,
          nativeRequestId: item.nativeRequestId,
          response: {
            type: 'permission',
            decision:
              behavior === 'allow'
                ? { behavior }
                : {
                    behavior,
                    message: 'This test denies the requested write.',
                    interrupt: false,
                  },
          },
        }
        const receipt = await rpc('approvals.respond', params)
        check(
          receipt.delivery === 'sent' &&
            receipt.nativeApplication === 'unknown',
          'approval_delivery_unconfirmed',
        )
        if (exerciseIdempotency) {
          const repeated = await rpc('approvals.respond', params)
          check(
            JSON.stringify(repeated) === JSON.stringify(receipt),
            'approval_not_idempotent',
          )
          await expectRpcError(
            'approvals.respond',
            {
              ...params,
              response: {
                type: 'permission',
                decision: {
                  behavior: 'deny',
                  message: 'Conflicting decision must not be sent.',
                  interrupt: false,
                },
              },
            },
            'interaction_decision_conflict',
          )
        }
        return true
      }
      return { state, handler }
    }
    function toolOrder(events, expected) {
      const names = blocks(events)
        .filter(block => block.type === 'tool_use')
        .map(block => block.name)
      check(
        names.length === expected.length &&
          names.every((name, index) => name === expected[index]),
        'tool_sequence_mismatch',
      )
      checkToolPaths(events, tools)
    }
    await caseOf(
      'tools_write_read_allow',
      ['model_0_concurrent_first'],
      async () => {
        const approval = permissionHandler(
          'Write',
          { file_path: file, content: original },
          'allow',
          true,
        )
        const run = await success(
          tools,
          await submit(
            tools,
            `Call Write with exactly ${JSON.stringify({ file_path: file, content: original })}, then Read that same absolute path with only file_path, no offset, limit or pages. Do not alter the content or use any other tool/path. Report WRITE_OK after reading.`,
          ),
          approval.handler,
        )
        check(
          approval.state.count === 1 && approval.state.readCount === 1,
          'write_read_approval_missing',
        )
        toolOrder(runEvents(await replay(tools), run), ['Write', 'Read'])
        await fileEquals(file, original)
        tools.instance = await instance(tools)
        tools.pids = (await pidState(tools)).pids
        return {
          counts: {
            allows: 1,
            readAllows: 1,
            idempotentResponses: 1,
            decisionConflicts: 1,
          },
        }
      },
    )
    await caseOf(
      'tools_edit_read_allow',
      ['tools_write_read_allow'],
      async () => {
        const input = {
          file_path: file,
          old_string: original.trimEnd(),
          new_string: edited.trimEnd(),
          replace_all: false,
        }
        const approval = permissionHandler('Edit', input, 'allow')
        const run = await success(
          tools,
          await submit(
            tools,
            `Call Edit with exactly ${JSON.stringify(input)}, explicitly include replace_all:false, then Read the same absolute path with only file_path, no offset, limit or pages. Do not write, retry, or use other paths. Report EDIT_OK after reading.`,
          ),
          approval.handler,
        )
        check(
          approval.state.count === 1 && approval.state.readCount === 1,
          'edit_read_approval_missing',
        )
        toolOrder(runEvents(await replay(tools), run), ['Edit', 'Read'])
        await fileEquals(file, edited)
        return { counts: { allows: 1, readAllows: 1 } }
      },
    )
    await caseOf(
      'tools_deny_write_no_side_effect',
      ['tools_write_read_allow'],
      async () => {
        await absent(denied)
        const approval = permissionHandler(
          'Write',
          { file_path: denied, content: 'DENIED_CONTENT\n' },
          'deny',
        )
        const run = await waitRun(
          tools,
          await submit(
            tools,
            `Attempt Write exactly once with ${JSON.stringify({ file_path: denied, content: 'DENIED_CONTENT\n' })}. If denied, stop and acknowledge the denial; do not retry, read, edit, or use another path.`,
          ),
          approval.handler,
        )
        check(
          ['succeeded', 'failed'].includes(run.status) &&
            approval.state.count === 1,
          'deny_run_not_settled',
        )
        const events = runEvents(await replay(tools), run)
        toolOrder(events, ['Write'])
        check(
          blocks(events).some(
            block => block.type === 'tool_result' && block.is_error === true,
          ),
          'deny_tool_result_missing',
        )
        await absent(denied)
        return { counts: { denies: 1 } }
      },
    )
    await caseOf(
      'tools_question_green',
      ['tools_write_read_allow'],
      async () => {
        let answered = 0
        const question = 'Which color should we use?'
        const handler = async (item, family) => {
          const questions = item.request?.input?.questions
          if (
            family !== 'questions' ||
            item.category !== 'askUserQuestion' ||
            item.request?.tool_name !== 'AskUserQuestion' ||
            answered !== 0 ||
            !Array.isArray(questions) ||
            questions.length !== 1 ||
            questions[0].question !== question ||
            questions[0].multiSelect !== false ||
            questions[0].options?.length !== 2 ||
            !questions[0].options.some(option => option.label === 'Green') ||
            !questions[0].options.some(option => option.label === 'Blue')
          )
            return false
          answered++
          const receipt = await rpc('questions.respond', {
            sessionId: item.sessionId,
            instanceId: item.instanceId,
            nativeRequestId: item.nativeRequestId,
            response: {
              type: 'askUserQuestion',
              answer: { action: 'answer', answers: { [question]: 'Green' } },
            },
          })
          check(receipt.delivery === 'sent', 'question_delivery_unconfirmed')
          return true
        }
        const input = {
          questions: [
            {
              question,
              header: 'Color',
              options: [
                { label: 'Green', description: 'Use green' },
                { label: 'Blue', description: 'Use blue' },
              ],
              multiSelect: false,
            },
          ],
        }
        const run = await success(
          tools,
          await submit(
            tools,
            `Call AskUserQuestion once with exactly ${JSON.stringify(input)}. Wait for the answer, then report the color the user selected. Do not call any file tools.`,
          ),
          handler,
        )
        check(answered === 1, 'question_not_observed')
        const events = runEvents(await replay(tools), run)
        toolOrder(events, ['AskUserQuestion'])
        check(
          /\bgreen\b/i.test(assistantText(events)),
          'question_answer_not_returned',
        )
        check(
          blocks(events).some(
            block =>
              block.type === 'tool_result' &&
              JSON.stringify(block.content).includes('Green'),
          ),
          'question_tool_result_missing',
        )
        return { counts: { answers: 1 } }
      },
    )

    const primary = matrix[0][0]
    await caseOf(
      'queued_cancel_before_send',
      ['model_0_queued_memory'],
      async () => {
        const first = await submit(
          primary,
          'Without tools, list 80 numbered short arithmetic equations, one per line. Complete the list.',
        )
        const cancelled = await submit(
          primary,
          'This queued input must be cancelled before execution.',
        )
        const run = await rpc('runs.cancel', { runId: cancelled })
        check(
          run.status === 'cancelled' && run.reason === 'cancelled_before_send',
          'queued_cancel_not_confirmed',
        )
        await success(primary, first)
        const events = await replay(primary)
        check(
          !nativeEvents(events).some(
            event =>
              event.payload.type === 'user' &&
              event.payload.uuid === run.messageId,
          ),
          'cancelled_input_acknowledged',
        )
        return { counts: { cancelledBeforeSend: 1 } }
      },
    )
    await caseOf(
      'active_cancel_and_reuse',
      ['queued_cancel_before_send'],
      async () => {
        const cursor = live.length
        const id = await submit(
          primary,
          'Without tools, output 3000 numbered lines of simple arithmetic equations. Start immediately and continue until all 3000 lines are complete; do not summarize.',
        )
        await until(async () => {
          const events = live
            .slice(cursor)
            .filter(event => event.sessionId === primary.id)
          const running = events.some(
            event =>
              event.kind === 'native.message' &&
              event.payload.subtype === 'session_state_changed' &&
              event.payload.state === 'running',
          )
          const delta = events.some(
            event =>
              event.kind === 'native.message' &&
              event.payload.type === 'stream_event' &&
              event.payload.event?.type === 'content_block_delta' &&
              Object.entries(event.payload.event.delta ?? {}).some(
                ([key, value]) =>
                  key !== 'type' &&
                  typeof value === 'string' &&
                  value.length > 0,
              ),
          )
          const run = await rpc('runs.get', { runId: id })
          check(!terminal(run), 'cancel_stream_finished_before_request')
          return running && delta
        }, 'cancel_stream_delta_deadline')
        await rpc('runs.cancel', { runId: id })
        const run = await waitRun(primary, id)
        check(
          run.status === 'cancelled' &&
            run.reason === 'native_interruption_observed',
          'active_cancel_not_observed',
        )
        const recovered = await success(
          primary,
          await submit(
            primary,
            'Recall the original marker and reply with it and RECOVERED. Do not use tools.',
          ),
        )
        remember(
          runEvents(await replay(primary), recovered),
          primary.marker,
          'RECOVERED',
        )
        check(
          (await instance(primary)) === primary.instance,
          'cancel_instance_not_reused',
        )
        const pids = (await pidState(primary)).pids
        check(
          pids.length === 1 && pids[0] === primary.pids[0],
          'cancel_pid_not_reused',
        )
        return { counts: { interrupted: 1, recoveryRuns: 1 } }
      },
    )

    for (const [index, pair] of matrix.entries()) {
      await caseOf(
        `model_${index}_history_close_resume`,
        [
          `model_${index}_queued_memory`,
          ...(index === 0 ? ['active_cancel_and_reuse'] : []),
        ],
        async () => {
          const session = pair[0]
          const history = []
          let offset = 0
          let total
          let pages = 0
          while (true) {
            const page = await rpc('sessions.get', {
              sessionId: session.id,
              history: true,
              offset,
              limit: 2,
            })
            total ??= page.history.total
            check(
              page.history.total === total &&
                Array.isArray(page.history.messages),
              'history_page_changed',
            )
            history.push(...page.history.messages)
            pages++
            if (page.history.nextOffset === null) break
            check(page.history.nextOffset > offset, 'history_cursor_stalled')
            offset = page.history.nextOffset
          }
          check(
            pages > 1 &&
              history.length === total &&
              new Set(history.map(message => message.uuid)).size === total,
            'history_pagination_mismatch',
          )
          check(
            JSON.stringify(history).includes(session.marker),
            'history_marker_missing',
          )
          for (const id of session.runs.slice(0, 3)) {
            const run = await rpc('runs.get', { runId: id })
            check(
              history.some(message => message.uuid === run.messageId),
              'history_input_missing',
            )
          }
          await audit(session)
          check(
            (await rpc('sessions.close', { sessionId: session.id })).status ===
              'closed',
            'close_not_closed',
          )
          check(
            (await rpc('sessions.native', { sessionId: session.id }))
              .instanceId === null,
            'closed_instance_present',
          )
          await expectRpcError(
            'runs.submit',
            {
              sessionId: session.id,
              content: 'This closed-session input must be rejected.',
            },
            'session_closed',
          )
          check(
            (await rpc('sessions.resume', { sessionId: session.id })).status ===
              'open',
            'resume_not_open',
          )
          check(
            (await rpc('sessions.native', { sessionId: session.id }))
              .instanceId === null,
            'resume_launched_early',
          )
          const run = await success(
            session,
            await submit(
              session,
              'Recall the exact original marker from before the session closed, and reply with it and RESUMED. Do not use tools.',
            ),
          )
          remember(
            runEvents(await replay(session), run),
            session.marker,
            'RESUMED',
            pair[1].marker,
          )
          check(
            (await instance(session)) !== session.instance,
            'resume_instance_not_replaced',
          )
          const pids = (await pidState(session)).pids
          check(
            pids.length === 2 &&
              pids[0] === session.pids[0] &&
              pids[0] !== pids[1],
            'resume_pid_not_replaced',
          )
          return {
            counts: {
              historyPages: pages,
              historyMessages: total,
              resumedRuns: 1,
            },
          }
        },
      )
    }
  } catch (error) {
    if (!results.has('setup') || results.get('setup').status === 'passed') {
      const failure = {
        name: 'suite_control',
        status: 'failed',
        error: safeError(error),
      }
      report.cases.push(failure)
    }
  } finally {
    for (const [index, session] of sessions.entries()) {
      try {
        await caseOf(`session_${index}_wire_usage_audit`, [], async () => {
          const result = await audit(session)
          checkToolPaths(await replay(session), session)
          return result
        })
      } finally {
        await caseOf(`session_${index}_cleanup`, [], async () => {
          check(
            (await rpc('sessions.close', { sessionId: session.id })).status ===
              'closed',
            'cleanup_not_closed',
          )
        })
      }
    }
    report.thinking.blocks = sessions.reduce(
      (sum, session) => sum + (session.audit?.counts.thinkingBlocks ?? 0),
      0,
    )
    report.thinking.chars = sessions.reduce(
      (sum, session) => sum + (session.audit?.counts.thinkingChars ?? 0),
      0,
    )
    report.thinking.status =
      report.thinking.chars > 0 ? 'observed' : 'notObserved'
    await caseOf('thinking_requirement', ['setup'], async () => {
      if (process.env.MATCHA_TEST_REQUIRE_THINKING === '1')
        check(report.thinking.chars > 0, 'required_thinking_not_observed')
      return { counts: { observedBlocks: report.thinking.blocks } }
    })
    if (socket) socket.close()
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer)
      pending.reject(new ValidationError('suite_closed'))
    }
    waiting.clear()
    report.status = report.cases.some(result => result.status === 'failed')
      ? 'failed'
      : 'passed'
    await writeFile(
      path.join(root, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    )
    console.log(
      JSON.stringify({
        status: report.status,
        cases: report.cases.map(({ name, status, error }) => ({
          name,
          status,
          error,
        })),
        thinking: report.thinking,
      }),
    )
    process.exitCode = report.status === 'passed' ? 0 : 1
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    process.exitCode = 1
  })
}
