import { CommandDeadlineExceededError, awaitWithDeadline } from './deadline.js'
import { createLogger } from '../../logger.js'
import { recordCommandDiagnostic } from './diagnostics.js'

const DEFAULT_NORMAL_QUEUE_LIMIT = 100
const DEFAULT_UNBLOCK_CONCURRENCY = 8
const DEFAULT_UNBLOCK_QUEUE_LIMIT = 256
const TELEMETRY_WINDOW_SIZE = 40
const SLOW_QUEUE_WAIT_MS = 500
const SLOW_EXECUTION_MS = 5_000
const log = createLogger('cdp:queue')

function recordQueueDiagnostic(queue, scheduled, outcome, queueWaitMs) {
  recordCommandDiagnostic({
    requestId: scheduled.commandContext?.requestId,
    tabId: queue.tabId,
    method: scheduled.method,
    lane: scheduled.lane,
    outcome,
    stage: 'tab_command.queue_wait',
    queueWaitMs,
    extensionTotalMs: queueWaitMs,
    deadlineSource: scheduled.commandContext?.deadlineSource,
    timeoutSource: outcome === 'timeout' ? 'command_deadline' : undefined,
  })
}

function durationSummary(values) {
  if (!values.length) return { count: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: values.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted[sorted.length - 1],
    lastMs: values.at(-1),
  }
}

function recordDuration(values, durationMs) {
  values.push(Math.max(0, durationMs))
  if (values.length > TELEMETRY_WINDOW_SIZE) values.shift()
}

function newLaneTelemetry() {
  return { queueWaitMs: [], executionMs: [], completed: 0, failed: 0,
    expired: 0, overloaded: 0, cancelled: 0 }
}

export class TabCommandQueueClosedError extends Error {
  constructor({ tabId, generation, reason, method }) {
    super(
      `Tab ${tabId} command queue generation ${generation} closed (${reason}) ` +
        `[tabQueueError code=closed reason=${reason}]`,
    )
    this.name = 'TabCommandQueueClosedError'
    this.code = 'tab_command_queue.closed'
    this.tabId = tabId
    this.generation = generation
    this.reason = reason
    this.method = method
  }
}

export class TabCommandQueueOverloadedError extends Error {
  constructor({ tabId, generation, lane, limit }) {
    const message =
      lane === 'normal'
        ? `Tab ${tabId} command queue full (${limit})`
        : `Tab ${tabId} unblock command queue full (${limit})`
    super(`${message} [tabQueueError code=overloaded lane=${lane}]`)
    this.name = 'TabCommandQueueOverloadedError'
    this.code = 'tab_command_queue.overloaded'
    this.tabId = tabId
    this.generation = generation
    this.lane = lane
    this.limit = limit
  }
}

export function createTabCommandScheduler({
  normalQueueLimit = DEFAULT_NORMAL_QUEUE_LIMIT,
  unblockConcurrency = DEFAULT_UNBLOCK_CONCURRENCY,
  unblockQueueLimit = DEFAULT_UNBLOCK_QUEUE_LIMIT,
} = {}) {
  return new TabCommandScheduler({ normalQueueLimit, unblockConcurrency, unblockQueueLimit })
}

export class TabCommandScheduler {
  #normalQueueLimit
  #unblockConcurrency
  #unblockQueueLimit
  #generationSequence = 0
  #openQueues = new Map()
  #nativeSettlements = new Map()

  constructor({ normalQueueLimit, unblockConcurrency, unblockQueueLimit }) {
    if (!Number.isInteger(normalQueueLimit) || normalQueueLimit < 0) {
      throw new TypeError('normalQueueLimit must be a non-negative integer')
    }
    if (!Number.isInteger(unblockConcurrency) || unblockConcurrency < 1) {
      throw new TypeError('unblockConcurrency must be a positive integer')
    }
    if (!Number.isInteger(unblockQueueLimit) || unblockQueueLimit < 0) {
      throw new TypeError('unblockQueueLimit must be a non-negative integer')
    }
    this.#normalQueueLimit = normalQueueLimit
    this.#unblockConcurrency = unblockConcurrency
    this.#unblockQueueLimit = unblockQueueLimit
  }

