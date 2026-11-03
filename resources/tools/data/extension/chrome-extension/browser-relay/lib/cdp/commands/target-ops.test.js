import { afterEach, describe, expect, test } from 'bun:test'

import { createCommandContext } from './deadline.js'
import { createTargetOps } from './target-ops.js'

const originalChrome = globalThis.chrome
const originalSetTimeout = globalThis.setTimeout

afterEach(() => {
  globalThis.chrome = originalChrome
  globalThis.setTimeout = originalSetTimeout
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function deadlineContext(requestId, method, timeoutMs) {
  const sentAt = Date.now()
  return createCommandContext({
    requestId,
    method,
    sentAt,
    deadlineAt: sentAt + timeoutMs,
  })
}

describe('Target.createTarget lifecycle', () => {
  test('releases the create lock when chrome.tabs.create exceeds the command deadline', async () => {
    let createCalls = 0
    const agentTabs = new Set()
    globalThis.chrome = {
      tabs: {
        create: () => {
          createCalls++
          return createCalls === 1 ? new Promise(() => {}) : Promise.resolve({ id: 2 })
        },
        remove: async () => {},
      },
      windows: { create: async () => ({ tabs: [{ id: 99 }] }) },
    }
    const mgr = {
      get agentTabCount() {
        return agentTabs.size
      },
      get retainedTabCount() {
        return 0
      },
      registerAgentTab(tabId) {
        agentTabs.add(tabId)
        return { tabId, vtabId: `vtab-${tabId}` }
      },
      addToAgentGroup: async () => {},
      ensureAttached: async () => ({ ok: true }),
    }
    const { cdpCreateTarget } = createTargetOps(mgr)

    await expect(
      cdpCreateTarget(
        { url: 'https://one.example' },
        deadlineContext(1, 'Target.createTarget', 20),
      ),
    ).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.tabs.create',
    })
    await expect(
      cdpCreateTarget(
        { url: 'https://two.example' },
        deadlineContext(2, 'Target.createTarget', 1_000),
      ),
    ).resolves.toEqual({ targetId: 'vtab-2', retained: false })
    expect(createCalls).toBe(2)
  })

  test('an expired lock waiter never enters the create critical section', async () => {
    const firstCreate = deferred()
    let createCalls = 0
    const agentTabs = new Set()
    globalThis.chrome = {
      tabs: {
        create: () => {
          createCalls++
          return createCalls === 1 ? firstCreate.promise : Promise.resolve({ id: createCalls })
        },
        remove: async () => {},
      },
      windows: { create: async () => ({ tabs: [{ id: 99 }] }) },
    }
    const mgr = {
      get agentTabCount() {
        return agentTabs.size
      },
      get retainedTabCount() {
        return 0
      },
      registerAgentTab(tabId) {
        agentTabs.add(tabId)
        return { tabId, vtabId: `vtab-${tabId}` }
      },
      addToAgentGroup: async () => {},
      ensureAttached: async () => ({ ok: true }),
    }
    const { cdpCreateTarget } = createTargetOps(mgr)

    const first = cdpCreateTarget({ url: 'https://one.example' })
    await Promise.resolve()
    const expired = cdpCreateTarget(
      { url: 'https://expired.example' },
      deadlineContext(3, 'Target.createTarget', 20),
    )
    await expect(expired).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'target_create.lock_wait',
    })
    expect(createCalls).toBe(1)

    const third = cdpCreateTarget({ url: 'https://three.example' })
    await Promise.resolve()
    expect(createCalls).toBe(1)
    firstCreate.resolve({ id: 1 })
    await first
    await third
    expect(createCalls).toBe(2)
  })

  test('does not compensate a created tab after the command deadline', async () => {
    const agentTabs = new Set()
    const removed = []
    let attachCalled = false
    globalThis.chrome = {
      tabs: {
        create: async () => ({ id: 7 }),
        remove: async (tabId) => {
          removed.push(tabId)
        },
      },
      windows: { create: async () => ({ tabs: [{ id: 99 }] }) },
    }
    const mgr = {
      get agentTabCount() {
        return agentTabs.size
      },
      get retainedTabCount() {
        return 0
      },
      registerAgentTab(tabId) {
        agentTabs.add(tabId)
        return { tabId, vtabId: `vtab-${tabId}` }
      },
      addToAgentGroup: async () => {},
      ensureAttached: async () => {
        attachCalled = true
        return { ok: true }
      },
    }
    const { cdpCreateTarget } = createTargetOps(mgr)

    await expect(
      cdpCreateTarget(
        { url: 'https://one.example' },
        deadlineContext(4, 'Target.createTarget', 20),
      ),
    ).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'target_create.delay',
    })

    expect(agentTabs.has(7)).toBe(true)
    expect(removed).toEqual([])
    expect(attachCalled).toBe(false)
  })

  test('serializes creation without enforcing legacy tab limits', async () => {
    let releaseFirstCreate
    let createCalls = 0
    const firstCreate = new Promise((resolve) => {
      releaseFirstCreate = () => resolve({ id: 1 })
    })
    const agentTabs = new Set()

    globalThis.chrome = {
      tabs: {
        create: async () => {
          createCalls += 1
          return createCalls === 1 ? firstCreate : { id: createCalls }
        },
        remove: async () => {},
      },
      windows: { create: async () => ({ tabs: [{ id: 99 }] }) },
    }
    const mgr = {
      get agentTabCount() {
        return agentTabs.size
      },
      get retainedTabCount() {
        return 0
      },
      registerAgentTab(tabId) {
        agentTabs.add(tabId)
        return { tabId, vtabId: `vtab-${tabId}` }
      },
      releaseAgent(tabId) {
        agentTabs.delete(tabId)
      },
      addToAgentGroup: async () => {},
      ensureAttached: async () => ({ ok: true }),
      close: async (tabId) => { agentTabs.delete(tabId) },
    }
    const { cdpCreateTarget } = createTargetOps(mgr)

    const first = cdpCreateTarget({ url: 'https://one.example', maxOpenTabs: 1 })
    const second = cdpCreateTarget({ url: 'https://two.example', maxOpenTabs: 1 })
    await Promise.resolve()
    await Promise.resolve()

    expect(createCalls).toBe(1)
    releaseFirstCreate()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { targetId: 'vtab-1', retained: false },
      { targetId: 'vtab-2', retained: false },
    ])
    expect(createCalls).toBe(2)
    expect(agentTabs.size).toBe(2)
  })

  test.each([{}, { maxOpenTabs: 1, maxRetainedTabs: 1 }])(
    'opens and retains beyond former limits without closing pages: %j',
    async (legacyLimits) => {
      const retainedTabs = new Set(Array.from({ length: 25 }, (_, index) => index + 1))
      const removed = []
      globalThis.chrome = {
        tabs: {
          create: async () => ({ id: 26 }),
          remove: async (tabId) => { removed.push(tabId) },
        },
      }
      const mgr = {
        get agentTabCount() { return retainedTabs.size },
        get retainedTabCount() { return retainedTabs.size },
        registerAgentTab(tabId, options) {
          expect(options.retained).toBe(true)
          retainedTabs.add(tabId)
          return { tabId, vtabId: `vtab-${tabId}` }
        },
        addToAgentGroup: async () => {},
        ensureAttached: async () => ({ ok: true }),
        close: async (tabId) => { retainedTabs.delete(tabId) },
      }
      const { cdpCreateTarget } = createTargetOps(mgr)

      await expect(cdpCreateTarget({
        url: 'https://result.example',
        retain: true,
        ...legacyLimits,
      })).resolves.toEqual({ targetId: 'vtab-26', retained: true })
      expect(retainedTabs.size).toBe(26)
      expect(removed).toEqual([])
    },
  )

  test('keeps a virtual target when eager attach fails retryably', async () => {
    const agentTabs = new Set()
    globalThis.chrome = {
      tabs: {
        create: async () => ({ id: 7 }),
        remove: async () => {},
      },
      windows: { create: async () => ({ tabs: [{ id: 99 }] }) },
    }
    const mgr = {
      get agentTabCount() {
        return agentTabs.size
      },
      get retainedTabCount() {
        return 0
      },
      registerAgentTab(tabId) {
        agentTabs.add(tabId)
        return { tabId, vtabId: `vtab-${tabId}` }
      },
      addToAgentGroup: async () => {},
      ensureAttached: async () => ({
        ok: false,
        code: 'attach_failed',
        message: 'temporary attach failure',
      }),
    }
    const { cdpCreateTarget } = createTargetOps(mgr)

    await expect(cdpCreateTarget({ url: 'https://retry.example' })).resolves.toEqual({
      targetId: 'vtab-7',
      retained: false,
    })
    expect(agentTabs.has(7)).toBe(true)
  })

  test('rejects creation when the tab is removed during eager attach', async () => {
    const agentTabs = new Set()
    globalThis.chrome = {
      tabs: {
        create: async () => ({ id: 8 }),
        remove: async () => {},
      },
      windows: { create: async () => ({ tabs: [{ id: 99 }] }) },
    }
    const mgr = {
      get agentTabCount() {
        return agentTabs.size
      },
      get retainedTabCount() {
        return 0
      },
      registerAgentTab(tabId) {
        agentTabs.add(tabId)
        return { tabId, vtabId: `vtab-${tabId}` }
      },
      addToAgentGroup: async () => {},
      ensureAttached: async (tabId) => {
        agentTabs.delete(tabId)
        return { ok: false, code: 'tab_removed', message: `Tab ${tabId} was removed during attach` }
      },
    }
    const { cdpCreateTarget } = createTargetOps(mgr)

    await expect(cdpCreateTarget({ url: 'https://removed.example' })).rejects.toThrow(
      'Target.createTarget failed: Tab 8 was removed during attach',
    )
    expect(agentTabs.has(8)).toBe(false)
  })
})

