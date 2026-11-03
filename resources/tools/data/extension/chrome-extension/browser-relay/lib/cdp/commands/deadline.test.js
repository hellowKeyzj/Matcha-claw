import { describe, expect, test } from 'bun:test'

import {
  CommandDeadlineExceededError,
  DEFAULT_CDP_OPERATION_TIMEOUT_MS,
  DEFAULT_COMMAND_DEADLINE_MS,
  LONG_COMMAND_DEADLINE_MS,
  RELAY_RESPONSE_GRACE_MS,
  awaitWithDeadline,
  createCommandContext,
  getCdpOperationTimeoutMs,
  getCommandDeadlineMs,
  serializeCommandDeadlineError,
} from './deadline.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('command deadline', () => {
  test('classifies normal and long-running commands', () => {
    expect(getCommandDeadlineMs('Runtime.evaluate')).toBe(DEFAULT_COMMAND_DEADLINE_MS)
    expect(getCommandDeadlineMs('Page.captureScreenshot')).toBe(LONG_COMMAND_DEADLINE_MS)
    expect(getCommandDeadlineMs('Accessibility.getFullAXTree')).toBe(LONG_COMMAND_DEADLINE_MS)
    expect(getCdpOperationTimeoutMs('Runtime.evaluate')).toBe(DEFAULT_CDP_OPERATION_TIMEOUT_MS)
    expect(getCdpOperationTimeoutMs('Page.captureScreenshot')).toBe(LONG_COMMAND_DEADLINE_MS)
    expect(getCdpOperationTimeoutMs('Accessibility.getFullAXTree')).toBe(
      LONG_COMMAND_DEADLINE_MS,
    )
    expect(DEFAULT_CDP_OPERATION_TIMEOUT_MS).toBe(10_000)
    expect(RELAY_RESPONSE_GRACE_MS).toBe(2_000)
  })

  test('uses the relay deadline without exceeding the local command limit', () => {
    let now = 1_000
    const context = createCommandContext({
      requestId: 7,
      method: 'Runtime.evaluate',
      sentAt: 500,
      deadlineAt: 50_000,
      now: () => now,
    })

    expect(context.deadlineAt).toBe(500 + DEFAULT_COMMAND_DEADLINE_MS)
    expect(context.deadlineSource).toBe('local_cap')
    expect(context.ageMs()).toBe(500)
    expect(context.remainingMs()).toBe(29_500)

    now = context.deadlineAt
    expect(context.isExpired()).toBe(true)
    expect(context.remainingMs()).toBe(0)
  })

  test('derives a local deadline for an old relay payload', () => {
    const context = createCommandContext({
      requestId: 8,
      method: 'Page.captureScreenshot',
      sentAt: 10_000,
      now: () => 12_000,
    })

    expect(context.deadlineAt).toBe(10_000 + LONG_COMMAND_DEADLINE_MS)
    expect(context.deadlineSource).toBe('local_fallback')
    expect(context.remainingMs()).toBe(58_000)
  })

  test('returns a completed operation before its deadline', async () => {
    const context = createCommandContext({
      requestId: 9,
      method: 'Runtime.evaluate',
      sentAt: Date.now(),
    })

    await expect(awaitWithDeadline(context, 'Runtime.evaluate', () => Promise.resolve(42))).resolves.toBe(
      42,
    )
  })

  test('serializes only stable deadline diagnostics', () => {
    const context = createCommandContext({
      requestId: 13,
      method: 'Runtime.evaluate',
      sentAt: 1_000,
      deadlineAt: 2_000,
      now: () => 2_100,
    })
    const error = new CommandDeadlineExceededError({
      context,
      stage: 'chrome.debugger.sendCommand:Runtime.evaluate',
      operationElapsedMs: 900,
      timeoutSource: 'command_deadline',
    })

    expect(serializeCommandDeadlineError(error)).toEqual({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      message: 'Command Runtime.evaluate timed out at chrome.debugger.sendCommand:Runtime.evaluate',
      requestId: 13,
      method: 'Runtime.evaluate',
      stage: 'chrome.debugger.sendCommand:Runtime.evaluate',
      operationElapsedMs: 900,
      commandAgeMs: 1_100,
      deadlineAt: 2_000,
      deadlineSource: 'relay',
      timeoutSource: 'command_deadline',
      outcome: 'unknown',
      retryable: false,
    })
    expect(() => serializeCommandDeadlineError(new Error('no'))).toThrow(
      'CommandDeadlineExceededError is required',
    )
  })

  test('rejects an unsettled operation at the leaf wait limit', async () => {
    const operation = deferred()
    const context = createCommandContext({
      requestId: 10,
      method: 'Runtime.evaluate',
      sentAt: Date.now(),
    })

    await expect(
      awaitWithDeadline(context, 'Runtime.evaluate', () => operation.promise, { maxWaitMs: 5 }),
    ).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      requestId: 10,
      method: 'Runtime.evaluate',
      stage: 'Runtime.evaluate',
      timeoutSource: 'operation_limit',
      outcome: 'unknown',
      retryable: false,
    })

    operation.reject(new Error('late failure'))
    await Promise.resolve()
  })

  test('does not start an operation after the command deadline', async () => {
    let operationStarted = false
    const context = createCommandContext({
      requestId: 11,
      method: 'Runtime.evaluate',
      sentAt: 1,
      deadlineAt: 2,
      now: () => 3,
    })

    let caught
    try {
      await awaitWithDeadline(context, 'before_dispatch', () => {
        operationStarted = true
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CommandDeadlineExceededError)
    expect(caught).toMatchObject({ timeoutSource: 'command_deadline' })
    expect(operationStarted).toBe(false)
  })

  test('requires a deferred operation function', async () => {
    const context = createCommandContext({
      requestId: 12,
      method: 'Runtime.evaluate',
      sentAt: Date.now(),
    })

    await expect(
      awaitWithDeadline(context, 'Runtime.evaluate', Promise.resolve()),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      awaitWithDeadline(context, 'Runtime.evaluate', () => Promise.resolve()),
    ).resolves.toBeUndefined()
  })
})
