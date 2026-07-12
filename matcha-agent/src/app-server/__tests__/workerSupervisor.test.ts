import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { SpawnOptionsWithoutStdio } from 'node:child_process'
import type { WorkerFrame } from '../protocol/types.js'
import { encodeWorkerFrame } from '../workers/workerProtocol.js'
import type { WorkerSupervisorSession } from '../workers/workerSupervisor.js'
import {
  classifyWorkerInitializationError,
  WorkerSupervisor,
} from '../workers/workerSupervisor.js'
import type {
  WorkerChildProcess,
  WorkerProcessSpawn,
} from '../workers/workerProcess.js'

class WritableSink extends Writable {
  readonly chunks: string[] = []
  endCount = 0

  override end(cb?: () => void): this
  override end(chunk: unknown, cb?: () => void): this
  override end(
    chunk: unknown,
    encoding: BufferEncoding,
    cb?: () => void,
  ): this
  override end(
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): this {
    this.endCount += 1
    if (typeof encodingOrCallback === 'function') {
      return super.end(chunk, encodingOrCallback)
    }
    if (encodingOrCallback) {
      return super.end(chunk, encodingOrCallback, callback)
    }
    return chunk === undefined ? super.end(callback) : super.end(chunk, callback)
  }

  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
    callback()
  }
}

type FakeChild = WorkerChildProcess & {
  readonly assignedWorkerId: string
  killCount: number
  stdinEndCount(): number
  emitFrame(frame: WorkerFrame): void
  emitStderr(chunk: string): void
  emitExit(exitCode: number | null, signal: NodeJS.Signals | null): void
  writtenInput(): string
}

function createFakeChild(assignedWorkerId: string): FakeChild {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new WritableSink()
  const child = Object.assign(emitter, {
    stdout,
    stderr,
    stdin,
    pid: 12345,
    assignedWorkerId,
    killCount: 0,
    kill: () => true,
    emitFrame: (frame: WorkerFrame) => {
      stdout.emit('data', Buffer.from(encodeWorkerFrame(frame), 'utf8'))
    },
    emitStderr: (chunk: string) => {
      stderr.emit('data', Buffer.from(chunk, 'utf8'))
    },
    emitExit: (exitCode: number | null, signal: NodeJS.Signals | null) => {
      emitter.emit('exit', exitCode, signal)
    },
    stdinEndCount: () => stdin.endCount,
    writtenInput: () => stdin.chunks.join(''),
  })
  child.kill = () => {
    child.killCount += 1
    return true
  }
  return child
}

const children: FakeChild[] = []

const spawnFakeChild: WorkerProcessSpawn = (
  _command: string,
  _args: string[],
  options: SpawnOptionsWithoutStdio,
): WorkerChildProcess => {
  const assignedWorkerId = String(options.env?.MATCHA_AGENT_WORKER_ID ?? '')
  const child = createFakeChild(assignedWorkerId)
  children.push(child)
  return child
}

function createRequestIdFactory(): () => string {
  let nextRequestId = 0
  return () => {
    nextRequestId += 1
    return `request-${nextRequestId}`
  }
}

