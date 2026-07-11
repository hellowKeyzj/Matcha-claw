import type {
  Base64ImageSource,
  ContentBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import type {
  WorkerCommand,
  WorkerFrame,
  WorkerResponse,
} from '../protocol/types.js'
import { encodeWorkerFrame, NdjsonFrameParser } from './workerProtocol.js'
import { classifyWorkerError } from './workerErrors.js'
import { createWorkerSession } from './workerSession.js'
import type { WorkerSession } from './workerSession.js'

type WorkerEntryOptions = {
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  stderr?: NodeJS.WriteStream
  heartbeatIntervalMs?: number
  now?: () => Date
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
const MAX_PENDING_STDOUT_FRAMES = 1024

export async function runWorkerEntry(
  options: WorkerEntryOptions = {},
): Promise<void> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS

  redirectConsoleToStderr(stderr)
  await initializeWorkerRuntime()

  const runner = new WorkerEntryRunner({ stdout, stderr })
  const heartbeat = setInterval(() => {
    runner.emitDetached({
      type: 'worker.heartbeat',
      workerId: runner.workerId,
      resourceUsage: resourceUsageSnapshot(),
    })
  }, heartbeatIntervalMs)

  try {
    for await (const chunk of stdin) {
      await runner.handleChunk(chunk)
      if (runner.shouldStop) break
    }
    await runner.flushParser()
  } finally {
    clearInterval(heartbeat)
    await runner.flushStdout()
  }
}

type WorkerEntryRunnerOptions = {
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
}

class WorkerEntryRunner {
  readonly workerId =
    process.env.MATCHA_AGENT_WORKER_ID ?? `worker-${process.pid}`
  private readonly stdoutWriter: SerialWorkerFrameWriter
  private readonly stderr: NodeJS.WriteStream
  private readonly parser = new NdjsonFrameParser<WorkerCommand>()
  private session: WorkerSession | undefined
  private activePrompt: Promise<void> | undefined
  private stopping = false

  constructor(options: WorkerEntryRunnerOptions) {
    this.stdoutWriter = new SerialWorkerFrameWriter(options.stdout)
    this.stderr = options.stderr
  }

  get shouldStop(): boolean {
    return this.stopping
  }

  emit(frame: WorkerFrame): Promise<void> {
    return this.stdoutWriter.write(frame)
  }

  emitDetached(frame: WorkerFrame): void {
    void this.emit(frame).catch(error => {
      this.reportEmitError(error)
    })
  }

  flushStdout(): Promise<void> {
    return this.stdoutWriter.flush()
  }

  async handleChunk(chunk: string | Buffer): Promise<void> {
    for (const item of this.parser.push(chunk)) {
      if ('error' in item) {
        await this.emitFatal(item.error)
        continue
      }
      await this.handleCommand(item.frame)
    }
  }

  async flushParser(): Promise<void> {
    for (const item of this.parser.flush()) {
      if ('error' in item) {
        await this.emitFatal(item.error)
        continue
      }
      await this.handleCommand(item.frame)
    }
  }

  private async handleCommand(command: WorkerCommand): Promise<void> {
    try {
      switch (command.type) {
        case 'worker.initialize':
          await this.initialize(command)
          return
        case 'session.prompt':
          await this.handlePrompt(command)
          return
        case 'session.cancel':
          this.session?.cancel(command.runId, command.reason)
          if (this.activePrompt) {
            await this.activePrompt.catch(() => {})
          }
          await this.emitSuccess(command.id)
          return
        case 'approval.response':
          if (
            !this.session?.respondToApproval(
              command.approvalId,
              command.decision,
            )
          ) {
            await this.emitFailure(
              command.id,
              new Error(`Unknown approval ${command.approvalId}`),
            )
            return
          }
          await this.emitSuccess(command.id)
          return
        case 'session.flush':
          await this.session?.flush()
          await this.emitSuccess(command.id)
          return
        case 'worker.shutdown':
          await this.session?.shutdown(command.reason)
          await this.emitSuccess(command.id)
          this.stopping = true
          return
      }
    } catch (error) {
      await this.emitFailure(command.id, error)
    }
  }

  private async initialize(
    command: Extract<WorkerCommand, { type: 'worker.initialize' }>,
  ): Promise<void> {
    if (this.session) {
      await this.emitSuccess(command.id, { workerId: this.workerId })
      return
    }

    process.env.MATCHA_AGENT_WORKER_ID = this.workerId
    this.session = await createWorkerSession(command.payload, {
      emit: frame => {
        this.emitDetached(frame)
      },
    })
    await this.emit({
      type: 'worker.ready',
      workerId: this.workerId,
      pid: process.pid,
    })
    await this.emitSuccess(command.id, {
      workerId: this.workerId,
      pid: process.pid,
    })
  }

  private async handlePrompt(
    command: Extract<WorkerCommand, { type: 'session.prompt' }>,
  ): Promise<void> {
    if (!this.session) {
      await this.emitFailure(command.id, new Error('Worker is not initialized'))
      return
    }
    if (this.activePrompt) {
      await this.emitFailure(
        command.id,
        new Error('A prompt is already running'),
      )
      return
    }

    await this.emitSuccess(command.id)
    this.activePrompt = this.session.prompt(
      command.runId,
      promptInputFromCommand(command),
    )
    this.activePrompt
      .catch(error => {
        const classified = classifyWorkerError(error)
        this.emitDetached({
          type: 'run.failed',
          runId: command.runId,
          error: classified,
        })
      })
      .finally(() => {
        this.activePrompt = undefined
      })
  }

  private async emitSuccess(id: string, result?: unknown): Promise<void> {
    const response: WorkerResponse = { id, ok: true, result }
    await this.emit(response)
  }

  private async emitFailure(id: string, error: unknown): Promise<void> {
    const response: WorkerResponse = {
      id,
      ok: false,
      error: classifyWorkerError(error),
    }
    await this.emit(response)
  }

  private async emitFatal(error: unknown): Promise<void> {
    const classified = classifyWorkerError(error)
    await this.emit({ type: 'worker.fatal', error: classified })
    this.stderr.write(`[worker] ${classified.message}\n`)
  }

  private reportEmitError(error: unknown): void {
    const classified = classifyWorkerError(error, 'worker')
    this.stderr.write(`[worker:stdout] ${classified.message}\n`)
  }
}

type QueuedWorkerFrame = {
  payload: string
  resolve: () => void
  reject: (error: Error) => void
}

class SerialWorkerFrameWriter {
  private readonly stdout: NodeJS.WriteStream
  private readonly maxPendingFrames: number
  private readonly pendingFrames: QueuedWorkerFrame[] = []
  private readonly idleResolvers: Array<() => void> = []
  private draining = false
  private closed = false

  constructor(
    stdout: NodeJS.WriteStream,
    maxPendingFrames = MAX_PENDING_STDOUT_FRAMES,
  ) {
    this.stdout = stdout
    this.maxPendingFrames = maxPendingFrames
  }

  write(frame: WorkerFrame): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Worker stdout writer is closed'))
    }
    if (this.pendingFrames.length >= this.maxPendingFrames) {
      return Promise.reject(
        new Error(
          `Worker stdout queue exceeded ${this.maxPendingFrames} pending frames`,
        ),
      )
    }

    return new Promise((resolve, reject) => {
      this.pendingFrames.push({
        payload: encodeWorkerFrame(frame),
        resolve,
        reject,
      })
      void this.drain()
    })
  }

  async flush(): Promise<void> {
    if (!this.draining && this.pendingFrames.length === 0) return
    await new Promise<void>(resolve => {
      this.idleResolvers.push(resolve)
    })
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true

    try {
      while (this.pendingFrames.length > 0) {
        const item = this.pendingFrames.shift()
        if (!item) continue

        try {
          await this.writePayload(item.payload)
          item.resolve()
        } catch (error) {
          const writeError = errorToError(error)
          item.reject(writeError)
          this.rejectPending(writeError)
          return
        }
      }
    } finally {
      this.draining = false
      this.resolveIdleIfReady()
    }
  }

  private writePayload(payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        this.stdout.off('error', handleError)
        this.stdout.off('drain', handleDrain)
      }
      const finish = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const handleError = (error: Error): void => {
        fail(error)
      }
      const handleDrain = (): void => {
        finish()
      }

      this.stdout.once('error', handleError)
      let canContinue: boolean
      try {
        canContinue = this.stdout.write(payload)
      } catch (error) {
        fail(errorToError(error))
        return
      }

      if (canContinue) {
        finish()
        return
      }
      this.stdout.once('drain', handleDrain)
    })
  }

  private rejectPending(error: Error): void {
    this.closed = true
    while (this.pendingFrames.length > 0) {
      this.pendingFrames.shift()?.reject(error)
    }
  }

  private resolveIdleIfReady(): void {
    if (this.draining || this.pendingFrames.length > 0) return
    while (this.idleResolvers.length > 0) {
      this.idleResolvers.shift()?.()
    }
  }
}

