import { describe, expect, test } from 'bun:test'
import type { WorkerCommand } from '../protocol/types.js'
import {
  encodeWorkerCommand,
  encodeWorkerFrame,
  isWorkerFrame,
  NdjsonFrameParser,
} from '../workers/workerProtocol.js'

const classifiedError = {
  type: 'worker' as const,
  message: 'Worker failed',
  retryable: true,
}

const usage = {
  inputTokens: 1,
  outputTokens: 2,
  cachedReadTokens: 3,
  cachedWriteTokens: 4,
  totalTokens: 10,
}

describe('worker protocol NDJSON helpers', () => {
  test('encodes commands and frames as single NDJSON lines', () => {
    const command: WorkerCommand = {
      id: 'cmd-1',
      type: 'session.flush',
    }

    expect(encodeWorkerCommand(command)).toBe(
      '{"id":"cmd-1","type":"session.flush"}\n',
    )
    expect(encodeWorkerFrame({ id: 'cmd-1', ok: true })).toBe(
      '{"id":"cmd-1","ok":true}\n',
    )
  })

  test('parses split chunks, multiple frames, and skips empty lines', () => {
    const parser = new NdjsonFrameParser<{ kind: string }>()

    expect(parser.push('{"kind":"a"')).toEqual([])
    expect(parser.push('}\n\n{"kind":"b"}\n')).toEqual([
      { frame: { kind: 'a' } },
      { frame: { kind: 'b' } },
    ])
  })

  test('reports invalid JSON without dropping following frames', () => {
    const parser = new NdjsonFrameParser<{ kind: string }>()
    const results = parser.push('{bad}\n{"kind":"ok"}\n')

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ raw: '{bad}' })
    expect(results[1]).toEqual({ frame: { kind: 'ok' } })
  })

  test('flush parses buffered tail and reports invalid tail', () => {
    const validParser = new NdjsonFrameParser<{ kind: string }>()
    validParser.push('{"kind":"tail"}')
    expect(validParser.flush()).toEqual([{ frame: { kind: 'tail' } }])

    const invalidParser = new NdjsonFrameParser<{ kind: string }>()
    invalidParser.push('{tail')
    expect(invalidParser.flush()[0]).toMatchObject({ raw: '{tail' })
  })

  test('recognizes worker responses and known worker notifications only', () => {
    expect(
      isWorkerFrame({ id: 'cmd-1', ok: false, error: classifiedError }),
    ).toBe(true)
    expect(
      isWorkerFrame({ type: 'worker.ready', workerId: 'worker-1', pid: 123 }),
    ).toBe(true)
    expect(
      isWorkerFrame({ type: 'worker.heartbeat', workerId: 'worker-1' }),
    ).toBe(true)
    expect(
      isWorkerFrame({
        type: 'event',
        runId: 'run-1',
        event: { type: 'run.started', runId: 'run-1', workerId: 'worker-1' },
      }),
    ).toBe(true)
    expect(
      isWorkerFrame({
        type: 'event',
        runId: 'run-1',
        event: {
          type: 'run.trace',
          runId: 'run-1',
          workerId: 'worker-1',
          stage: 'api.stream.first_chunk',
          details: { requestId: 'req-1', enabled: true },
        },
      }),
    ).toBe(true)
    expect(
      isWorkerFrame({
        type: 'approval.request',
        request: {
          approvalId: 'approval-1',
          runId: 'run-1',
          toolCallId: 'tool-1',
          toolName: 'Bash',
          prompt: 'Allow?',
          input: {},
          options: [
            {
              optionId: 'allow',
              label: 'Allow',
              kind: 'allow_once',
            },
          ],
        },
      }),
    ).toBe(true)
    expect(
      isWorkerFrame({
        type: 'run.completed',
        runId: 'run-1',
        stopReason: 'end_turn',
        usage,
      }),
    ).toBe(true)
    expect(
      isWorkerFrame({
        type: 'run.failed',
        runId: 'run-1',
        error: classifiedError,
      }),
    ).toBe(true)
    expect(
      isWorkerFrame({ type: 'worker.fatal', error: classifiedError }),
    ).toBe(true)
    expect(isWorkerFrame({ type: 'worker.mystery' })).toBe(false)
    expect(isWorkerFrame({ id: 'cmd-1' })).toBe(false)
  })

  test('rejects malformed responses and notifications', () => {
    expect(isWorkerFrame({ id: 'cmd-1', ok: false })).toBe(false)
    expect(
      isWorkerFrame({ type: 'worker.ready', workerId: 'worker-1', pid: '123' }),
    ).toBe(false)
    expect(isWorkerFrame({ type: 'worker.heartbeat' })).toBe(false)
    expect(isWorkerFrame({ type: 'event', event: { runId: 'run-1' } })).toBe(
      false,
    )
    expect(
      isWorkerFrame({
        type: 'event',
        event: { type: 'run.trace', runId: 'run-1' },
      }),
    ).toBe(false)
    expect(
      isWorkerFrame({
        type: 'event',
        event: { type: 'run.trace', runId: 'run-1', stage: 1 },
      }),
    ).toBe(false)
    expect(
      isWorkerFrame({
        type: 'event',
        event: {
          type: 'run.trace',
          runId: 'run-1',
          stage: 'api.stream.first_chunk',
          details: { nested: { requestId: 'req-1' } },
        },
      }),
    ).toBe(false)
    expect(
      isWorkerFrame({
        type: 'approval.request',
        request: { runId: 'run-1', options: [] },
      }),
    ).toBe(false)
    expect(
      isWorkerFrame({
        type: 'run.completed',
        runId: 'run-1',
        stopReason: 'unknown',
      }),
    ).toBe(false)
    expect(isWorkerFrame({ type: 'run.failed', runId: 'run-1' })).toBe(false)
    expect(isWorkerFrame({ type: 'worker.fatal', error: 'fatal' })).toBe(false)
  })
})
