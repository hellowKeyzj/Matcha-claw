import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

const noop = () => {}
const noopAsync = () => Promise.resolve()
let sendCommandImpl = () => Promise.resolve({})
let getDebuggerTargetsImpl = () => Promise.resolve([])
let executeScriptImpl = () => Promise.resolve([])
let getZoomImpl = () => Promise.resolve(1)
let setZoomImpl = () => Promise.resolve()
let getTabImpl = (tabId) => Promise.resolve({ id: tabId, windowId: 1 })
let removeTabImpl = () => Promise.resolve()

// Restore the real chrome object so the fake cannot leak into other suites.
const realChrome = globalThis.chrome
afterAll(() => {
  globalThis.chrome = realChrome
})

globalThis.chrome = {
  debugger: {
    sendCommand: (...args) => sendCommandImpl(...args),
    getTargets: (...args) => getDebuggerTargetsImpl(...args),
  },
  tabs: {
    create: () => Promise.resolve({ id: 99 }),
    remove: (...args) => removeTabImpl(...args),
    discard: noopAsync,
    get: (...args) => getTabImpl(...args),
    update: noopAsync,
    getZoom: (...args) => getZoomImpl(...args),
    setZoom: (...args) => setZoomImpl(...args),
  },
  windows: {
    create: () => Promise.resolve({ tabs: [{ id: 99 }] }),
    update: noopAsync,
  },
  scripting: { executeScript: (...args) => executeScriptImpl(...args) },
  storage: { session: { get: () => Promise.resolve({}), set: noopAsync } },
  runtime: { lastError: null },
  downloads: {
    onCreated: { addListener: noop },
    onChanged: { addListener: noop },
    search: () => Promise.resolve([]),
  },
}

const { createDispatcher } = await import('./dispatch.js')
const { CdpCommandRouteError } = await import('./route-error.js')
const { createCommandContext } = await import('./deadline.js')
const { TabCommandQueueOverloadedError, createTabCommandScheduler } = await import(
  './tab-command-scheduler.js'
)

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate) {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('Condition was not reached')
}

function createManager({ ensureAttached } = {}) {
  const manager = {
    currentSessionId: 'session-1',
    targetId: 'REAL_TARGET_1',
    childSessions: new Set(),
    notifyCalls: [],
    detachCalls: [],
    commandCalls: [],
    reconcileCalls: 0,
    claimSyncCalls: [],
    claimSyncContexts: [],
    ownershipMarkCalls: [],
    ownershipMarkContexts: [],
    agentTabCount: 1,
    retainedTabCount: 0,
    resolveCommandRoute(sessionId, targetId, { allowTargetFallback = false } = {}) {
      const byTargetId = () =>
        targetId === this.targetId || targetId === 'vtab-1'
          ? {
              ok: true,
              tabId: 1,
              attachmentSessionId: this.currentSessionId,
              commandSessionId: undefined,
              sessionKind: undefined,
            }
          : null
      if (sessionId) {
        if (sessionId === this.currentSessionId) {
          return {
            ok: true,
            tabId: 1,
            attachmentSessionId: this.currentSessionId,
            commandSessionId: sessionId,
            sessionKind: 'main',
          }
        }
        if (this.childSessions.has(sessionId)) {
          return {
            ok: true,
            tabId: 1,
            attachmentSessionId: this.currentSessionId,
            commandSessionId: sessionId,
            sessionKind: 'child',
          }
        }
        if (!allowTargetFallback || !targetId) return { ok: false, code: 'stale_session' }
        const degraded = byTargetId()
        if (degraded) return { ...degraded, degradedFromSession: true }
        return { ok: false, code: 'target_not_found' }
      }
      return byTargetId() ?? { ok: false, code: 'target_not_found' }
    },
    validateCommandRoute(route) {
      if (!route?.ok || route.attachmentSessionId !== this.currentSessionId) return false
      if (!route.commandSessionId) return true
      return route.sessionKind === 'main'
        ? route.commandSessionId === this.currentSessionId
        : this.childSessions.has(route.commandSessionId)
    },
    notifyStaleTarget(sessionId, targetId) {
      this.notifyCalls.push({ sessionId, targetId })
    },
    reconcileFromChrome() {
      this.reconcileCalls++
      return Promise.resolve()
    },
    onCdpCommand(tabId) {
      this.commandCalls.push(tabId)
    },
    ensureAttached: ensureAttached || (() => Promise.resolve({ ok: true })),
    get() {
      return {
        state: 'connected',
        attachmentSessionId: this.currentSessionId,
        realTargetId: this.targetId,
      }
    },
    getCurrentTargetId() {
      return this.targetId
    },
    getByStableOrRealTargetId(targetId) {
      return targetId === this.targetId || targetId === 'vtab-1' ? 1 : null
    },
    isAgent: () => true,
    isRetained: () => false,
    getAgentTabIds: () => [1],
    registerAgentTab: noop,
    releaseAgent: noop,
    addToAgentGroup: noopAsync,
    attach: () => Promise.resolve({ vtabId: 'vtab-1' }),
    syncAgentClaimedUserTabs(targetIds, commandContext) {
      this.claimSyncCalls.push(targetIds)
      this.claimSyncContexts.push(commandContext)
      return Promise.resolve({ marked: targetIds.length, cleared: 0, ignored: 0 })
    },
    markTabOwnedByAgent(vtabId, commandContext) {
      this.ownershipMarkCalls.push(vtabId)
      this.ownershipMarkContexts.push(commandContext)
      return Promise.resolve({ success: true, vtabId })
    },
    closeAllAccioAgentGroupTabs: noopAsync,
    markRelayRequestedClose: noop,
    clearRelayRequestedClose: noop,
    close: noopAsync,
    async detach(tabId, reason, options) {
      this.detachCalls.push({ tabId, reason, options })
    },
  }
  return manager
}