  schedule(
    tabId,
    {
      lane = 'normal',
      method = '',
      attachmentSessionId,
      commandSessionId,
      commandContext,
      completesAfterOwnTabClose = false,
      task,
    },
  ) {
    if (lane !== 'normal' && lane !== 'unblock') {
      return Promise.reject(new TypeError(`Unknown tab command lane: ${lane}`))
    }
    if (typeof attachmentSessionId !== 'string' || attachmentSessionId.length === 0) {
      return Promise.reject(new TypeError('attachmentSessionId is required'))
    }
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('task must be a function'))
    }

    const queue = this.#getOrCreateQueue(tabId, attachmentSessionId)
    if (queue.attachmentSessionId !== attachmentSessionId) {
      return Promise.reject(
        new TabCommandQueueClosedError({
          tabId,
          generation: queue.generation,
          reason: 'attachment_session_changed',
          method,
        }),
      )
    }

    const waiting = lane === 'normal' ? queue.normalWaiting : queue.unblockWaiting
    const hasCapacity =
      lane === 'normal'
        ? queue.normalActive === null
        : queue.unblockActive.size < this.#unblockConcurrency
    const waitingLimit = lane === 'normal' ? this.#normalQueueLimit : this.#unblockQueueLimit

    if (!hasCapacity && waiting.length >= waitingLimit) {
      queue.telemetry[lane].overloaded++
      const error = new TabCommandQueueOverloadedError({
        tabId,
        generation: queue.generation,
        lane,
        limit: waitingLimit,
      })
      log.warn('command queue overloaded', {
        tabId, generation: queue.generation, lane, method,
        requestId: commandContext?.requestId, waiting: waiting.length, limit: waitingLimit,
      })
      recordCommandDiagnostic({
        requestId: commandContext?.requestId, tabId, method, lane,
        outcome: 'overloaded', stage: 'tab_command.queue_wait',
        queueWaitMs: 0, extensionTotalMs: 0,
        deadlineSource: commandContext?.deadlineSource,
      })
      if (lane === 'unblock') this.#closeQueue(queue, 'unblock_overflow')
      return Promise.reject(error)
    }

    let resolveExternal
    let rejectExternal
    const externalPromise = new Promise((resolve, reject) => {
      resolveExternal = resolve
      rejectExternal = reject
    })
    const scheduled = {
      lane,
      method,
      attachmentSessionId,
      commandSessionId,
      commandContext,
      completesAfterOwnTabClose,
      task,
      resolveExternal,
      rejectExternal,
      externalSettled: false,
      queuedAt: Date.now(),
      startedAt: undefined,
      waitTimer: undefined,
    }

    if (hasCapacity) {
      this.#startTask(queue, scheduled)
    } else {
      waiting.push(scheduled)
      if (commandContext) {
        scheduled.waitTimer = setTimeout(
          () => this.#expireWaitingTask(queue, scheduled),
          commandContext.remainingMs(),
        )
      }
      if (lane === 'normal') {
        queue.maxNormalWaiting = Math.max(queue.maxNormalWaiting, waiting.length)
      } else {
        queue.maxUnblockWaiting = Math.max(queue.maxUnblockWaiting, waiting.length)
      }
    }
    return externalPromise
  }

  closeTab(tabId, reason, { expectedGeneration, expectedAttachmentSessionId } = {}) {
    const queue = this.#openQueues.get(tabId)
    if (!queue) return false
    if (expectedGeneration !== undefined && queue.generation !== expectedGeneration) return false
    if (
      expectedAttachmentSessionId !== undefined &&
      queue.attachmentSessionId !== expectedAttachmentSessionId
    )
      return false
    this.#closeQueue(queue, reason)
    return true
  }

  closeAll(reason) {
    const queues = [...this.#openQueues.values()]
    for (const queue of queues) this.#closeQueue(queue, reason)
  }

  async drainTabs(tabIds) {
    const ids = [...new Set(tabIds)]
    const tasks = ids.flatMap((tabId) => {
      const queue = this.#openQueues.get(tabId)
      return queue ? [queue.normalActive, ...queue.unblockActive].flatMap((task) => task?.settlement ? [task.settlement] : []) : []
    })
    for (const tabId of ids) this.closeTab(tabId, 'session_cleanup')
    await Promise.allSettled(tasks)
    while (true) {
      const pending = ids.map((tabId) => this.#nativeSettlements.get(tabId)).filter(Boolean)
      if (!pending.length) return
      await Promise.allSettled(pending)
    }
  }

  isCurrent(tabId, generation, attachmentSessionId) {
    const queue = this.#openQueues.get(tabId)
    return Boolean(
      queue &&
        queue.state === 'open' &&
        queue.generation === generation &&
        queue.attachmentSessionId === attachmentSessionId,
    )
  }

  canDetachGeneration(tabId, generation, attachmentSessionId) {
    const queue = this.#openQueues.get(tabId)
    if (!queue) return true
    return queue.generation === generation && queue.attachmentSessionId === attachmentSessionId
  }

  getSnapshot(tabId) {
    const queue = this.#openQueues.get(tabId)
    if (!queue) return null
    return {
      tabId,
      generation: queue.generation,
      attachmentSessionId: queue.attachmentSessionId,
      state: queue.state,
      normalActive: queue.normalActive ? 1 : 0,
      normalWaiting: queue.normalWaiting.length,
      unblockActive: queue.unblockActive.size,
      unblockWaiting: queue.unblockWaiting.length,
      maxNormalWaiting: queue.maxNormalWaiting,
      maxUnblockWaiting: queue.maxUnblockWaiting,
      unblockBypassCount: queue.unblockBypassCount,
      lateResultIgnoredCount: queue.lateResultIgnoredCount,
      telemetry: Object.fromEntries(['normal', 'unblock'].map((lane) => [lane, {
        queueWaitMs: durationSummary(queue.telemetry[lane].queueWaitMs),
        executionMs: durationSummary(queue.telemetry[lane].executionMs),
        completed: queue.telemetry[lane].completed,
        failed: queue.telemetry[lane].failed,
        expired: queue.telemetry[lane].expired,
        overloaded: queue.telemetry[lane].overloaded,
        cancelled: queue.telemetry[lane].cancelled,
      }])),
      closedReason: queue.closeReason,
    }
  }

  #getOrCreateQueue(tabId, attachmentSessionId) {
    let queue = this.#openQueues.get(tabId)
    if (queue) return queue
    queue = {
      tabId,
      generation: ++this.#generationSequence,
      attachmentSessionId,
      state: 'open',
      closeReason: undefined,
      normalActive: null,
      normalWaiting: [],
      unblockActive: new Set(),
      unblockWaiting: [],
      abortController: new AbortController(),
      maxNormalWaiting: 0,
      maxUnblockWaiting: 0,
      unblockBypassCount: 0,
      lateResultIgnoredCount: 0,
      telemetry: { normal: newLaneTelemetry(), unblock: newLaneTelemetry() },
      lastSummaryAt: Date.now(),
    }
    this.#openQueues.set(tabId, queue)
    return queue
  }

  #startTask(queue, scheduled) {
    if (scheduled.waitTimer !== undefined) {
      clearTimeout(scheduled.waitTimer)
      scheduled.waitTimer = undefined
    }
    if (queue.state !== 'open') {
      this.#rejectTask(scheduled, this.#closedError(queue, scheduled.method))
      return false
    }
    if (scheduled.commandContext?.isExpired()) {
      queue.telemetry[scheduled.lane].expired++
      log.warn('command queue deadline', {
        tabId: queue.tabId, generation: queue.generation, lane: scheduled.lane,
        method: scheduled.method, requestId: scheduled.commandContext?.requestId,
        queueWaitMs: Math.max(0, Date.now() - scheduled.queuedAt),
      })
      recordQueueDiagnostic(queue, scheduled, 'timeout', Math.max(0, Date.now() - scheduled.queuedAt))
      this.#rejectTask(scheduled, this.#deadlineError(scheduled))
      return false
    }

    scheduled.startedAt = Date.now()
    const queueWaitMs = Math.max(0, scheduled.startedAt - scheduled.queuedAt)
    recordDuration(queue.telemetry[scheduled.lane].queueWaitMs, queueWaitMs)
    if (queueWaitMs >= SLOW_QUEUE_WAIT_MS) {
      log.warn('slow command queue wait', {
        tabId: queue.tabId, generation: queue.generation, lane: scheduled.lane,
        method: scheduled.method, requestId: scheduled.commandContext?.requestId,
        queueWaitMs,
        normalWaiting: queue.normalWaiting.length, unblockWaiting: queue.unblockWaiting.length,
      })
    }

    if (scheduled.lane === 'normal') {
      queue.normalActive = scheduled
    } else {
      queue.unblockActive.add(scheduled)
      if (queue.normalActive) queue.unblockBypassCount++
    }

    if (scheduled.commandContext) {
      scheduled.commandContext.onNativeOperation = (operation) => {
        this.holdNativeSettlement(queue.tabId, operation)
      }
    }
    const run = () => {
      if (!this.isCurrent(queue.tabId, queue.generation, scheduled.attachmentSessionId)) {
        throw this.#closedError(queue, scheduled.method)
      }
      return scheduled.task({
        signal: queue.abortController.signal,
        generation: queue.generation,
        attachmentSessionId: scheduled.attachmentSessionId,
        commandSessionId: scheduled.commandSessionId,
        commandContext: scheduled.commandContext,
        queuedAt: scheduled.queuedAt,
        queueWaitMs,
      })
    }
    let result
    try {
      const settlement = scheduled.lane === 'normal'
        ? this.#nativeSettlements.get(queue.tabId)
        : null
      result = settlement
        ? (async () => {
            let pending = settlement
            while (pending) {
              if (scheduled.commandContext) {
                await awaitWithDeadline(scheduled.commandContext, 'tab_command.native_settlement', () => pending)
              } else {
                await pending
              }
              pending = this.#nativeSettlements.get(queue.tabId)
            }
            return run()
          })()
        : run()
    } catch (error) {
      result = Promise.reject(error)
    }

    scheduled.settlement = Promise.resolve(result)
    scheduled.settlement.then(
      (value) => this.#settleAndFinishTask(queue, scheduled, true, value),
      (error) => this.#settleAndFinishTask(queue, scheduled, false, error),
    )
    return true
  }

  #expireWaitingTask(queue, scheduled) {
    if (queue.state !== 'open' || scheduled.externalSettled) return
    const waiting = scheduled.lane === 'normal' ? queue.normalWaiting : queue.unblockWaiting
    const index = waiting.indexOf(scheduled)
    if (index < 0) return
    waiting.splice(index, 1)
    queue.telemetry[scheduled.lane].expired++
    log.warn('command queue deadline', {
      tabId: queue.tabId, generation: queue.generation, lane: scheduled.lane,
      method: scheduled.method, requestId: scheduled.commandContext?.requestId,
      queueWaitMs: Math.max(0, Date.now() - scheduled.queuedAt),
    })
    recordQueueDiagnostic(queue, scheduled, 'timeout', Math.max(0, Date.now() - scheduled.queuedAt))
    this.#rejectTask(scheduled, this.#deadlineError(scheduled))
  }

  #deadlineError(scheduled) {
    return new CommandDeadlineExceededError({
      context: scheduled.commandContext,
      stage: 'tab_command.queue_wait',
      operationElapsedMs: Math.max(0, Date.now() - scheduled.queuedAt),
      timeoutSource: 'command_deadline',
    })
  }

  holdNativeSettlement(tabId, operation) {
    const previous = this.#nativeSettlements.get(tabId)
    const settlement = Promise.allSettled(previous ? [previous, operation] : [operation])
    this.#nativeSettlements.set(tabId, settlement)
    void settlement.then(() => {
      if (this.#nativeSettlements.get(tabId) === settlement) this.#nativeSettlements.delete(tabId)
    })
  }

  #settleAndFinishTask(queue, scheduled, succeeded, result) {
    const executionMs = Math.max(0, Date.now() - (scheduled.startedAt ?? Date.now()))
    const telemetry = queue.telemetry[scheduled.lane]
    recordDuration(telemetry.executionMs, executionMs)
    if (succeeded) telemetry.completed++
    else telemetry.failed++
    const completedCount = queue.telemetry.normal.completed + queue.telemetry.normal.failed +
      queue.telemetry.unblock.completed + queue.telemetry.unblock.failed
    if (completedCount % 50 === 0 && Date.now() - queue.lastSummaryAt >= 30_000) {
      queue.lastSummaryAt = Date.now()
      log.warn('command queue summary', {
        tabId: queue.tabId, generation: queue.generation, completedCount,
        normal: {
          queueWaitMs: durationSummary(queue.telemetry.normal.queueWaitMs),
          executionMs: durationSummary(queue.telemetry.normal.executionMs),
          expired: queue.telemetry.normal.expired,
          cancelled: queue.telemetry.normal.cancelled,
        },
        unblock: {
          queueWaitMs: durationSummary(queue.telemetry.unblock.queueWaitMs),
          executionMs: durationSummary(queue.telemetry.unblock.executionMs),
          expired: queue.telemetry.unblock.expired,
          cancelled: queue.telemetry.unblock.cancelled,
        },
        maxNormalWaiting: queue.maxNormalWaiting,
        maxUnblockWaiting: queue.maxUnblockWaiting,
      })
    }
    if (executionMs >= SLOW_EXECUTION_MS) {
      log.warn('slow command execution', {
        tabId: queue.tabId, generation: queue.generation, lane: scheduled.lane,
        method: scheduled.method, requestId: scheduled.commandContext?.requestId,
        queueWaitMs: Math.max(0, (scheduled.startedAt ?? scheduled.queuedAt) - scheduled.queuedAt),
        executionMs, outcome: succeeded ? 'success' : 'failure',
      })
    }
    if (queue.state === 'open') this.#settleTask(scheduled, succeeded, result)
    const settlement = scheduled.lane === 'normal'
      ? scheduled.commandContext?.waitForNativeSettlement?.()
      : null
    if (settlement) {
      void settlement.then(() => this.#finishTask(queue, scheduled, succeeded, result))
    } else {
      this.#finishTask(queue, scheduled, succeeded, result)
    }
  }

  #finishTask(queue, scheduled, succeeded, result) {
    if (scheduled.lane === 'normal') {
      if (queue.normalActive === scheduled) queue.normalActive = null
    } else {
      queue.unblockActive.delete(scheduled)
    }

    if (queue.state === 'closed') {
      if (
        scheduled.completesAfterOwnTabClose &&
        queue.closeReason === 'tab_closed' &&
        !scheduled.externalSettled
      ) {
        this.#settleTask(scheduled, succeeded, result)
      } else {
        queue.lateResultIgnoredCount++
        log.warn('late command result ignored', {
          tabId: queue.tabId, generation: queue.generation, lane: scheduled.lane,
          method: scheduled.method, requestId: scheduled.commandContext?.requestId,
          executionMs: Math.max(0, Date.now() - (scheduled.startedAt ?? Date.now())),
          closeReason: queue.closeReason,
        })
      }
      return
    }

    this.#settleTask(scheduled, succeeded, result)
    this.#pumpLane(queue, scheduled.lane)
  }

  #pumpLane(queue, lane) {
    if (queue.state !== 'open') return
    if (lane === 'normal') {
      while (!queue.normalActive && queue.normalWaiting.length > 0) {
        if (this.#startTask(queue, queue.normalWaiting.shift())) return
      }
      return
    }
    while (
      queue.state === 'open' &&
      queue.unblockActive.size < this.#unblockConcurrency &&
      queue.unblockWaiting.length > 0
    ) {
      this.#startTask(queue, queue.unblockWaiting.shift())
    }
  }

  #closeQueue(queue, reason) {
    if (queue.state === 'closed') return
    const activeAtClose = (queue.normalActive ? 1 : 0) + queue.unblockActive.size
    const waitingAtClose = queue.normalWaiting.length + queue.unblockWaiting.length
    queue.state = 'closed'
    queue.closeReason = reason
    if (this.#openQueues.get(queue.tabId) === queue) this.#openQueues.delete(queue.tabId)
    queue.abortController.abort(reason)

    for (const scheduled of queue.normalWaiting.splice(0)) {
      queue.telemetry.normal.cancelled++
      this.#rejectTask(scheduled, this.#closedError(queue, scheduled.method))
    }
    for (const scheduled of queue.unblockWaiting.splice(0)) {
      queue.telemetry.unblock.cancelled++
      this.#rejectTask(scheduled, this.#closedError(queue, scheduled.method))
    }
    if (
      queue.normalActive &&
      (!queue.normalActive.completesAfterOwnTabClose || reason !== 'tab_closed')
    ) {
      queue.telemetry.normal.cancelled++
      this.#rejectTask(queue.normalActive, this.#closedError(queue, queue.normalActive.method))
    }
    for (const scheduled of queue.unblockActive) {
      if (!scheduled.completesAfterOwnTabClose || reason !== 'tab_closed') {
        queue.telemetry.unblock.cancelled++
        this.#rejectTask(scheduled, this.#closedError(queue, scheduled.method))
      }
    }
    if (activeAtClose || waitingAtClose) {
      log.warn('command queue closed', {
        tabId: queue.tabId, generation: queue.generation, reason,
        activeAtClose, waitingAtClose,
        normalCancelled: queue.telemetry.normal.cancelled,
        unblockCancelled: queue.telemetry.unblock.cancelled,
        normalQueueWaitMs: durationSummary(queue.telemetry.normal.queueWaitMs),
        unblockQueueWaitMs: durationSummary(queue.telemetry.unblock.queueWaitMs),
      })
    }
  }

  #closedError(queue, method) {
    return new TabCommandQueueClosedError({
      tabId: queue.tabId,
      generation: queue.generation,
      reason: queue.closeReason || 'closed',
      method,
    })
  }

  #settleTask(scheduled, succeeded, result) {
    if (scheduled.externalSettled) return
    if (scheduled.waitTimer !== undefined) {
      clearTimeout(scheduled.waitTimer)
      scheduled.waitTimer = undefined
    }
    scheduled.externalSettled = true
    if (succeeded) scheduled.resolveExternal(result)
    else scheduled.rejectExternal(result)
  }

  #rejectTask(scheduled, error) {
    this.#settleTask(scheduled, false, error)
  }
}
