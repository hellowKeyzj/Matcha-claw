/**
 * TabManager regression tests.
 *
 * Covers:
 *   1. downgrade/reattach → late onDebuggerDetach races do not retire the replacement attachment
 *   2. onDebuggerDetach always downgrades (never removes)
 *   3. downgradeToVirtual cleans up child sessions
 *   4. close() removes entry and notifies relay
 *   5. removeTrackedEntry event semantics
 */

import { afterEach, describe, expect, test } from 'bun:test'

// ── Minimal chrome.* mock ──
// TabManager and its dependencies call chrome.tabs, chrome.debugger,
// chrome.tabGroups, chrome.storage, chrome.action, and chrome.scripting at import/construct time.

const noop = () => {}
const noopAsync = () => Promise.resolve()
const noopCb = (_arg, cb) => { if (cb) cb(); return Promise.resolve() }

globalThis.chrome = {
  tabs: {
    query: () => Promise.resolve([]),
    get: (id) =>
      Promise.resolve({
        id,
        url: 'https://example.com',
        title: 'Test',
        favIconUrl: 'https://example.com/favicon.ico',
      }),
    update: noopAsync,
    remove: noopAsync,
    create: () => Promise.resolve({ id: 999 }),
    group: () => Promise.resolve(1),
    sendMessage: () => Promise.resolve({ ok: true }),
    onRemoved: { addListener: noop, removeListener: noop },
    onUpdated: { addListener: noop, removeListener: noop },
  },
  debugger: {
    attach: noopCb,
    detach: noopCb,
    sendCommand: (_d, _m, _p, cb) => { if (cb) cb(); return Promise.resolve() },
    getTargets: () => Promise.resolve([]),
    onEvent: { addListener: noop, removeListener: noop },
    onDetach: { addListener: noop, removeListener: noop },
  },
  tabGroups: {
    query: () => Promise.resolve([]),
    get: (id) => Promise.resolve({ id, title: 'Accio Agent' }),
    update: noopAsync,
    TAB_GROUP_ID_NONE: -1,
  },
  storage: {
    session: {
      get: () => Promise.resolve({}),
      set: noopAsync,
      remove: noopAsync,
    },
  },
  action: {
    setIcon: noopAsync,
    setBadgeText: noopAsync,
    setBadgeBackgroundColor: noopAsync,
  },
  alarms: {
    create: noop,
    clear: noop,
  },
  windows: {
    update: noopAsync,
    create: () => Promise.resolve({ tabs: [{ id: 999 }] }),
  },
  scripting: {
    executeScript: () => Promise.resolve([]),
  },
  runtime: {
    lastError: null,
    getURL: (path) => `chrome-extension://test${path}`,
  },
}

globalThis.fetch = () =>
  Promise.resolve(
    new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { 'content-type': 'image/png' },
    }),
  )

// Now safe to import TabManager
const { TabManager } = await import('./manager.js')
const { createCommandContext } = await import('../commands/deadline.js')
const { createTabCommandScheduler } = await import('../commands/tab-command-scheduler.js')

// ── Test helpers ──

function createManager() {
  const sent = []
  const sendToRelay = (payload) => sent.push(payload)
  const scheduler = createTabCommandScheduler()
  const mgr = new TabManager(sendToRelay, scheduler)
  return { mgr, scheduler, sent }
}

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
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return
    await Bun.sleep(0)
  }
  throw new Error('Condition was not reached')
}

function decodeFaviconSvg(dataUrl) {
  return decodeURIComponent(dataUrl.slice('data:image/svg+xml,'.length))
}

function setupConnectedTab(mgr, tabId, sessionId, realTargetId) {
  mgr._injectConnectedState(tabId, sessionId, realTargetId)
}

function addChildSession(mgr, parentTabId, mainSessionId, childSessionId, childTargetId) {
  mgr.onDebuggerEvent(
    { tabId: parentTabId, sessionId: mainSessionId },
    'Target.attachedToTarget',
    {
      sessionId: childSessionId,
      targetInfo: { type: 'iframe', targetId: childTargetId, url: 'https://child.example.com' },
    },
  )
}

describe('TabManager — TabEntry identity model', () => {
  test('virtual entries store attachment identity separately from the derived vtab ID', () => {
    const { mgr } = createManager()

    mgr.discover(90, 'https://example.com', 'Example')

    const entry = mgr.get(90)
    expect(entry).toMatchObject({
      state: 'virtual',
      realTargetId: null,
      url: 'https://example.com',
      title: 'Example',
    })
    expect(entry.attachmentSessionId).toStartWith('cb-tab-')
    expect(entry).not.toHaveProperty('sessionId')
    expect(entry).not.toHaveProperty('targetId')
    expect(mgr.getCurrentTargetId(90)).toBe('vtab-90')
    expect(mgr.listTabSnapshots()).toEqual([{
      tabId: 90,
      state: 'virtual',
      sessionId: entry.attachmentSessionId,
      vtabId: 'vtab-90',
      targetId: 'vtab-90',
      url: 'https://example.com',
      title: 'Example',
      isAgent: false,
      isRetained: false,
    }])
  })

  test('connected entries keep the real target separate from their stable vtab ID', () => {
    const { mgr } = createManager()

    setupConnectedTab(mgr, 91, 'session-91', 'REAL_TARGET_91')

    expect(mgr.get(91)).toMatchObject({
      state: 'connected',
      attachmentSessionId: 'session-91',
      realTargetId: 'REAL_TARGET_91',
    })
    expect(mgr.getCurrentTargetId(91)).toBe('REAL_TARGET_91')
    expect(mgr.getByStableOrRealTargetId('vtab-91')).toBe(91)
    expect(mgr.getByStableOrRealTargetId('REAL_TARGET_91')).toBe(91)
  })

  test('vtab lookup rejects malformed IDs instead of partially parsing them', () => {
    const { mgr } = createManager()
    mgr.discover(92, 'https://example.com', 'Example')

    expect(mgr.getByStableOrRealTargetId('vtab-92')).toBe(92)
    expect(mgr.getByStableOrRealTargetId('vtab-92-extra')).toBeNull()
    expect(mgr.getByStableOrRealTargetId('prefix-vtab-92')).toBeNull()
    expect(mgr.getByStableOrRealTargetId('vtab--92')).toBeNull()
  })

  test('Agent registration creates and discovers a complete entry with derived counts', () => {
    const { mgr, sent } = createManager()

    const view = mgr.registerAgentTab(93, {
      url: 'https://agent.example.com',
      title: 'Agent',
      retained: true,
    })

    expect(view).toMatchObject({
      tabId: 93,
      state: 'virtual',
      vtabId: 'vtab-93',
      targetId: 'vtab-93',
      isAgent: true,
      isRetained: true,
    })
    expect(mgr.get(93)).toMatchObject({
      state: 'virtual',
      realTargetId: null,
      createdByAgent: true,
      retained: true,
      attachPermission: 'allowed',
    })
    expect(mgr.get(93).childSessionIds).toBeInstanceOf(Set)
    expect(mgr.agentTabCount).toBe(1)
    expect(mgr.retainedTabCount).toBe(1)
    expect(sent.find((event) => event.params?.method === 'Extension.tabDiscovered'))
      .toMatchObject({
        params: {
          params: {
            sessionId: view.sessionId,
            targetInfo: { targetId: 'vtab-93', attached: false },
          },
        },
      })

    mgr.releaseAgent(93)
    expect(mgr.has(93)).toBe(true)
    expect(mgr.agentTabCount).toBe(0)
    expect(mgr.retainedTabCount).toBe(0)
  })

  test('claim snapshot content-script updates remain ordered', async () => {
    const claimedIndicatorGate = deferred()
    const indicatorCalls = []
    const injectionCalls = []
    const originalSendMessage = chrome.tabs.sendMessage
    const originalExecuteScript = chrome.scripting.executeScript
    let contentScriptReady = false
    chrome.tabs.sendMessage = async (tabId, message) => {
      if (message.type === 'ACCIO_TAB_CLAIM_INDICATOR_PING') {
        if (!contentScriptReady) throw new Error('No receiver')
        return { ok: true }
      }
      indicatorCalls.push({ tabId, message })
      if (message.claimed) await claimedIndicatorGate.promise
      return { ok: true }
    }
    chrome.scripting.executeScript = async (input) => {
      injectionCalls.push(input)
      contentScriptReady = true
    }

    try {
      const { mgr } = createManager()
      mgr.discover(93, 'https://user.example.com', 'User')

      const claimed = mgr.syncAgentClaimedUserTabs(['vtab-93'])
      await waitFor(() => indicatorCalls.some(({ message }) => message.claimed === true))
      const released = mgr.syncAgentClaimedUserTabs([])
      await Promise.resolve()

      expect(injectionCalls).toEqual([
        {
          target: { tabId: 93 },
          files: ['lib/content_script/tab-claim-indicator.js'],
          injectImmediately: true,
        },
      ])
      expect(indicatorCalls).toHaveLength(1)
      expect(indicatorCalls[0]).toMatchObject({
        tabId: 93,
        message: { type: 'ACCIO_TAB_CLAIM_INDICATOR_UPDATE', claimed: true },
      })
      const faviconSvg = decodeFaviconSvg(indicatorCalls[0].message.favicon)
      expect(faviconSvg).toContain(
        '<image href="data:image/png;base64,iVBORw==" width="32" height="32" opacity="0.3"/>',
      )
      expect(faviconSvg).toContain('<path d="M3.04536 4.45259')
      claimedIndicatorGate.resolve()
      await Promise.all([claimed, released])
      expect(indicatorCalls.at(-1)).toEqual({
        tabId: 93,
        message: {
          type: 'ACCIO_TAB_CLAIM_INDICATOR_UPDATE',
          claimed: false,
          favicon: null,
        },
      })
      expect(mgr.get(93).claimedByAgent).toBe(false)
    } finally {
      chrome.tabs.sendMessage = originalSendMessage
      chrome.scripting.executeScript = originalExecuteScript
    }
  })

  test('claim snapshots update TabEntry through content script without changing Agent ownership', async () => {
    const indicatorCalls = []
    const originalSendMessage = chrome.tabs.sendMessage
    const originalSetBadgeText = chrome.action.setBadgeText
    const originalSetBadgeBackgroundColor = chrome.action.setBadgeBackgroundColor
    chrome.tabs.sendMessage = async (tabId, message) => {
      if (message.type === 'ACCIO_TAB_CLAIM_INDICATOR_PING') return { ok: true }
      indicatorCalls.push({ tabId, message })
      return { ok: true }
    }
    chrome.action.setBadgeText = () => {
      throw new Error('claim must not update extension badge text')
    }
    chrome.action.setBadgeBackgroundColor = () => {
      throw new Error('claim must not update extension badge color')
    }

    try {
      const { mgr } = createManager()
      mgr.discover(94, 'https://user.example.com', 'User')
      mgr.registerAgentTab(95, { url: 'https://agent.example.com' })
      for (let i = 0; i < 4; i += 1) await Promise.resolve()
      indicatorCalls.length = 0

      const result = await mgr.syncAgentClaimedUserTabs([
        'vtab-94',
        'vtab-95',
        'vtab-999',
        'vtab-94',
      ])

      expect(result).toEqual({ marked: 1, cleared: 0, ignored: 2 })
      expect(mgr.get(94).claimedByAgent).toBe(true)
      expect(mgr.get(94).createdByAgent).toBe(false)
      expect(mgr.get(95).claimedByAgent).toBe(false)
      expect(mgr.get(95).createdByAgent).toBe(true)
      expect(mgr.agentTabCount).toBe(1)
      expect(indicatorCalls).toHaveLength(2)
      const userClaim = indicatorCalls.find(({ tabId }) => tabId === 94)
      const agentClear = indicatorCalls.find(({ tabId }) => tabId === 95)
      expect(userClaim).toMatchObject({
        tabId: 94,
        message: { type: 'ACCIO_TAB_CLAIM_INDICATOR_UPDATE', claimed: true },
      })
      expect(userClaim.message.favicon).toStartWith('data:image/svg+xml,')
      expect(agentClear).toEqual({
        tabId: 95,
        message: {
          type: 'ACCIO_TAB_CLAIM_INDICATOR_UPDATE',
          claimed: false,
          favicon: null,
        },
      })

      indicatorCalls.length = 0
      mgr.discover(94, 'https://user.example.com/after-navigation', 'User')
      await waitFor(() => indicatorCalls.length > 0)
      expect(indicatorCalls).toHaveLength(1)
      expect(indicatorCalls[0]).toMatchObject({
        tabId: 94,
        message: { type: 'ACCIO_TAB_CLAIM_INDICATOR_UPDATE', claimed: true },
      })
      expect(indicatorCalls[0].message.favicon).toStartWith('data:image/svg+xml,')

      const beforeReleaseCount = indicatorCalls.length
      expect(await mgr.syncAgentClaimedUserTabs([])).toEqual({
        marked: 0,
        cleared: 1,
        ignored: 0,
      })
      expect(mgr.get(94).claimedByAgent).toBe(false)
      expect(indicatorCalls.slice(beforeReleaseCount)).toContainEqual({
        tabId: 94,
        message: {
          type: 'ACCIO_TAB_CLAIM_INDICATOR_UPDATE',
          claimed: false,
          favicon: null,
        },
      })
    } finally {
      chrome.tabs.sendMessage = originalSendMessage
      chrome.action.setBadgeText = originalSetBadgeText
      chrome.action.setBadgeBackgroundColor = originalSetBadgeBackgroundColor
    }
  })

  test('claimed tabs without a page favicon still receive a cursor indicator', async () => {
    const indicatorCalls = []
    const originalGet = chrome.tabs.get
    const originalSendMessage = chrome.tabs.sendMessage
    chrome.tabs.get = (id) =>
      Promise.resolve({ id, url: 'https://no-favicon.example.com', title: 'No favicon' })
    chrome.tabs.sendMessage = async (tabId, message) => {
      if (message.type === 'ACCIO_TAB_CLAIM_INDICATOR_PING') return { ok: true }
      indicatorCalls.push({ tabId, message })
      return { ok: true }
    }

    try {
      const { mgr } = createManager()
      mgr.discover(96, 'https://no-favicon.example.com', 'No favicon')

      expect(await mgr.syncAgentClaimedUserTabs(['vtab-96'])).toEqual({
        marked: 1,
        cleared: 0,
        ignored: 0,
      })
      expect(indicatorCalls).toHaveLength(1)
      expect(indicatorCalls[0]).toMatchObject({
        tabId: 96,
        message: { type: 'ACCIO_TAB_CLAIM_INDICATOR_UPDATE', claimed: true },
      })
      const faviconSvg = decodeFaviconSvg(indicatorCalls[0].message.favicon)
      expect(faviconSvg).not.toContain('<image ')
      expect(faviconSvg).toContain('<path d="M3.04536 4.45259')
    } finally {
      chrome.tabs.get = originalGet
      chrome.tabs.sendMessage = originalSendMessage
    }
  })

  test('claim snapshot deadline releases a blocked indicator and the sync chain', async () => {
    const originalSendMessage = chrome.tabs.sendMessage
    chrome.tabs.sendMessage = () => new Promise(() => {})

    try {
      const { mgr } = createManager()
      mgr.discover(97, 'https://user.example.com', 'User')
      const sentAt = Date.now()

      await expect(
        mgr.syncAgentClaimedUserTabs(
          ['vtab-97'],
          createCommandContext({
            requestId: 20,
            method: 'Extension.syncAgentClaimedUserTabs',
            sentAt,
            deadlineAt: sentAt + 20,
          }),
        ),
      ).rejects.toMatchObject({
        code: 'COMMAND_DEADLINE_EXCEEDED',
        stage: 'chrome.tabs.sendMessage:claimIndicatorPing',
      })

      chrome.tabs.sendMessage = async () => ({ ok: true })
      const retrySentAt = Date.now()
      await expect(
        mgr.syncAgentClaimedUserTabs(
          [],
          createCommandContext({
            requestId: 21,
            method: 'Extension.syncAgentClaimedUserTabs',
            sentAt: retrySentAt,
            deadlineAt: retrySentAt + 1_000,
          }),
        ),
      ).resolves.toEqual({ marked: 0, cleared: 1, ignored: 0 })
    } finally {
      chrome.tabs.sendMessage = originalSendMessage
    }
  })

  test('ownership marking bounds tab grouping with the command deadline', async () => {
    const originalGroup = chrome.tabs.group
    chrome.tabs.group = () => new Promise(() => {})

    try {
      const { mgr } = createManager()
      mgr.discover(98, 'https://agent.example.com', 'Agent')
      const sentAt = Date.now()

      await expect(
        mgr.markTabOwnedByAgent(
          'vtab-98',
          createCommandContext({
            requestId: 22,
            method: 'Extension.markTabOwnedByAgent',
            sentAt,
            deadlineAt: sentAt + 20,
          }),
        ),
      ).rejects.toMatchObject({
        code: 'COMMAND_DEADLINE_EXCEEDED',
        stage: 'chrome.tabs.group',
      })

      chrome.tabs.group = async () => 1
      const retrySentAt = Date.now()
      await expect(
        mgr.markTabOwnedByAgent(
          'vtab-98',
          createCommandContext({
            requestId: 23,
            method: 'Extension.markTabOwnedByAgent',
            sentAt: retrySentAt,
            deadlineAt: retrySentAt + 1_000,
          }),
        ),
      ).resolves.toEqual({ success: true, vtabId: 'vtab-98' })
    } finally {
      chrome.tabs.group = originalGroup
    }
  })
})