function command(method, { sessionId = 'session-1', params } = {}) {
  return {
    params: {
      sessionId,
      method,
      params,
    },
  }
}

function settle(promise) {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  )
}

async function expectCommandTimeoutReleasesQueue({ method, params, stage, deadlineMs = 20 }) {
  const scheduler = createTabCommandScheduler()
  const manager = createManager()
  const dispatch = createDispatcher(manager, scheduler)
  const sentAt = Date.now()
  const timedOut = settle(
    dispatch(
      command(method, { params }),
      createCommandContext({
        requestId: 30,
        method,
        sentAt,
        deadlineAt: sentAt + deadlineMs,
      }),
    ),
  )
  await waitFor(() => scheduler.getSnapshot(1)?.normalActive === 1)

  const following = dispatch(
    command('Runtime.evaluate'),
    createCommandContext({
      requestId: 31,
      method: 'Runtime.evaluate',
      sentAt,
      deadlineAt: sentAt + 1_000,
    }),
  )
  await waitFor(() => scheduler.getSnapshot(1)?.normalWaiting === 1)

  expect(await timedOut).toMatchObject({
    status: 'rejected',
    reason: { code: 'COMMAND_DEADLINE_EXCEEDED', stage },
  })
  await expect(following).resolves.toEqual({})
  expect(scheduler.getSnapshot(1)).toMatchObject({ normalActive: 0, normalWaiting: 0 })
}

beforeEach(() => {
  sendCommandImpl = () => Promise.resolve({})
  getDebuggerTargetsImpl = () => Promise.resolve([])
  executeScriptImpl = () => Promise.resolve([])
  getZoomImpl = () => Promise.resolve(1)
  setZoomImpl = () => Promise.resolve()
  getTabImpl = (tabId) => Promise.resolve({ id: tabId, windowId: 1 })
  removeTabImpl = () => Promise.resolve()
})

