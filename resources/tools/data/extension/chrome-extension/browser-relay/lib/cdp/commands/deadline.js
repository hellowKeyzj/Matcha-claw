export const DEFAULT_COMMAND_DEADLINE_MS = 30_000
export const LONG_COMMAND_DEADLINE_MS = 60_000
export const RELAY_RESPONSE_GRACE_MS = 2_000
export const DEFAULT_CDP_OPERATION_TIMEOUT_MS = 10_000

export const LONG_RUNNING_METHODS = new Set([
  'Page.captureScreenshot',
  'Extension.captureViewport',
  'Accessibility.getFullAXTree',
])

export class CommandDeadlineExceededError extends Error {
  constructor({ context, stage, operationElapsedMs, timeoutSource }) {
    super(`Command ${context.method} timed out at ${stage}`)
    this.name = 'CommandDeadlineExceededError'
    this.code = 'COMMAND_DEADLINE_EXCEEDED'
    this.requestId = context.requestId
    this.method = context.method
    this.stage = stage
    this.operationElapsedMs = operationElapsedMs
    this.commandAgeMs = context.ageMs()
    this.deadlineAt = context.deadlineAt
    this.deadlineSource = context.deadlineSource
    this.timeoutSource = timeoutSource
    this.outcome = 'unknown'
    this.retryable = false
  }
}

export function serializeCommandDeadlineError(error) {
  if (!(error instanceof CommandDeadlineExceededError)) {
    throw new TypeError('CommandDeadlineExceededError is required')
  }
  return {
    code: error.code,
    message: error.message,
    requestId: error.requestId,
    method: error.method,
    stage: error.stage,
    operationElapsedMs: error.operationElapsedMs,
    commandAgeMs: error.commandAgeMs,
    deadlineAt: error.deadlineAt,
    deadlineSource: error.deadlineSource,
    timeoutSource: error.timeoutSource,
    outcome: error.outcome,
    retryable: error.retryable,
  }
}

export function getCommandDeadlineMs(method) {
  return LONG_RUNNING_METHODS.has(method)
    ? LONG_COMMAND_DEADLINE_MS
    : DEFAULT_COMMAND_DEADLINE_MS
}

export function getCdpOperationTimeoutMs(method) {
  return LONG_RUNNING_METHODS.has(method)
    ? LONG_COMMAND_DEADLINE_MS
    : DEFAULT_CDP_OPERATION_TIMEOUT_MS
}

export function createCommandContext({
  requestId,
  method,
  sentAt,
  deadlineAt,
  now = Date.now,
}) {
  const receivedAt = now()
  const normalizedSentAt = Number.isFinite(sentAt) ? sentAt : receivedAt
  const localDeadlineAt = normalizedSentAt + getCommandDeadlineMs(method)
  const hasRelayDeadline = Number.isFinite(deadlineAt) && deadlineAt > 0
  const resolvedDeadlineAt = hasRelayDeadline
    ? Math.min(deadlineAt, localDeadlineAt)
    : localDeadlineAt
  const deadlineSource = !hasRelayDeadline
    ? 'local_fallback'
    : deadlineAt <= localDeadlineAt
      ? 'relay'
      : 'local_cap'

  let timeoutError
  const nativeOperations = new Set()

  return {
    throwIfTimedOut() {
      if (timeoutError) throw timeoutError
    },
    markTimedOut(error) {
      timeoutError ??= error
    },
    trackNativeOperation(operation) {
      nativeOperations.add(operation)
      this.onNativeOperation?.(operation)
      void operation.then(
        () => nativeOperations.delete(operation),
        () => nativeOperations.delete(operation),
      )
    },
    waitForNativeSettlement() {
      return nativeOperations.size ? Promise.allSettled([...nativeOperations]) : null
    },
    requestId,
    method,
    sentAt: normalizedSentAt,
    receivedAt,
    deadlineAt: resolvedDeadlineAt,
    deadlineSource,
    ageMs: () => Math.max(0, now() - normalizedSentAt),
    remainingMs: () => Math.max(0, resolvedDeadlineAt - now()),
    isExpired: () => now() >= resolvedDeadlineAt,
  }
}

export async function awaitWithDeadline(context, stage, operation, { maxWaitMs } = {}) {
  if (typeof stage !== 'string' || stage.length === 0) {
    throw new TypeError('stage is required')
  }
  if (typeof operation !== 'function') {
    throw new TypeError('operation must be a function')
  }

  context.throwIfTimedOut?.()
  context.assertCurrent?.()
  const isNativeOperation = stage.startsWith('chrome.')
  const operationLimit = Number.isFinite(maxWaitMs) ? Math.max(0, maxWaitMs) : Infinity
  const operationStartedAt = Date.now()
  const remainingMs = context.remainingMs()
  const waitMs = Math.min(remainingMs, operationLimit)
  const timeoutSource = waitMs < remainingMs ? 'operation_limit' : 'command_deadline'

  if (waitMs <= 0) {
    throw new CommandDeadlineExceededError({
      context,
      stage,
      operationElapsedMs: 0,
      timeoutSource,
    })
  }

  let timer
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        context.throwIfTimedOut?.()
        context.assertCurrent?.()
        if (context.isExpired()) {
          throw new CommandDeadlineExceededError({
            context,
            stage,
            operationElapsedMs: Date.now() - operationStartedAt,
            timeoutSource: 'command_deadline',
          })
        }
        const result = Promise.resolve(operation())
        if (isNativeOperation) context.trackNativeOperation?.(result)
        return result
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new CommandDeadlineExceededError({
              context,
              stage,
              operationElapsedMs: Date.now() - operationStartedAt,
              timeoutSource,
            }),
          )
        }, waitMs)
      }),
    ])
    if (context.isExpired()) {
      throw new CommandDeadlineExceededError({
        context,
        stage,
        operationElapsedMs: Date.now() - operationStartedAt,
        timeoutSource: 'command_deadline',
      })
    }
    context.throwIfTimedOut?.()
    context.assertCurrent?.()
    return result
  } catch (error) {
    if (error instanceof CommandDeadlineExceededError && error.timeoutSource === 'command_deadline') {
      context.markTimedOut?.(error)
    }
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
