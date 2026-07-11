import { randomUUID } from 'node:crypto'
import type {
  ClassifiedError,
  RunRecord,
  RunStatus,
  StopReason,
} from '../protocol/types.js'

export type RunCoordinatorOptions = {
  maxQueueSize: number
  createRunId?: () => string
  createPromptId?: () => string
  now?: () => Date
}

export type RunRestoreInput = {
  run: RunRecord
  prompt?: string
}

export type RunRestoreResult =
  | { resultType: 'restored'; run: RunRecord }
  | { resultType: 'duplicateRun'; runId: string }

export type RunEnqueueInput = {
  sessionId: string
  prompt: string
  runId?: string
  payload?: unknown
}

export type QueuedRun = {
  run: RunRecord
  prompt: string
  payload?: unknown
}

export type RunTransition =
  | { type: 'start'; workerId: string; startedAt: string }
  | { type: 'waitForApproval'; approvalIds: string[] }
  | { type: 'complete'; completedAt: string; stopReason: StopReason }
  | { type: 'cancel'; completedAt: string; reason: string }
  | { type: 'startFailed'; completedAt: string; error: ClassifiedError }
  | { type: 'fail'; completedAt: string; error: ClassifiedError }
  | {
      type: 'interrupt'
      completedAt: string
      reason: 'workerCrashed' | 'serverShutdown'
    }

export type RunTransitionResult =
  | { resultType: 'transitioned'; status: RunStatus }
  | {
      resultType: 'invalidTransition'
      from: RunStatus
      transition: RunTransition
    }

export type RunEnqueueResult =
  | { resultType: 'enqueued'; queuedRun: QueuedRun }
  | { resultType: 'duplicateRun'; runId: string }
  | {
      resultType: 'queueFull'
      sessionId: string
      maxQueueSize: number
      queuedCount: number
    }

export type RunStartNextResult =
  | { resultType: 'started'; queuedRun: QueuedRun }
  | { resultType: 'sessionAlreadyRunning'; queuedRun: QueuedRun }
  | { resultType: 'queueEmpty'; sessionId: string }

export type RunTerminalResult =
  | { resultType: 'updated'; run: RunRecord }
  | { resultType: 'runNotFound'; runId: string }
  | {
      resultType: 'invalidTransition'
      run: RunRecord
      transition: RunTransition
    }

export class RunCoordinator {
  private readonly maxQueueSize: number
  private readonly createRunId: () => string
  private readonly createPromptId: () => string
  private readonly now: () => Date
  private readonly queuedRunsByRunId = new Map<string, QueuedRun>()
  private readonly runIdsBySessionId = new Map<string, string[]>()

  constructor(options: RunCoordinatorOptions) {
    this.maxQueueSize = options.maxQueueSize
    this.createRunId = options.createRunId ?? randomUUID
    this.createPromptId = options.createPromptId ?? randomUUID
    this.now = options.now ?? (() => new Date())
  }

  enqueue(input: RunEnqueueInput): RunEnqueueResult {
    const runId = input.runId ?? this.createRunId()
    if (this.queuedRunsByRunId.has(runId)) {
      return { resultType: 'duplicateRun', runId }
    }

    const queuedCount = this.countQueuedRuns(input.sessionId)
    if (queuedCount >= this.maxQueueSize) {
      return {
        resultType: 'queueFull',
        sessionId: input.sessionId,
        maxQueueSize: this.maxQueueSize,
        queuedCount,
      }
    }

    const queuedRun: QueuedRun = {
      run: {
        runId,
        sessionId: input.sessionId,
        promptId: this.createPromptId(),
        status: { type: 'queued', queuedAt: this.now().toISOString() },
      },
      prompt: input.prompt,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    }
    this.insertQueuedRun(queuedRun)
    return { resultType: 'enqueued', queuedRun }
  }

  restore(input: RunRestoreInput): RunRestoreResult {
    if (this.queuedRunsByRunId.has(input.run.runId)) {
      return { resultType: 'duplicateRun', runId: input.run.runId }
    }

    this.insertQueuedRun({ run: input.run, prompt: input.prompt ?? '' })
    return { resultType: 'restored', run: input.run }
  }

  startNext(sessionId: string, workerId: string): RunStartNextResult {
    const activeRun = this.findActiveRun(sessionId)
    if (activeRun) {
      return { resultType: 'sessionAlreadyRunning', queuedRun: activeRun }
    }

    const nextRun = this.findFirstRun(sessionId, 'queued')
    if (!nextRun) {
      return { resultType: 'queueEmpty', sessionId }
    }

    const transition: RunTransition = {
      type: 'start',
      workerId,
      startedAt: this.now().toISOString(),
    }
    const result = transitionRunStatus(nextRun.run.status, transition)
    if (result.resultType === 'invalidTransition') {
      return { resultType: 'queueEmpty', sessionId }
    }

    const queuedRun = this.replaceRunStatus(nextRun, result.status)
    return { resultType: 'started', queuedRun }
  }

  markWaitingForApproval(
    runId: string,
    approvalIds: string[],
  ): RunTerminalResult {
    return this.applyTransition(runId, {
      type: 'waitForApproval',
      approvalIds,
    })
  }

  complete(runId: string, stopReason: StopReason): RunTerminalResult {
    return this.applyTransition(runId, {
      type: 'complete',
      completedAt: this.now().toISOString(),
      stopReason,
    })
  }

  failStart(runId: string, error: ClassifiedError): RunTerminalResult {
    return this.applyTransition(runId, {
      type: 'startFailed',
      completedAt: this.now().toISOString(),
      error,
    })
  }

  fail(runId: string, error: ClassifiedError): RunTerminalResult {
    return this.applyTransition(runId, {
      type: 'fail',
      completedAt: this.now().toISOString(),
      error,
    })
  }