describe('Target activation deadlines', () => {
  test('bounds tab lookup, window focus, and tab activation', async () => {
    const mgr = {
      close: async () => {},
      get: () => ({ state: 'connected' }),
    }
    const { cdpActivateTarget } = createTargetOps(mgr)

    globalThis.chrome = {
      tabs: {
        get: () => new Promise(() => {}),
        update: async () => {},
      },
      windows: { update: async () => {} },
    }
    await expect(
      cdpActivateTarget({}, 1, deadlineContext(10, 'Target.activateTarget', 20)),
    ).rejects.toMatchObject({ stage: 'chrome.tabs.get:activateTarget' })

    globalThis.chrome.tabs.get = async () => ({ id: 1, windowId: 2 })
    globalThis.chrome.windows.update = () => new Promise(() => {})
    await expect(
      cdpActivateTarget({}, 1, deadlineContext(11, 'Target.activateTarget', 20)),
    ).rejects.toMatchObject({ stage: 'chrome.windows.update:activateTarget' })

    globalThis.chrome.windows.update = async () => {}
    globalThis.chrome.tabs.update = () => new Promise(() => {})
    await expect(
      cdpActivateTarget({}, 1, deadlineContext(12, 'Target.activateTarget', 20)),
    ).rejects.toMatchObject({ stage: 'chrome.tabs.update:activateTarget' })
  })

  test('passes the command context into lazy attach', async () => {
    let receivedContext
    const mgr = {
      close: async () => {},
      get: () => ({ state: 'virtual' }),
      ensureAttached: async (_tabId, commandContext) => {
        receivedContext = commandContext
        return { ok: true }
      },
    }
    globalThis.chrome = {
      tabs: {
        get: async () => ({ id: 1, windowId: 2 }),
        update: async () => {},
      },
      windows: { update: async () => {} },
    }
    const { cdpActivateTarget } = createTargetOps(mgr)
    const commandContext = deadlineContext(13, 'Target.activateTarget', 1_000)

    await cdpActivateTarget({}, 1, commandContext)
    expect(receivedContext).toBe(commandContext)
  })
})