test('claim snapshot is a global command that does not resolve or attach a tab', async () => {
  const scheduler = createTabCommandScheduler()
  const manager = createManager()
  manager.resolveCommandRoute = () => {
    throw new Error('must not route')
  }
  manager.ensureAttached = () => {
    throw new Error('must not attach')
  }
  const dispatch = createDispatcher(manager, scheduler)
  const commandContext = createCommandContext({
    requestId: 1,
    method: 'Extension.syncAgentClaimedUserTabs',
    sentAt: Date.now(),
  })

  const result = await dispatch(
    command('Extension.syncAgentClaimedUserTabs', {
      sessionId: '',
      params: { targetIds: ['vtab-2', 'vtab-1', 'vtab-2'] },
    }),
    commandContext,
  )

  expect(manager.claimSyncCalls).toEqual([['vtab-2', 'vtab-1']])
  expect(manager.claimSyncContexts).toEqual([commandContext])
  expect(result).toEqual({ marked: 2, cleared: 0, ignored: 0 })
})

test('lifecycle ownership snapshot result is a global command', async () => {
  const scheduler = createTabCommandScheduler()
  const manager = createManager()
  manager.resolveCommandRoute = () => {
    throw new Error('must not route')
  }
  const dispatch = createDispatcher(manager, scheduler)
  const commandContext = createCommandContext({
    requestId: 2,
    method: 'Extension.markTabOwnedByAgent',
    sentAt: Date.now(),
  })

  const result = await dispatch(
    command('Extension.markTabOwnedByAgent', {
      sessionId: '',
      params: { vtabId: 'vtab-2' },
    }),
    commandContext,
  )

  expect(manager.ownershipMarkCalls).toEqual(['vtab-2'])
  expect(manager.ownershipMarkContexts).toEqual([commandContext])
  expect(result).toEqual({ success: true, vtabId: 'vtab-2' })
})