describe('TabManager — onDebuggerDetach behavior', () => {
  test('onDebuggerDetach does NOT delete an entry already downgraded to virtual', async () => {
    const { mgr, sent } = createManager()

    setupConnectedTab(mgr, 100, 'session-100', 'REAL_TARGET_ABC')
    sent.length = 0

    // Step 1: downgradeToVirtual — simulates "sendCommand failed, debugger gone"
    mgr.downgradeToVirtual(100, 'debugger-gone')

    expect(mgr.get(100)?.state).toBe('virtual')
    expect(mgr.resolveTabId(null, 'vtab-100')).toBe(100)
    sent.length = 0

    // Step 2: onDebuggerDetach fires (late arrival from Chrome)
    await mgr.onDebuggerDetach({ tabId: 100 }, 'target_closed')

    // Entry should STILL exist — virtual skip must prevent re-processing
    expect(mgr.get(100)).toBeDefined()
    expect(mgr.get(100).state).toBe('virtual')
    expect(sent.length).toBe(0)
  })

  test('onDebuggerDetach(target_closed) downgrades connected entry to virtual', async () => {
    const { mgr, sent } = createManager()

    setupConnectedTab(mgr, 200, 'session-200', 'REAL_TARGET_XYZ')
    sent.length = 0

    const detachedCurrentAttachment = await mgr.onDebuggerDetach({ tabId: 200 }, 'target_closed')

    expect(detachedCurrentAttachment).toBe(true)
    const afterDetach = mgr.get(200)
    expect(afterDetach).toBeDefined()
    expect(afterDetach.state).toBe('virtual')
    expect(mgr.resolveTabId(null, 'vtab-200')).toBe(200)
    expect(mgr.resolveTabId(null, 'REAL_TARGET_XYZ')).toBeNull()

    const detachEvent = sent.find((s) => s.params?.method === 'Target.detachedFromTarget')
    expect(detachEvent).toBeDefined()
    const discoverEvent = sent.find((s) => s.params?.method === 'Extension.tabDiscovered')
    expect(discoverEvent).toBeDefined()
  })

  test('onDebuggerDetach(canceled_by_user) also downgrades to virtual', async () => {
    const { mgr, sent } = createManager()

    setupConnectedTab(mgr, 250, 'session-250', 'REAL_TARGET_250')
    sent.length = 0

    const detachedCurrentAttachment = await mgr.onDebuggerDetach({ tabId: 250 }, 'canceled_by_user')

    expect(detachedCurrentAttachment).toBe(true)
    const afterDetach = mgr.get(250)
    expect(afterDetach).toBeDefined()
    expect(afterDetach.state).toBe('virtual')
    expect(afterDetach.attachPermission).toBe('user_denied')
    expect(mgr.resolveTabId(null, 'vtab-250')).toBe(250)
    expect(mgr.resolveTabId(null, 'REAL_TARGET_250')).toBeNull()
    await expect(mgr.ensureAttached(250)).resolves.toMatchObject({
      ok: false,
      code: 'user_denied',
    })
  })

  test('late canceled_by_user from a retired attachment does not deny the replacement epoch', async () => {
    const { mgr, sent } = createManager()

    setupConnectedTab(mgr, 251, 'session-251-old', 'REAL_TARGET_251')
    mgr.downgradeToVirtual(251, 'debugger-gone')
    const replacementSessionId = mgr.get(251).attachmentSessionId
    sent.length = 0

    const detachedCurrentAttachment = await mgr.onDebuggerDetach(
      { tabId: 251 },
      'canceled_by_user',
    )

    expect(detachedCurrentAttachment).toBe(false)
    expect(mgr.get(251)).toMatchObject({
      state: 'virtual',
      attachmentSessionId: replacementSessionId,
      attachPermission: 'allowed',
    })
    expect(sent).toEqual([])
  })
})

describe('TabManager — downgradeToVirtual cleans child sessions', () => {
  test('child sessions registered via onDebuggerEvent are cleared on downgrade', () => {
    const { mgr, sent } = createManager()

    setupConnectedTab(mgr, 300, 'session-300', 'REAL_TARGET_PARENT')
    addChildSession(mgr, 300, 'session-300', 'child-iframe-1', 'child-target-1')
    addChildSession(mgr, 300, 'session-300', 'child-worker-2', 'child-target-2')

    expect(mgr.resolveTabId('child-iframe-1', null)).toBe(300)
    expect(mgr.resolveTabId('child-worker-2', null)).toBe(300)

    sent.length = 0
    mgr.downgradeToVirtual(300, 'debugger-gone')

    expect(mgr.get(300)?.state).toBe('virtual')
    expect(mgr.resolveTabId(null, 'REAL_TARGET_PARENT')).toBeNull()
    expect(mgr.resolveTabId(null, 'vtab-300')).toBe(300)
    expect(mgr.getBySessionId('child-iframe-1')).toBeNull()
    expect(mgr.getBySessionId('child-worker-2')).toBeNull()
  })

  test('Target.detachedFromTarget removes only the registered child route', () => {
    const { mgr } = createManager()
    setupConnectedTab(mgr, 320, 'session-320', 'REAL_TARGET_320')
    addChildSession(mgr, 320, 'session-320', 'child-320', 'CHILD_TARGET_320')

    mgr.onDebuggerEvent(
      { tabId: 320, sessionId: 'session-320' },
      'Target.detachedFromTarget',
      { sessionId: 'child-320' },
    )

    expect(mgr.getBySessionId('child-320')).toBeNull()
    expect(mgr.getBySessionId('session-320')).toEqual({ tabId: 320, kind: 'main' })
  })

  test('onDebuggerDetach after downgrade does not revive stale child routes', async () => {
    const { mgr, sent } = createManager()

    setupConnectedTab(mgr, 350, 'session-350', 'REAL_TARGET_350')
    addChildSession(mgr, 350, 'session-350', 'child-sw-1', 'sw-target-1')

    mgr.downgradeToVirtual(350, 'debugger-gone')
    expect(mgr.getBySessionId('child-sw-1')).toBeNull()

    sent.length = 0
    await mgr.onDebuggerDetach({ tabId: 350 }, 'target_closed')

    expect(mgr.get(350)?.state).toBe('virtual')
    expect(mgr.getBySessionId('child-sw-1')).toBeNull()
    expect(sent.length).toBe(0)
  })
})

