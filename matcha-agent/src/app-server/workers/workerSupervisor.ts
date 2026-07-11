import { randomUUID } from 'node:crypto'
import type {
  AppServerEvent,
  WorkerApprovalRequest,
  WorkerFrame,
  WorkerInitializePayload,
  WorkerNotification,
  WorkerResponse,
  StopReason,
  UsageSummary,
  ClassifiedError,
} from '../protocol/types.js'
import { isRecord } from '../protocol/jsonRpc.js'
import { WorkerProcess } from './workerProcess.js'
import type {
  WorkerProcessExit,
  WorkerProcessOptions,
  WorkerProcessSpawn,
  WorkerProcessSpawnOptions,
} from './workerProcess.js'
import { classifyWorkerError, errorToMessage } from './workerErrors.js'

export type WorkerSupervisorSession = WorkerInitializePayload

export type WorkerSupervisorPorts = {
  onWorkerReady?: (event: {
    sessionId: string
    workerId: string
    pid: number
  }) => void
  onHeartbeat?: (event: {
    sessionId: string
    workerId: string
    resourceUsage?: Record<string, unknown>
  }) => void
  onEvent?: (event: {
    sessionId: string
    workerId: string
    runId?: string
    event: AppServerEvent
  }) => void
  onApprovalRequest?: (event: {
    sessionId: string
    workerId: string
    request: WorkerApprovalRequest
  }) => void
  onRunCompleted?: (event: {
    sessionId: string
    workerId: string
    runId: string
    stopReason: StopReason
    usage?: UsageSummary
  }) => void
  onRunFailed?: (event: {
    sessionId: string
    workerId: string
    runId: string
    error: ClassifiedError
  }) => void
  onFatal?: (event: {
    sessionId: string
    workerId: string
    error: ClassifiedError
  }) => void
  onCrash?: (event: {
    sessionId: string
    workerId: string
    exitCode?: number
    signal?: string
    stderrTail: string
  }) => void
  onProtocolError?: (event: {
    sessionId: string
    workerId: string
    error: Error
    raw: string
  }) => void
}

export type WorkerSupervisorOptions = WorkerProcessSpawnOptions & {
  requestTimeoutMs: number
  heartbeatTimeoutMs?: number
  stderrTailBytes?: number
  ports?: WorkerSupervisorPorts
  spawnWorker?: WorkerProcessSpawn
  createRequestId?: () => string
}

type WorkerSlot = {
  session: WorkerSupervisorSession
  process: WorkerProcess
  lastHeartbeatAt: number
  heartbeatTimer: ReturnType<typeof setTimeout> | undefined
}

export class WorkerSupervisor {
  private readonly spawnOptions: WorkerProcessSpawnOptions
  private readonly requestTimeoutMs: number
  private readonly heartbeatTimeoutMs?: number
  private readonly stderrTailBytes?: number
  private readonly ports: WorkerSupervisorPorts
  private readonly spawnWorker?: WorkerProcessSpawn
  private readonly createRequestId: () => string
  private readonly workersBySessionId = new Map<string, WorkerSlot>()

  constructor(options: WorkerSupervisorOptions) {
    this.spawnOptions = {
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
    }
    this.requestTimeoutMs = options.requestTimeoutMs
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs
    this.stderrTailBytes = options.stderrTailBytes
    this.ports = options.ports ?? {}
    this.spawnWorker = options.spawnWorker
    this.createRequestId = options.createRequestId ?? randomUUID
  }

  async ensureWorker(session: WorkerSupervisorSession): Promise<WorkerProcess> {
    const existing = this.workersBySessionId.get(session.sessionId)
    if (existing) return existing.process

    const workerId = randomUUID()
    const process = this.createWorkerProcess(workerId, session.sessionId)
    this.workersBySessionId.set(session.sessionId, {
      session,
      process,
      lastHeartbeatAt: Date.now(),
      heartbeatTimer: undefined,
    })
    this.scheduleHeartbeatWatchdog(session.sessionId)

    let response: WorkerResponse
    try {
      response = await process.send({
        id: this.createRequestId(),
        type: 'worker.initialize',
        payload: session,
      })
    } catch (error) {
      this.removeWorkerSlot(session.sessionId)
      process.kill('worker initialize failed')
      throw error
    }

    if (!response.ok) {
      this.removeWorkerSlot(session.sessionId)
      process.kill('worker initialize failed')
      throw workerInitializationError(response.error)
    }

    const responseIdentityError = this.validateResponseWorkerId(
      session.sessionId,
      workerId,
      response,
    )
    if (responseIdentityError) throw responseIdentityError

    return process
  }

  getWorker(sessionId: string): WorkerProcess | undefined {
    return this.workersBySessionId.get(sessionId)?.process
  }

