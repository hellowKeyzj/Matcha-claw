import { spawn } from 'node:child_process'
import type { SpawnOptionsWithoutStdio } from 'node:child_process'
import type {
  WorkerCommand,
  WorkerFrame,
  WorkerResponse,
} from '../protocol/types.js'
import {
  encodeWorkerCommand,
  isWorkerFrame,
  NdjsonFrameParser,
} from './workerProtocol.js'
import { classifyWorkerError, errorToMessage } from './workerErrors.js'

export type WorkerProcessSpawnOptions = {
  command: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export type WorkerProcessOptions = WorkerProcessSpawnOptions & {
  workerId: string
  requestTimeoutMs: number
  stderrTailBytes?: number
  stdoutMaxFrameBytes?: number
  spawnWorker?: WorkerProcessSpawn
  onFrame?: (frame: Exclude<WorkerFrame, WorkerResponse>) => void
  onParseError?: (error: Error, raw: string) => void
  onExit?: (exit: WorkerProcessExit) => void
}

export type WorkerProcessExit = {
  workerId: string
  exitCode?: number
  signal?: string
  stderrTail: string
}

export type WorkerChildProcess = {
  pid?: number
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  stdin: NodeJS.WritableStream
  on(event: 'error', listener: (error: Error) => void): WorkerChildProcess
  on(
    event: 'exit',
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): WorkerChildProcess
  kill(): boolean
}

export type WorkerProcessSpawn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => WorkerChildProcess

type PendingRequest = {
  resolve: (response: WorkerResponse) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const DEFAULT_STDERR_TAIL_BYTES = 64 * 1024
const DEFAULT_STDOUT_MAX_FRAME_BYTES = 1024 * 1024

export class WorkerProcess {
  readonly workerId: string
  private readonly requestTimeoutMs: number
  private readonly stderrTailBytes: number
  private readonly stdoutMaxFrameBytes: number
  private stdoutPendingBytes = 0
  private readonly onFrame?: (
    frame: Exclude<WorkerFrame, WorkerResponse>,
  ) => void
  private readonly onParseError?: (error: Error, raw: string) => void
  private readonly onExit?: (exit: WorkerProcessExit) => void
  private readonly parser = new NdjsonFrameParser<WorkerFrame>()
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly child: WorkerChildProcess
  private readonly exited: Promise<void>
  private resolveExited: () => void = () => {}
  private stderrTail = ''
  private closed = false
  private exitedProcess = false

  constructor(options: WorkerProcessOptions) {
    this.workerId = options.workerId
    this.requestTimeoutMs = options.requestTimeoutMs
    this.stderrTailBytes = options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES
    this.stdoutMaxFrameBytes =
      options.stdoutMaxFrameBytes ?? DEFAULT_STDOUT_MAX_FRAME_BYTES
    this.onFrame = options.onFrame
    this.onParseError = options.onParseError
    this.onExit = options.onExit
    this.exited = new Promise(resolve => {
      this.resolveExited = resolve
    })

    const spawnWorker = options.spawnWorker ?? spawnWorkerProcess
    this.child = spawnWorker(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
    })

    this.child.stdout.on('data', chunk => {
      this.handleStdoutChunk(chunk)
    })
    this.child.stderr.on('data', chunk => {
      this.appendStderrTail(chunk)
    })
    this.child.on('error', error => {
      this.rejectAllPending(error)
    })
    this.child.on('exit', (exitCode, signal) => {
      this.handleExit(exitCode, signal)
    })
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  getStderrTail(): string {
    return this.stderrTail
  }

  async send(command: WorkerCommand): Promise<WorkerResponse> {
    if (this.closed) {
      throw new Error(`Worker ${this.workerId} is closed`)
    }
    if (this.pendingRequests.has(command.id)) {
      throw new Error(
        `Worker ${this.workerId} already has pending request ${command.id}`,
      )
    }

    const responsePromise = new Promise<WorkerResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(command.id)
        reject(
          new Error(
            `Worker request ${command.id} timed out after ${this.requestTimeoutMs}ms`,
          ),
        )
      }, this.requestTimeoutMs)
      this.pendingRequests.set(command.id, { resolve, reject, timeout })
    })

    try {
      await this.writeCommand(command)
    } catch (error) {
      this.rejectPending(command.id, errorToError(error))
    }

    return responsePromise
  }

  async close(reason = 'worker process closed'): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.rejectAllPending(new Error(reason))
      this.child.stdin.end()
    }
    await this.waitForExit()
  }

  async waitForExit(): Promise<void> {
    await this.exited
  }

  kill(reason = 'worker process killed'): void {
    if (this.exitedProcess) return
    this.closed = true
    this.rejectAllPending(new Error(reason))
    this.child.kill()
  }

  private async writeCommand(command: WorkerCommand): Promise<void> {
    const payload = encodeWorkerCommand(command)
    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error): void => {
        this.child.stdin.off('error', handleError)
        reject(error)
      }

      this.child.stdin.once('error', handleError)
      this.child.stdin.write(payload, () => {
        this.child.stdin.off('error', handleError)
        resolve()
      })
    })
  }

  private handleStdoutChunk(chunk: string | Buffer): void {
    if (this.updateStdoutPendingBytes(chunk)) {
      const error = new Error(
        `Worker stdout frame exceeded ${this.stdoutMaxFrameBytes} bytes without a newline`,
      )
      this.onParseError?.(error, '')
      this.kill(error.message)
      return
    }

    this.handleParserItems(this.parser.push(chunk))
  }

  private flushStdoutParser(): void {
    this.stdoutPendingBytes = 0
    this.handleParserItems(this.parser.flush())
  }

  private handleParserItems(
    items: Array<{ frame: WorkerFrame } | { error: Error; raw: string }>,
  ): void {
    for (const item of items) {
      if ('error' in item) {
        this.onParseError?.(item.error, item.raw)
        continue
      }
      this.handleFrame(item.frame)
    }
  }

  private updateStdoutPendingBytes(chunk: string | Buffer): boolean {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    let segmentStart = 0

    while (true) {
      const newlineIndex = text.indexOf('\n', segmentStart)
      if (newlineIndex === -1) {
        this.stdoutPendingBytes += Buffer.byteLength(
          text.slice(segmentStart),
          'utf8',
        )
        return this.stdoutPendingBytes > this.stdoutMaxFrameBytes
      }

      this.stdoutPendingBytes += Buffer.byteLength(
        text.slice(segmentStart, newlineIndex),
        'utf8',
      )
      if (this.stdoutPendingBytes > this.stdoutMaxFrameBytes) return true

      this.stdoutPendingBytes = 0
      segmentStart = newlineIndex + 1
    }
  }

  private handleFrame(frame: WorkerFrame): void {
    if (!isWorkerFrame(frame)) {
      this.onParseError?.(
        new Error('Worker stdout frame has unknown shape'),
        JSON.stringify(frame),
      )
      return
    }

    if (isWorkerResponseFrame(frame)) {
      this.resolvePending(frame)
      return
    }

    this.onFrame?.(frame)
  }

  private resolvePending(response: WorkerResponse): void {
    const pending = this.pendingRequests.get(response.id)
    if (!pending) {
      this.onParseError?.(
        new Error(
          `Worker response ${response.id} did not match a pending request`,
        ),
        JSON.stringify(response),
      )
      return
    }

    this.pendingRequests.delete(response.id)
    clearTimeout(pending.timeout)
    pending.resolve(response)
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pendingRequests.get(id)
    if (!pending) return
    this.pendingRequests.delete(id)
    clearTimeout(pending.timeout)
    pending.reject(error)
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id)
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
  }

  private appendStderrTail(chunk: string | Buffer): void {
    this.stderrTail += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    const overflowBytes =
      Buffer.byteLength(this.stderrTail, 'utf8') - this.stderrTailBytes
    if (overflowBytes <= 0) return

    let dropChars = overflowBytes
    while (
      dropChars < this.stderrTail.length &&
      Buffer.byteLength(this.stderrTail.slice(dropChars), 'utf8') >
        this.stderrTailBytes
    ) {
      dropChars += 1
    }
    this.stderrTail = this.stderrTail.slice(
      Math.min(dropChars, this.stderrTail.length),
    )
  }

  private handleExit(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.exitedProcess) return
    this.exitedProcess = true
    this.flushStdoutParser()
    if (!this.closed) {
      this.closed = true
    }
    this.rejectAllPending(
      new Error(
        `Worker ${this.workerId} exited before completing pending requests`,
      ),
    )
    this.onExit?.({
      workerId: this.workerId,
      exitCode: exitCode ?? undefined,
      signal: signal ?? undefined,
      stderrTail: this.stderrTail,
    })
    this.resolveExited()
  }
}

function spawnWorkerProcess(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
): WorkerChildProcess {
  return spawn(command, args, options)
}

function isWorkerResponseFrame(frame: WorkerFrame): frame is WorkerResponse {
  return 'id' in frame && 'ok' in frame
}

function errorToError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(classifyWorkerError(error).message)
}