function testSession(sessionId = 'session-1'): WorkerSupervisorSession {
  return { sessionId, cwd: 'E:/workspace' }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function emitInitializedWorker(
  child: FakeChild,
  requestId = 'request-1',
): void {
  child.emitFrame({
    type: 'worker.ready',
    workerId: child.assignedWorkerId,
    pid: 12345,
  })
  child.emitFrame({
    id: requestId,
    ok: true,
    result: { workerId: child.assignedWorkerId, pid: 12345 },
  })
}

afterEach(() => {
  children.length = 0
})

describe('WorkerSupervisor', () => {
  test('kills and reports one crash when heartbeat times out', async () => {
    const crashes: Array<{ sessionId: string; workerId: string }> = []
    const supervisor = new WorkerSupervisor({
      command: 'fake-worker',
      requestTimeoutMs: 100,
      heartbeatTimeoutMs: 20,
      spawnWorker: spawnFakeChild,
      createRequestId: createRequestIdFactory(),
      ports: {
        onCrash: event => {
          crashes.push({ sessionId: event.sessionId, workerId: event.workerId })
        },
      },
    })

    const ensurePromise = supervisor.ensureWorker(testSession())
    emitInitializedWorker(children[0]!)
    await ensurePromise

    await sleep(35)

    expect(children[0]?.killCount).toBe(1)
    expect(crashes).toHaveLength(1)
    expect(crashes[0]?.sessionId).toBe('session-1')
    expect(crashes[0]?.workerId).toBe(children[0]?.assignedWorkerId)

    children[0]?.emitExit(1, null)
    expect(crashes).toHaveLength(1)
  })

  test('heartbeat resets the timeout window', async () => {
    const crashes: Array<{ sessionId: string; workerId: string }> = []
    const supervisor = new WorkerSupervisor({
      command: 'fake-worker',
      requestTimeoutMs: 100,
      heartbeatTimeoutMs: 30,
      spawnWorker: spawnFakeChild,
      createRequestId: createRequestIdFactory(),
      ports: {
        onCrash: event => {
          crashes.push({ sessionId: event.sessionId, workerId: event.workerId })
        },
      },
    })

    const ensurePromise = supervisor.ensureWorker(testSession())
    emitInitializedWorker(children[0]!)
    await ensurePromise

    await sleep(20)
    children[0]?.emitFrame({
      type: 'worker.heartbeat',
      workerId: children[0].assignedWorkerId,
    })
    await sleep(20)

    expect(crashes).toHaveLength(0)
    expect(children[0]?.killCount).toBe(0)

    await sleep(20)

    expect(crashes).toHaveLength(1)
    expect(children[0]?.killCount).toBe(1)
  })

  test('shutdown clears heartbeat timer', async () => {
    const crashes: Array<{ sessionId: string; workerId: string }> = []
    const supervisor = new WorkerSupervisor({
      command: 'fake-worker',
      requestTimeoutMs: 100,
      heartbeatTimeoutMs: 20,
      spawnWorker: spawnFakeChild,
      createRequestId: createRequestIdFactory(),
      ports: {
        onCrash: event => {
          crashes.push({ sessionId: event.sessionId, workerId: event.workerId })
        },
      },
    })

    const ensurePromise = supervisor.ensureWorker(testSession())
    emitInitializedWorker(children[0]!)
    await ensurePromise

    const shutdownPromise = supervisor.shutdownSession('session-1')
    children[0]?.emitFrame({ id: 'request-2', ok: true })
    await shutdownPromise
    await sleep(35)

    expect(crashes).toHaveLength(0)
    expect(children[0]?.killCount).toBe(0)
  })

  test('waits for worker exit after its shutdown response', async () => {
    const supervisor = new WorkerSupervisor({
      command: 'fake-worker',
      requestTimeoutMs: 100,
      shutdownTimeoutMs: 100,
      spawnWorker: spawnFakeChild,
      createRequestId: createRequestIdFactory(),
    })

    const ensurePromise = supervisor.ensureWorker(testSession())
    emitInitializedWorker(children[0]!)
    await ensurePromise

    let shutdownComplete = false
    const shutdownPromise = supervisor.shutdownSession('session-1').then(() => {
      shutdownComplete = true
    })
    children[0]?.emitFrame({ id: 'request-2', ok: true })
    await sleep(0)

    expect(children[0]?.stdinEndCount()).toBe(1)
    expect(shutdownComplete).toBe(false)

    children[0]?.emitExit(0, null)
    await shutdownPromise

    expect(shutdownComplete).toBe(true)
  })

  test('kills a worker that does not exit before the shutdown deadline', async () => {
    const supervisor = new WorkerSupervisor({
      command: 'fake-worker',
      requestTimeoutMs: 100,
      shutdownTimeoutMs: 5,
      spawnWorker: spawnFakeChild,
      createRequestId: createRequestIdFactory(),
    })

    const ensurePromise = supervisor.ensureWorker(testSession())
    emitInitializedWorker(children[0]!)
    await ensurePromise

    const shutdownPromise = supervisor.shutdownSession('session-1')
    children[0]?.emitFrame({ id: 'request-2', ok: true })
    await sleep(10)

    expect(children[0]?.killCount).toBe(1)
    children[0]?.emitExit(null, 'SIGTERM')
    await shutdownPromise
  })

  test('ignores late worker frames after shutdown removes the session worker', async () => {
    const events: WorkerFrame[] = []
    const supervisor = new WorkerSupervisor({
      command: 'fake-worker',
      requestTimeoutMs: 100,
      spawnWorker: spawnFakeChild,
      createRequestId: createRequestIdFactory(),
      ports: {
        onWorkerReady: event => {
          events.push({
            type: 'worker.ready',
            workerId: event.workerId,
            pid: event.pid,
          })
        },
        onEvent: event => {
          events.push({ type: 'event', runId: event.runId, event: event.event })
        },
      },
    })

    const ensurePromise = supervisor.ensureWorker(testSession())
    emitInitializedWorker(children[0]!)
    await ensurePromise
    events.length = 0

    const shutdownPromise = supervisor.shutdownSession('session-1')
    children[0]?.emitFrame({ id: 'request-2', ok: true })
    await shutdownPromise

    children[0]?.emitFrame({
      type: 'worker.ready',
      workerId: children[0]?.assignedWorkerId ?? '',
      pid: 12345,
    })
    children[0]?.emitFrame({
      type: 'event',
      event: {
        type: 'message.delta',
        messageId: 'late-message',
        delta: 'late',
      },
    })

    expect(events).toEqual([])
  })

  test('reports protocol error and kills worker when notification workerId mismatches assignment', async () => {
    const protocolErrors: Array<{
      workerId: string
      message: string
      raw: string
    }> = []
    const heartbeats: Array<{ workerId: string }> = []
    const supervisor = new WorkerSupervisor({
      command: 'fake-worker',
      requestTimeoutMs: 100,
      spawnWorker: spawnFakeChild,
      createRequestId: createRequestIdFactory(),
      ports: {
        onProtocolError: event => {
          protocolErrors.push({
            workerId: event.workerId,
            message: event.error.message,
            raw: event.raw,
          })
        },
        onHeartbeat: event => {
          heartbeats.push({ workerId: event.workerId })
        },
      },
    })

    const ensurePromise = supervisor.ensureWorker(testSession())
    emitInitializedWorker(children[0]!)
    await ensurePromise

    children[0]?.emitFrame({
      type: 'worker.heartbeat',
      workerId: 'worker-other',
    })

    expect(protocolErrors).toHaveLength(1)
    expect(protocolErrors[0]?.workerId).toBe(children[0]?.assignedWorkerId)
    expect(protocolErrors[0]?.message).toContain('identity mismatch')
    expect(protocolErrors[0]?.raw).toContain('worker-other')
    expect(children[0]?.killCount).toBe(1)
    expect(supervisor.getWorker('session-1')).toBeUndefined()
    expect(heartbeats).toHaveLength(0)
  })

  test('preserves classified initialize response errors', async () => {
    const supervisor = new WorkerSupervisor({
      command: 'fake-worker',
      requestTimeoutMs: 100,
      spawnWorker: spawnFakeChild,
      createRequestId: createRequestIdFactory(),
    })

    const ensurePromise = supervisor.ensureWorker(testSession())
    children[0]?.emitFrame({
      id: 'request-1',
      ok: false,
      error: {
        type: 'internal',
        message: 'Cannot find package @claude-code-best/builtin-tools',
        retryable: false,
      },
    })

    await expect(ensurePromise).rejects.toThrow(
      'Cannot find package @claude-code-best/builtin-tools',
    )
    try {
      await ensurePromise
    } catch (error) {
      expect(classifyWorkerInitializationError(error)).toEqual({
        type: 'internal',
        message: 'Cannot find package @claude-code-best/builtin-tools',
        retryable: false,
      })
    }
    expect(children[0]?.killCount).toBe(1)
    expect(supervisor.getWorker('session-1')).toBeUndefined()
  })

  test('rejects initialize response when result workerId mismatches assignment', async () => {
    const protocolErrors: Array<{
      workerId: string
      message: string
      raw: string
    }> = []
    const supervisor = new WorkerSupervisor({
      command: 'fake-worker',
      requestTimeoutMs: 100,
      spawnWorker: spawnFakeChild,
      createRequestId: createRequestIdFactory(),
      ports: {
        onProtocolError: event => {
          protocolErrors.push({
            workerId: event.workerId,
            message: event.error.message,
            raw: event.raw,
          })
        },
      },
    })

    const ensurePromise = supervisor.ensureWorker(testSession())
    children[0]?.emitFrame({
      id: 'request-1',
      ok: true,
      result: { workerId: 'worker-other', pid: 12345 },
    })

    await expect(ensurePromise).rejects.toThrow('identity mismatch')
    expect(protocolErrors).toHaveLength(1)
    expect(protocolErrors[0]?.workerId).toBe(children[0]?.assignedWorkerId)
    expect(protocolErrors[0]?.raw).toContain('worker-other')
    expect(children[0]?.killCount).toBe(1)
    expect(supervisor.getWorker('session-1')).toBeUndefined()
  })
})