describe('Target close operations', () => {
  test('returns at the command deadline when chrome.tabs.remove never settles', async () => {
    const agentTabs = new Set([1])
    globalThis.chrome = {
      tabs: {
        remove: () => new Promise(() => {}),
        discard: async () => {},
      },
    }
    const mgr = {
      getByStableOrRealTargetId: () => 1,
      isAgent: (tabId) => agentTabs.has(tabId),
      isRetained: () => false,
      markRelayRequestedClose: () => {},
      clearRelayRequestedClose: () => {},
      close: async (tabId) => { agentTabs.delete(tabId) },
    }
    const { cdpCloseTarget } = createTargetOps(mgr)

    await expect(
      cdpCloseTarget(
        { targetId: 'vtab-1' },
        undefined,
        deadlineContext(4, 'Target.closeTarget', 20),
      ),
    ).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.tabs.remove',
    })
    expect(agentTabs.has(1)).toBe(true)
  })

  test('keeps the tab counted until chrome.tabs.remove settles', async () => {
    let finishRemove
    const removePending = new Promise((resolve) => {
      finishRemove = resolve
    })
    const agentTabs = new Set([1])

    globalThis.chrome = {
      tabs: {
        remove: () => removePending,
        discard: async () => {},
      },
    }
    const mgr = {
      get agentTabCount() {
        return agentTabs.size
      },
      getByStableOrRealTargetId: (targetId) => (targetId === 'vtab-1' ? 1 : undefined),
      isAgent: (tabId) => agentTabs.has(tabId),
      isRetained: () => false,
      markRelayRequestedClose: () => {},
      clearRelayRequestedClose: () => {},
      close: async (tabId) => { agentTabs.delete(tabId) },
    }
    const { cdpCloseTarget } = createTargetOps(mgr)

    const closePending = cdpCloseTarget({ targetId: 'vtab-1' })
    await Promise.resolve()

    expect(agentTabs.size).toBe(1)

    finishRemove()
    expect(await closePending).toEqual({ success: true, alreadyClosed: false })
    expect(agentTabs.size).toBe(0)
  })

  test('close-all releases all ownership before discarding timed-out tabs', async () => {
    const agentTabs = new Map([
      [1, {}],
      [2, {}],
    ])
    const accountingSizesAtDiscard = []
    globalThis.setTimeout = (callback) => {
      queueMicrotask(callback)
      return 1
    }
    globalThis.chrome = {
      tabs: {
        remove: () => new Promise(() => {}),
        discard: async () => {
          accountingSizesAtDiscard.push(agentTabs.size)
        },
      },
    }
    const mgr = {
      getAgentTabIds: () => [...agentTabs.keys()],
      isRetained: () => false,
      releaseAgent: (tabId) => agentTabs.delete(tabId),
      markRelayRequestedClose: () => {},
      clearRelayRequestedClose: () => {},
      close: async () => {},
    }
    const { cdpCloseAllAgentTabs } = createTargetOps(mgr)

    await expect(cdpCloseAllAgentTabs()).resolves.toMatchObject({
      success: true,
      timedOut: 2,
      discarded: 2,
    })
    expect(accountingSizesAtDiscard).toEqual([0, 0])
    expect(agentTabs.size).toBe(0)
  })

  test('close-all releases ownership when a failed removal leaves the tab alive', async () => {
    const agentTabs = new Set([1])
    const released = []
    globalThis.chrome = {
      tabs: {
        remove: async () => { throw new Error('blocked') },
        get: async (tabId) => ({ id: tabId }),
        discard: async () => {},
      },
    }
    const mgr = {
      getAgentTabIds: () => [...agentTabs],
      isRetained: () => false,
      releaseAgent(tabId) {
        released.push(tabId)
        agentTabs.delete(tabId)
      },
      markRelayRequestedClose: () => {},
      clearRelayRequestedClose: () => {},
      close: async () => {},
    }
    const { cdpCloseAllAgentTabs } = createTargetOps(mgr)

    await expect(cdpCloseAllAgentTabs()).resolves.toMatchObject({
      success: true,
      failed: 1,
      failedIds: [1],
    })
    expect(released).toEqual([1])
    expect(agentTabs.size).toBe(0)
  })
})