async function initializeWorkerRuntime(): Promise<void> {
  const [{ enableConfigs }, { setShellIfWindows }] = await Promise.all([
    import('../../utils/config.js'),
    import('../../utils/windowsPaths.js'),
  ])
  enableConfigs()
  setShellIfWindows()
}

function promptInputFromCommand(
  command: Extract<WorkerCommand, { type: 'session.prompt' }>,
): string | ContentBlockParam[] {
  const payload = isRecord(command.payload) ? command.payload : undefined
  const prompt = readString(payload?.message) ?? command.prompt
  const attachments = readPayloadAttachments(payload)
  if (attachments.length === 0) return prompt

  return [
    ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
    ...attachments,
  ]
}

function readPayloadAttachments(payload: unknown): ContentBlockParam[] {
  const record = isRecord(payload) ? payload : undefined
  const attachments = Array.isArray(record?.attachments)
    ? record.attachments
    : []
  return attachments.flatMap(readPayloadAttachment)
}

function readPayloadAttachment(value: unknown): ContentBlockParam[] {
  const attachment = isRecord(value) ? value : undefined
  if (!attachment) return []
  const content = readString(attachment.content)
  const mediaType = readImageMediaType(attachment.mimeType)
  if (!content || !mediaType) return []

  return [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: content,
      },
    },
  ]
}