  cancel(runId: string, reason: string): RunTerminalResult {
    return this.applyTransition(runId, {
      type: 'cancel',
      completedAt: this.now().toISOString(),
      reason,
    })
  }

  interrupted(
    runId: string,
    reason: 'workerCrashed' | 'serverShutdown',
  ): RunTerminalResult {
    return this.applyTransition(runId, {
      type: 'interrupt',
      completedAt: this.now().toISOString(),
      reason,
    })
  }

  getRun(runId: string): RunRecord | undefined {
    return this.queuedRunsByRunId.get(runId)?.run
  }

  listRuns(sessionId: string): RunRecord[] {
    return this.getSessionQueuedRuns(sessionId).map(queuedRun => queuedRun.run)
  }

  private applyTransition(
    runId: string,
    transition: RunTransition,
  ): RunTerminalResult {
    const queuedRun = this.queuedRunsByRunId.get(runId)
    if (!queuedRun) {
      return { resultType: 'runNotFound', runId }
    }

    const result = transitionRunStatus(queuedRun.run.status, transition)
    if (result.resultType === 'invalidTransition') {
      return { resultType: 'invalidTransition', run: queuedRun.run, transition }
    }

    return {
      resultType: 'updated',
      run: this.replaceRunStatus(queuedRun, result.status).run,
    }
  }

  private replaceRunStatus(queuedRun: QueuedRun, status: RunStatus): QueuedRun {
    const updated: QueuedRun = {
      ...queuedRun,
      run: { ...queuedRun.run, status },
    }
    this.queuedRunsByRunId.set(updated.run.runId, updated)
    return updated
  }

  private insertQueuedRun(queuedRun: QueuedRun): void {
    this.queuedRunsByRunId.set(queuedRun.run.runId, queuedRun)
    const sessionRunIds =
      this.runIdsBySessionId.get(queuedRun.run.sessionId) ?? []
    sessionRunIds.push(queuedRun.run.runId)
    this.runIdsBySessionId.set(queuedRun.run.sessionId, sessionRunIds)
  }

  private countQueuedRuns(sessionId: string): number {
    return this.getSessionQueuedRuns(sessionId).filter(
      queuedRun => queuedRun.run.status.type === 'queued',
    ).length
  }

  private findActiveRun(sessionId: string): QueuedRun | undefined {
    return this.getSessionQueuedRuns(sessionId).find(queuedRun =>
      isActiveRunStatus(queuedRun.run.status),
    )
  }

  private findFirstRun(
    sessionId: string,
    statusType: RunStatus['type'],
  ): QueuedRun | undefined {
    return this.getSessionQueuedRuns(sessionId).find(
      queuedRun => queuedRun.run.status.type === statusType,
    )
  }

  private getSessionQueuedRuns(sessionId: string): QueuedRun[] {
    const runIds = this.runIdsBySessionId.get(sessionId) ?? []
    return runIds.flatMap(runId => {
      const queuedRun = this.queuedRunsByRunId.get(runId)
      return queuedRun ? [queuedRun] : []
    })
  }
}

export function transitionRunStatus(
  status: RunStatus,
  transition: RunTransition,
): RunTransitionResult {
  switch (transition.type) {
    case 'start':
      if (status.type !== 'queued') {
        return { resultType: 'invalidTransition', from: status, transition }
      }
      return {
        resultType: 'transitioned',
        status: {
          type: 'running',
          startedAt: transition.startedAt,
          workerId: transition.workerId,
        },
      }

    case 'waitForApproval':
      if (status.type !== 'running' && status.type !== 'waitingForApproval') {
        return { resultType: 'invalidTransition', from: status, transition }
      }
      return {
        resultType: 'transitioned',
        status: {
          type: 'waitingForApproval',
          approvalIds: transition.approvalIds,
        },
      }

    case 'complete':
      if (!isWorkerOwnedRunStatus(status)) {
        return { resultType: 'invalidTransition', from: status, transition }
      }
      return {
        resultType: 'transitioned',
        status: {
          type: 'completed',
          completedAt: transition.completedAt,
          stopReason: transition.stopReason,
        },
      }

    case 'cancel':
      if (!isNonTerminalRunStatus(status)) {
        return { resultType: 'invalidTransition', from: status, transition }
      }
      return {
        resultType: 'transitioned',
        status: {
          type: 'cancelled',
          completedAt: transition.completedAt,
          reason: transition.reason,
        },
      }

    case 'startFailed':
      if (status.type !== 'queued') {
        return { resultType: 'invalidTransition', from: status, transition }
      }
      return {
        resultType: 'transitioned',
        status: {
          type: 'failed',
          completedAt: transition.completedAt,
          error: transition.error,
        },
      }

    case 'fail':
      if (!isWorkerOwnedRunStatus(status)) {
        return { resultType: 'invalidTransition', from: status, transition }
      }
      return {
        resultType: 'transitioned',
        status: {
          type: 'failed',
          completedAt: transition.completedAt,
          error: transition.error,
        },
      }

    case 'interrupt':
      if (!isNonTerminalRunStatus(status)) {
        return { resultType: 'invalidTransition', from: status, transition }
      }
      return {
        resultType: 'transitioned',
        status: {
          type: 'interrupted',
          completedAt: transition.completedAt,
          reason: transition.reason,
        },
      }
  }
}

function isActiveRunStatus(status: RunStatus): boolean {
  return isWorkerOwnedRunStatus(status)
}

function isWorkerOwnedRunStatus(status: RunStatus): boolean {
  return status.type === 'running' || status.type === 'waitingForApproval'
}

function isNonTerminalRunStatus(status: RunStatus): boolean {
  return status.type === 'queued' || isWorkerOwnedRunStatus(status)
}
