import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { SpawnOptionsWithoutStdio } from 'node:child_process'
import type { WorkerCommand } from '../protocol/types.js'
import { runWorkerEntry } from '../workers/workerEntry.js'
import { WorkerProcess } from '../workers/workerProcess.js'
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
  killCount: number
  stdinEndCount(): number
  emitStdout(chunk: string): void
  emitStderr(chunk: string): void
  emitExit(exitCode: number | null, signal: NodeJS.Signals | null): void
  writtenInput(): string
}

function createFakeChild(): FakeChild {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new WritableSink()
  const child = Object.assign(emitter, {
    stdout,
    stderr,
    stdin,
    pid: 12345,
    killCount: 0,
    kill: () => true,
    emitStdout: (chunk: string) => {
      stdout.emit('data', Buffer.from(chunk, 'utf8'))
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

function spawnFakeChild(
  _command: string,
  _args: string[],
  _options: SpawnOptionsWithoutStdio,
): WorkerChildProcess {
  const child = createFakeChild()
  children.push(child)
  return child
}

function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function flushCommand(id: string): WorkerCommand {
  return { id, type: 'session.flush' }
}

class BackpressuredWriteStream extends Writable {
  readonly chunks: string[] = []
  private writesUntilBackpressure: number

  constructor(writesUntilBackpressure: number) {
    super()
    this.writesUntilBackpressure = writesUntilBackpressure
  }

  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
    callback()
  }

  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const didWrite =
      typeof encodingOrCallback === 'string'
        ? super.write(chunk, encodingOrCallback, callback)
        : super.write(chunk, encodingOrCallback)
    if (!didWrite) return false
    if (this.writesUntilBackpressure <= 0) return true

    this.writesUntilBackpressure -= 1
    return this.writesUntilBackpressure > 0
  }
}

class ReadableInput extends PassThrough {
  closeInput(): void {
    this.end()
  }
}

afterEach(() => {
  children.length = 0
})

describe('WorkerProcess', () => {
  test('writes commands and resolves the matching response', async () => {
    const worker = new WorkerProcess({
      workerId: 'worker-1',
      command: 'fake-worker',
      requestTimeoutMs: 100,
      spawnWorker: spawnFakeChild as WorkerProcessSpawn,
    })

    const responsePromise = worker.send(flushCommand('cmd-1'))
    await flushMicrotasks()
    expect(children[0]?.writtenInput()).toBe(
      '{"id":"cmd-1","type":"session.flush"}\n',
    )

    children[0]?.emitStdout(
      '{"id":"cmd-1","ok":true,"result":{"flushed":true}}\n',
    )
    await expect(responsePromise).resolves.toEqual({
      id: 'cmd-1',
      ok: true,
      result: { flushed: true },
    })
  })

  test('routes notifications without resolving pending requests', async () => {
    const frames: unknown[] = []
    const worker = new WorkerProcess({
      workerId: 'worker-1',
      command: 'fake-worker',
      requestTimeoutMs: 100,
      spawnWorker: spawnFakeChild as WorkerProcessSpawn,
      onFrame: frame => {
        frames.push(frame)
      },
    })

    const responsePromise = worker.send(flushCommand('cmd-1'))
    children[0]?.emitStdout(
      '{"type":"worker.heartbeat","workerId":"worker-1"}\n',
    )
    children[0]?.emitStdout('{"id":"cmd-1","ok":true}\n')

    await expect(responsePromise).resolves.toEqual({ id: 'cmd-1', ok: true })
    expect(frames).toEqual([{ type: 'worker.heartbeat', workerId: 'worker-1' }])
  })

  test('reports malformed worker frames without routing notifications', () => {
    const frames: unknown[] = []
    const protocolErrors: Array<{ message: string; raw: string }> = []
    const worker = new WorkerProcess({
      workerId: 'worker-1',
      command: 'fake-worker',
      requestTimeoutMs: 100,
      spawnWorker: spawnFakeChild as WorkerProcessSpawn,
      onFrame: frame => {
        frames.push(frame)
      },
      onParseError: (error, raw) => {
        protocolErrors.push({ message: error.message, raw })
      },
    })

    children[0]?.emitStdout('{"type":"worker.heartbeat"}\n')

    expect(frames).toEqual([])
    expect(protocolErrors).toEqual([
      {
        message: 'Worker stdout frame has unknown shape',
        raw: '{"type":"worker.heartbeat"}',
      },
    ])
  })

  test('rejects pending requests on timeout and close', async () => {
    const worker = new WorkerProcess({
      workerId: 'worker-1',
      command: 'fake-worker',
      requestTimeoutMs: 5,
      spawnWorker: spawnFakeChild as WorkerProcessSpawn,
    })

    await expect(worker.send(flushCommand('timeout'))).rejects.toThrow(
      'timed out',
    )

    const closePromise = worker.send(flushCommand('close'))
    const workerClosePromise = worker.close('closing worker')
    children[0]?.emitExit(0, null)
    await workerClosePromise
    await expect(closePromise).rejects.toThrow('closing worker')
  })

  test('waits for child exit after closing stdin', async () => {
    const worker = new WorkerProcess({
      workerId: 'worker-1',
      command: 'fake-worker',
      requestTimeoutMs: 100,
      spawnWorker: spawnFakeChild as WorkerProcessSpawn,
    })

    let closed = false
    const closePromise = worker.close().then(() => {
      closed = true
    })
    await flushMicrotasks()

    expect(children[0]?.stdinEndCount()).toBe(1)
    expect(closed).toBe(false)

    children[0]?.emitExit(0, null)
    await closePromise

    expect(closed).toBe(true)
  })

  test('kills a closing worker that has not exited yet', async () => {
    const worker = new WorkerProcess({
      workerId: 'worker-1',
      command: 'fake-worker',
      requestTimeoutMs: 100,
      spawnWorker: spawnFakeChild as WorkerProcessSpawn,
    })

    const closePromise = worker.close()
    worker.kill()

    expect(children[0]?.killCount).toBe(1)
    children[0]?.emitExit(null, 'SIGTERM')
    await closePromise
  })

  test('keeps stderr tail bounded', () => {
    const worker = new WorkerProcess({
      workerId: 'worker-1',
      command: 'fake-worker',
      requestTimeoutMs: 100,
      stderrTailBytes: 6,
      spawnWorker: spawnFakeChild as WorkerProcessSpawn,
    })

    children[0]?.emitStderr('abcdef')
    children[0]?.emitStderr('ghijk')

    expect(
      Buffer.byteLength(worker.getStderrTail(), 'utf8'),
    ).toBeLessThanOrEqual(6)
    expect(worker.getStderrTail()).toBe('fghijk')
  })

  test('rejects pending requests when stdout frame exceeds the buffer limit', async () => {
    const protocolErrors: string[] = []
    const worker = new WorkerProcess({
      workerId: 'worker-1',
      command: 'fake-worker',
      requestTimeoutMs: 100,
      stdoutMaxFrameBytes: 4,
      spawnWorker: spawnFakeChild as WorkerProcessSpawn,
      onParseError: error => {
        protocolErrors.push(error.message)
      },
    })

    const responsePromise = worker.send(flushCommand('cmd-1'))
    children[0]?.emitStdout('abcde')

    await expect(responsePromise).rejects.toThrow('exceeded 4 bytes')
    expect(protocolErrors).toEqual([
      'Worker stdout frame exceeded 4 bytes without a newline',
    ])
  })

  test('flushes a complete stdout tail before child exit', async () => {
    const worker = new WorkerProcess({
      workerId: 'worker-1',
      command: 'fake-worker',
      requestTimeoutMs: 100,
      spawnWorker: spawnFakeChild as WorkerProcessSpawn,
    })

    const responsePromise = worker.send(flushCommand('cmd-1'))
    children[0]?.emitStdout('{"id":"cmd-1","ok":true}')
    children[0]?.emitExit(0, null)

    await expect(responsePromise).resolves.toEqual({ id: 'cmd-1', ok: true })
  })

  test('reports an invalid stdout tail before child exit', () => {
    const protocolErrors: Array<{ message: string; raw: string }> = []
    const worker = new WorkerProcess({
      workerId: 'worker-1',
      command: 'fake-worker',
      requestTimeoutMs: 100,
      spawnWorker: spawnFakeChild as WorkerProcessSpawn,
      onParseError: (error, raw) => {
        protocolErrors.push({ message: error.message, raw })
      },
    })

    children[0]?.emitStdout('{not-json')
    children[0]?.emitExit(0, null)

    expect(protocolErrors).toHaveLength(1)
    expect(protocolErrors[0]?.raw).toBe('{not-json')
  })

  test('rejects pending requests when child exits', async () => {
    const exits: unknown[] = []
    const worker = new WorkerProcess({
      workerId: 'worker-1',
      command: 'fake-worker',
      requestTimeoutMs: 100,
      spawnWorker: spawnFakeChild as WorkerProcessSpawn,
      onExit: exit => {
        exits.push(exit)
      },
    })

    const responsePromise = worker.send(flushCommand('cmd-1'))
    children[0]?.emitStderr('last error')
    children[0]?.emitExit(1, null)

    await expect(responsePromise).rejects.toThrow(
      'exited before completing pending requests',
    )
    expect(exits).toEqual([
      {
        workerId: 'worker-1',
        exitCode: 1,
        signal: undefined,
        stderrTail: 'last error',
      },
    ])
  })

  test('worker entry waits for stdout drain before writing the next frame', async () => {
    const stdin = new ReadableInput()
    const stdout = new BackpressuredWriteStream(1)
    const stderr = new WritableSink()
    const workerEntryPromise = runWorkerEntry({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      heartbeatIntervalMs: 60_000,
    })

    stdin.write('{bad}\n{bad-again}\n')
    await flushMicrotasks()

    expect(stdout.chunks).toHaveLength(1)
    expect(stdout.chunks[0]).toContain('worker.fatal')

    stdout.emit('drain')
    await flushMicrotasks()

    expect(stdout.chunks).toHaveLength(2)
    expect(stdout.chunks[1]).toContain('worker.fatal')

    stdin.closeInput()
    await workerEntryPromise
  })
})