  async send(
    sessionId: string,
    command: Parameters<WorkerProcess['send']>[0],
  ): Promise<WorkerResponse> {
    const worker = this.workersBySessionId.get(sessionId)?.process
    if (!worker) {
      return {
        id: command.id,
        ok: false,
        error: {
          type: 'worker',
          message: `No worker is running for session ${sessionId}`,
          retryable: true,
        },
      }
    }

    const response = await worker.send(command)
    const responseIdentityError = this.validateResponseWorkerId(
      sessionId,
      worker.workerId,
      response,
    )
    if (!responseIdentityError) return response

    return {
      id: command.id,
      ok: false,
      error: classifyWorkerError(responseIdentityError, 'worker'),
    }
  }

  killSession(sessionId: string, reason: string): boolean {
    const slot = this.removeWorkerSlot(sessionId)
    if (!slot) return false

    slot.process.kill(reason)
    return true
  }

  async shutdownSession(
    sessionId: string,
    reason: 'serverShutdown' | 'idleTimeout' | 'restart' = 'serverShutdown',
  ): Promise<void> {
    const slot = this.removeWorkerSlot(sessionId)
    if (!slot) return

    try {
      await slot.process.send({
        id: this.createRequestId(),
        type: 'worker.shutdown',
        reason,
      })
    } catch {
      slot.process.kill(`worker shutdown failed for session ${sessionId}`)
      return
    }

    await slot.process.close(`worker shutdown for session ${sessionId}`)
  }

  async shutdownAll(
    reason: 'serverShutdown' | 'restart' = 'serverShutdown',
  ): Promise<void> {
    const sessionIds = Array.from(this.workersBySessionId.keys())
    await Promise.all(
      sessionIds.map(sessionId => this.shutdownSession(sessionId, reason)),
    )
  }

  private createWorkerProcess(
    workerId: string,
    sessionId: string,
  ): WorkerProcess {
    const options: WorkerProcessOptions = {
      ...this.spawnOptions,
      env: {
        ...this.spawnOptions.env,
        MATCHA_AGENT_WORKER_ID: workerId,
      },
      workerId,
      requestTimeoutMs: this.requestTimeoutMs,
      stderrTailBytes: this.stderrTailBytes,
      spawnWorker: this.spawnWorker,
      onFrame: frame => {
        this.handleFrame(sessionId, workerId, frame)
      },
      onParseError: (error, raw) => {
        this.ports.onProtocolError?.({ sessionId, workerId, error, raw })
      },
      onExit: exit => {
        this.handleExit(sessionId, exit)
      },
    }
    return new WorkerProcess(options)
  }

  private noteWorkerHeartbeat(sessionId: string): void {
    const slot = this.workersBySessionId.get(sessionId)
    if (!slot) return
    slot.lastHeartbeatAt = Date.now()
    this.scheduleHeartbeatWatchdog(sessionId)
  }

  private scheduleHeartbeatWatchdog(sessionId: string): void {
    if (this.heartbeatTimeoutMs === undefined) return

    const slot = this.workersBySessionId.get(sessionId)
    if (!slot) return

    if (slot.heartbeatTimer) {
      clearTimeout(slot.heartbeatTimer)
      slot.heartbeatTimer = undefined
    }

    const elapsedMs = Date.now() - slot.lastHeartbeatAt
    const remainingMs = Math.max(this.heartbeatTimeoutMs - elapsedMs, 0)
    slot.heartbeatTimer = setTimeout(() => {
      this.handleHeartbeatTimeout(sessionId)
    }, remainingMs)
  }

  private handleHeartbeatTimeout(sessionId: string): void {
    if (this.heartbeatTimeoutMs === undefined) return

    const slot = this.workersBySessionId.get(sessionId)
    if (!slot) return

    const elapsedMs = Date.now() - slot.lastHeartbeatAt
    if (elapsedMs < this.heartbeatTimeoutMs) {
      this.scheduleHeartbeatWatchdog(sessionId)
      return
    }

    const removedSlot = this.removeWorkerSlot(sessionId)
    if (!removedSlot) return

    removedSlot.process.kill(
      `Worker heartbeat timed out after ${this.heartbeatTimeoutMs}ms`,
    )
    this.ports.onCrash?.({
      sessionId,
      workerId: removedSlot.process.workerId,
      stderrTail: removedSlot.process.getStderrTail(),
    })
  }

  private removeWorkerSlot(sessionId: string): WorkerSlot | undefined {
    const slot = this.workersBySessionId.get(sessionId)
    if (!slot) return undefined

    this.workersBySessionId.delete(sessionId)
    if (slot.heartbeatTimer) {
      clearTimeout(slot.heartbeatTimer)
      slot.heartbeatTimer = undefined
    }
    return slot
  }

  private acceptFrameWorkerId(
    sessionId: string,
    assignedWorkerId: string,
    frame: Exclude<WorkerFrame, WorkerResponse>,
  ): boolean {
    const frameWorkerId = workerIdFromFrame(frame)
    if (frameWorkerId === undefined || frameWorkerId === assignedWorkerId) {
      return true
    }

    this.rejectWorkerIdentityMismatch(
      sessionId,
      assignedWorkerId,
      frameWorkerId,
      JSON.stringify(frame),
    )
    return false
  }

