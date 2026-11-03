import { describe, expect, test } from 'bun:test'

import { createCommandContext } from './deadline.js'
import {
  TabCommandQueueClosedError,
  TabCommandQueueOverloadedError,
  createTabCommandScheduler,
} from './tab-command-scheduler.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function schedule(scheduler, tabId, options = {}) {
  return scheduler.schedule(tabId, {
    lane: 'normal',
    method: 'Runtime.evaluate',
    attachmentSessionId: `session-${tabId}`,
    task: () => undefined,
    ...options,
  })
}

describe('TabCommandScheduler', () => {
  test('keeps normal commands FIFO per tab while different tabs run independently', async () => {
    const scheduler = createTabCommandScheduler()
    const first = deferred()
    const order = []

    const firstPromise = schedule(scheduler, 1, {
      task: async () => {
        order.push('tab-1-first-start')
        await first.promise
        order.push('tab-1-first-end')
      },
    })
    const secondPromise = schedule(scheduler, 1, {
      task: () => order.push('tab-1-second'),
    })
    const otherTabPromise = schedule(scheduler, 2, {
      task: () => order.push('tab-2'),
    })

    await otherTabPromise
    expect(order).toEqual(['tab-1-first-start', 'tab-2'])
    first.resolve()
    await Promise.all([firstPromise, secondPromise])
    expect(order).toEqual(['tab-1-first-start', 'tab-2', 'tab-1-first-end', 'tab-1-second'])
  })

  test('removes a command that expires while waiting without running it', async () => {
    const scheduler = createTabCommandScheduler()
    const active = deferred()
    let waitingCalled = false
    const activePromise = schedule(scheduler, 5, { task: () => active.promise })
    const sentAt = Date.now()
    const waitingPromise = schedule(scheduler, 5, {
      method: 'Page.navigate',
      commandContext: createCommandContext({
        requestId: 5,
        method: 'Page.navigate',
        sentAt,
        deadlineAt: sentAt + 20,
      }),
      task: () => {
        waitingCalled = true
      },
    })

    await expect(waitingPromise).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'tab_command.queue_wait',
    })
    expect(waitingCalled).toBe(false)
    expect(scheduler.getSnapshot(5)).toMatchObject({ normalActive: 1, normalWaiting: 0 })

    active.resolve()
    await activePromise
    expect(waitingCalled).toBe(false)
  })

  test('rechecks the deadline before starting when the waiting timer has not fired', async () => {
    const scheduler = createTabCommandScheduler()
    const active = deferred()
    const activePromise = schedule(scheduler, 6, { task: () => active.promise })
    let now = Date.now()
    const expiredPromise = schedule(scheduler, 6, {
      commandContext: createCommandContext({
        requestId: 6,
        method: 'Page.navigate',
        sentAt: now,
        deadlineAt: now + 10_000,
        now: () => now,
      }),
      task: () => {
        throw new Error('expired task must not run')
      },
    }).catch((error) => error)
    let nextCalled = false
    const nextPromise = schedule(scheduler, 6, {
      task: () => {
        nextCalled = true
      },
    })

    now += 10_001
    active.resolve()
    await activePromise

    await expect(expiredPromise).resolves.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'tab_command.queue_wait',
    })
    await nextPromise
    expect(nextCalled).toBe(true)
  })

  test('runs unblock commands while a normal command is active', async () => {
    const scheduler = createTabCommandScheduler({ unblockConcurrency: 2 })
    const normal = deferred()
    let unblockStarted = false

    const normalPromise = schedule(scheduler, 10, { task: () => normal.promise })
    const unblockPromise = schedule(scheduler, 10, {
      lane: 'unblock',
      method: 'Fetch.continueRequest',
      task: () => {
        unblockStarted = true
      },
    })

    await unblockPromise
    expect(unblockStarted).toBe(true)
    expect(scheduler.getSnapshot(10)?.normalActive).toBe(1)
    normal.resolve()
    await normalPromise
  })

  test('limits unblock concurrency and pumps only its own waiting lane', async () => {
    const scheduler = createTabCommandScheduler({ unblockConcurrency: 2, unblockQueueLimit: 4 })
    const gates = [deferred(), deferred(), deferred()]
    const started = []

    const promises = gates.map((gate, index) =>
      schedule(scheduler, 20, {
        lane: 'unblock',
        method: 'Fetch.continueRequest',
        task: () => {
          started.push(index)
          return gate.promise
        },
      }),
    )

    expect(started).toEqual([0, 1])
    expect(scheduler.getSnapshot(20)).toMatchObject({ unblockActive: 2, unblockWaiting: 1 })
    gates[0].resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual([0, 1, 2])
    gates[1].resolve()
    gates[2].resolve()
    await Promise.all(promises)
  })

  test('closeTab rejects active and waiting promises and ignores late results', async () => {
    const scheduler = createTabCommandScheduler()
    const active = deferred()
    let waitingCalled = false

    const activePromise = schedule(scheduler, 30, { task: () => active.promise })
    const waitingPromise = schedule(scheduler, 30, {
      task: () => {
        waitingCalled = true
      },
    })
    const generation = scheduler.getSnapshot(30).generation

    expect(scheduler.closeTab(30, 'debugger_detached', { expectedGeneration: generation })).toBe(
      true,
    )
    await expect(activePromise).rejects.toMatchObject({
      code: 'tab_command_queue.closed',
      reason: 'debugger_detached',
      message: expect.stringContaining('[tabQueueError code=closed reason=debugger_detached]'),
    })
    await expect(waitingPromise).rejects.toBeInstanceOf(TabCommandQueueClosedError)
    expect(waitingCalled).toBe(false)

    active.resolve('late')
    await Promise.resolve()
    await schedule(scheduler, 30, { task: () => 'new-generation' })
    expect(scheduler.getSnapshot(30).generation).toBeGreaterThan(generation)
  })

  test('does not close a replacement generation through a stale token', async () => {
    const scheduler = createTabCommandScheduler()
    await schedule(scheduler, 40)
    const oldGeneration = scheduler.getSnapshot(40).generation
    scheduler.closeTab(40, 'debugger_detached')
    await schedule(scheduler, 40, { attachmentSessionId: 'session-40-next' })

    expect(scheduler.closeTab(40, 'debugger_detached', { expectedGeneration: oldGeneration })).toBe(
      false,
    )
    expect(scheduler.getSnapshot(40)?.state).toBe('open')
  })

  test('closeAll rejects active tasks across tabs before dropping queue state', async () => {
    const scheduler = createTabCommandScheduler()
    const firstGate = deferred()
    const secondGate = deferred()
    const firstResult = schedule(scheduler, 41, { task: () => firstGate.promise }).catch(
      (error) => error,
    )
    const secondResult = schedule(scheduler, 42, { task: () => secondGate.promise }).catch(
      (error) => error,
    )

    scheduler.closeAll('manager_clear_all')

    await expect(firstResult).resolves.toMatchObject({ reason: 'manager_clear_all' })
    await expect(secondResult).resolves.toMatchObject({ reason: 'manager_clear_all' })
    expect(scheduler.getSnapshot(41)).toBeNull()
    expect(scheduler.getSnapshot(42)).toBeNull()
    firstGate.resolve()
    secondGate.resolve()
  })

  test('rejects a different attachment session on an open generation', async () => {
    const scheduler = createTabCommandScheduler()
    const active = deferred()
    const activePromise = schedule(scheduler, 50, { task: () => active.promise })

    await expect(
      schedule(scheduler, 50, {
        attachmentSessionId: 'session-50-next',
      }),
    ).rejects.toMatchObject({ reason: 'attachment_session_changed' })

    active.resolve()
    await activePromise
  })

  test('closes the whole generation when the unblock waiting limit is reached', async () => {
    const scheduler = createTabCommandScheduler({ unblockConcurrency: 1, unblockQueueLimit: 1 })
    const active = deferred()
    const first = schedule(scheduler, 60, {
      lane: 'unblock',
      method: 'Fetch.continueRequest',
      task: () => active.promise,
    })
    const waiting = schedule(scheduler, 60, {
      lane: 'unblock',
      method: 'Fetch.failRequest',
    })

    await expect(
      schedule(scheduler, 60, {
        lane: 'unblock',
        method: 'Fetch.fulfillRequest',
      }),
    ).rejects.toBeInstanceOf(TabCommandQueueOverloadedError)
    await expect(first).rejects.toMatchObject({ reason: 'unblock_overflow' })
    await expect(waiting).rejects.toMatchObject({ reason: 'unblock_overflow' })
    expect(scheduler.getSnapshot(60)).toBeNull()
    active.resolve()
  })

  test('preserves only an active self-closing task result after cleanup', async () => {
    const scheduler = createTabCommandScheduler()
    const closeResult = deferred()
    const closePromise = schedule(scheduler, 70, {
      method: 'Target.closeTarget',
      completesAfterOwnTabClose: true,
      task: () => closeResult.promise,
    })
    const waitingPromise = schedule(scheduler, 70)

    scheduler.closeTab(70, 'tab_closed')
    await expect(waitingPromise).rejects.toMatchObject({ reason: 'tab_closed' })
    closeResult.resolve({ success: true })
    await expect(closePromise).resolves.toEqual({ success: true })
  })

  test('rejects a self-closing task when cleanup was not caused by its tab close', async () => {
    const scheduler = createTabCommandScheduler()
    const closeResult = deferred()
    const closePromise = schedule(scheduler, 71, {
      method: 'Target.closeTarget',
      completesAfterOwnTabClose: true,
      task: () => closeResult.promise,
    })

    scheduler.closeTab(71, 'manager_clear_all')
    await expect(closePromise).rejects.toMatchObject({ reason: 'manager_clear_all' })
    closeResult.resolve({ success: true })
  })

  test('keeps the existing normal waiting limit semantics', async () => {
    const scheduler = createTabCommandScheduler({ normalQueueLimit: 2 })
    const active = deferred()
    const promises = [schedule(scheduler, 80, { task: () => active.promise })]
    promises.push(schedule(scheduler, 80))
    promises.push(schedule(scheduler, 80))

    await expect(schedule(scheduler, 80)).rejects.toMatchObject({
      code: 'tab_command_queue.overloaded',
      lane: 'normal',
    })
    active.resolve()
    await Promise.all(promises)
  })
})