describe('TabManager — attachment epoch fence', () => {
  test('downgrade retires the old session, closes its queue, and discovers a new session', async () => {
    const { mgr, scheduler, sent } = createManager()
    const active = deferred()

    setupConnectedTab(mgr, 360, 'session-360-old', 'REAL_TARGET_360')
    const activePromise = scheduler.schedule(360, {
      lane: 'normal',
      method: 'Page.navigate',
      attachmentSessionId: 'session-360-old',
      task: () => active.promise,
    })
    const waitingPromise = scheduler.schedule(360, {
      lane: 'normal',
      method: 'Runtime.evaluate',
      attachmentSessionId: 'session-360-old',
      task: () => undefined,
    })
    sent.length = 0

    mgr.downgradeToVirtual(360, 'debugger-gone')

    const nextSessionId = mgr.get(360)?.attachmentSessionId
    expect(nextSessionId).toStartWith('cb-tab-')
    expect(nextSessionId).not.toBe('session-360-old')
    expect(mgr.resolveCommandRoute('session-360-old', 'vtab-360')).toEqual({
      ok: false,
      code: 'stale_session',
    })
    expect(mgr.resolveCommandRoute(nextSessionId, 'vtab-360')).toMatchObject({
      ok: true,
      tabId: 360,
      attachmentSessionId: nextSessionId,
    })
    await expect(activePromise).rejects.toMatchObject({ reason: 'debugger_detached' })
    await expect(waitingPromise).rejects.toMatchObject({ reason: 'debugger_detached' })

    const detachEvent = sent.find((event) => event.params?.method === 'Target.detachedFromTarget')
    const discoverEvent = sent.find((event) => event.params?.method === 'Extension.tabDiscovered')
    expect(detachEvent?.params?.params?.sessionId).toBe('session-360-old')
    expect(discoverEvent?.params?.params?.sessionId).toBe(nextSessionId)
    active.resolve()
  })

  test('an explicit stale child session never falls back to the current target', () => {
    const { mgr } = createManager()

    setupConnectedTab(mgr, 370, 'session-370-old', 'REAL_TARGET_370')
    addChildSession(mgr, 370, 'session-370-old', 'child-370-old', 'CHILD_TARGET_370')
    mgr.downgradeToVirtual(370, 'debugger-gone')

    expect(mgr.resolveCommandRoute('child-370-old', 'vtab-370')).toEqual({
      ok: false,
      code: 'stale_session',
    })
    expect(mgr.resolveCommandRoute(undefined, 'vtab-370')).toMatchObject({
      ok: true,
      tabId: 370,
    })
  })

  test('allowTargetFallback degrades a stale session to the target and drops the session identity', () => {
    const { mgr } = createManager()

    setupConnectedTab(mgr, 380, 'session-380-old', 'REAL_TARGET_380')
    addChildSession(mgr, 380, 'session-380-old', 'child-380-old', 'CHILD_TARGET_380')
    mgr.downgradeToVirtual(380, 'debugger-gone')
    const currentSessionId = mgr.get(380)?.attachmentSessionId

    const degraded = mgr.resolveCommandRoute('child-380-old', 'vtab-380', {
      allowTargetFallback: true,
    })
    expect(degraded).toEqual({
      ok: true,
      tabId: 380,
      attachmentSessionId: currentSessionId,
      commandSessionId: undefined,
      sessionKind: undefined,
      degradedFromSession: true,
    })
    // Keeping the dead session would make the scheduler re-resolve it on dequeue and fail again.
    expect(mgr.validateCommandRoute(degraded)).toBe(true)

    expect(
      mgr.resolveCommandRoute('child-380-old', 'vtab-missing', { allowTargetFallback: true }),
    ).toEqual({ ok: false, code: 'target_not_found' })
  })

  test('state mismatch rotates the session before reattaching', async () => {
    const { mgr, sent } = createManager()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalGetTargets = globalThis.chrome.debugger.getTargets
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    globalThis.chrome.debugger.getTargets = () => Promise.resolve([])
    globalThis.chrome.debugger.attach = () => Promise.resolve()
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) => Promise.resolve(
      method === 'Target.getTargetInfo'
        ? { targetInfo: { targetId: 'REAL_TARGET_380_NEXT' } }
        : undefined,
    )

    try {
      setupConnectedTab(mgr, 380, 'session-380-old', 'REAL_TARGET_380')
      sent.length = 0

      await expect(mgr.ensureAttached(380)).resolves.toEqual({ ok: true })

      const nextSessionId = mgr.get(380)?.attachmentSessionId
      expect(nextSessionId).not.toBe('session-380-old')
      expect(mgr.get(380)).toMatchObject({
        state: 'connected',
        attachmentSessionId: nextSessionId,
        realTargetId: 'REAL_TARGET_380_NEXT',
      })
      expect(sent.find((event) => event.params?.method === 'Target.detachedFromTarget')
        ?.params?.params?.sessionId).toBe('session-380-old')
      expect(sent.find((event) => event.params?.method === 'Target.attachedToTarget')
        ?.params?.params?.sessionId).toBe(nextSessionId)
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.getTargets = originalGetTargets
      globalThis.chrome.debugger.sendCommand = originalSendCommand
    }
  })

  test('ensureAttached waits for a proactive detach barrier', async () => {
    const { mgr } = createManager()
    const detachGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    let attachCalls = 0
    globalThis.chrome.debugger.detach = () => detachGate.promise
    globalThis.chrome.debugger.attach = () => {
      attachCalls++
      return Promise.resolve()
    }
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) => Promise.resolve(
      method === 'Target.getTargetInfo'
        ? { targetInfo: { targetId: 'REAL_TARGET_390_NEXT' } }
        : undefined,
    )

    try {
      setupConnectedTab(mgr, 390, 'session-390-old', 'REAL_TARGET_390')
      const detachPromise = mgr.detach(390, 'idle-timeout', { initiatedByUs: true })
      const attachPromise = mgr.ensureAttached(390)

      await Promise.resolve()
      expect(attachCalls).toBe(0)
      detachGate.resolve()
      await detachPromise
      await expect(attachPromise).resolves.toEqual({ ok: true })
      expect(attachCalls).toBe(1)
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
    }
  })

  test('ensureAttached rechecks a detach barrier installed during reconciliation', async () => {
    const { mgr } = createManager()
    const targetsGate = deferred()
    const detachGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    const originalGetTargets = globalThis.chrome.debugger.getTargets
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    let attachCalls = 0
    globalThis.chrome.debugger.getTargets = () => targetsGate.promise
    globalThis.chrome.debugger.detach = () => detachGate.promise
    globalThis.chrome.debugger.attach = () => {
      attachCalls++
      return Promise.resolve()
    }
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) => Promise.resolve(
      method === 'Target.getTargetInfo'
        ? { targetInfo: { targetId: 'REAL_TARGET_391_NEXT' } }
        : undefined,
    )

    try {
      setupConnectedTab(mgr, 391, 'session-391-old', 'REAL_TARGET_391')
      const attachPromise = mgr.ensureAttached(391)
      await Promise.resolve()
      const detachPromise = mgr.detach(391, 'idle-timeout', { initiatedByUs: true })
      targetsGate.resolve([{ tabId: 391, attached: true, type: 'page', id: 'REAL_TARGET_391' }])

      await Promise.resolve()
      expect(attachCalls).toBe(0)
      detachGate.resolve()
      await detachPromise
      await expect(attachPromise).resolves.toEqual({ ok: true })
      expect(attachCalls).toBe(1)
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
      globalThis.chrome.debugger.getTargets = originalGetTargets
      globalThis.chrome.debugger.sendCommand = originalSendCommand
    }
  })

  test('clearAll waits for proactive detach barriers that were already active', async () => {
    const { mgr } = createManager()
    const detachGates = [deferred(), deferred()]
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    let detachCalls = 0
    globalThis.chrome.debugger.attach = () => Promise.resolve()
    globalThis.chrome.debugger.detach = () => {
      const gate = detachGates[detachCalls++]
      return gate.promise
    }
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) => Promise.resolve(
      method === 'Target.getTargetInfo'
        ? { targetInfo: { targetId: 'REAL_TARGET_394_NEXT' } }
        : undefined,
    )

    try {
      setupConnectedTab(mgr, 394, 'session-394', 'REAL_TARGET_394')
      setupConnectedTab(mgr, 395, 'session-395', 'REAL_TARGET_395')
      const firstProactiveDetach = mgr.detach(394, 'idle-timeout', { initiatedByUs: true })
      const secondProactiveDetach = mgr.detach(395, 'idle-timeout', { initiatedByUs: true })
      const clearAllPromise = mgr.clearAll()
      let clearAllSettled = false
      void clearAllPromise.then(() => {
        clearAllSettled = true
      })

      await Promise.resolve()
      expect(mgr.size).toBe(0)
      expect(clearAllSettled).toBe(false)
      expect(detachCalls).toBe(2)

      detachGates[0].resolve()
      await firstProactiveDetach
      await Promise.resolve()
      expect(clearAllSettled).toBe(false)

      detachGates[1].resolve()
      await secondProactiveDetach
      await expect(clearAllPromise).resolves.toEqual([])
      expect(clearAllSettled).toBe(true)

      mgr.discover(394, 'https://example.com', 'Replacement')
      await expect(mgr.ensureAttached(394)).resolves.toEqual({ ok: true })
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
    }
  })

  test('clearAll waits for an attach already in flight', async () => {
    const { mgr } = createManager()
    const attachGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    globalThis.chrome.debugger.attach = () => attachGate.promise
    globalThis.chrome.debugger.detach = () => Promise.resolve()

    try {
      mgr.discover(3960, 'https://example.com', 'Pending')
      const attaching = mgr.ensureAttached(3960)
      await Promise.resolve()
      const clearing = mgr.clearAll()
      let clearSettled = false
      void clearing.then(() => { clearSettled = true })

      await Promise.resolve()
      expect(clearSettled).toBe(false)
      attachGate.resolve()
      await expect(attaching).resolves.toMatchObject({ ok: false, code: 'tab_removed' })
      await clearing
      expect(clearSettled).toBe(true)
      expect(mgr.size).toBe(0)
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
    }
  })

  test('clearAll waits for a late timed-out attach and its compensation detach', async () => {
    const { mgr } = createManager()
    const attachGate = deferred()
    const detachGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    let detachCalls = 0
    globalThis.chrome.debugger.attach = () => attachGate.promise
    globalThis.chrome.debugger.detach = () => {
      detachCalls++
      return detachGate.promise
    }

    try {
      mgr.discover(3961, 'https://example.com', 'Pending')
      const sentAt = Date.now()
      await expect(
        mgr.ensureAttached(
          3961,
          createCommandContext({
            requestId: 14,
            method: 'Runtime.evaluate',
            sentAt,
            deadlineAt: sentAt + 20,
          }),
        ),
      ).rejects.toMatchObject({ code: 'COMMAND_DEADLINE_EXCEEDED' })
      expect(mgr.get(3961)).toMatchObject({ state: 'virtual' })

      const clearing = mgr.clearAll()
      let clearSettled = false
      void clearing.then(() => { clearSettled = true })
      await Promise.resolve()
      expect(clearSettled).toBe(false)

      attachGate.resolve()
      await waitFor(() => detachCalls === 1)
      expect(clearSettled).toBe(false)

      detachGate.resolve()
      await expect(clearing).resolves.toEqual([])
      expect(clearSettled).toBe(true)
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
    }
  })

  test('clearAll returns when a timed-out raw attach never settles', async () => {
    const { mgr } = createManager()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    const originalSetTimeout = globalThis.setTimeout
    let attachCalls = 0
    globalThis.chrome.debugger.attach = () => {
      attachCalls++
      return attachCalls === 1 ? new Promise(() => {}) : Promise.resolve()
    }
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) => Promise.resolve(
      method === 'Target.getTargetInfo'
        ? { targetInfo: { targetId: 'REAL_TARGET_3964' } }
        : undefined,
    )

    try {
      mgr.discover(3963, 'https://example.com', 'Stuck')
      const sentAt = Date.now()
      await expect(
        mgr.ensureAttached(
          3963,
          createCommandContext({
            requestId: 17,
            method: 'Runtime.evaluate',
            sentAt,
            deadlineAt: sentAt + 20,
          }),
        ),
      ).rejects.toMatchObject({ stage: 'chrome.debugger.attach' })

      globalThis.setTimeout = (callback, delay, ...args) =>
        originalSetTimeout(callback, delay >= 900 ? 0 : delay, ...args)
      await expect(mgr.clearAll()).resolves.toEqual([])
      globalThis.setTimeout = originalSetTimeout

      mgr.discover(3964, 'https://example.com', 'Unrelated')
      await expect(mgr.ensureAttached(3964)).resolves.toEqual({ ok: true })
      expect(attachCalls).toBe(2)
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test('bounded clearAll keeps a late attach fenced through compensation', async () => {
    const { mgr } = createManager()
    const attachGate = deferred()
    const detachGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    const originalSetTimeout = globalThis.setTimeout
    let attachCalls = 0
    let detachCalls = 0
    globalThis.chrome.debugger.attach = () => {
      attachCalls++
      return attachCalls === 1 ? attachGate.promise : Promise.resolve()
    }
    globalThis.chrome.debugger.detach = () => {
      detachCalls++
      return detachGate.promise
    }
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) => Promise.resolve(
      method === 'Target.getTargetInfo'
        ? { targetInfo: { targetId: 'REAL_TARGET_3965' } }
        : undefined,
    )

    try {
      mgr.discover(3965, 'https://example.com', 'Pending')
      const firstAttach = mgr.ensureAttached(3965)
      await Promise.resolve()

      globalThis.setTimeout = (callback, delay, ...args) =>
        originalSetTimeout(callback, delay >= 900 ? 0 : delay, ...args)
      await expect(mgr.clearAll()).resolves.toEqual([])
      globalThis.setTimeout = originalSetTimeout

      mgr.discover(3965, 'https://example.com', 'Replacement')
      const retrySentAt = Date.now()
      const retry = mgr.ensureAttached(
        3965,
        createCommandContext({
          requestId: 18,
          method: 'Runtime.evaluate',
          sentAt: retrySentAt,
          deadlineAt: retrySentAt + 1_000,
        }),
      )
      await Promise.resolve()
      expect(attachCalls).toBe(1)

      attachGate.resolve()
      await waitFor(() => detachCalls === 1)
      expect(attachCalls).toBe(1)

      detachGate.resolve()
      await expect(firstAttach).resolves.toMatchObject({ ok: false, code: 'attach_failed' })
      await expect(retry).resolves.toEqual({ ok: true })
      expect(attachCalls).toBe(2)
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test('clearAll retains a never-settling shutdown detach as a tab-local fence', async () => {
    const { mgr } = createManager()
    const detachGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    const originalSetTimeout = globalThis.setTimeout
    let attachCalls = 0
    globalThis.chrome.debugger.attach = () => {
      attachCalls++
      return Promise.resolve()
    }
    globalThis.chrome.debugger.detach = () => detachGate.promise
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) => Promise.resolve(
      method === 'Target.getTargetInfo'
        ? { targetInfo: { targetId: 'REAL_TARGET_3966' } }
        : undefined,
    )

    try {
      setupConnectedTab(mgr, 3966, 'session-3966', 'REAL_TARGET_3966')
      globalThis.setTimeout = (callback, delay, ...args) =>
        originalSetTimeout(callback, delay >= 900 ? 0 : delay, ...args)
      await expect(mgr.clearAll()).resolves.toEqual([])
      globalThis.setTimeout = originalSetTimeout

      mgr.discover(3967, 'https://example.com', 'Unrelated')
      await expect(mgr.ensureAttached(3967)).resolves.toEqual({ ok: true })

      mgr.discover(3966, 'https://example.com', 'Replacement')
      const sameTabSentAt = Date.now()
      await expect(
        mgr.ensureAttached(
          3966,
          createCommandContext({
            requestId: 19,
            method: 'Runtime.evaluate',
            sentAt: sameTabSentAt,
            deadlineAt: sameTabSentAt + 20,
          }),
        ),
      ).rejects.toMatchObject({ stage: 'tab_manager.waitForDetach' })
      expect(attachCalls).toBe(1)

      detachGate.resolve()
      await expect(mgr.ensureAttached(3966)).resolves.toEqual({ ok: true })
      expect(attachCalls).toBe(2)
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test('a waiter started before clearAll cannot attach a replacement entry', async () => {
    const { mgr } = createManager()
    const detachGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    const originalSetTimeout = globalThis.setTimeout
    let attachCalls = 0
    globalThis.chrome.debugger.attach = () => {
      attachCalls++
      return Promise.resolve()
    }
    globalThis.chrome.debugger.detach = () => detachGate.promise
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) => Promise.resolve(
      method === 'Target.getTargetInfo'
        ? { targetInfo: { targetId: 'REAL_TARGET_3968' } }
        : undefined,
    )

    try {
      setupConnectedTab(mgr, 3968, 'session-3968', 'REAL_TARGET_3968')
      const detaching = mgr.detach(3968, 'idle-timeout', { initiatedByUs: true })
      const oldWaiter = mgr.ensureAttached(3968)

      globalThis.setTimeout = (callback, delay, ...args) =>
        originalSetTimeout(callback, delay >= 900 ? 0 : delay, ...args)
      await expect(mgr.clearAll()).resolves.toEqual([])
      globalThis.setTimeout = originalSetTimeout

      mgr.discover(3968, 'https://example.com', 'Replacement')
      detachGate.resolve()
      await detaching
      await expect(oldWaiter).resolves.toMatchObject({ ok: false, code: 'attach_failed' })
      expect(attachCalls).toBe(0)

      await expect(mgr.ensureAttached(3968)).resolves.toEqual({ ok: true })
      expect(attachCalls).toBe(1)
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test('clearAll cleans a superseded already-attached initialization', async () => {
    const { mgr } = createManager()
    const targetInfoGate = deferred()
    const detachGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    const originalSetTimeout = globalThis.setTimeout
    let attachCalls = 0
    let detachCalls = 0
    globalThis.chrome.debugger.attach = () => {
      attachCalls++
      return attachCalls === 1
        ? Promise.reject(new Error('Another debugger is already attached'))
        : Promise.resolve()
    }
    globalThis.chrome.debugger.detach = () => {
      detachCalls++
      return detachGate.promise
    }
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) => {
      if (method === 'Target.getTargetInfo' && attachCalls === 1) return targetInfoGate.promise
      return Promise.resolve(
        method === 'Target.getTargetInfo'
          ? { targetInfo: { targetId: 'REAL_TARGET_3969' } }
          : undefined,
      )
    }

    try {
      mgr.discover(3969, 'https://example.com', 'Pending')
      const firstAttach = mgr.ensureAttached(3969)
      await Promise.resolve()

      globalThis.setTimeout = (callback, delay, ...args) =>
        originalSetTimeout(callback, delay >= 900 ? 0 : delay, ...args)
      await expect(mgr.clearAll()).resolves.toEqual([])
      globalThis.setTimeout = originalSetTimeout

      mgr.discover(3969, 'https://example.com', 'Replacement')
      const retry = mgr.ensureAttached(3969)
      targetInfoGate.resolve({ targetInfo: { targetId: 'REAL_TARGET_3969_OLD' } })
      await waitFor(() => detachCalls === 1)
      expect(attachCalls).toBe(1)

      detachGate.resolve()
      await expect(firstAttach).resolves.toMatchObject({ ok: false })
      await expect(retry).resolves.toEqual({ ok: true })
      expect(attachCalls).toBe(2)
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test('a late proactive detach event does not retire the replacement attachment', async () => {
    const { mgr, scheduler, sent } = createManager()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    const originalGetTargets = globalThis.chrome.debugger.getTargets
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    globalThis.chrome.debugger.attach = () => Promise.resolve()
    globalThis.chrome.debugger.detach = () => Promise.resolve()
    globalThis.chrome.debugger.getTargets = () =>
      Promise.resolve([{ tabId: 393, attached: true, type: 'page', id: 'REAL_TARGET_393_NEXT' }])
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) =>
      Promise.resolve(
        method === 'Target.getTargetInfo'
          ? { targetInfo: { targetId: 'REAL_TARGET_393_NEXT' } }
          : undefined,
      )

    try {
      setupConnectedTab(mgr, 393, 'session-393-old', 'REAL_TARGET_393_OLD')
      await mgr.detach(393, 'idle-timeout', { initiatedByUs: true })
      const replacementSessionId = mgr.get(393)?.attachmentSessionId
      await expect(mgr.ensureAttached(393)).resolves.toEqual({ ok: true })
      await scheduler.schedule(393, {
        method: 'Runtime.evaluate',
        attachmentSessionId: replacementSessionId,
        task: () => undefined,
      })
      const replacementGeneration = scheduler.getSnapshot(393)?.generation
      const eventCountBeforeLateDetach = sent.length

      const detachedCurrentAttachment = await mgr.onDebuggerDetach(
        { tabId: 393 },
        'canceled_by_user',
      )

      expect(detachedCurrentAttachment).toBe(false)
      expect(mgr.get(393)).toMatchObject({
        state: 'connected',
        attachmentSessionId: replacementSessionId,
        realTargetId: 'REAL_TARGET_393_NEXT',
        attachPermission: 'allowed',
      })
      expect(scheduler.getSnapshot(393)?.generation).toBe(replacementGeneration)
      expect(sent.length).toBe(eventCountBeforeLateDetach)
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
      globalThis.chrome.debugger.getTargets = originalGetTargets
      globalThis.chrome.debugger.sendCommand = originalSendCommand
    }
  })

  test('overflow detach does not close a replacement queue generation', async () => {
    const { mgr, scheduler } = createManager()
    setupConnectedTab(mgr, 391, 'session-391', 'REAL_TARGET_391')

    await scheduler.schedule(391, {
      method: 'Runtime.evaluate',
      attachmentSessionId: 'session-391',
      task: () => undefined,
    })
    const oldGeneration = scheduler.getSnapshot(391).generation
    scheduler.closeTab(391, 'unblock_overflow', { expectedGeneration: oldGeneration })
    await scheduler.schedule(391, {
      method: 'Runtime.evaluate',
      attachmentSessionId: 'session-391',
      task: () => undefined,
    })

    await mgr.detach(391, 'unblock-overflow', {
      initiatedByUs: true,
      expectedGeneration: oldGeneration,
      expectedAttachmentSessionId: 'session-391',
    })

    expect(mgr.get(391)).toMatchObject({
      state: 'connected',
      attachmentSessionId: 'session-391',
    })
    expect(scheduler.getSnapshot(391)?.generation).toBeGreaterThan(oldGeneration)
  })

  test('a debugger attach without a real target ID stays virtual', async () => {
    const { mgr } = createManager()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    let detachCalls = 0
    globalThis.chrome.debugger.attach = () => Promise.resolve()
    globalThis.chrome.debugger.detach = () => {
      detachCalls++
      return Promise.resolve()
    }
    globalThis.chrome.debugger.sendCommand = () => Promise.resolve({})

    try {
      mgr.discover(397, 'https://example.com', 'Test')

      await expect(mgr.ensureAttached(397)).resolves.toMatchObject({
        ok: false,
        code: 'attach_failed',
      })
      expect(mgr.get(397)).toMatchObject({
        state: 'virtual',
        realTargetId: null,
      })
      expect(detachCalls).toBe(1)
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
    }
  })

  test('an attach error after tab removal reports a terminal outcome', async () => {
    const { mgr } = createManager()
    const attachGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    globalThis.chrome.debugger.attach = () => attachGate.promise

    try {
      mgr.discover(398, 'https://example.com', 'Test')
      const attaching = mgr.ensureAttached(398)
      await Promise.resolve()
      await mgr.close(398, 'tab-closed')
      attachGate.reject(new Error('No tab with id: 398'))

      await expect(attaching).resolves.toMatchObject({ ok: false, code: 'tab_removed' })
      expect(mgr.get(398)).toBeUndefined()
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
    }
  })

  test('debugger reuse does not restore indexes after the tab was removed', async () => {
    const { mgr } = createManager()
    const targetInfoGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    globalThis.chrome.debugger.attach = () => Promise.reject(
      new Error('Another debugger is already attached'),
    )
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) =>
      method === 'Target.getTargetInfo' ? targetInfoGate.promise : Promise.resolve()

    try {
      mgr.discover(396, 'https://example.com', 'Test')
      const attach = mgr.ensureAttached(396)
      await Promise.resolve()
      mgr.removeTrackedEntry(396, 'tab-closed')
      targetInfoGate.resolve({ targetInfo: { targetId: 'REAL_TARGET_396' } })

      await expect(attach).resolves.toMatchObject({ ok: false, code: 'tab_removed' })
      expect(mgr.get(396)).toBeUndefined()
      expect(mgr.getByStableOrRealTargetId('REAL_TARGET_396')).toBeNull()
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
    }
  })

  test('a superseded attach is cleaned up before a replacement attach starts', async () => {
    const { mgr } = createManager()
    const firstAttachGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    const order = []
    let attachCalls = 0
    globalThis.chrome.debugger.attach = () => {
      attachCalls++
      order.push(`attach-${attachCalls}`)
      return attachCalls === 1 ? firstAttachGate.promise : Promise.resolve()
    }
    globalThis.chrome.debugger.detach = () => {
      order.push('detach')
      return Promise.resolve()
    }
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) =>
      Promise.resolve(
        method === 'Target.getTargetInfo'
          ? { targetInfo: { targetId: 'REAL_TARGET_392' } }
          : undefined,
      )

    try {
      mgr.discover(392, 'https://example.com', 'Test')
      const firstAttach = mgr.ensureAttached(392)
      await Promise.resolve()
      const detach = mgr.detach(392, 'unblock-overflow', { initiatedByUs: true })
      const replacementAttach = mgr.ensureAttached(392)

      expect(order).toEqual(['attach-1'])
      firstAttachGate.resolve()

      await expect(firstAttach).resolves.toMatchObject({ ok: false })
      await detach
      await expect(replacementAttach).resolves.toEqual({ ok: true })
      expect(order).toEqual(['attach-1', 'detach', 'attach-2'])
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
    }
  })

  test('an existing debugger completes setup and publishes the attached event', async () => {
    const { mgr, sent } = createManager()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    globalThis.chrome.debugger.attach = () =>
      Promise.reject(new Error('Another debugger is already attached'))
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) => Promise.resolve(
      method === 'Target.getTargetInfo'
        ? { targetInfo: { targetId: 'REAL_TARGET_395' } }
        : undefined,
    )

    try {
      mgr.discover(395, 'https://example.com', 'Test')
      await expect(mgr.ensureAttached(395)).resolves.toEqual({ ok: true })
      expect(mgr.get(395)).toMatchObject({
        state: 'connected',
        realTargetId: 'REAL_TARGET_395',
      })
      expect(
        sent.filter((event) => event.params?.method === 'Target.attachedToTarget'),
      ).toHaveLength(1)
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
    }
  })

  test('connects with a real target ID through the legacy target-info fallback', async () => {
    const { mgr, sent } = createManager()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalGetTargets = globalThis.chrome.debugger.getTargets
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    globalThis.chrome.debugger.attach = () => Promise.resolve()
    globalThis.chrome.debugger.getTargets = () => Promise.resolve([
      { id: 'REAL_TARGET_3951', tabId: 3951, attached: true, type: 'page' },
    ])
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) => {
      if (method === 'Target.getTargetInfo') {
        return Promise.reject(new Error('{"code":-32000,"message":"Not allowed"}'))
      }
      return Promise.resolve()
    }

    try {
      mgr.discover(3951, 'https://example.com', 'Test')
      await expect(mgr.ensureAttached(3951)).resolves.toEqual({ ok: true })
      expect(mgr.get(3951)).toMatchObject({
        state: 'connected',
        realTargetId: 'REAL_TARGET_3951',
      })
      expect(
        sent.find((event) => event.params?.method === 'Target.attachedToTarget')
          ?.params?.params?.targetInfo?.targetId,
      ).toBe('REAL_TARGET_3951')
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.getTargets = originalGetTargets
      globalThis.chrome.debugger.sendCommand = originalSendCommand
    }
  })

  test('uses the legacy target-info fallback when reusing an existing debugger', async () => {
    const { mgr } = createManager()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalGetTargets = globalThis.chrome.debugger.getTargets
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    globalThis.chrome.debugger.attach = () =>
      Promise.reject(new Error('Another debugger is already attached'))
    globalThis.chrome.debugger.getTargets = () => Promise.resolve([
      { id: 'REAL_TARGET_3952', tabId: 3952, attached: true, type: 'page' },
    ])
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) => {
      if (method === 'Target.getTargetInfo') {
        return Promise.reject(new Error('{"code":-32000,"message":"Not allowed"}'))
      }
      return Promise.resolve()
    }

    try {
      mgr.discover(3952, 'https://example.com', 'Test')
      await expect(mgr.ensureAttached(3952)).resolves.toEqual({ ok: true })
      expect(mgr.get(3952)).toMatchObject({
        state: 'connected',
        realTargetId: 'REAL_TARGET_3952',
      })
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.getTargets = originalGetTargets
      globalThis.chrome.debugger.sendCommand = originalSendCommand
    }
  })

  test('a late raw attach is detached before a retry starts a new generation', async () => {
    const { mgr, scheduler } = createManager()
    const firstAttachGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    let attachCalls = 0
    let detachCalls = 0
    globalThis.chrome.debugger.attach = () => {
      attachCalls++
      return attachCalls === 1 ? firstAttachGate.promise : Promise.resolve()
    }
    globalThis.chrome.debugger.detach = () => {
      detachCalls++
      return Promise.resolve()
    }
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) =>
      Promise.resolve(
        method === 'Target.getTargetInfo'
          ? { targetInfo: { targetId: 'REAL_TARGET_396' } }
          : undefined,
      )

    try {
      mgr.discover(396, 'https://example.com', 'Test')
      const attachmentSessionId = mgr.get(396).attachmentSessionId
      const firstSentAt = Date.now()
      const first = scheduler.schedule(396, {
        method: 'Runtime.evaluate',
        attachmentSessionId,
        task: () =>
          mgr.ensureAttached(
            396,
            createCommandContext({
              requestId: 1,
              method: 'Runtime.evaluate',
              sentAt: firstSentAt,
              deadlineAt: firstSentAt + 20,
            }),
          ),
      })

      await expect(first).rejects.toMatchObject({
        code: 'COMMAND_DEADLINE_EXCEEDED',
        requestId: 1,
        stage: 'chrome.debugger.attach',
      })
      expect(mgr.get(396)).toMatchObject({ state: 'virtual' })
      expect(scheduler.getSnapshot(396)).toMatchObject({ normalActive: 0, normalWaiting: 0 })
      expect(attachCalls).toBe(1)
      expect(detachCalls).toBe(0)

      const secondSentAt = Date.now()
      const second = scheduler.schedule(396, {
        method: 'Runtime.evaluate',
        attachmentSessionId,
        task: () =>
          mgr.ensureAttached(
            396,
            createCommandContext({
              requestId: 2,
              method: 'Runtime.evaluate',
              sentAt: secondSentAt,
              deadlineAt: secondSentAt + 1_000,
            }),
          ),
      })
      await Promise.resolve()
      expect(attachCalls).toBe(1)

      firstAttachGate.resolve()
      await expect(second).resolves.toEqual({ ok: true })
      expect(detachCalls).toBe(1)
      expect(attachCalls).toBe(2)
      expect(mgr.get(396)).toMatchObject({ state: 'connected', realTargetId: 'REAL_TARGET_396' })
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
    }
  })

  test('a retry deadline does not bypass an unsettled attach lifecycle', async () => {
    const { mgr } = createManager()
    const attachGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    let attachCalls = 0
    globalThis.chrome.debugger.attach = () => {
      attachCalls++
      return attachGate.promise
    }
    globalThis.chrome.debugger.detach = () => Promise.resolve()

    try {
      mgr.discover(3962, 'https://example.com', 'Test')
      const firstSentAt = Date.now()
      await expect(
        mgr.ensureAttached(
          3962,
          createCommandContext({
            requestId: 15,
            method: 'Runtime.evaluate',
            sentAt: firstSentAt,
            deadlineAt: firstSentAt + 20,
          }),
        ),
      ).rejects.toMatchObject({ stage: 'chrome.debugger.attach' })

      const retrySentAt = Date.now()
      await expect(
        mgr.ensureAttached(
          3962,
          createCommandContext({
            requestId: 16,
            method: 'Runtime.evaluate',
            sentAt: retrySentAt,
            deadlineAt: retrySentAt + 20,
          }),
        ),
      ).rejects.toMatchObject({
        requestId: 16,
        stage: 'tab_manager.waitForDetach',
      })
      expect(attachCalls).toBe(1)

      attachGate.resolve()
      await mgr.detach(3962, 'test-cleanup', { initiatedByUs: true })
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
    }
  })

  test('a late cleanup detach settles before retry starts a fresh attach', async () => {
    const { mgr, sent } = createManager()
    const cleanupGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    const originalSetTimeout = globalThis.setTimeout
    let attachCalls = 0
    let pageEnableCalls = 0
    let detachCalls = 0
    globalThis.chrome.debugger.attach = () => {
      attachCalls++
      return Promise.resolve()
    }
    globalThis.chrome.debugger.detach = () => {
      detachCalls++
      return cleanupGate.promise
    }
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) => {
      if (method === 'Page.enable') {
        pageEnableCalls++
        return pageEnableCalls === 1 ? new Promise(() => {}) : Promise.resolve()
      }
      return Promise.resolve({ targetInfo: { targetId: 'REAL_TARGET_397' } })
    }
    globalThis.setTimeout = (callback, delay, ...args) =>
      originalSetTimeout(callback, delay >= 900 ? 0 : delay, ...args)

    try {
      mgr.discover(397, 'https://example.com', 'Test')
      const sentAt = Date.now()
      await expect(
        mgr.ensureAttached(
          397,
          createCommandContext({
            requestId: 3,
            method: 'Runtime.evaluate',
            sentAt,
            deadlineAt: sentAt + 20,
          }),
        ),
      ).rejects.toMatchObject({
        code: 'COMMAND_DEADLINE_EXCEEDED',
        stage: 'chrome.debugger.sendCommand:Page.enable',
      })
      expect(mgr.get(397)).toMatchObject({ state: 'virtual' })
      expect(detachCalls).toBe(1)

      globalThis.setTimeout = originalSetTimeout
      const retrySentAt = Date.now()
      const retry = mgr.ensureAttached(
        397,
        createCommandContext({
          requestId: 4,
          method: 'Runtime.evaluate',
          sentAt: retrySentAt,
          deadlineAt: retrySentAt + 1_000,
        }),
      )
      await Promise.resolve()
      expect(attachCalls).toBe(1)

      cleanupGate.resolve()
      await expect(retry).resolves.toEqual({ ok: true })
      expect(attachCalls).toBe(2)
      expect(pageEnableCalls).toBe(2)
      expect(mgr.get(397)).toMatchObject({ state: 'connected', realTargetId: 'REAL_TARGET_397' })
      expect(
        sent.filter((event) => event.params?.method === 'Target.attachedToTarget'),
      ).toHaveLength(1)
      expect(
        sent.find((event) => event.params?.method === 'Target.attachedToTarget'),
      ).toMatchObject({
        params: {
          params: {
            sessionId: mgr.get(397).attachmentSessionId,
            targetInfo: { targetId: 'REAL_TARGET_397', attached: true },
          },
        },
      })
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test('an attach leaf timeout cleans up physical state and releases pending', async () => {
    const { mgr } = createManager()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    const originalSetTimeout = globalThis.setTimeout
    let attachCalls = 0
    let detachCalls = 0
    globalThis.chrome.debugger.attach = () => {
      attachCalls++
      return Promise.resolve()
    }
    globalThis.chrome.debugger.detach = () => {
      detachCalls++
      return Promise.resolve()
    }
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) =>
      method === 'Page.enable'
        ? new Promise(() => {})
        : Promise.resolve({ targetInfo: { targetId: 'REAL_TARGET_400' } })
    globalThis.setTimeout = (callback, delay, ...args) =>
      originalSetTimeout(callback, delay === 10_000 ? 0 : delay, ...args)

    try {
      mgr.discover(400, 'https://example.com', 'Test')
      const sentAt = Date.now()
      await expect(
        mgr.ensureAttached(
          400,
          createCommandContext({
            requestId: 7,
            method: 'Runtime.evaluate',
            sentAt,
            deadlineAt: sentAt + 60_000,
          }),
        ),
      ).rejects.toMatchObject({
        code: 'COMMAND_DEADLINE_EXCEEDED',
        requestId: 7,
        stage: 'chrome.debugger.sendCommand:Page.enable',
        timeoutSource: 'operation_limit',
      })
      expect(mgr.get(400)).toMatchObject({ state: 'virtual' })
      expect(detachCalls).toBe(1)

      globalThis.chrome.debugger.sendCommand = (_debuggee, method) =>
        Promise.resolve(
          method === 'Target.getTargetInfo'
            ? { targetInfo: { targetId: 'REAL_TARGET_400' } }
            : undefined,
        )
      await expect(mgr.ensureAttached(400)).resolves.toEqual({ ok: true })
      expect(attachCalls).toBe(2)
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test('a conflict diagnosis timeout surfaces its stage and rolls back attach state', async () => {
    const { mgr } = createManager()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    const originalExecuteScript = globalThis.chrome.scripting.executeScript
    const originalDateNow = Date.now
    let detachCalls = 0
    let executeScriptCalls = 0
    let clockOffsetMs = 0
    Date.now = () => originalDateNow() + clockOffsetMs
    globalThis.chrome.debugger.attach = () => {
      // Exhaust the shared attach budget before conflict diagnosis starts.
      clockOffsetMs = 31_000
      return Promise.reject(
        new Error('Cannot access a chrome-extension:// URL of different extension'),
      )
    }
    globalThis.chrome.debugger.detach = () => {
      detachCalls++
      return Promise.resolve()
    }
    globalThis.chrome.scripting.executeScript = () => {
      executeScriptCalls++
      return Promise.resolve([])
    }

    try {
      mgr.discover(401, 'https://example.com', 'Test')
      const sentAt = Date.now()
      await expect(
        mgr.ensureAttached(
          401,
          createCommandContext({
            requestId: 11,
            method: 'Runtime.evaluate',
            sentAt,
            deadlineAt: sentAt + 60_000,
          }),
        ),
      ).rejects.toMatchObject({
        code: 'COMMAND_DEADLINE_EXCEEDED',
        requestId: 11,
        stage: 'chrome.scripting.executeScript:findForeignExtensionFrames',
      })
      expect(executeScriptCalls).toBe(0)
      expect(mgr.get(401)).toMatchObject({ state: 'virtual' })
      expect(detachCalls).toBeGreaterThan(0)

      clockOffsetMs = 0
      globalThis.chrome.debugger.attach = () => Promise.resolve()
      globalThis.chrome.debugger.sendCommand = (_debuggee, method) =>
        Promise.resolve(
          method === 'Target.getTargetInfo'
            ? { targetInfo: { targetId: 'REAL_TARGET_401' } }
            : undefined,
        )
      await expect(mgr.ensureAttached(401)).resolves.toEqual({ ok: true })
    } finally {
      Date.now = originalDateNow
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
      globalThis.chrome.scripting.executeScript = originalExecuteScript
    }
  })

  test('concurrent waiters share the initiating deadline and retain their own error identity', async () => {
    const { mgr } = createManager()
    const firstAttachGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    let attachCalls = 0
    globalThis.chrome.debugger.attach = () => {
      attachCalls++
      return firstAttachGate.promise
    }
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) =>
      Promise.resolve(
        method === 'Target.getTargetInfo'
          ? { targetInfo: { targetId: 'REAL_TARGET_398' } }
          : undefined,
      )

    try {
      mgr.discover(398, 'https://example.com', 'Test')
      const firstSentAt = Date.now()
      const first = mgr.ensureAttached(
        398,
        createCommandContext({
          requestId: 4,
          method: 'Runtime.evaluate',
          sentAt: firstSentAt,
          deadlineAt: firstSentAt + 20,
        }),
      )
      await Promise.resolve()

      const secondSentAt = Date.now()
      const second = mgr.ensureAttached(
        398,
        createCommandContext({
          requestId: 5,
          method: 'Runtime.evaluate',
          sentAt: secondSentAt,
          deadlineAt: secondSentAt + 1_000,
        }),
      )

      const outcomes = await Promise.allSettled([first, second])
      expect(outcomes[0]).toMatchObject({
        status: 'rejected',
        reason: { requestId: 4, stage: 'chrome.debugger.attach' },
      })
      expect(outcomes[1]).toMatchObject({
        status: 'rejected',
        reason: { requestId: 5, stage: 'chrome.debugger.attach' },
      })
      expect(attachCalls).toBe(1)
      expect(mgr.get(398)).toMatchObject({ state: 'virtual' })

      globalThis.chrome.debugger.attach = () => {
        attachCalls++
        return Promise.resolve()
      }
      firstAttachGate.resolve()
      const retrySentAt = Date.now()
      await expect(
        mgr.ensureAttached(
          398,
          createCommandContext({
            requestId: 6,
            method: 'Runtime.evaluate',
            sentAt: retrySentAt,
            deadlineAt: retrySentAt + 1_000,
          }),
        ),
      ).resolves.toEqual({ ok: true })
      expect(attachCalls).toBe(2)
      expect(mgr.get(398)).toMatchObject({ state: 'connected', realTargetId: 'REAL_TARGET_398' })
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
    }
  })

  test('proactive detach waits for an expired attach generation to settle', async () => {
    const { mgr } = createManager()
    const attachGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalDetach = globalThis.chrome.debugger.detach
    let detachCalls = 0
    globalThis.chrome.debugger.attach = () => attachGate.promise
    globalThis.chrome.debugger.detach = () => {
      detachCalls++
      return Promise.resolve()
    }

    try {
      mgr.discover(399, 'https://example.com', 'Test')
      const sentAt = Date.now()
      await expect(
        mgr.ensureAttached(
          399,
          createCommandContext({
            requestId: 7,
            method: 'Runtime.evaluate',
            sentAt,
            deadlineAt: sentAt + 20,
          }),
        ),
      ).rejects.toMatchObject({ code: 'COMMAND_DEADLINE_EXCEEDED' })

      const detach = mgr.detach(399, 'unblock-overflow', { initiatedByUs: true })
      await Promise.resolve()
      expect(detachCalls).toBe(0)

      attachGate.resolve()
      await expect(detach).resolves.toBeUndefined()
      expect(detachCalls).toBe(1)
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.detach = originalDetach
    }
  })
})

describe('TabManager — close() removes entry', () => {
  test('close() on connected entry fully removes and notifies relay', async () => {
    const { mgr, sent } = createManager()

    setupConnectedTab(mgr, 400, 'session-400', 'REAL_TARGET_400')
    sent.length = 0

    await mgr.close(400, 'tab-closed')

    expect(mgr.get(400)).toBeUndefined()
    expect(mgr.resolveTabId('session-400', null)).toBeNull()
    expect(mgr.resolveTabId(null, 'REAL_TARGET_400')).toBeNull()

    const detach = sent.find((s) => s.params?.method === 'Target.detachedFromTarget')
    expect(detach).toBeDefined()
    expect(detach.params.params.targetId).toBe('REAL_TARGET_400')
    // Belt-and-suspenders: also sends Extension.tabRemoved for tab-closed
    const removed = sent.find((s) => s.params?.method === 'Extension.tabRemoved')
    expect(removed).toBeDefined()
  })

  test('close() on virtual entry sends Extension.tabRemoved', async () => {
    const { mgr, sent } = createManager()

    mgr.discover(450, 'https://example.com', 'Virtual')
    sent.length = 0

    await mgr.close(450, 'tab-closed')

    expect(mgr.get(450)).toBeUndefined()
    const removed = sent.find((s) => s.params?.method === 'Extension.tabRemoved')
    expect(removed).toBeDefined()
  })

  test('close() deletes derived Agent and retained state with the entry', async () => {
    const { mgr } = createManager()

    setupConnectedTab(mgr, 460, 'session-460', 'REAL_TARGET_460')
    mgr.registerAgentTab(460, { retained: true })
    expect(mgr.agentTabCount).toBe(1)
    expect(mgr.retainedTabCount).toBe(1)
    expect(mgr.getAgentTabIds()).toEqual([460])

    await mgr.close(460, 'tab-closed')

    expect(mgr.agentTabCount).toBe(0)
    expect(mgr.retainedTabCount).toBe(0)
    expect(mgr.getAgentTabIds()).toEqual([])
    expect(mgr.isRetained(460)).toBe(false)
    expect(mgr.isAgent(460)).toBe(false)
  })
})

describe('TabManager — removeTrackedEntry event semantics', () => {
  test('attaching entry sends Extension.tabRemoved (not detachedFromTarget)', () => {
    const { mgr, sent } = createManager()

    mgr.discover(500, 'https://example.com', 'Attaching')
    const entry = mgr.get(500)
    entry.state = 'attaching'
    sent.length = 0

    mgr.removeTrackedEntry(500, 'attach-failed')

    expect(mgr.get(500)).toBeUndefined()
    const removed = sent.find((s) => s.params?.method === 'Extension.tabRemoved')
    expect(removed).toBeDefined()
    const detach = sent.find((s) => s.params?.method === 'Target.detachedFromTarget')
    expect(detach).toBeUndefined()
  })

  test('connected entry with child sessions clears child routes on removal', () => {
    const { mgr, sent } = createManager()

    setupConnectedTab(mgr, 700, 'session-700', 'REAL_TARGET_700')
    addChildSession(mgr, 700, 'session-700', 'child-oopif-1', 'oopif-target-1')

    expect(mgr.getBySessionId('child-oopif-1')?.tabId).toBe(700)
    sent.length = 0

    mgr.removeTrackedEntry(700, 'tab-closed')

    expect(mgr.get(700)).toBeUndefined()
    expect(mgr.getBySessionId('child-oopif-1')).toBeNull()
    expect(mgr.resolveTabId('child-oopif-1', null)).toBeNull()
  })

  test('an externally closed Agent tab is reported as such', async () => {
    const { mgr, sent } = createManager()

    mgr.discover(710, 'https://example.com', 'Agent page')
    mgr.registerAgentTab(710, {})
    sent.length = 0

    await mgr.close(710, 'tab-closed', { closedBy: 'external' })

    const removed = sent.find((s) => s.params?.method === 'Extension.tabRemoved')
    expect(removed.params.params).toMatchObject({ closedBy: 'external', agentTab: true })
  })

  test('a relay-requested close outranks the caller reading it as external', async () => {
    const { mgr, sent } = createManager()

    mgr.discover(720, 'https://example.com', 'Agent page')
    mgr.registerAgentTab(720, {})
    sent.length = 0

    // chrome.tabs.onRemoved also fires for our own removes, so the mark set
    // before chrome.tabs.remove has to win over what that listener assumes.
    mgr.markRelayRequestedClose(720)
    await mgr.close(720, 'tab-closed', { closedBy: 'external' })

    const removed = sent.find((s) => s.params?.method === 'Extension.tabRemoved')
    expect(removed.params.params).toMatchObject({ closedBy: 'relay', agentTab: true })
  })

  test('an internal removal claims nothing about who closed the tab', () => {
    const { mgr, sent } = createManager()

    mgr.discover(730, 'https://example.com', 'Virtual')
    sent.length = 0

    mgr.removeTrackedEntry(730, 'attach-failed')

    const removed = sent.find((s) => s.params?.method === 'Extension.tabRemoved')
    expect(removed.params.params).toMatchObject({ closedBy: 'cleanup', agentTab: false })
  })

  test('a consumed mark cannot leak onto a tab that reuses the id', async () => {
    const { mgr, sent } = createManager()

    mgr.discover(740, 'https://example.com', 'Agent page')
    mgr.registerAgentTab(740, {})
    mgr.markRelayRequestedClose(740)
    await mgr.close(740, 'tab-closed', { closedBy: 'external' })

    mgr.discover(740, 'https://example.com/next', 'Reused id')
    mgr.registerAgentTab(740, {})
    sent.length = 0

    await mgr.close(740, 'tab-closed', { closedBy: 'external' })

    const removed = sent.find((s) => s.params?.method === 'Extension.tabRemoved')
    expect(removed.params.params).toMatchObject({ closedBy: 'external', agentTab: true })
  })
})

describe('TabManager — resync protocol', () => {
  test('publishes a complete snapshot with epoch and authoritative status', () => {
    const { mgr, sent } = createManager()
    setupConnectedTab(mgr, 801, 'session-801', 'REAL_TARGET_801')
    mgr.discover(802, 'https://virtual.example.com', 'Virtual')
    mgr.discover(803, 'https://attaching.example.com', 'Attaching')
    mgr.get(803).state = 'attaching'
    sent.length = 0

    const epoch = mgr.beginTabsResync()
    expect(mgr.resyncAttachedTabs({ epoch, authoritative: true })).toBe(true)

    expect(sent.find((event) => event.params?.method === 'Extension.tabsResyncComplete'))
      .toMatchObject({
        params: {
          params: {
            activeVtabIds: ['vtab-801', 'vtab-802', 'vtab-803'],
            epoch,
            authoritative: true,
          },
        },
      })
  })

  test('drops a stale resync before replaying any tab state', () => {
    const { mgr, sent } = createManager()
    mgr.discover(804, 'https://example.com', 'Tab')
    const staleEpoch = mgr.beginTabsResync()
    const currentEpoch = mgr.beginTabsResync()
    sent.length = 0

    expect(mgr.isTabsResyncCurrent(staleEpoch)).toBe(false)
    expect(mgr.isTabsResyncCurrent(currentEpoch)).toBe(true)
    expect(mgr.resyncAttachedTabs({ epoch: staleEpoch, authoritative: true })).toBe(false)
    expect(sent).toEqual([])
  })

  test('does not apply discovery results after their resync becomes stale', async () => {
    const { mgr } = createManager()
    const queryGate = deferred()
    const originalQuery = globalThis.chrome.tabs.query
    globalThis.chrome.tabs.query = () => queryGate.promise

    try {
      const epoch = mgr.beginTabsResync()
      const discovery = mgr.discoverAll(() => mgr.isTabsResyncCurrent(epoch))
      mgr.beginTabsResync()
      queryGate.resolve([{ id: 805, url: 'https://example.com', title: 'Late' }])

      await expect(discovery).resolves.toBe(false)
      expect(mgr.has(805)).toBe(false)
    } finally {
      globalThis.chrome.tabs.query = originalQuery
    }
  })

  test('does not mutate tab state when Chrome reconciliation becomes stale', async () => {
    const { mgr, sent } = createManager()
    mgr.discover(806, 'https://example.com', 'Still live')
    const queryGate = deferred()
    const originalQuery = globalThis.chrome.tabs.query
    globalThis.chrome.tabs.query = () => queryGate.promise
    sent.length = 0

    try {
      const reconciliation = mgr.reconcileFromChrome()
      mgr.beginTabsResync()
      queryGate.resolve([])

      await reconciliation
      expect(mgr.has(806)).toBe(true)
      expect(sent).toEqual([])
    } finally {
      globalThis.chrome.tabs.query = originalQuery
    }
  })

  test('coalesces runtime reconciliation and publishes one authoritative epoch', async () => {
    const { mgr, sent } = createManager()
    const queryGate = deferred()
    const originalQuery = globalThis.chrome.tabs.query
    const originalGetTargets = globalThis.chrome.debugger.getTargets
    let queryCount = 0
    globalThis.chrome.tabs.query = () => {
      queryCount += 1
      return queryGate.promise
    }
    globalThis.chrome.debugger.getTargets = () => Promise.resolve([])

    try {
      const first = mgr.reconcileFromChrome()
      const second = mgr.reconcileFromChrome()
      expect(second).toBe(first)
      queryGate.resolve([])
      await first

      expect(queryCount).toBe(1)
      const completions = sent.filter(
        (event) => event.params?.method === 'Extension.tabsResyncComplete',
      )
      expect(completions).toHaveLength(1)
      expect(completions[0]).toMatchObject({
        params: { params: { epoch: 1, authoritative: true } },
      })
    } finally {
      globalThis.chrome.tabs.query = originalQuery
      globalThis.chrome.debugger.getTargets = originalGetTargets
    }
  })

  test('replaces a stale runtime reconciliation instead of joining it', async () => {
    const { mgr, sent } = createManager()
    const firstQuery = deferred()
    const originalQuery = globalThis.chrome.tabs.query
    const originalGetTargets = globalThis.chrome.debugger.getTargets
    let queryCount = 0
    globalThis.chrome.tabs.query = () => {
      queryCount += 1
      return queryCount === 1 ? firstQuery.promise : Promise.resolve([])
    }
    globalThis.chrome.debugger.getTargets = () => Promise.resolve([])

    try {
      const stale = mgr.reconcileFromChrome()
      mgr.beginTabsResync()
      const current = mgr.reconcileFromChrome()
      expect(current).not.toBe(stale)
      await current
      firstQuery.resolve([])
      await stale

      expect(queryCount).toBe(2)
      const completions = sent.filter(
        (event) => event.params?.method === 'Extension.tabsResyncComplete',
      )
      expect(completions).toHaveLength(1)
      expect(completions[0]).toMatchObject({
        params: { params: { epoch: 3, authoritative: true } },
      })
    } finally {
      globalThis.chrome.tabs.query = originalQuery
      globalThis.chrome.debugger.getTargets = originalGetTargets
    }
  })

  test('does not publish a completion when runtime reconciliation fails', async () => {
    const { mgr, sent } = createManager()
    const originalQuery = globalThis.chrome.tabs.query
    globalThis.chrome.tabs.query = () => Promise.reject(new Error('query failed'))

    try {
      await expect(mgr.reconcileFromChrome()).rejects.toThrow('query failed')
      expect(sent.some((event) => event.params?.method === 'Extension.tabsResyncComplete'))
        .toBe(false)
    } finally {
      globalThis.chrome.tabs.query = originalQuery
    }
  })
})

describe('TabManager — v2 persistence and legacy migration', () => {
  const originalGet = globalThis.chrome.storage.session.get
  const originalSet = globalThis.chrome.storage.session.set
  const originalRemove = globalThis.chrome.storage.session.remove
  const originalQuery = globalThis.chrome.tabs.query
  const originalGetTargets = globalThis.chrome.debugger.getTargets

  afterEach(() => {
    globalThis.chrome.storage.session.get = originalGet
    globalThis.chrome.storage.session.set = originalSet
    globalThis.chrome.storage.session.remove = originalRemove
    globalThis.chrome.tabs.query = originalQuery
    globalThis.chrome.debugger.getTargets = originalGetTargets
  })

  function installStorage({
    v2Present = false,
    v2,
    legacyTabs,
    cancelledTabs,
    liveTabs = [],
    targets = [],
    setImpl,
  } = {}) {
    const getCalls = []
    const writes = []
    const removes = []
    globalThis.chrome.tabs.query = () => Promise.resolve(liveTabs)
    globalThis.chrome.debugger.getTargets = () => Promise.resolve(targets)
    globalThis.chrome.storage.session.get = async (keys) => {
      getCalls.push(keys)
      if (keys === 'accio_tabRegistryV2') {
        return v2Present ? { accio_tabRegistryV2: v2 } : {}
      }
      return {
        accio_tabsState: legacyTabs,
        accio_cancelledTabs: cancelledTabs,
      }
    }
    globalThis.chrome.storage.session.set = async (value) => {
      writes.push(value)
      if (setImpl) await setImpl(value)
    }
    globalThis.chrome.storage.session.remove = async (keys) => {
      removes.push(keys)
    }
    return { getCalls, writes, removes }
  }

  function legacyEntry(tabId, state = 'connected') {
    return {
      sessionId: `session-${tabId}`,
      targetId: state === 'connected' ? `REAL_TARGET_${tabId}` : `vtab-${tabId}`,
      state,
      url: `https://${tabId}.example.com/old`,
      title: `Old ${tabId}`,
    }
  }

  test('migrates only complete legacy tab records and removes legacy keys after v2 write', async () => {
    const storage = installStorage({
      legacyTabs: {
        tabs: [
          [10, legacyEntry(10)],
          [11, legacyEntry(11, 'attaching')],
          [12, legacyEntry(12, 'virtual')],
        ],
        sessionSeq: 12,
        agentTabs: [
          [10, 'retained'],
          [11, 'agent'],
          [999, 'retained'],
        ],
      },
      cancelledTabs: [12, 998],
      liveTabs: [
        { id: 10, url: 'https://10.example.com/live', title: 'Live 10' },
        { id: 11, url: 'https://11.example.com/live', title: 'Live 11' },
        { id: 12, url: 'https://12.example.com/live', title: 'Live 12' },
      ],
      targets: [{ tabId: 10, attached: true, type: 'page', id: 'REAL_TARGET_10_NEW' }],
    })
    const { mgr } = createManager()

    await expect(mgr.loadTabs()).resolves.toBe(true)
    await mgr.reconcileTabs()

    expect(mgr.get(10)).toMatchObject({
      state: 'connected',
      realTargetId: 'REAL_TARGET_10_NEW',
      url: 'https://10.example.com/live',
      title: 'Live 10',
      createdByAgent: true,
      retained: true,
      attachPermission: 'allowed',
    })
    expect(mgr.get(11)).toMatchObject({
      state: 'virtual',
      realTargetId: null,
      createdByAgent: true,
      retained: false,
    })
    expect(mgr.get(12)).toMatchObject({
      state: 'virtual',
      createdByAgent: false,
      retained: false,
      attachPermission: 'user_denied',
    })
    expect(mgr.agentTabCount).toBe(2)
    expect(mgr.retainedTabCount).toBe(1)
    expect(mgr.get(999)).toBeUndefined()
    expect(mgr.get(998)).toBeUndefined()
    expect(storage.removes).toEqual([['accio_tabsState', 'accio_cancelledTabs']])
    expect(storage.writes.at(-1)).toHaveProperty('accio_tabRegistryV2')
    await mgr.clearAll()
  })

  test('preserves a live orphan legacy cancellation when the tab snapshot lagged behind', async () => {
    const storage = installStorage({
      legacyTabs: { tabs: [], agentTabs: [], sessionSeq: 0 },
      cancelledTabs: [77, 78],
      liveTabs: [{ id: 77, url: 'https://77.example.com', title: 'Seventy-seven' }],
    })
    const { mgr } = createManager()

    await expect(mgr.loadTabs()).resolves.toBe(true)
    await mgr.discoverAll(() => true)

    expect(mgr.get(77)).toMatchObject({
      state: 'virtual',
      realTargetId: null,
      url: 'https://77.example.com',
      title: 'Seventy-seven',
      createdByAgent: false,
      retained: false,
      attachPermission: 'user_denied',
    })
    expect(mgr.get(78)).toBeUndefined()
    await expect(mgr.ensureAttached(77)).resolves.toMatchObject({
      ok: false,
      code: 'user_denied',
    })
    expect(storage.writes[0].accio_tabRegistryV2.tabs).toEqual([
      [77, expect.objectContaining({ attachPermission: 'user_denied' })],
    ])
    expect(storage.removes).toEqual([['accio_tabsState', 'accio_cancelledTabs']])
    await mgr.clearAll()
  })

  test('keeps a restricted live cancellation hidden until it becomes debuggable', async () => {
    const storage = installStorage({
      legacyTabs: { tabs: [], agentTabs: [], sessionSeq: 0 },
      cancelledTabs: [79],
      liveTabs: [{ id: 79, url: 'chrome://newtab/', title: 'New Tab' }],
    })
    const { mgr, sent } = createManager()

    await expect(mgr.loadTabs()).resolves.toBe(true)
    expect(mgr.get(79)).toMatchObject({
      state: 'virtual',
      url: 'chrome://newtab/',
      attachPermission: 'user_denied',
    })
    expect(storage.writes[0].accio_tabRegistryV2.tabs).toEqual([
      [79, expect.objectContaining({ attachPermission: 'user_denied' })],
    ])

    const epoch = mgr.beginTabsResync()
    mgr.resyncAttachedTabs({ epoch, authoritative: true })
    expect(sent.some((event) => event.params?.method === 'Extension.tabDiscovered')).toBe(false)
    expect(sent.find((event) => event.params?.method === 'Extension.tabsResyncComplete'))
      .toMatchObject({ params: { params: { activeVtabIds: [], epoch, authoritative: true } } })

    mgr.discover(79, 'https://79.example.com', 'Seventy-nine')
    expect(mgr.get(79)).toMatchObject({
      url: 'https://79.example.com',
      title: 'Seventy-nine',
      attachPermission: 'user_denied',
    })
    expect(sent.filter((event) => event.params?.method === 'Extension.tabDiscovered'))
      .toEqual([
        expect.objectContaining({
          params: expect.objectContaining({
            params: expect.objectContaining({
              targetInfo: expect.objectContaining({
                targetId: 'vtab-79',
                url: 'https://79.example.com',
              }),
            }),
          }),
        }),
      ])
    await expect(mgr.ensureAttached(79)).resolves.toMatchObject({
      ok: false,
      code: 'user_denied',
    })

    await mgr.close(79, 'tab-closed')
    expect(mgr.get(79)).toBeUndefined()
  })

  test('a present v2 key skips all legacy reads and cleanup', async () => {
    const storage = installStorage({
      v2Present: true,
      v2: {
        sessionSeq: 3,
        tabs: [[20, {
          state: 'virtual',
          attachmentSessionId: 'session-20',
          realTargetId: null,
          url: 'https://20.example.com',
          title: 'Twenty',
          createdByAgent: true,
          retained: false,
          attachPermission: 'allowed',
        }]],
      },
      legacyTabs: { tabs: [[999, legacyEntry(999)]] },
      liveTabs: [{ id: 20, url: 'https://20.example.com', title: 'Twenty' }],
    })
    const { mgr } = createManager()

    await mgr.loadTabs()

    expect(storage.getCalls).toEqual(['accio_tabRegistryV2'])
    expect(storage.removes).toEqual([])
    expect(storage.writes).toEqual([])
    expect(mgr.getAgentTabIds()).toEqual([20])
  })

  test('loadTabs reports failure when storage read fails', async () => {
    globalThis.chrome.storage.session.get = async () => { throw new Error('read failed') }
    const { mgr } = createManager()

    await expect(mgr.loadTabs()).resolves.toBe(false)
  })

  test('failed v2 migration write preserves both legacy keys', async () => {
    const storage = installStorage({
      legacyTabs: { tabs: [[30, legacyEntry(30, 'virtual')]], agentTabs: [] },
      cancelledTabs: [],
      liveTabs: [{ id: 30, url: 'https://30.example.com', title: 'Thirty' }],
      setImpl: async () => { throw new Error('storage unavailable') },
    })
    const { mgr } = createManager()

    await expect(mgr.loadTabs()).resolves.toBe(true)

    expect(mgr.has(30)).toBe(true)
    expect(storage.writes).toHaveLength(1)
    expect(storage.removes).toEqual([])
  })

  test('v2 serialization excludes runtime fields and normalizes attaching', async () => {
    const storage = installStorage({
      v2Present: true,
      v2: {
        sessionSeq: 4,
        tabs: [[40, {
          state: 'attaching',
          attachmentSessionId: 'session-40',
          realTargetId: 'SHOULD_BE_DROPPED',
          url: 'https://40.example.com',
          title: 'Forty',
          createdByAgent: true,
          retained: true,
          attachPermission: 'allowed',
          childSessionIds: ['not-restored'],
        }]],
      },
      liveTabs: [{ id: 40, url: 'https://40.example.com', title: 'Forty' }],
    })
    const { mgr } = createManager()

    await mgr.loadTabs()
    const entry = mgr.get(40)
    expect(entry).toMatchObject({ state: 'virtual', realTargetId: null })
    expect(entry.childSessionIds.size).toBe(0)

    await mgr.reconcileTabs()
    await Bun.sleep(220)

    const persisted = storage.writes.at(-1).accio_tabRegistryV2.tabs[0][1]
    expect(persisted).toEqual({
      state: 'virtual',
      attachmentSessionId: 'session-40',
      realTargetId: null,
      url: 'https://40.example.com',
      title: 'Forty',
      createdByAgent: true,
      retained: true,
      attachPermission: 'allowed',
    })
    expect(persisted).not.toHaveProperty('childSessionIds')
    expect(persisted).not.toHaveProperty('targetId')
    expect(persisted).not.toHaveProperty('sessionId')
  })

  test('reconcile removes closed tabs, refreshes metadata and targets, and rebuilds routes', async () => {
    installStorage({
      v2Present: true,
      v2: {
        sessionSeq: 7,
        tabs: [
          [50, {
            state: 'connected', attachmentSessionId: 'session-50', realTargetId: 'OLD_50',
            url: 'https://old.example.com', title: 'Old', createdByAgent: false,
            retained: false, attachPermission: 'allowed',
          }],
          [51, {
            state: 'connected', attachmentSessionId: 'session-51', realTargetId: 'OLD_51',
            url: 'https://old.example.com', title: 'Old', createdByAgent: false,
            retained: false, attachPermission: 'allowed',
          }],
          [52, {
            state: 'virtual', attachmentSessionId: 'session-52', realTargetId: null,
            url: 'https://closed.example.com', title: 'Closed', createdByAgent: false,
            retained: false, attachPermission: 'allowed',
          }],
        ],
      },
      liveTabs: [
        { id: 50, url: 'https://new.example.com', title: 'New' },
        { id: 51, url: 'https://detached.example.com', title: 'Detached' },
      ],
      targets: [{ tabId: 50, attached: true, type: 'page', id: 'NEW_50' }],
    })
    const { mgr } = createManager()

    await mgr.loadTabs()
    await mgr.reconcileTabs()

    expect(mgr.get(50)).toMatchObject({
      state: 'connected',
      realTargetId: 'NEW_50',
      url: 'https://new.example.com',
      title: 'New',
    })
    expect(mgr.getByStableOrRealTargetId('NEW_50')).toBe(50)
    expect(mgr.get(51)?.state).toBe('virtual')
    expect(mgr.get(51)?.realTargetId).toBeNull()
    expect(mgr.getBySessionId('session-51')).toBeNull()
    expect(mgr.getBySessionId(mgr.get(51).attachmentSessionId)).toEqual({ tabId: 51, kind: 'main' })
    expect(mgr.has(52)).toBe(false)
    await mgr.clearAll()
  })

  test('restored session IDs are unique and advance the generated sequence', async () => {
    installStorage({
      v2Present: true,
      v2: {
        sessionSeq: 0,
        tabs: [
          [53, {
            state: 'virtual', attachmentSessionId: 'cb-tab-9000-53', realTargetId: null,
            createdByAgent: false, retained: false, attachPermission: 'allowed',
          }],
          [54, {
            state: 'virtual', attachmentSessionId: 'cb-tab-9000-53', realTargetId: null,
            createdByAgent: false, retained: false, attachPermission: 'allowed',
          }],
          [55, {
            state: 'virtual', attachmentSessionId: '', realTargetId: null,
            createdByAgent: false, retained: false, attachPermission: 'allowed',
          }],
        ],
      },
      liveTabs: [{ id: 53 }, { id: 54 }, { id: 55 }],
    })
    const { mgr } = createManager()

    await mgr.loadTabs()

    const sessionIds = [53, 54, 55].map((tabId) => mgr.get(tabId).attachmentSessionId)
    expect(new Set(sessionIds).size).toBe(3)
    expect(sessionIds[0]).toBe('cb-tab-9000-53')
    for (const sessionId of sessionIds.slice(1)) {
      expect(Number(/^cb-tab-(\d+)-/.exec(sessionId)?.[1])).toBeGreaterThan(9000)
    }
  })

  test('reconcile preserves connected child routes', async () => {
    installStorage({
      v2Present: true,
      v2: {
        sessionSeq: 0,
        tabs: [[57, {
          state: 'connected', attachmentSessionId: 'session-57', realTargetId: 'REAL_TARGET_57',
          createdByAgent: false, retained: false, attachPermission: 'allowed',
        }]],
      },
      liveTabs: [{ id: 57, url: 'https://57.example.com', title: 'Fifty-seven' }],
      targets: [{ tabId: 57, attached: true, type: 'page', id: 'REAL_TARGET_57' }],
    })
    const { mgr } = createManager()
    await mgr.loadTabs()
    addChildSession(mgr, 57, 'session-57', 'child-57', 'CHILD_TARGET_57')

    await mgr.reconcileTabs()

    expect(mgr.get(57)).toMatchObject({
      state: 'connected',
      attachmentSessionId: 'session-57',
      realTargetId: 'REAL_TARGET_57',
    })
    expect(mgr.getBySessionId('child-57')).toEqual({ tabId: 57, kind: 'child' })
    await mgr.clearAll()
  })

  test('reconcile preserves an in-flight attach', async () => {
    installStorage({
      v2Present: true,
      v2: {
        sessionSeq: 0,
        tabs: [[58, {
          state: 'virtual', attachmentSessionId: 'session-58', realTargetId: null,
          createdByAgent: false, retained: false, attachPermission: 'allowed',
        }]],
      },
      liveTabs: [{ id: 58, url: 'https://58.example.com', title: 'Fifty-eight' }],
    })
    const { mgr } = createManager()
    await mgr.loadTabs()

    const attachGate = deferred()
    const originalAttach = globalThis.chrome.debugger.attach
    const originalSendCommand = globalThis.chrome.debugger.sendCommand
    globalThis.chrome.debugger.attach = () => attachGate.promise
    globalThis.chrome.debugger.sendCommand = (_debuggee, method) => Promise.resolve(
      method === 'Target.getTargetInfo'
        ? { targetInfo: { targetId: 'REAL_TARGET_58' } }
        : undefined,
    )

    try {
      const attaching = mgr.ensureAttached(58)
      expect(mgr.get(58)?.state).toBe('attaching')

      await mgr.reconcileTabs()
      expect(mgr.get(58)?.state).toBe('attaching')

      attachGate.resolve()
      await expect(attaching).resolves.toEqual({ ok: true })
      expect(mgr.get(58)).toMatchObject({
        state: 'connected',
        attachmentSessionId: 'session-58',
        realTargetId: 'REAL_TARGET_58',
      })
      await mgr.clearAll()
    } finally {
      globalThis.chrome.debugger.attach = originalAttach
      globalThis.chrome.debugger.sendCommand = originalSendCommand
    }
  })

  test('serialized writes preserve mutation order and clearAll writes the final empty snapshot', async () => {
    const storage = installStorage({ v2Present: true, v2: { sessionSeq: 0, tabs: [] } })
    const { mgr } = createManager()
    await mgr.loadTabs()
    storage.writes.length = 0

    const firstWrite = deferred()
    let setCalls = 0
    globalThis.chrome.storage.session.set = async (value) => {
      storage.writes.push(value)
      setCalls++
      if (setCalls === 1) await firstWrite.promise
    }

    mgr.registerAgentTab(60, {
      url: 'https://60.example.com',
      title: 'First',
      retained: false,
    })
    await Bun.sleep(220)
    mgr.updateTab(60, undefined, 'Second')
    await Bun.sleep(220)

    const clearing = mgr.clearAll()
    await Promise.resolve()
    expect(storage.writes).toHaveLength(1)
    firstWrite.resolve()
    await clearing

    expect(storage.writes.map((write) => write.accio_tabRegistryV2.tabs[0]?.[1]?.title ?? null))
      .toEqual(['First', 'Second', null])
    expect(storage.writes.at(-1).accio_tabRegistryV2.tabs).toEqual([])
    expect(mgr.size).toBe(0)
  })

  test('restores a pending navigation-target relationship before child discovery', async () => {
    installStorage({
      v2Present: true,
      v2: {
        sessionSeq: 1,
        tabs: [[39, {
          state: 'virtual', attachmentSessionId: 'session-39', realTargetId: null,
          createdByAgent: true, retained: false, attachPermission: 'allowed',
        }]],
        pendingNavigationTargets: [[40, 39]],
      },
    })
    const { mgr, sent } = createManager()

    await mgr.loadTabs()
    mgr.discover(40, 'https://example.com/opened', 'Opened')

    const discovered = sent.find((s) => s.params?.method === 'Extension.tabDiscovered')
    expect(discovered.params.params.openerVtabId).toBe('vtab-39')
    expect(mgr.get(40).createdByAgent).toBe(true)
  })
})

describe('TabManager — direct navigation-target relationship', () => {
  test('reports the relationship immediately before child discovery', () => {
    const { mgr, sent } = createManager()

    mgr.recordNavigationTarget(500, 499)

    expect(sent.map((event) => event.params?.method)).toEqual([
      'Extension.tabOpenerUpdated',
    ])
    expect(sent[0].params.params).toEqual({
      vtabId: 'vtab-500',
      openerVtabId: 'vtab-499',
    })
    expect(mgr.has(500)).toBe(false)
  })

  test('an agent-created source makes the discovered child agent-created and grouped', async () => {
    const groupedTabIds = []
    const originalGroup = chrome.tabs.group
    chrome.tabs.group = async ({ tabIds }) => {
      groupedTabIds.push(...tabIds)
      return 1
    }

    try {
      const { mgr, sent } = createManager()
      mgr.registerAgentTab(499, { url: 'https://example.com', title: 'Source' })
      sent.length = 0

      mgr.recordNavigationTarget(500, 499)
      mgr.discover(500, 'https://example.com/opened', 'Opened')
      await waitFor(() => groupedTabIds.includes(500))

      const discovered = sent.find((s) => s.params?.method === 'Extension.tabDiscovered')
      expect(discovered.params.params.openerVtabId).toBe('vtab-499')
      expect(discovered.params.params.targetInfo.openerVtabId).toBeUndefined()
      expect(mgr.get(500)).toMatchObject({
        openerVtabId: 'vtab-499',
        createdByAgent: true,
        claimedByAgent: false,
        retained: false,
      })
      expect(groupedTabIds).toContain(500)
    } finally {
      chrome.tabs.group = originalGroup
    }
  })

  test('a stale claimed projection cannot grant lifecycle ownership', async () => {
    const groupedTabIds = []
    const originalGroup = chrome.tabs.group
    chrome.tabs.group = async ({ tabIds }) => {
      groupedTabIds.push(...tabIds)
      return 1
    }

    try {
      const { mgr } = createManager()
      mgr.discover(509, 'https://example.com', 'Source')
      await mgr.syncAgentClaimedUserTabs(['vtab-509'])

      mgr.recordNavigationTarget(510, 509)
      mgr.discover(510, 'https://example.com/opened', 'Opened')

      expect(mgr.get(510)).toMatchObject({
        openerVtabId: 'vtab-509',
        createdByAgent: false,
        claimedByAgent: false,
        retained: false,
      })
      expect(groupedTabIds).not.toContain(510)

      await mgr.markTabOwnedByAgent('vtab-510')
      expect(mgr.get(510).createdByAgent).toBe(true)
      expect(groupedTabIds).toContain(510)
    } finally {
      chrome.tabs.group = originalGroup
    }
  })

  test('a late navigation-target event attributes and groups an existing discovery once', async () => {
    const groupedTabIds = []
    const originalGroup = chrome.tabs.group
    chrome.tabs.group = async ({ tabIds }) => {
      groupedTabIds.push(...tabIds)
      return 1
    }

    try {
      const { mgr, sent } = createManager()
      mgr.registerAgentTab(519, { url: 'https://example.com', title: 'Source' })
      mgr.discover(520, 'https://example.com/opened', 'Opened')
      sent.length = 0

      mgr.recordNavigationTarget(520, 519)
      mgr.recordNavigationTarget(520, 518)
      await waitFor(() => groupedTabIds.includes(520))

      const updates = sent.filter((s) => s.params?.method === 'Extension.tabOpenerUpdated')
      expect(updates).toHaveLength(1)
      expect(updates[0].params.params).toEqual({
        vtabId: 'vtab-520',
        openerVtabId: 'vtab-519',
      })
      expect(mgr.get(520).createdByAgent).toBe(true)
      expect(groupedTabIds).toContain(520)
    } finally {
      chrome.tabs.group = originalGroup
    }
  })

  test('closing a source removes its pending child relationships', () => {
    const { mgr, sent } = createManager()
    mgr.registerAgentTab(599, { url: 'https://example.com', title: 'Source' })
    sent.length = 0

    mgr.recordNavigationTarget(600, 599)
    mgr.removeNavigationTarget(599)
    mgr.discover(600, 'https://example.com/opened', 'Opened')

    const discovered = sent.find((s) => s.params?.method === 'Extension.tabDiscovered')
    expect(discovered.params.params.openerVtabId).toBeUndefined()
    expect(mgr.get(600).createdByAgent).toBe(false)
  })

  test('virtual and connected resync preserve the direct relationship', () => {
    const { mgr, sent } = createManager()
    mgr.discover(619, 'https://example.com', 'Source')
    mgr.recordNavigationTarget(620, 619)
    mgr.discover(620, 'https://example.com/opened', 'Opened')
    sent.length = 0

    let epoch = mgr.beginTabsResync()
    mgr.resyncAttachedTabs({ epoch, authoritative: true })
    const childDiscovery = sent.find(
      (event) => event.params?.params?.targetInfo?.targetId === 'vtab-620',
    )
    expect(childDiscovery.params.params.openerVtabId).toBe('vtab-619')

    setupConnectedTab(mgr, 620, 'session-620', 'REAL_TARGET_620')
    sent.length = 0
    epoch = mgr.beginTabsResync()
    mgr.resyncAttachedTabs({ epoch, authoritative: true })
    expect(sent.find((s) => s.params?.method === 'Target.attachedToTarget').params.params.openerVtabId)
      .toBe('vtab-619')
  })
})