describe('CDP dispatcher scheduling', () => {
  test('Fetch unblock commands bypass an active normal command while normal commands remain FIFO', async () => {
    const scheduler = createTabCommandScheduler()
    const manager = createManager()
    const dispatch = createDispatcher(manager, scheduler)
    const navigate = deferred()
    const calls = []
    sendCommandImpl = (_debuggee, method) => {
      calls.push(method)
      return method === 'Page.navigate' ? navigate.promise : Promise.resolve({ method })
    }

    const navigatePromise = dispatch(command('Page.navigate'))
    await waitFor(() => calls.includes('Page.navigate'))

    const unblockMethods = [
      'Fetch.continueRequest',
      'Fetch.continueResponse',
      'Fetch.continueWithAuth',
      'Fetch.fulfillRequest',
      'Fetch.failRequest',
      'Runtime.runIfWaitingForDebugger',
    ]
    await Promise.all(unblockMethods.map((method) => dispatch(command(method))))
    expect(calls).toEqual(['Page.navigate', ...unblockMethods])

    const normalPromise = dispatch(command('Runtime.evaluate'))
    await Promise.resolve()
    expect(calls).not.toContain('Runtime.evaluate')
    navigate.resolve({ frameId: 'frame-1' })
    await navigatePromise
    await normalPromise
    expect(calls.at(-1)).toBe('Runtime.evaluate')
  })

  test('Fetch.enable remains in the normal lane', async () => {
    const scheduler = createTabCommandScheduler()
    const manager = createManager()
    const dispatch = createDispatcher(manager, scheduler)
    const navigate = deferred()
    const calls = []
    sendCommandImpl = (_debuggee, method) => {
      calls.push(method)
      return method === 'Page.navigate' ? navigate.promise : Promise.resolve({})
    }

    const navigatePromise = dispatch(command('Page.navigate'))
    await waitFor(() => calls.includes('Page.navigate'))
    const enablePromise = dispatch(command('Fetch.enable'))
    await Promise.resolve()
    expect(calls).toEqual(['Page.navigate'])
    navigate.resolve({})
    await Promise.all([navigatePromise, enablePromise])
    expect(calls).toEqual(['Page.navigate', 'Fetch.enable'])
  })

  for (const method of ['Page.captureScreenshot', 'Accessibility.getFullAXTree']) {
    test(`${method} uses the long command budget for its CDP leaf`, async () => {
      const originalSetTimeout = globalThis.setTimeout
      const delays = []
      globalThis.setTimeout = (callback, delay, ...args) => {
        delays.push(delay)
        return originalSetTimeout(callback, delay, ...args)
      }

      try {
        const scheduler = createTabCommandScheduler()
        const manager = createManager()
        const dispatch = createDispatcher(manager, scheduler)
        const now = 1_000

        await dispatch(
          command(method),
          createCommandContext({
            requestId: 10,
            method,
            sentAt: now,
            deadlineAt: now + 60_000,
            now: () => now,
          }),
        )

        expect(delays.at(-1)).toBe(60_000)
      } finally {
        globalThis.setTimeout = originalSetTimeout
      }
    })
  }

  test('releases the normal queue when a Relay CDP leaf exceeds its deadline', async () => {
    const scheduler = createTabCommandScheduler()
    const manager = createManager()
    const dispatch = createDispatcher(manager, scheduler)
    const neverSettles = deferred()
    const calls = []
    sendCommandImpl = (_debuggee, method) => {
      calls.push(method)
      return method === 'Page.navigate' ? neverSettles.promise : Promise.resolve({ method })
    }
    getDebuggerTargetsImpl = () => new Promise(() => {})

    const sentAt = Date.now()
    const timedOut = settle(
      dispatch(
        command('Page.navigate'),
        createCommandContext({
          requestId: 1,
          method: 'Page.navigate',
          sentAt,
          deadlineAt: sentAt + 20,
        }),
      ),
    )
    await waitFor(() => calls.includes('Page.navigate'))

    const following = dispatch(
      command('Runtime.evaluate'),
      createCommandContext({
        requestId: 2,
        method: 'Runtime.evaluate',
        sentAt,
        deadlineAt: sentAt + 1_000,
      }),
    )
    await waitFor(() => scheduler.getSnapshot(1)?.normalWaiting === 1)

    expect(await timedOut).toMatchObject({
      status: 'rejected',
      reason: {
        code: 'COMMAND_DEADLINE_EXCEEDED',
        method: 'Page.navigate',
        stage: 'chrome.debugger.sendCommand:Page.navigate',
        timeoutSource: 'command_deadline',
      },
    })
    await expect(following).resolves.toEqual({ method: 'Runtime.evaluate' })
    expect(calls).toEqual(['Page.navigate', 'Runtime.evaluate'])
    expect(scheduler.getSnapshot(1)).toMatchObject({ normalActive: 0, normalWaiting: 0 })
  })

  for (const method of [
    'Extension.extractContent',
    'Extension.markElements',
    'Extension.click',
    'Extension.input',
  ]) {
    test(`${method} releases the normal queue when script injection exceeds its deadline`, async () => {
      const scheduler = createTabCommandScheduler()
      const manager = createManager()
      const dispatch = createDispatcher(manager, scheduler)
      executeScriptImpl = () => new Promise(() => {})

      const sentAt = Date.now()
      const timedOut = settle(
        dispatch(
          command(method, { params: { selector: '#target', text: 'value' } }),
          createCommandContext({
            requestId: 20,
            method,
            sentAt,
            deadlineAt: sentAt + 20,
          }),
        ),
      )
      await waitFor(() => scheduler.getSnapshot(1)?.normalActive === 1)

      const following = dispatch(
        command('Runtime.evaluate'),
        createCommandContext({
          requestId: 21,
          method: 'Runtime.evaluate',
          sentAt,
          deadlineAt: sentAt + 1_000,
        }),
      )
      await waitFor(() => scheduler.getSnapshot(1)?.normalWaiting === 1)

      expect(await timedOut).toMatchObject({
        status: 'rejected',
        reason: {
          code: 'COMMAND_DEADLINE_EXCEEDED',
          stage: `chrome.scripting.executeScript:${method}`,
        },
      })
      await expect(following).resolves.toEqual({})
      expect(scheduler.getSnapshot(1)).toMatchObject({ normalActive: 0, normalWaiting: 0 })
    })
  }

  test('bounds getViewportInfo debugger evaluation', async () => {
    sendCommandImpl = (_debuggee, method, params) =>
      method === 'Runtime.evaluate' && params?.expression?.includes('scrollWidth')
        ? new Promise(() => {})
        : Promise.resolve({})

    await expectCommandTimeoutReleasesQueue({
      method: 'Extension.getViewportInfo',
      stage: 'chrome.debugger.sendCommand:Runtime.evaluate:getViewportInfo',
    })
  })

  test('bounds ensureZoom read, write, and stabilization stages', async () => {
    getZoomImpl = () => new Promise(() => {})
    await expectCommandTimeoutReleasesQueue({
      method: 'Extension.ensureZoom',
      params: { zoom: 1 },
      stage: 'chrome.tabs.getZoom',
    })

    getZoomImpl = () => Promise.resolve(2)
    setZoomImpl = () => new Promise(() => {})
    await expectCommandTimeoutReleasesQueue({
      method: 'Extension.ensureZoom',
      params: { zoom: 1 },
      stage: 'chrome.tabs.setZoom',
    })

    setZoomImpl = () => Promise.resolve()
    await expectCommandTimeoutReleasesQueue({
      method: 'Extension.ensureZoom',
      params: { zoom: 1 },
      stage: 'Extension.ensureZoom:delay',
    })
  })

  for (const { name, stage, hangs } of [
    {
      name: 'animation frames',
      stage: 'chrome.debugger.sendCommand:Runtime.evaluate:animationFrames',
      hangs: (method, params) =>
        method === 'Runtime.evaluate' && params?.expression?.includes('requestAnimationFrame'),
    },
    {
      name: 'layout metrics',
      stage: 'chrome.debugger.sendCommand:Page.getLayoutMetrics',
      hangs: (method) => method === 'Page.getLayoutMetrics',
    },
    {
      name: 'device pixel ratio',
      stage: 'chrome.debugger.sendCommand:Runtime.evaluate:devicePixelRatio',
      hangs: (method, params) =>
        method === 'Runtime.evaluate' && params?.expression?.includes('devicePixelRatio'),
    },
    {
      name: 'screenshot',
      stage: 'chrome.debugger.sendCommand:Page.captureScreenshot',
      hangs: (method) => method === 'Page.captureScreenshot',
    },
  ]) {
    test(`bounds captureViewport ${name} stage`, async () => {
      sendCommandImpl = (_debuggee, method, params) => {
        if (hangs(method, params)) return new Promise(() => {})
        if (method === 'Page.getLayoutMetrics') {
          return Promise.resolve({ visualViewport: { clientWidth: 1280, clientHeight: 720 } })
        }
        if (method === 'Runtime.evaluate' && params?.expression?.includes('devicePixelRatio')) {
          return Promise.resolve({ result: { value: '{"dpr":1}' } })
        }
        return Promise.resolve({})
      }

      await expectCommandTimeoutReleasesQueue({
        method: 'Extension.captureViewport',
        stage,
      })
    })
  }

  test('bounds failure diagnostics and releases the normal queue', async () => {
    const scheduler = createTabCommandScheduler()
    const manager = createManager()
    const dispatch = createDispatcher(manager, scheduler)
    sendCommandImpl = (_debuggee, method) =>
      method === 'Page.navigate'
        ? Promise.reject(new Error('navigation failed'))
        : Promise.resolve({})
    getTabImpl = () => new Promise(() => {})

    const sentAt = Date.now()
    await expect(
      dispatch(
        command('Page.navigate'),
        createCommandContext({
          requestId: 40,
          method: 'Page.navigate',
          sentAt,
          deadlineAt: sentAt + 20,
        }),
      ),
    ).rejects.toThrow('navigation failed')
    expect(scheduler.getSnapshot(1)).toMatchObject({ normalActive: 0, normalWaiting: 0 })
  })

  test('bounds the Runtime.disable pre-step and releases the normal queue', async () => {
    const scheduler = createTabCommandScheduler()
    const manager = createManager()
    const dispatch = createDispatcher(manager, scheduler)
    const calls = []
    sendCommandImpl = (_debuggee, method) => {
      calls.push(method)
      return method === 'Runtime.disable' ? new Promise(() => {}) : Promise.resolve({ method })
    }

    const sentAt = Date.now()
    const timedOut = settle(
      dispatch(
        command('Runtime.enable'),
        createCommandContext({
          requestId: 10,
          method: 'Runtime.enable',
          sentAt,
          deadlineAt: sentAt + 20,
        }),
      ),
    )
    await waitFor(() => calls.includes('Runtime.disable'))
    const following = dispatch(
      command('Runtime.evaluate'),
      createCommandContext({
        requestId: 11,
        method: 'Runtime.evaluate',
        sentAt,
        deadlineAt: sentAt + 1_000,
      }),
    )

    expect(await timedOut).toMatchObject({
      status: 'rejected',
      reason: {
        code: 'COMMAND_DEADLINE_EXCEEDED',
        stage: 'chrome.debugger.sendCommand:Runtime.disable',
      },
    })
    await expect(following).resolves.toEqual({ method: 'Runtime.evaluate' })
    expect(calls).toEqual(['Runtime.disable', 'Runtime.evaluate'])
    expect(scheduler.getSnapshot(1)).toMatchObject({ normalActive: 0, normalWaiting: 0 })
  })

  test('bounds the final Runtime.enable debugger call', async () => {
    const scheduler = createTabCommandScheduler()
    const manager = createManager()
    const dispatch = createDispatcher(manager, scheduler)
    const calls = []
    sendCommandImpl = (_debuggee, method) => {
      calls.push(method)
      return method === 'Runtime.enable' ? new Promise(() => {}) : Promise.resolve({})
    }

    const sentAt = Date.now()
    await expect(
      dispatch(
        command('Runtime.enable'),
        createCommandContext({
          requestId: 12,
          method: 'Runtime.enable',
          sentAt,
          deadlineAt: sentAt + 40,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.debugger.sendCommand:Runtime.enable',
    })
    expect(calls).toEqual(['Runtime.disable', 'Runtime.enable'])
    expect(scheduler.getSnapshot(1)).toMatchObject({ normalActive: 0, normalWaiting: 0 })
  })

  test('bounds the getAttachState debugger probe', async () => {
    const scheduler = createTabCommandScheduler()
    const manager = createManager()
    const dispatch = createDispatcher(manager, scheduler)
    getDebuggerTargetsImpl = () => new Promise(() => {})

    const sentAt = Date.now()
    await expect(
      dispatch(
        command('Extension.getAttachState'),
        createCommandContext({
          requestId: 13,
          method: 'Extension.getAttachState',
          sentAt,
          deadlineAt: sentAt + 20,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.debugger.getTargets:getAttachState',
    })
    expect(scheduler.getSnapshot(1)).toMatchObject({ normalActive: 0, normalWaiting: 0 })
  })

  test('forwards child session commands with the child debugger session', async () => {
    const scheduler = createTabCommandScheduler()
    const manager = createManager()
    manager.childSessions.add('child-session-1')
    const dispatch = createDispatcher(manager, scheduler)
    const debuggees = []
    sendCommandImpl = (debuggee) => {
      debuggees.push(debuggee)
      return Promise.resolve({})
    }

    await dispatch(command('Runtime.evaluate', { sessionId: 'child-session-1' }))
    expect(debuggees).toEqual([{ tabId: 1, sessionId: 'child-session-1' }])
  })
})

describe('CDP dispatcher session fence', () => {
  test('treats a stale getAttachState probe as detached for V1 SDK recovery', async () => {
    const scheduler = createTabCommandScheduler()
    const manager = createManager()
    const dispatch = createDispatcher(manager, scheduler)

    await expect(
      dispatch(
        command('Extension.getAttachState', {
          sessionId: 'session-old',
          params: { targetId: 'vtab-1' },
        }),
      ),
    ).resolves.toEqual({ attached: false })
    expect(manager.notifyCalls).toEqual([])
    expect(manager.commandCalls).toEqual([])
  })

  test('keeps target-not-found cleanup strict for getAttachState', async () => {
    const scheduler = createTabCommandScheduler()
    const manager = createManager()
    const dispatch = createDispatcher(manager, scheduler)

    const result = dispatch(
      command('Extension.getAttachState', {
        sessionId: '',
        params: { targetId: 'vtab-missing' },
      }),
    )

    await expect(result).rejects.toMatchObject({
      code: 'cdp_command_route.target_not_found',
      routeCode: 'target_not_found',
    })
    expect(manager.notifyCalls).toEqual([{ sessionId: undefined, targetId: 'vtab-missing' }])
  })

  test('rejects an explicit stale session without target fallback or lifecycle cleanup', async () => {
    const scheduler = createTabCommandScheduler()
    const manager = createManager()
    const dispatch = createDispatcher(manager, scheduler)
    let sendCalls = 0
    sendCommandImpl = () => {
      sendCalls++
      return Promise.resolve({})
    }

    const result = dispatch(
      command('Runtime.evaluate', {
        sessionId: 'session-old',
        params: { targetId: 'REAL_TARGET_1' },
      }),
    )

    await expect(result).rejects.toMatchObject({
      code: 'cdp_command_route.stale_session',
      routeCode: 'stale_session',
      message: expect.stringContaining('[cdpRouteError code=stale_session]'),
    })
    expect(manager.notifyCalls).toEqual([])
    expect(manager.detachCalls).toEqual([])
    expect(sendCalls).toBe(0)
  })

  test('degrades a dead session to the targetId for tab-scoped closeTarget', async () => {
    const scheduler = createTabCommandScheduler()
    const manager = createManager()
    const dispatch = createDispatcher(manager, scheduler)
    const removedTabIds = []
    removeTabImpl = async (tabId) => {
      removedTabIds.push(tabId)
      scheduler.closeTab(1, 'tab_closed')
    }

    await expect(
      dispatch(
        command('Target.closeTarget', {
          sessionId: 'pending-vtab-1-123',
          params: { targetId: 'vtab-1' },
        }),
      ),
    ).resolves.toEqual({ success: true, alreadyClosed: false })
    expect(removedTabIds).toEqual([1])
    // The tab was found by targetId, so there was no drift to reconcile.
    expect(manager.reconcileCalls).toBe(0)
    expect(manager.notifyCalls).toEqual([])
  })

  test('reclassifies a double route miss as target_not_found and runs the self-heal', async () => {
    const scheduler = createTabCommandScheduler()
    const manager = createManager()
    const dispatch = createDispatcher(manager, scheduler)

    const result = dispatch(
      command('Target.closeTarget', {
        sessionId: 'pending-vtab-9-123',
        params: { targetId: 'vtab-9' },
      }),
    )

    await expect(result).rejects.toMatchObject({
      code: 'cdp_command_route.target_not_found',
      routeCode: 'target_not_found',
    })
    expect(manager.reconcileCalls).toBe(1)
    expect(manager.notifyCalls).toEqual([{ sessionId: undefined, targetId: 'vtab-9' }])
  })

  test('revalidates the captured session after ensureAttached and before sendCommand', async () => {
    const attach = deferred()
    const scheduler = createTabCommandScheduler()
    let receivedContext
    const manager = createManager({
      ensureAttached: (_tabId, commandContext) => {
        receivedContext = commandContext
        return attach.promise
      },
    })
    const dispatch = createDispatcher(manager, scheduler)
    let sendCalls = 0
    sendCommandImpl = () => {
      sendCalls++
      return Promise.resolve({})
    }
    const sentAt = Date.now()
    const commandContext = createCommandContext({
      requestId: 3,
      method: 'Runtime.evaluate',
      sentAt,
      deadlineAt: sentAt + 1_000,
    })

    const result = dispatch(command('Runtime.evaluate'), commandContext)
    await waitFor(() => receivedContext === commandContext)
    expect(receivedContext).toBe(commandContext)
    manager.currentSessionId = 'session-2'
    attach.resolve({ ok: true })

    await expect(result).rejects.toBeInstanceOf(CdpCommandRouteError)
    expect(sendCalls).toBe(0)
  })

  test('unblock overflow closes the generation and detaches only the expected attachment', async () => {
    const scheduler = createTabCommandScheduler({
      unblockConcurrency: 1,
      unblockQueueLimit: 1,
    })
    const manager = createManager()
    const dispatch = createDispatcher(manager, scheduler)
    const active = deferred()
    sendCommandImpl = (_debuggee, method) =>
      method === 'Fetch.continueRequest' ? active.promise : Promise.resolve({})

    const first = dispatch(command('Fetch.continueRequest'))
    await waitFor(() => scheduler.getSnapshot(1)?.unblockActive === 1)
    const waiting = dispatch(command('Fetch.failRequest'))
    const firstResult = settle(first)
    const waitingResult = settle(waiting)
    const overflow = dispatch(command('Fetch.fulfillRequest'))
    active.resolve({})

    const [overflowOutcome, firstOutcome, waitingOutcome] = await Promise.all([
      settle(overflow),
      firstResult,
      waitingResult,
    ])
    expect(overflowOutcome.reason).toBeInstanceOf(TabCommandQueueOverloadedError)
    expect(firstOutcome.reason).toMatchObject({ reason: 'unblock_overflow' })
    expect(waitingOutcome.reason).toMatchObject({ reason: 'unblock_overflow' })
    expect(manager.detachCalls).toEqual([
      {
        tabId: 1,
        reason: 'unblock-overflow',
        options: {
          initiatedByUs: true,
          expectedGeneration: overflowOutcome.reason.generation,
          expectedAttachmentSessionId: 'session-1',
        },
      },
    ])
  })

  test('allows Target.closeTarget to return after its own queue cleanup', async () => {
    const scheduler = createTabCommandScheduler()
    const manager = createManager()
    const dispatch = createDispatcher(manager, scheduler)
    removeTabImpl = async () => {
      scheduler.closeTab(1, 'tab_closed')
    }

    await expect(
      dispatch(
        command('Target.closeTarget', {
          params: { targetId: 'REAL_TARGET_1' },
        }),
      ),
    ).resolves.toEqual({ success: true, alreadyClosed: false })
  })
})

test('screenshot phase progress distinguishes queue wait from unresolved Chrome capture', async () => {
  const scheduler = createTabCommandScheduler()
  const manager = createManager()
  const dispatch = createDispatcher(manager, scheduler)
  const first = deferred()
  const capture = deferred()
  sendCommandImpl = (_debuggee, method) =>
    method === 'Runtime.evaluate' ? first.promise : capture.promise
  const initial = dispatch(command('Runtime.evaluate'))
  await waitFor(() => scheduler.getSnapshot(1)?.normalActive === 1)

  const stages = []
  const context = createCommandContext({
    requestId: 501,
    method: 'Page.captureScreenshot',
    sentAt: Date.now(),
    deadlineAt: Date.now() + 60_000,
  })
  context.reportProgress = (stage) => stages.push(stage)
  const screenshot = dispatch(command('Page.captureScreenshot'), context)
  await waitFor(() => scheduler.getSnapshot(1)?.normalWaiting === 1)
  expect(stages).toEqual(['queued'])

  first.resolve({})
  await initial
  await waitFor(() => stages.includes('send_command_started'))
  expect(stages).toEqual(['queued', 'dequeued', 'send_command_started'])
  capture.resolve({ data: 'test-image' })
  await expect(screenshot).resolves.toEqual({ data: 'test-image' })
  expect(stages.at(-1)).toBe('send_command_resolved')
})

test('unresolved screenshot reports timeout stage without claiming Chrome settled', async () => {
  const scheduler = createTabCommandScheduler()
  const manager = createManager()
  const dispatch = createDispatcher(manager, scheduler)
  sendCommandImpl = () => new Promise(() => {})
  const stages = []
  const sentAt = Date.now()
  const context = createCommandContext({
    requestId: 502,
    method: 'Page.captureScreenshot',
    sentAt,
    deadlineAt: sentAt + 20,
  })
  context.reportProgress = (stage) => stages.push(stage)
  await expect(dispatch(command('Page.captureScreenshot'), context)).rejects.toMatchObject({
    code: 'COMMAND_DEADLINE_EXCEEDED',
    stage: 'chrome.debugger.sendCommand:Page.captureScreenshot',
  })
  expect(stages).toEqual(['queued', 'dequeued', 'send_command_started', 'send_command_timeout'])
})
