import type { WorkerCommand, WorkerFrame } from '../protocol/types.js'
import { isRecord } from '../protocol/jsonRpc.js'

export function encodeWorkerCommand(command: WorkerCommand): string {
  return `${JSON.stringify(command)}\n`
}

export function encodeWorkerFrame(frame: WorkerFrame): string {
  return `${JSON.stringify(frame)}\n`
}

export class NdjsonFrameParser<T> {
  private buffer = ''

  push(
    chunk: string | Buffer,
  ): Array<{ frame: T } | { error: Error; raw: string }> {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    const frames: Array<{ frame: T } | { error: Error; raw: string }> = []

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n')
      if (newlineIndex === -1) break

      const line = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (!line) continue

      try {
        const parsed = JSON.parse(line) as T
        frames.push({ frame: parsed })
      } catch (error) {
        frames.push({
          error: error instanceof Error ? error : new Error(String(error)),
          raw: line,
        })
      }
    }

    return frames
  }

  flush(): Array<{ frame: T } | { error: Error; raw: string }> {
    const tail = this.buffer.trim()
    this.buffer = ''
    if (!tail) return []

    try {
      const parsed = JSON.parse(tail) as T
      return [{ frame: parsed }]
    } catch (error) {
      return [
        {
          error: error instanceof Error ? error : new Error(String(error)),
          raw: tail,
        },
      ]
    }
  }
}

export function isWorkerFrame(value: unknown): value is WorkerFrame {
  return isWorkerResponse(value) || isWorkerNotification(value)
}

function isWorkerResponse(value: unknown): value is WorkerFrame {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.ok !== 'boolean'
  ) {
    return false
  }

  if (value.ok) return true
  return isClassifiedError(value.error)
}

function isWorkerNotification(value: unknown): value is WorkerFrame {
  if (!isRecord(value) || typeof value.type !== 'string') return false

  switch (value.type) {
    case 'worker.ready':
      return isWorkerReadyFrame(value)
    case 'worker.heartbeat':
      return isWorkerHeartbeatFrame(value)
    case 'event':
      return isEventFrame(value)
    case 'approval.request':
      return isApprovalRequestFrame(value)
    case 'run.completed':
      return isRunCompletedFrame(value)
    case 'run.failed':
      return isRunFailedFrame(value)
    case 'worker.fatal':
      return isWorkerFatalFrame(value)
    default:
      return false
  }
}

function isWorkerReadyFrame(value: Record<string, unknown>): boolean {
  return typeof value.workerId === 'string' && isFiniteNumber(value.pid)
}

function isWorkerHeartbeatFrame(value: Record<string, unknown>): boolean {
  return (
    typeof value.workerId === 'string' &&
    (value.resourceUsage === undefined || isRecord(value.resourceUsage))
  )
}

function isEventFrame(value: Record<string, unknown>): boolean {
  return (
    isAppServerEvent(value.event) &&
    (value.runId === undefined || typeof value.runId === 'string')
  )
}

function isApprovalRequestFrame(value: Record<string, unknown>): boolean {
  return isWorkerApprovalRequest(value.request)
}

function isRunCompletedFrame(value: Record<string, unknown>): boolean {
  return (
    typeof value.runId === 'string' &&
    isStopReason(value.stopReason) &&
    (value.usage === undefined || isUsageSummary(value.usage))
  )
}

function isRunFailedFrame(value: Record<string, unknown>): boolean {
  return typeof value.runId === 'string' && isClassifiedError(value.error)
}

function isWorkerFatalFrame(value: Record<string, unknown>): boolean {
  return isClassifiedError(value.error)
}

function isWorkerApprovalRequest(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.approvalId === undefined || typeof value.approvalId === 'string') &&
    typeof value.runId === 'string' &&
    typeof value.toolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.prompt === 'string' &&
    isRecord(value.input) &&
    Array.isArray(value.options) &&
    value.options.every(isApprovalOption)
  )
}

function isApprovalOption(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.optionId === 'string' &&
    typeof value.label === 'string' &&
    isApprovalOptionKind(value.kind)
  )
}

function isApprovalOptionKind(value: unknown): boolean {
  switch (value) {
    case 'allow_once':
    case 'allow_always':
    case 'reject_once':
    case 'reject_always':
      return true
    default:
      return false
  }
}