function readImageMediaType(
  value: unknown,
): Base64ImageSource['media_type'] | undefined {
  if (
    value === 'image/jpeg' ||
    value === 'image/png' ||
    value === 'image/gif' ||
    value === 'image/webp'
  ) {
    return value
  }
  return undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function redirectConsoleToStderr(stderr: NodeJS.WriteStream): void {
  const write = (level: string, args: unknown[]): void => {
    stderr.write(`[console.${level}] ${args.map(formatConsoleArg).join(' ')}\n`)
  }
  console.log = (...args: unknown[]) => write('log', args)
  console.info = (...args: unknown[]) => write('info', args)
  console.warn = (...args: unknown[]) => write('warn', args)
  console.error = (...args: unknown[]) => write('error', args)
  console.debug = (...args: unknown[]) => write('debug', args)
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function resourceUsageSnapshot(): Record<string, unknown> {
  const usage = process.resourceUsage()
  return {
    userCpuTime: usage.userCPUTime,
    systemCpuTime: usage.systemCPUTime,
    maxRss: usage.maxRSS,
  }
}

function errorToError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(classifyWorkerError(error).message)
}

if (import.meta.main && process.argv.includes('--matcha-agent-worker-entry')) {
  runWorkerEntry().catch(error => {
    const classified = classifyWorkerError(error)
    process.stderr.write(`[worker:fatal] ${classified.message}\n`)
    process.exitCode = 1
  })
}