  private validateResponseWorkerId(
    sessionId: string,
    assignedWorkerId: string,
    response: WorkerResponse,
  ): Error | undefined {
    const responseWorkerId = workerIdFromResponse(response)
    if (
      responseWorkerId === undefined ||
      responseWorkerId === assignedWorkerId
    ) {
      return undefined
    }

    return this.rejectWorkerIdentityMismatch(
      sessionId,
      assignedWorkerId,
      responseWorkerId,
      JSON.stringify(response),
    )
  }

  private rejectWorkerIdentityMismatch(
    sessionId: string,
    assignedWorkerId: string,
    receivedWorkerId: string,
    raw: string,
  ): Error {
    const error = new Error(
      `Worker frame identity mismatch: assigned ${assignedWorkerId}, received ${receivedWorkerId}`,
    )
    this.ports.onProtocolError?.({
      sessionId,
      workerId: assignedWorkerId,
      error,
      raw,
    })

    const slot = this.removeWorkerSlot(sessionId)
    if (slot) {
      slot.process.kill(error.message)
    }
    return error
  }

  private handleFrame(
    sessionId: string,
    workerId: string,
    frame: Exclude<WorkerFrame, WorkerResponse>,
  ): void {
    const slot = this.workersBySessionId.get(sessionId)
    if (!slot || slot.process.workerId !== workerId) return
    if (!this.acceptFrameWorkerId(sessionId, workerId, frame)) return

    switch (frame.type) {
      case 'worker.ready':
        this.noteWorkerHeartbeat(sessionId)
        this.ports.onWorkerReady?.({
          sessionId,
          workerId,
          pid: frame.pid,
        })
        break
      case 'worker.heartbeat':
        this.noteWorkerHeartbeat(sessionId)
        this.ports.onHeartbeat?.({
          sessionId,
          workerId,
          resourceUsage: frame.resourceUsage,
        })
        break
      case 'event':
        this.ports.onEvent?.({
          sessionId,
          workerId,
          runId: frame.runId,
          event: frame.event,
        })
        break
      case 'approval.request':
        this.ports.onApprovalRequest?.({
          sessionId,
          workerId,
          request: frame.request,
        })
        break
      case 'run.completed':
        this.ports.onRunCompleted?.({
          sessionId,
          workerId,
          runId: frame.runId,
          stopReason: frame.stopReason,
          usage: frame.usage,
        })
        break
      case 'run.failed':
        this.ports.onRunFailed?.({
          sessionId,
          workerId,
          runId: frame.runId,
          error: frame.error,
        })
        break
      case 'worker.fatal':
        this.ports.onFatal?.({ sessionId, workerId, error: frame.error })
        break
    }
  }

  private handleExit(sessionId: string, exit: WorkerProcessExit): void {
    const slot = this.removeWorkerSlot(sessionId)
    if (!slot) return

    this.ports.onCrash?.({
      sessionId,
      workerId: exit.workerId,
      exitCode: exit.exitCode,
      signal: exit.signal,
      stderrTail: exit.stderrTail,
    })
  }
}

function workerIdFromResponse(response: WorkerResponse): string | undefined {
  if (!response.ok) return undefined
  if (!isRecord(response.result)) return undefined

  const workerId = response.result.workerId
  return typeof workerId === 'string' ? workerId : undefined
}

function workerIdFromFrame(
  frame: Exclude<WorkerFrame, WorkerResponse>,
): string | undefined {
  switch (frame.type) {
    case 'worker.ready':
    case 'worker.heartbeat':
      return frame.workerId
    case 'event':
      return workerIdFromAppServerEvent(frame.event)
    case 'approval.request':
      return undefined
    case 'run.completed':
    case 'run.failed':
    case 'worker.fatal':
      return undefined
  }
}

function workerIdFromAppServerEvent(event: AppServerEvent): string | undefined {
  switch (event.type) {
    case 'worker.spawning':
    case 'worker.ready':
    case 'worker.heartbeat':
    case 'worker.crashed':
    case 'run.started':
      return event.workerId
    case 'approval.requested':
    case 'approval.resolved':
      return event.approval.workerId
    default:
      return undefined
  }
}

export function responseToClassifiedError(
  response: WorkerResponse,
): ClassifiedError | undefined {
  if (response.ok) return undefined
  return response.error
}

export function workerError(error: unknown): ClassifiedError {
  return classifyWorkerError(error, 'worker')
}

export function workerInitializationError(error: ClassifiedError): Error {
  return new WorkerInitializationError(error)
}

export function classifyWorkerInitializationError(
  error: unknown,
): ClassifiedError {
  if (error instanceof WorkerInitializationError) return error.classified
  return classifyWorkerError(error, 'worker')
}

class WorkerInitializationError extends Error {
  readonly classified: ClassifiedError

  constructor(error: ClassifiedError) {
    super(errorToMessage(error, error.message))
    this.name = 'WorkerInitializationError'
    this.classified = error
  }
}