function isAppServerEvent(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false

  switch (value.type) {
    case 'session.created':
    case 'session.loaded':
      return isSessionRecord(value.session)
    case 'session.closed':
      return typeof value.sessionId === 'string'
    case 'worker.spawning':
      return typeof value.workerId === 'string'
    case 'worker.ready':
      return typeof value.workerId === 'string' && isFiniteNumber(value.pid)
    case 'worker.heartbeat':
      return (
        typeof value.workerId === 'string' &&
        (value.resourceUsage === undefined || isRecord(value.resourceUsage))
      )
    case 'worker.crashed':
      return (
        typeof value.workerId === 'string' &&
        (value.exitCode === undefined || isFiniteNumber(value.exitCode)) &&
        (value.signal === undefined || typeof value.signal === 'string')
      )
    case 'run.queued':
      return isRunRecord(value.run)
    case 'run.started':
      return (
        typeof value.runId === 'string' && typeof value.workerId === 'string'
      )
    case 'run.cancelRequested':
      return (
        (value.runId === undefined || typeof value.runId === 'string') &&
        typeof value.reason === 'string'
      )
    case 'run.cancelled':
      return typeof value.runId === 'string' && typeof value.reason === 'string'
    case 'run.trace':
      return (
        typeof value.runId === 'string' &&
        typeof value.stage === 'string' &&
        (value.workerId === undefined || typeof value.workerId === 'string') &&
        (value.details === undefined || isRunTraceDetails(value.details))
      )
    case 'run.completed':
      return (
        typeof value.runId === 'string' &&
        isStopReason(value.stopReason) &&
        (value.usage === undefined || isUsageSummary(value.usage))
      )
    case 'run.failed':
      return typeof value.runId === 'string' && isClassifiedError(value.error)
    case 'run.interrupted':
      return (
        typeof value.runId === 'string' && isInterruptedReason(value.reason)
      )
    case 'message.started':
      return typeof value.messageId === 'string' && isMessageRole(value.role)
    case 'message.delta':
      return (
        typeof value.messageId === 'string' &&
        typeof value.delta === 'string' &&
        (value.channel === undefined || isMessageDeltaChannel(value.channel))
      )
    case 'message.completed':
      return typeof value.messageId === 'string'
    case 'tool.started':
      return (
        typeof value.toolCallId === 'string' &&
        typeof value.toolName === 'string'
      )
    case 'tool.progress':
      return (
        typeof value.toolCallId === 'string' &&
        (typeof value.content === 'string' || isBlobRef(value.content))
      )
    case 'tool.completed':
      return typeof value.toolCallId === 'string'
    case 'tool.failed':
      return (
        typeof value.toolCallId === 'string' && isClassifiedError(value.error)
      )
    case 'approval.requested':
    case 'approval.resolved':
      return isApprovalRecord(value.approval)
    case 'usage.updated':
      return isUsageSummary(value.usage)
    case 'error.reported':
      return isClassifiedError(value.error)
    case 'snapshot.invalidated':
      return typeof value.reason === 'string'
    case 'sdk.message':
      return (
        value.sdkMessageVersion === 'claude-code-sdk-message-v1' &&
        isRecord(value.sdkMessage) &&
        (value.projectionHints === undefined ||
          isProjectionHints(value.projectionHints))
      )
    default:
      return false
  }
}

function isSessionRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.workspaceRoot === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    value.runtime === 'matcha-agent' &&
    isFiniteNumber(value.lastSeq) &&
    isFiniteNumber(value.lastSnapshotVersion) &&
    isRecord(value.workerState)
  )
}

function isRunRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.runId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.promptId === 'string' &&
    isRecord(value.status)
  )
}

function isApprovalRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.approvalId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.workerId === 'string' &&
    typeof value.toolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.prompt === 'string' &&
    Array.isArray(value.options) &&
    value.options.every(isApprovalOption) &&
    isApprovalStatus(value.status)
  )
}

function isApprovalStatus(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false

  switch (value.type) {
    case 'pending':
      return (
        typeof value.requestedAt === 'string' &&
        (value.expiresAt === undefined || typeof value.expiresAt === 'string')
      )
    case 'approved':
      return (
        typeof value.resolvedAt === 'string' &&
        typeof value.optionId === 'string'
      )
    case 'denied':
      return (
        typeof value.resolvedAt === 'string' &&
        (value.reason === undefined || typeof value.reason === 'string')
      )
    case 'cancelled':
      return (
        typeof value.resolvedAt === 'string' &&
        (value.reason === 'runCancelled' || value.reason === 'workerExited')
      )
    case 'expired':
      return typeof value.resolvedAt === 'string'
    default:
      return false
  }
}

function isBlobRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.blobId === 'string' &&
    isFiniteNumber(value.byteLength) &&
    typeof value.contentType === 'string' &&
    typeof value.sha256 === 'string' &&
    (value.preview === undefined || typeof value.preview === 'string')
  )
}

function isProjectionHints(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.messageId === undefined || typeof value.messageId === 'string') &&
    (value.toolCallId === undefined || typeof value.toolCallId === 'string') &&
    (value.isTerminal === undefined || typeof value.isTerminal === 'boolean')
  )
}

function isInterruptedReason(value: unknown): boolean {
  return value === 'workerCrashed' || value === 'serverShutdown'
}

function isRunTraceDetails(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isRunTraceValue)
}

function isRunTraceValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    isFiniteNumber(value)
  )
}

function isMessageRole(value: unknown): boolean {
  return value === 'assistant' || value === 'user' || value === 'tool'
}

function isMessageDeltaChannel(value: unknown): boolean {
  return value === 'text' || value === 'thinking' || value === 'tool'
}

function isClassifiedError(value: unknown): boolean {
  return (
    isRecord(value) &&
    isClassifiedErrorType(value.type) &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean'
  )
}

function isClassifiedErrorType(value: unknown): boolean {
  switch (value) {
    case 'invalidRequest':
    case 'auth':
    case 'permission':
    case 'network':
    case 'aborted':
    case 'worker':
    case 'internal':
      return true
    default:
      return false
  }
}

function isStopReason(value: unknown): boolean {
  switch (value) {
    case 'end_turn':
    case 'max_tokens':
    case 'max_turn_requests':
    case 'refusal':
    case 'cancelled':
    case 'error':
      return true
    default:
      return false
  }
}

function isUsageSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.inputTokens) &&
    isFiniteNumber(value.outputTokens) &&
    isFiniteNumber(value.cachedReadTokens) &&
    isFiniteNumber(value.cachedWriteTokens) &&
    isFiniteNumber(value.totalTokens)
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
